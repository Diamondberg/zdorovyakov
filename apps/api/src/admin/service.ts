import type { Pool,PoolClient } from 'pg';
import { transaction } from '../../../../db/migrate.js';
import { DomainError } from '../errors.js';
import { normalizePhone } from '../orders.js';
import type { Actor } from './auth.js';
import { owner } from './auth.js';

export async function audit(db:PoolClient,actor:Actor,action:string,entity:string,id:string,changes:object={}) {
  await db.query('INSERT INTO audit_logs(admin_id,action,entity_type,entity_id,redacted_changes) VALUES ($1,$2,$3,$4,$5)',[actor.id,action,entity,id,changes]);
}
function revision(row:{version:number}|undefined,version:number) {
  if(!row) throw new DomainError('NOT_FOUND',404);
  if(row.version!==version) throw new DomainError('VERSION_CONFLICT',409);
}
export async function summary(pool:Pool) {
  const result=await pool.query(`WITH bounds AS (SELECT date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Tomsk') AT TIME ZONE 'Asia/Tomsk' AS start)
    SELECT (SELECT count(*) FROM orders,bounds WHERE created_at>=bounds.start) AS new_orders,
    (SELECT count(*) FROM orders WHERE payment_status='unpaid' AND processing_status<>'cancelled') AS awaiting_payment,
    (SELECT count(*) FROM orders WHERE processing_status='assembled' AND payment_status='paid' AND delivery_status IN ('not_shipped','prepared')) AS ready_to_ship,
    (SELECT coalesce(sum(CASE kind WHEN 'payment' THEN amount_minor ELSE -amount_minor END),0) FROM payments,bounds WHERE state='confirmed' AND confirmed_at>=bounds.start) AS received_minor`);
  const r=result.rows[0];return {timezone:'Asia/Tomsk',newOrdersToday:Number(r.new_orders),awaitingPayment:Number(r.awaiting_payment),readyToShip:Number(r.ready_to_ship),receivedTodayMinor:Number(r.received_minor)};
}
export async function listOrders(pool:Pool,q:{search?:string;processing?:string;payment?:string;delivery?:string;attention?:string;offset?:number}) {
  const result=await pool.query(`SELECT o.id,o.number,o.created_at,o.processing_status,o.payment_status,o.delivery_status,o.items_total_minor,o.total_minor,o.version,
    c.first_name,c.last_name,s.name AS storefront_name,count(*) OVER() AS total_count
    FROM orders o JOIN customers c ON c.id=o.customer_id JOIN storefronts s ON s.id=o.storefront_id
    WHERE ($1::text IS NULL OR o.number ILIKE '%'||$1||'%' OR c.first_name ILIKE '%'||$1||'%' OR c.last_name ILIKE '%'||$1||'%'
      OR EXISTS(SELECT 1 FROM customer_contacts cc WHERE cc.customer_id=c.id AND cc.normalized_value ILIKE '%'||$1||'%'))
    AND ($2::text IS NULL OR o.processing_status=$2) AND ($3::text IS NULL OR o.payment_status=$3) AND ($4::text IS NULL OR o.delivery_status=$4)
    AND ($6::text IS NULL OR ($6='awaiting_payment' AND o.payment_status='unpaid' AND o.processing_status<>'cancelled')
      OR ($6='ready_to_ship' AND o.processing_status='assembled' AND o.payment_status='paid' AND o.delivery_status IN ('not_shipped','prepared')))
    ORDER BY o.created_at DESC,o.id LIMIT 25 OFFSET $5`,[q.search??null,q.processing??null,q.payment??null,q.delivery??null,q.offset??0,q.attention??null]);
  return {items:result.rows.map(({total_count,...r})=>r),total:Number(result.rows[0]?.total_count??0),limit:25};
}
export async function orderDetail(pool:Pool,id:string) {
  const order=(await pool.query('SELECT o.*,s.name AS storefront_name FROM orders o JOIN storefronts s ON s.id=o.storefront_id WHERE o.id=$1',[id])).rows[0];
  if(!order) throw new DomainError('NOT_FOUND',404);
  // Do not return internal idempotency/request hash or procurement snapshots.
  const {request_hash,idempotency_key,...safe}=order;
  const items=await pool.query(`SELECT id,product_id,sku,name,quantity,list_unit_price_minor,sale_unit_price_minor,discount_minor,line_total_minor,promotion_snapshot,bundle_code FROM order_items WHERE order_id=$1 ORDER BY id`,[id]);
  const events=await pool.query(`SELECT e.id,e.event_type,e.from_status,e.to_status,e.created_at,a.email AS actor FROM order_events e LEFT JOIN admin_users a ON a.id=e.actor_id WHERE e.order_id=$1 ORDER BY e.created_at,e.id`,[id]);
  const comments=await pool.query(`SELECT c.id,c.body,c.created_at,a.email AS actor FROM order_comments c JOIN admin_users a ON a.id=c.admin_id WHERE c.order_id=$1 ORDER BY c.created_at,c.id`,[id]);
  const shipments=await pool.query('SELECT id,carrier,tracking_number,delivery_status,shipped_at,delivered_at FROM shipments WHERE order_id=$1',[id]);
  return {...safe,items:items.rows,events:events.rows,comments:comments.rows,shipments:shipments.rows};
}
const processing:Record<string,string[]>={new:['confirmed','cancelled'],confirmed:['assembling','cancelled'],assembling:['assembled','cancelled'],assembled:['cancelled'],cancelled:[]};
const payment:Record<string,string[]>={unpaid:['paid'],paid:['refund_pending'],refund_pending:['refunded'],refunded:[]};
const delivery:Record<string,string[]>={not_shipped:['prepared'],prepared:['shipped','not_shipped'],shipped:['in_transit','delivered','returned'],in_transit:['pickup_ready','delivered','returned'],pickup_ready:['delivered','returned'],delivered:['returned'],returned:[]};

export async function changeStatus(pool:Pool,actor:Actor,id:string,input:{version:number;kind:'processing'|'payment'|'delivery';value:string;confirm?:boolean;amountMinor?:number}) {
  if(input.kind==='payment') {owner(actor);if(input.confirm!==true) throw new DomainError('PAYMENT_CONFIRMATION_REQUIRED');}
  return transaction(pool,async db=>{
    const row=(await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];revision(row,input.version);
    const column={processing:'processing_status',payment:'payment_status',delivery:'delivery_status'}[input.kind];
    const previous=row[column] as string;
    const transitions={processing,payment,delivery}[input.kind];
    if(!transitions[previous]?.includes(input.value)) throw new DomainError('INVALID_STATUS_TRANSITION',409);
    if(input.kind==='processing'&&input.value==='cancelled'&&!['not_shipped','prepared'].includes(row.delivery_status)) throw new DomainError('ALREADY_SHIPPED',409);
    if(input.kind==='payment'&&input.value==='paid') {
      if(row.processing_status==='cancelled') throw new DomainError('ORDER_CANCELLED',409);
      if(row.total_minor===null||Number(row.total_minor)!==input.amountMinor) throw new DomainError('PAYMENT_AMOUNT_MISMATCH',409);
      await db.query("INSERT INTO payments(order_id,kind,state,amount_minor,confirmed_at,recorded_by) VALUES ($1,'payment','confirmed',$2,clock_timestamp(),$3)",[id,input.amountMinor,actor.id]);
    }
    if(input.kind==='payment'&&input.value==='refunded') {
      const amount=Number(row.total_minor);
      if(input.amountMinor!==amount) throw new DomainError('PAYMENT_AMOUNT_MISMATCH',409);
      await db.query("INSERT INTO payments(order_id,kind,state,amount_minor,confirmed_at,recorded_by) VALUES ($1,'refund','confirmed',$2,clock_timestamp(),$3)",[id,amount,actor.id]);
    }
    if(input.kind==='delivery') {
      if(row.processing_status==='cancelled') throw new DomainError('ORDER_CANCELLED',409);
      let shipment=(await db.query('SELECT * FROM shipments WHERE order_id=$1 FOR UPDATE',[id])).rows[0];
      if(input.value==='prepared'&&!shipment) shipment=(await db.query('INSERT INTO shipments(order_id,recipient_snapshot,address_snapshot) VALUES ($1,$2,$3) RETURNING *',[id,row.recipient_snapshot,row.shipping_snapshot])).rows[0];
      if(input.value==='shipped'&&(row.processing_status!=='assembled'||!shipment?.carrier||!shipment?.tracking_number)) throw new DomainError('SHIPMENT_NOT_READY',409);
      if(!shipment) throw new DomainError('SHIPMENT_NOT_READY',409);
      await db.query(`UPDATE shipments SET delivery_status=$2,shipped_at=CASE WHEN $2='shipped' THEN clock_timestamp() ELSE shipped_at END,
        delivered_at=CASE WHEN $2='delivered' THEN clock_timestamp() ELSE delivered_at END WHERE id=$1`,[shipment.id,input.value]);
    }
    await db.query(`UPDATE orders SET ${column}=$2,version=version+1 WHERE id=$1`,[id,input.value]);
    await db.query('INSERT INTO order_events(order_id,event_type,from_status,to_status,actor_id) VALUES ($1,$2,$3,$4,$5)',[id,`${input.kind}.changed`,previous,input.value,actor.id]);
    await audit(db,actor,`order.${input.kind}.changed`,'order',id,{from:previous,to:input.value,fromVersion:input.version,toVersion:input.version+1});
    await db.query(`INSERT INTO notification_events(order_id,customer_id,event_type,dedup_key,payload) VALUES ($1,$2,$3,$4,$5)`,
      [id,row.customer_id,`order.${input.kind}.${input.value}`,`${id}:${input.version+1}`,{orderId:id,kind:input.kind,from:previous,to:input.value}]);
    return {version:input.version+1};
  });
}
export async function editOrder(pool:Pool,actor:Actor,id:string,input:{version:number;recipient?:object;shipping?:object;shippingMinor?:number;carrier?:string;trackingNumber?:string}) {
  return transaction(pool,async db=>{
    const row=(await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];revision(row,input.version);
    if((input.recipient||input.shipping)&&!['not_shipped','prepared'].includes(row.delivery_status)) throw new DomainError('ALREADY_SHIPPED',409);
    if(input.shippingMinor!==undefined&&row.payment_status!=='unpaid') throw new DomainError('PAYMENT_ALREADY_RECORDED',409);
    const recipient=input.recipient??row.recipient_snapshot;const shipping=input.shipping??row.shipping_snapshot;
    if(input.recipient&&'email' in input.recipient) {
      const email=String(input.recipient.email).trim().toLowerCase();
      const verified=await db.query("SELECT 1 FROM customer_contacts WHERE customer_id=$1 AND kind='email' AND normalized_value=$2 AND verified_at IS NOT NULL",[row.customer_id,email]);
      if(!verified.rowCount) throw new DomainError('EMAIL_NOT_VERIFIED',409);
      (recipient as {email:string}).email=email;
    }
    if(input.recipient&&'phone' in input.recipient) (recipient as {phone:string}).phone=normalizePhone((input.recipient as {phone:string}).phone);
    const fee=input.shippingMinor??row.shipping_minor;
    await db.query('UPDATE orders SET recipient_snapshot=$2,shipping_snapshot=$3,shipping_minor=$4,total_minor=$5,version=version+1 WHERE id=$1',
      [id,recipient,shipping,fee,fee===null?null:Number(row.items_total_minor)+Number(fee)]);
    if(input.carrier!==undefined||input.trackingNumber!==undefined) {
      let shipment=(await db.query('SELECT id FROM shipments WHERE order_id=$1',[id])).rows[0];
      if(!shipment) shipment=(await db.query('INSERT INTO shipments(order_id,recipient_snapshot,address_snapshot) VALUES ($1,$2,$3) RETURNING id',[id,recipient,shipping])).rows[0];
      await db.query('UPDATE shipments SET carrier=coalesce($2,carrier),tracking_number=coalesce($3,tracking_number) WHERE id=$1',[shipment.id,input.carrier??null,input.trackingNumber??null]);
    }
    if(input.recipient||input.shipping) await db.query('UPDATE shipments SET recipient_snapshot=$2,address_snapshot=$3 WHERE order_id=$1 AND shipped_at IS NULL',[id,recipient,shipping]);
    await audit(db,actor,'order.edited','order',id,{fields:Object.keys(input).filter(k=>k!=='version'),fromVersion:input.version,toVersion:input.version+1});
    await db.query("INSERT INTO order_events(order_id,event_type,actor_id) VALUES ($1,'order.edited',$2)",[id,actor.id]);
    return {version:input.version+1};
  });
}
export async function commentOrder(pool:Pool,actor:Actor,id:string,body:string) {
  return transaction(pool,async db=>{
    const row=await db.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE',[id]);if(!row.rowCount) throw new DomainError('NOT_FOUND',404);
    const comment=(await db.query('INSERT INTO order_comments(order_id,admin_id,body) VALUES ($1,$2,$3) RETURNING id',[id,actor.id,body])).rows[0];
    await audit(db,actor,'order.comment.added','order',id,{commentId:comment.id});return comment;
  });
}
export async function listCustomers(pool:Pool,search='',offset=0) {
  const rows=await pool.query(`SELECT c.id,c.first_name,c.last_name,c.created_at,c.version,count(*) OVER() AS total_count,
    (SELECT cc.normalized_value FROM customer_contacts cc WHERE cc.customer_id=c.id AND kind='email' AND verified_at IS NOT NULL LIMIT 1) AS email
    FROM customers c WHERE c.first_name ILIKE '%'||$1||'%' OR c.last_name ILIKE '%'||$1||'%'
    OR EXISTS(SELECT 1 FROM customer_contacts cc WHERE cc.customer_id=c.id AND cc.normalized_value ILIKE '%'||$1||'%')
    ORDER BY c.created_at DESC,c.id LIMIT 25 OFFSET $2`,[search,offset]);
  return {items:rows.rows.map(({total_count,...r})=>r),total:Number(rows.rows[0]?.total_count??0),limit:25};
}
export async function customerDetail(pool:Pool,id:string) {
  const c=(await pool.query('SELECT * FROM customers WHERE id=$1',[id])).rows[0];if(!c) throw new DomainError('NOT_FOUND',404);
  const contacts=await pool.query('SELECT id,kind,normalized_value,verified_at FROM customer_contacts WHERE customer_id=$1',[id]);
  const addresses=await pool.query('SELECT * FROM customer_addresses WHERE customer_id=$1',[id]);
  const pending=await pool.query('SELECT pending_email,requested_at FROM customer_email_changes WHERE customer_id=$1',[id]);
  const orders=await pool.query('SELECT id,number,processing_status,payment_status,delivery_status,items_total_minor,created_at FROM orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100',[id]);
  const metrics=(await pool.query(`SELECT count(*) FILTER(WHERE payment_status='paid' AND delivery_status='delivered') AS completed_orders,
    coalesce(sum(items_total_minor) FILTER(WHERE payment_status='paid'),0) AS confirmed_goods_minor FROM orders WHERE customer_id=$1`,[id])).rows[0];
  return {...c,contacts:contacts.rows,addresses:addresses.rows,pendingEmail:pending.rows[0]??null,orders:orders.rows,metrics};
}
export async function editCustomer(pool:Pool,actor:Actor,id:string,input:{version:number;firstName?:string;lastName?:string;phone?:string;email?:string;notes?:string;address?:{country:string;region?:string;city:string;postalCode?:string;address?:string;pickupPoint?:string}}) {
  return transaction(pool,async db=>{
    const c=(await db.query('SELECT * FROM customers WHERE id=$1 FOR UPDATE',[id])).rows[0];revision(c,input.version);
    let emailConfirmationPending=false;
    if(input.email) {
      const email=input.email.trim().toLowerCase();
      await db.query("SELECT pg_advisory_xact_lock(hashtext('email:'||$1))",[email]);
      const other=await db.query("SELECT customer_id FROM customer_contacts WHERE kind='email' AND normalized_value=$1 AND verified_at IS NOT NULL AND customer_id<>$2",[email,id]);
      if(other.rowCount) throw new DomainError('EMAIL_ALREADY_IN_USE',409);
      const same=await db.query("SELECT id FROM customer_contacts WHERE customer_id=$1 AND kind='email' AND normalized_value=$2 AND verified_at IS NOT NULL",[id,email]);
      if(!same.rowCount) {
        emailConfirmationPending=true;
        await db.query(`INSERT INTO customer_email_changes(customer_id,pending_email,requested_by) VALUES ($1,$2,$3)
          ON CONFLICT(customer_id) DO UPDATE SET pending_email=$2,requested_by=$3,requested_at=clock_timestamp()`,[id,email,actor.id]);
      }
    }
    let duplicatePhone=false;
    if(input.phone) {
      const phone=normalizePhone(input.phone);
      duplicatePhone=!!(await db.query("SELECT 1 FROM customer_contacts WHERE kind='phone' AND normalized_value=$1 AND customer_id<>$2 LIMIT 1",[phone,id])).rowCount;
      const old=(await db.query("SELECT id,normalized_value FROM customer_contacts WHERE customer_id=$1 AND kind='phone' ORDER BY id LIMIT 1",[id])).rows[0];
      if(old&&old.normalized_value!==phone) await db.query('UPDATE customer_contacts SET normalized_value=$2,verified_at=NULL WHERE id=$1',[old.id,phone]);
      else if(!old) await db.query("INSERT INTO customer_contacts(customer_id,kind,normalized_value) VALUES ($1,'phone',$2)",[id,phone]);
    }
    if(input.address) {
      const a=input.address;
      // Address book changes never mutate order or shipment snapshots.
      await db.query('INSERT INTO customer_addresses(customer_id,country,region,city,postal_code,address,pickup_point) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id,a.country,a.region??null,a.city,a.postalCode??null,a.address??null,a.pickupPoint??null]);
    }
    await db.query('UPDATE customers SET first_name=coalesce($2,first_name),last_name=coalesce($3,last_name),notes=coalesce($4,notes),version=version+1 WHERE id=$1',[id,input.firstName??null,input.lastName??null,input.notes??null]);
    await audit(db,actor,'customer.edited','customer',id,{fields:Object.keys(input).filter(k=>k!=='version'),fromVersion:input.version,toVersion:input.version+1});
    return {version:input.version+1,emailConfirmationPending,duplicatePhone};
  });
}
export async function editPrice(pool:Pool,actor:Actor,id:string,input:{version:number;retailPriceMinor:number;purchasePriceMinor:number}) {
  owner(actor);return transaction(pool,async db=>{
    const p=(await db.query('SELECT * FROM products WHERE id=$1 FOR UPDATE',[id])).rows[0];revision(p,input.version);
    await db.query('UPDATE products SET retail_price_minor=$2,purchase_price_minor=$3,version=version+1 WHERE id=$1',[id,input.retailPriceMinor,input.purchasePriceMinor]);
    await audit(db,actor,'product.price.changed','product',id,{from:{retail:p.retail_price_minor,purchase:p.purchase_price_minor},to:{retail:input.retailPriceMinor,purchase:input.purchasePriceMinor}});
    return {version:input.version+1};
  });
}

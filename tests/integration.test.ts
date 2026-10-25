import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, copyFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { testPostgres } from './helpers/postgres.js';
import { migrate, migrationsDir, transaction } from '../db/migrate.js';
import { buildApp } from '../apps/api/src/app.js';
import { savePromotion } from '../apps/api/src/promotions.js';
import { createOrder, type InternalOrderInput } from '../apps/api/src/orders.js';
import { passwordHash,digest } from '../apps/api/src/admin/auth.js';

let db:Awaited<ReturnType<typeof testPostgres>>;
let app:Awaited<ReturnType<typeof buildApp>>;
let productId:string;
let promotionId:string;
let campaign:Parameters<typeof savePromotion>[1];
const base='/api/v1/storefronts/vodny-propolis';
const approvedOrigin='https://xn----ctbgrdnlgeajblt4l.xn--p1ai';

before(async () => {
  db=await testPostgres();
  console.log(`Integration database: ${(await db.pool.query('SHOW server_version')).rows[0].server_version}; loopback only; generated ephemeral credentials.`);
  assert.deepEqual(await migrate(db.pool),['001_core.sql','002_initial_catalog.sql','003_admin.sql']);
  productId=(await db.pool.query('SELECT id FROM products')).rows[0].id;
  app=await buildApp(db.pool);
}, {timeout:120000});
after(async () => { await app?.close(); await db?.pool.end(); await db?.postgres.stop(); });

test('migration repeat/concurrency, checksum and failure rollback',async () => {
  assert.deepEqual(await migrate(db.pool),[]);
  assert.deepEqual(await Promise.all([migrate(db.pool),migrate(db.pool)]),[[],[]]);
  const scratch=await mkdtemp(join(tmpdir(),'zdorovyakov-migrations-'));
  for(const name of await readdir(migrationsDir)) if(name.endsWith('.sql')) await copyFile(join(migrationsDir,name),join(scratch,name));
  await writeFile(join(scratch,'004_broken.sql'),'CREATE TABLE rollback_probe (id int); SELECT * FROM missing_table_for_test;');
  await assert.rejects(migrate(db.pool,scratch));
  assert.equal((await db.pool.query("SELECT to_regclass('rollback_probe') AS value")).rows[0].value,null);
  assert.equal((await db.pool.query('SELECT count(*) FROM schema_migrations')).rows[0].count,'3');
  await writeFile(join(scratch,'001_core.sql'),'-- altered historical migration');
  await assert.rejects(migrate(db.pool,scratch),/checksum mismatch/);
});

test('public catalogue and origin isolation, no commercial cost leak', async () => {
  assert.equal((await app.inject('/health/ready')).statusCode,200);
  const catalogue=await app.inject(`${base}/products`);
  assert.equal(catalogue.statusCode,200);
  assert.deepEqual(Object.keys(catalogue.json()[0]).sort(),['currency','id','name','sku','unitPriceMinor','volumeMl']);
  assert.equal(catalogue.json()[0].unitPriceMinor,47000);
  assert(!catalogue.body.includes('27500'));
  assert.equal((await app.inject({url:`${base}/products`,headers:{origin:'https://evil.example'}})).statusCode,403);
  const cors=await app.inject({url:`${base}/products`,headers:{origin:approvedOrigin}});
  assert.equal(cors.headers['access-control-allow-origin'],approvedOrigin);
  assert.equal((await app.inject({method:'OPTIONS',url:`${base}/quote`,headers:{origin:approvedOrigin,'access-control-request-method':'POST','access-control-request-headers':'content-type'}})).statusCode,204);
  assert.equal((await app.inject(`${base.replace('vodny-propolis',"x' OR '1'='1")}/products`)).statusCode,400);
  assert.equal((await app.inject('/api/v1/orders')).statusCode,404);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/orders',payload:{}})).statusCode,404);
});

const quote = (quantity:number,extra:Record<string,unknown>={}) => app.inject({method:'POST',url:`${base}/quote`,payload:{items:[{productId,quantity}],...extra}});
test('no promotion enabled by default; strict input and product isolation',async () => {
  const response=await quote(9);
  assert.equal(response.statusCode,200);
  assert.equal(response.json().itemsTotalMinor,423000);
  assert.equal(response.json().shippingMinor,null);
  assert.equal(response.json().totalMinor,null);
  assert.equal(response.json().lines[0].promotion,null);
  for (const n of [0,-1,1.2,1000]) assert.equal((await quote(n)).statusCode,400);
  assert.equal((await quote(1,{unitPriceMinor:1})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:`${base}/quote`,headers:{'content-type':'application/json'},payload:'{broken'})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:`${base}/quote`,payload:{items:[{productId,quantity:1,unitPriceMinor:1}]}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:`${base}/quote`,payload:{items:[{productId:randomUUID(),quantity:1}]}})).statusCode,404);
  assert.equal((await app.inject({method:'POST',url:`${base}/quote`,payload:{items:[{productId,quantity:1},{productId,quantity:1}]}})).statusCode,400);
  const privateProduct=(await db.pool.query("INSERT INTO products(sku,name,retail_price_minor,purchase_price_minor) VALUES ('PRIVATE','Private',100,50) RETURNING id")).rows[0].id;
  assert.equal((await app.inject({method:'POST',url:`${base}/quote`,payload:{items:[{productId:privateProduct,quantity:1}]}})).statusCode,404);
});

test('active promotion, overlapping activation concurrency and expiry',async () => {
  const now=(await db.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  campaign={name:'Synthetic integration fixture',startsAt:new Date(+now-60000),endsAt:new Date(+now+3600000),active:true,
    productIds:[productId],rules:[{minQuantity:6,discountBps:1000},{minQuantity:9,discountBps:1500}]};
  const saves=await Promise.allSettled([savePromotion(db.pool,campaign),savePromotion(db.pool,{...campaign,name:'Conflict fixture'})]);
  assert.equal(saves.filter(s=>s.status==='fulfilled').length,1);
  assert.equal(saves.filter(s=>s.status==='rejected').length,1);
  promotionId=(saves.find(s=>s.status==='fulfilled') as PromiseFulfilledResult<string>).value;
  for(const [n,total] of [[1,47000],[3,141000],[6,253800],[9,359550]]) {
    const response=await quote(n!); assert.equal(response.statusCode,200); assert.equal(response.json().itemsTotalMinor,total);
    assert(!response.body.includes('purchase')); assert(!response.body.includes('27500'));
  }
  await savePromotion(db.pool,{...campaign,id:promotionId,endsAt:new Date(+now-1000),startsAt:new Date(+now-60000)});
  assert.equal((await quote(9)).json().itemsTotalMinor,423000);
  await savePromotion(db.pool,{...campaign,id:promotionId});
});

test('multiple products in one cart are calculated independently',async () => {
  const second=(await db.pool.query("INSERT INTO products(sku,name,retail_price_minor,purchase_price_minor) VALUES ('SECOND-FIXTURE','Synthetic second product',10000,5000) RETURNING id")).rows[0].id;
  await db.pool.query("INSERT INTO storefront_products SELECT id,$1 FROM storefronts WHERE slug='vodny-propolis'",[second]);
  const response=await app.inject({method:'POST',url:`${base}/quote`,payload:{items:[{productId,quantity:6},{productId:second,quantity:2}]}});
  assert.equal(response.statusCode,200);
  assert.equal(response.json().lines.length,2);
  assert.equal(response.json().itemsTotalMinor,273800);
  assert.equal(response.json().discountMinor,28200);
});

function order(overrides:Partial<InternalOrderInput>={}):InternalOrderInput {
  return {storefrontSlug:'vodny-propolis',idempotencyKey:randomUUID(),items:[{productId,quantity:9}],
    verifiedEmail:{email:'synthetic-customer@example.invalid',verifiedAt:new Date(Date.now()-1000)},
    recipient:{firstName:'Synthetic',lastName:'Fixture',phone:'+79990000000'},
    shipping:{country:'Test',city:'Fixture City',address:'Synthetic test address'},...overrides};
}

test('concurrent order idempotency, snapshot and atomic outbox',async () => {
  const input=order();
  const results=await Promise.all(Array.from({length:5},()=>createOrder(db.pool,input)));
  assert.equal(new Set(results.map(r=>r.id)).size,1);
  assert.equal(results.filter(r=>!r.replayed).length,1);
  const id=results[0]!.id;
  const row=(await db.pool.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0];
  assert.equal(row.items_total_minor,'359550'); assert.equal(row.payment_status,'unpaid');
  assert.equal(row.processing_status,'new'); assert.equal(row.delivery_status,'not_shipped'); assert.equal(row.total_minor,null);
  assert.equal((await db.pool.query('SELECT count(*) FROM notification_events WHERE order_id=$1',[id])).rows[0].count,'1');
  assert.equal((await db.pool.query('SELECT count(*) FROM order_events WHERE order_id=$1',[id])).rows[0].count,'1');
  await assert.rejects(createOrder(db.pool,{...input,items:[{productId,quantity:6}]}),/IDEMPOTENCY_CONFLICT/);
  await db.pool.query('UPDATE products SET retail_price_minor=48000 WHERE id=$1',[productId]);
  await savePromotion(db.pool,{...campaign,id:promotionId,active:false});
  assert.equal((await db.pool.query('SELECT line_total_minor FROM order_items WHERE order_id=$1',[id])).rows[0].line_total_minor,'359550');
  assert.equal((await quote(9)).json().itemsTotalMinor,432000);
  await assert.rejects(db.pool.query('UPDATE order_items SET quantity=1 WHERE order_id=$1',[id]));
  await assert.rejects(db.pool.query("UPDATE orders SET storefront_id=gen_random_uuid() WHERE id=$1",[id]));
  await assert.rejects(db.pool.query("UPDATE order_events SET to_status='paid' WHERE order_id=$1",[id]));
  await db.pool.query('UPDATE products SET retail_price_minor=47000 WHERE id=$1',[productId]);
});

test('verified email joins customer safely; unverified phone does not merge',async () => {
  const a=await createOrder(db.pool,order());
  const b=await createOrder(db.pool,order({verifiedEmail:{email:' SYNTHETIC-CUSTOMER@EXAMPLE.INVALID ',verifiedAt:new Date(Date.now()-1000)}}));
  const c=await createOrder(db.pool,order({verifiedEmail:{email:'other-synthetic@example.invalid',verifiedAt:new Date(Date.now()-1000)}}));
  const rows=(await db.pool.query('SELECT id,customer_id FROM orders WHERE id=ANY($1::uuid[])',[[a.id,b.id,c.id]])).rows;
  const customer=(id:string)=>rows.find(r=>r.id===id).customer_id;
  assert.equal(customer(a.id),customer(b.id)); assert.notEqual(customer(a.id),customer(c.id));
  const concurrent=await Promise.all(Array.from({length:4},()=>createOrder(db.pool,order({verifiedEmail:{email:'concurrent-identity@example.invalid',verifiedAt:new Date(Date.now()-1000)}}))));
  assert.equal((await db.pool.query('SELECT count(DISTINCT customer_id) FROM orders WHERE id=ANY($1::uuid[])',[concurrent.map(o=>o.id)])).rows[0].count,'1');
  assert.equal((await db.pool.query("SELECT count(*) FROM customer_contacts WHERE kind='phone' AND verified_at IS NOT NULL")).rows[0].count,'0');
});

test('late outbox failure rolls back customer, order and items',async () => {
  const counts=async () => (await db.pool.query(`SELECT (SELECT count(*) FROM orders) AS orders,
    (SELECT count(*) FROM customers) AS customers,(SELECT count(*) FROM order_items) AS items`)).rows[0];
  const previous=await counts();
  await db.pool.query(`CREATE FUNCTION test_reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END; $$;
    CREATE TRIGGER test_outbox_failure BEFORE INSERT ON notification_events FOR EACH ROW EXECUTE FUNCTION test_reject_outbox();`);
  try { await assert.rejects(createOrder(db.pool,order({verifiedEmail:{email:'rollback@example.invalid',verifiedAt:new Date(Date.now()-1000)}}))); }
  finally { await db.pool.query('DROP TRIGGER test_outbox_failure ON notification_events; DROP FUNCTION test_reject_outbox();'); }
  assert.deepEqual(await counts(),previous);
});

test('DB constraints, readiness failure and API rate limits',async () => {
  await assert.rejects(db.pool.query("INSERT INTO products(sku,name,retail_price_minor,purchase_price_minor) VALUES ('BAD','Bad',-1,0)"));
  await assert.rejects(db.pool.query('INSERT INTO promotion_rules(promotion_id,min_quantity,discount_bps) VALUES ($1,1,10001)',[promotionId]));
  await db.pool.query('CREATE DATABASE readiness_probe');
  const uninitialised=new pg.Pool({...db.pool.options,connectionString:undefined,database:'readiness_probe'});
  const unready=await buildApp(uninitialised);
  try { assert.equal((await unready.inject('/health/ready')).statusCode,503); }
  finally { await unready.close(); await uninitialised.end(); }
  const limited=await buildApp(db.pool,{rateMax:2});
  try { for(let i=0;i<2;i++) assert.equal((await limited.inject('/health/live')).statusCode,200);
    assert.equal((await limited.inject('/health/live')).statusCode,429);
  } finally { await limited.close(); }
  await transaction(db.pool,async client => {
    // Constraints on independent statuses do not couple payment to processing.
    await assert.rejects(client.query("UPDATE orders SET payment_status='not_a_status'"));
    // Query error aborts transaction; explicit rollback is performed by throwing.
    throw new Error('Expected transaction rollback');
  }).catch(e=>assert.equal(e.message,'Expected transaction rollback'));
});

test('real HTTP listener serves health and catalogue on loopback',async () => {
  const address=await app.listen({host:'127.0.0.1',port:0});
  const health=await fetch(`${address}/health/live`);
  assert.equal(health.status,200);
  const catalogue=await fetch(`${address}${base}/products`);
  assert.equal(catalogue.status,200);
  assert.equal((await catalogue.json()).length,2);
});

const adminBase='/api/v1/admin';
const adminOrigin='http://127.0.0.1:3000';
let ownerCookie:string;let ownerCsrf:string;let managerCookie:string;let managerCsrf:string;let adminOrderId:string;let adminCustomerId:string;
async function adminRequest(method:'GET'|'POST'|'PATCH'|'PUT',url:string,payload?:object,manager=false) {
  return app.inject({method,url:adminBase+url,headers:{origin:adminOrigin,cookie:manager?managerCookie:ownerCookie,'x-csrf-token':manager?managerCsrf:ownerCsrf},payload});
}
test('admin login uses hashed sessions, secure cookies, exact origin and CSRF',async()=>{
  for(const role of ['owner','manager']) await db.pool.query('INSERT INTO admin_users(email,password_hash,role) VALUES ($1,$2,$3)',[`${role}@example.invalid`,await passwordHash('Synthetic passphrase for tests only'),role]);
  assert.equal((await app.inject({url:adminBase+'/orders'})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:adminBase+'/auth/login',headers:{origin:'https://evil.example'},payload:{email:'owner@example.invalid',password:'Synthetic passphrase for tests only'}})).statusCode,403);
  const login=async(role:string)=>app.inject({method:'POST',url:adminBase+'/auth/login',headers:{origin:adminOrigin},payload:{email:`${role}@example.invalid`,password:'Synthetic passphrase for tests only'}});
  const a=await login('owner');assert.equal(a.statusCode,200);
  const cookie=String(a.headers['set-cookie']);assert(cookie.includes('HttpOnly')&&cookie.includes('Secure')&&cookie.includes('SameSite=Strict'));
  ownerCookie=cookie.split(';')[0]!;ownerCsrf=a.json().csrfToken;
  const b=await login('manager');assert.equal(b.statusCode,200);managerCookie=String(b.headers['set-cookie']).split(';')[0]!;managerCsrf=b.json().csrfToken;
  const token=ownerCookie.split('=')[1]!;
  assert.equal((await db.pool.query('SELECT count(*) FROM admin_sessions WHERE token_hash=$1',[token])).rows[0].count,'0');
  assert.equal((await db.pool.query('SELECT count(*) FROM admin_sessions WHERE token_hash=$1',[digest(token)])).rows[0].count,'1');
  assert.equal((await adminRequest('GET','/auth/me')).json().csrfToken,ownerCsrf);
  assert.equal((await app.inject({method:'POST',url:adminBase+'/auth/logout',headers:{origin:adminOrigin,cookie:ownerCookie}})).statusCode,403);
  assert.equal((await app.inject({url:adminBase+'/orders',headers:{origin:'https://evil.example',cookie:ownerCookie}})).statusCode,403);
});
test('admin list/search and dashboard exclude unpaid applications from revenue',async()=>{
  const result=await createOrder(db.pool,order({verifiedEmail:{email:'admin-fixture@example.invalid',verifiedAt:new Date(Date.now()-1000)}}));adminOrderId=result.id;
  adminCustomerId=(await db.pool.query('SELECT customer_id FROM orders WHERE id=$1',[result.id])).rows[0].customer_id;
  const rows=await adminRequest('GET','/orders?search='+encodeURIComponent(result.number));assert.equal(rows.statusCode,200);assert.equal(rows.json().items.length,1);
  const data=await adminRequest('GET','/summary');assert.equal(data.statusCode,200);assert.equal(data.json().receivedTodayMinor,0);assert(data.json().awaitingPayment>0);
  const waiting=(await adminRequest('GET','/orders?attention=awaiting_payment')).json();assert.equal(waiting.total,data.json().awaitingPayment);
  const detail=await adminRequest('GET',`/orders/${adminOrderId}`);assert(!detail.body.includes('purchase_unit_price_minor'));assert(!detail.body.includes('request_hash'));
  assert.equal((await adminRequest('GET','/products',undefined,true)).body.includes('purchase_price_minor'),false);
});
test('customer edits preserve confirmed email, require re-verification and do not rewrite order snapshots',async()=>{
  const before=(await adminRequest('GET',`/customers/${adminCustomerId}`)).json();
  const response=await adminRequest('PATCH',`/customers/${adminCustomerId}`,{version:1,firstName:'Edited fixture',phone:'8 (999) 000-00-00',email:'pending-fixture@example.invalid',notes:'Synthetic note',address:{country:'Test',city:'Updated fixture city',address:'Updated fixture address'}});
  assert.equal(response.statusCode,200);assert.equal(response.json().version,2);assert.equal(response.json().duplicatePhone,true);
  const after=(await adminRequest('GET',`/customers/${adminCustomerId}`)).json();assert.equal(after.pendingEmail.pending_email,'pending-fixture@example.invalid');
  assert.equal(after.contacts.find((c:{kind:string})=>c.kind==='email').normalized_value,before.contacts.find((c:{kind:string})=>c.kind==='email').normalized_value);
  assert.equal((await adminRequest('GET',`/orders/${adminOrderId}`)).json().recipient_snapshot.firstName,'Synthetic');
  assert.equal((await adminRequest('PATCH',`/customers/${adminCustomerId}`,{version:1,notes:'Stale'})).statusCode,409);
  assert.equal((await adminRequest('PATCH',`/customers/${adminCustomerId}`,{version:2,email:'synthetic-customer@example.invalid'})).statusCode,409);
});
test('manual payment requires owner, explicit confirmation, exact known amount and audit',async()=>{
  const edit=await adminRequest('PATCH',`/orders/${adminOrderId}`,{version:1,shippingMinor:10000,carrier:'Test carrier',trackingNumber:'FIXTURE-TRACK'});assert.equal(edit.statusCode,200);
  const request={version:2,kind:'payment',value:'paid',confirm:true,amountMinor:433000};
  assert.equal((await adminRequest('POST',`/orders/${adminOrderId}/status`,request,true)).statusCode,403);
  assert.equal((await adminRequest('POST',`/orders/${adminOrderId}/status`,{...request,confirm:false})).statusCode,400);
  assert.equal((await adminRequest('POST',`/orders/${adminOrderId}/status`,{...request,amountMinor:1})).statusCode,409);
  const paid=await adminRequest('POST',`/orders/${adminOrderId}/status`,request);assert.equal(paid.statusCode,200);
  assert.equal((await adminRequest('GET','/summary')).json().receivedTodayMinor,433000);
  assert.equal((await adminRequest('POST',`/orders/${adminOrderId}/status`,request)).statusCode,409);
  assert.equal((await db.pool.query("SELECT count(*) FROM payments WHERE order_id=$1 AND kind='payment'",[adminOrderId])).rows[0].count,'1');
  assert.equal((await adminRequest('PATCH',`/orders/${adminOrderId}`,{version:3,shippingMinor:0})).statusCode,409);
});
test('processing/delivery transitions retain actor/time/previous value and protect shipped snapshots',async()=>{
  let v=3;
  assert.equal((await adminRequest('POST',`/orders/${adminOrderId}/status`,{version:v,kind:'processing',value:'assembled'})).statusCode,409);
  for(const value of ['confirmed','assembling','assembled']) {const r=await adminRequest('POST',`/orders/${adminOrderId}/status`,{version:v,kind:'processing',value},true);assert.equal(r.statusCode,200);v++;}
  assert.equal((await adminRequest('GET','/summary')).json().readyToShip,1);
  assert.equal((await adminRequest('GET','/orders?attention=ready_to_ship')).json().total,1);
  for(const value of ['prepared','shipped','in_transit','delivered']) {const r=await adminRequest('POST',`/orders/${adminOrderId}/status`,{version:v,kind:'delivery',value},true);assert.equal(r.statusCode,200);v++;}
  const detail=(await adminRequest('GET',`/orders/${adminOrderId}`)).json();
  assert.equal(detail.storefront_name,'Водный прополис');
  const transition=detail.events.find((e:{from_status:string;to_status:string})=>e.from_status==='shipped'&&e.to_status==='in_transit');assert(transition.actor&&transition.created_at);
  assert.equal(detail.payment_status,'paid');assert.equal(detail.processing_status,'assembled');
  assert.equal((await adminRequest('PATCH',`/orders/${adminOrderId}`,{version:v,shipping:{country:'Test',city:'New',address:'Forbidden rewrite'}})).statusCode,409);
  assert.equal((await adminRequest('POST',`/orders/${adminOrderId}/comments`,{body:'Synthetic operator comment'},true)).statusCode,200);
  assert.equal((await adminRequest('GET',`/orders/${adminOrderId}`)).json().comments.length,1);
  await assert.rejects(db.pool.query("UPDATE shipments SET address_snapshot='{}' WHERE order_id=$1",[adminOrderId]));
});
test('product prices and campaign configuration are owner-only and version checked',async()=>{
  const product=(await adminRequest('GET','/products')).json().find((p:{id:string})=>p.id===productId);
  const change={version:product.version,retailPriceMinor:49000,purchasePriceMinor:28000};
  assert.equal((await adminRequest('PATCH',`/products/${productId}/price`,change,true)).statusCode,403);
  assert.equal((await adminRequest('PATCH',`/products/${productId}/price`,change)).statusCode,200);
  assert.equal((await adminRequest('PATCH',`/products/${productId}/price`,change)).statusCode,409);
  assert.equal((await db.pool.query('SELECT sale_unit_price_minor FROM order_items WHERE order_id=$1',[adminOrderId])).rows[0].sale_unit_price_minor,'47000');
  const next={name:'Admin fixture',startsAt:new Date(Date.now()+86400000).toISOString(),endsAt:new Date(Date.now()+172800000).toISOString(),active:false,productIds:[productId],rules:[{minQuantity:6,discountBps:1000}]};
  assert.equal((await adminRequest('POST','/promotions',next,true)).statusCode,403);
  const created=await adminRequest('POST','/promotions',next);assert.equal(created.statusCode,200);
  assert.equal((await adminRequest('PUT',`/promotions/${created.json().id}`,{...next,version:1})).statusCode,200);
  assert.equal((await adminRequest('PUT',`/promotions/${created.json().id}`,{...next,version:1})).statusCode,409);
  assert.equal((await adminRequest('GET','/audit',undefined,true)).statusCode,403);
  const log=(await adminRequest('GET','/audit')).json();assert(log.some((e:{action:string;actor:string})=>e.action==='order.payment.changed'&&e.actor==='owner@example.invalid'));
  assert(!JSON.stringify(log).includes('Synthetic passphrase'));
});
test('login throttling persists in PostgreSQL and revoked sessions fail',async()=>{
  for(let i=0;i<10;i++) assert.equal((await app.inject({method:'POST',url:adminBase+'/auth/login',remoteAddress:'192.0.2.5',headers:{origin:adminOrigin},payload:{email:'missing@example.invalid',password:'Wrong synthetic password'}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:adminBase+'/auth/login',remoteAddress:'192.0.2.5',headers:{origin:adminOrigin},payload:{email:'missing@example.invalid',password:'Wrong synthetic password'}})).statusCode,429);
  assert.equal((await adminRequest('POST','/auth/logout')).statusCode,200);
  assert.equal((await adminRequest('GET','/auth/me')).statusCode,401);
  await db.pool.query("UPDATE admin_users SET active=false WHERE email='manager@example.invalid'");
  assert.equal((await adminRequest('GET','/auth/me',undefined,true)).statusCode,401);
});

test('expired admin sessions and static path traversal are rejected',async()=>{
  await db.pool.query("UPDATE admin_users SET active=true WHERE email='manager@example.invalid'");
  const response=await app.inject({method:'POST',url:adminBase+'/auth/login',remoteAddress:'192.0.2.6',headers:{origin:adminOrigin},payload:{email:'manager@example.invalid',password:'Synthetic passphrase for tests only'}});
  assert.equal(response.statusCode,200);
  const cookie=String(response.headers['set-cookie']).split(';')[0]!;
  const raw=cookie.split('=')[1]!;
  await db.pool.query("UPDATE admin_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[digest(raw)]);
  assert.equal((await app.inject({url:adminBase+'/customers',headers:{cookie}})).statusCode,401);
  assert.equal((await app.inject({url:'/admin/%2e%2e/%2e%2e/package.json'})).statusCode,404);
});

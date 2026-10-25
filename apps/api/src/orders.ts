import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { transaction } from '../../../db/migrate.js';
import { quoteInTransaction, uuidPattern, validateItems, type Item } from './catalog.js';
import { DomainError } from './errors.js';

export type InternalOrderInput = {
  storefrontSlug: string; idempotencyKey: string; items: Item[];
  // Trusted result of email verification, NOT a client supplied HTTP property.
  verifiedEmail: { email: string; verifiedAt: Date };
  recipient: { firstName: string; lastName: string; phone: string };
  shipping: { country: string; city: string; address: string; postalCode?: string };
};

export function normalizePhone(value: string) {
  const digits = value.replace(/[\s()+-]/g, '');
  if (!/^[78]\d{10}$/.test(digits)) throw new DomainError('INVALID_PHONE');
  return `+7${digits.slice(1)}`;
}

function text(value: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new DomainError('INVALID_ORDER');
  return value.trim();
}

// Internal service only. No public order POST until verified checkout in stage 5.
export async function createOrder(pool: Pool, input: InternalOrderInput) {
  validateItems(input.items);
  if (!new RegExp(uuidPattern).test(input.idempotencyKey)) throw new DomainError('INVALID_IDEMPOTENCY_KEY');
  const email = text(input.verifiedEmail.email, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !Number.isFinite(+input.verifiedEmail.verifiedAt) ||
    input.verifiedEmail.verifiedAt > new Date()) throw new DomainError('EMAIL_NOT_VERIFIED');
  const recipient = { firstName: text(input.recipient.firstName, 100), lastName: text(input.recipient.lastName, 100),
    phone: normalizePhone(input.recipient.phone), email };
  const shipping = { country: text(input.shipping.country, 100), city: text(input.shipping.city, 150),
    address: text(input.shipping.address, 500), postalCode: input.shipping.postalCode?.trim() || null };
  if (shipping.postalCode && shipping.postalCode.length > 20) throw new DomainError('INVALID_ORDER');
  const items = input.items.map(i => ({ productId: i.productId.toLowerCase(), quantity: i.quantity })).sort((a,b) => a.productId.localeCompare(b.productId));
  const key = input.idempotencyKey.toLowerCase();
  const hash = createHash('sha256').update(JSON.stringify({ storefrontSlug: input.storefrontSlug, items, recipient, shipping })).digest('hex');
  return transaction(pool, async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('order:' || $1))", [key]);
    const previous = (await db.query('SELECT id, number, request_hash FROM orders WHERE idempotency_key=$1', [key])).rows[0];
    if (previous) {
      if (previous.request_hash !== hash) throw new DomainError('IDEMPOTENCY_CONFLICT', 409);
      return { id: previous.id as string, number: previous.number as string, replayed: true };
    }
    const calculated = await quoteInTransaction(db, input.storefrontSlug, items);
    await db.query("SELECT pg_advisory_xact_lock(hashtext('email:' || $1))", [email]);
    let customerId = (await db.query("SELECT customer_id FROM customer_contacts WHERE kind='email' AND normalized_value=$1 AND verified_at IS NOT NULL", [email])).rows[0]?.customer_id as string | undefined;
    if (!customerId) {
      customerId = (await db.query('INSERT INTO customers(first_name,last_name,acquired_storefront_id) VALUES ($1,$2,$3) RETURNING id',
        [recipient.firstName, recipient.lastName, calculated.storefrontId])).rows[0].id;
      await db.query("INSERT INTO customer_contacts(customer_id,kind,normalized_value,verified_at) VALUES ($1,'email',$2,$3)",
        [customerId, email, input.verifiedEmail.verifiedAt]);
      await db.query("INSERT INTO customer_contacts(customer_id,kind,normalized_value) VALUES ($1,'phone',$2)", [customerId, recipient.phone]);
    }
    const result = await db.query(`INSERT INTO orders(customer_id,storefront_id,idempotency_key,request_hash,
      items_subtotal_minor,discount_minor,items_total_minor,recipient_snapshot,shipping_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,number`,
      [customerId, calculated.storefrontId, key, hash, calculated.subtotalMinor, calculated.discountMinor,
        calculated.itemsTotalMinor, recipient, shipping]);
    const order = result.rows[0] as {id: string; number: string};
    for (const line of calculated.lines) {
      const bundle = ({1:'trial',3:'month',6:'two',9:'family'} as Record<number,string>)[line.quantity] ?? 'custom';
      await db.query(`INSERT INTO order_items(order_id,product_id,sku,name,quantity,list_unit_price_minor,
        sale_unit_price_minor,purchase_unit_price_minor,discount_minor,line_total_minor,promotion_snapshot,bundle_code)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [order.id,line.productId,line.sku,line.name,line.quantity,
        line.unitPriceMinor,line.saleUnitPriceMinor,line.purchaseUnitPriceMinor,line.discountMinor,line.totalMinor,line.promotion,bundle]);
    }
    await db.query("INSERT INTO order_events(order_id,event_type,to_status) VALUES ($1,'order.created','new')", [order.id]);
    await db.query(`INSERT INTO notification_events(order_id,customer_id,event_type,dedup_key,payload)
      VALUES ($1,$2,'order.created',$3,$4)`, [order.id,customerId,`order.created:${order.id}`,{orderId: order.id}]);
    return { ...order, replayed: false };
  });
}

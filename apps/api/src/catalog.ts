import type { Pool, PoolClient } from 'pg';
import { transaction } from '../../../db/migrate.js';
import { DomainError } from './errors.js';
import { priceLine, type Campaign } from './pricing.js';

type Queryable = Pool | PoolClient;
export type Item = { productId: string; quantity: number };
export const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export async function storefront(db: Queryable, slug: string) {
  const result = await db.query('SELECT id, slug, domain, name, allowed_origins FROM storefronts WHERE slug=$1 AND active', [slug]);
  if (!result.rows[0]) throw new DomainError('STOREFRONT_NOT_FOUND', 404);
  return result.rows[0] as {id: string; slug: string; domain: string; name: string; allowed_origins: string[]};
}

export async function publicProducts(db: Queryable, storefrontId: string) {
  const result = await db.query(`SELECT p.id, p.sku, p.name, p.retail_price_minor, p.currency, p.volume_ml
    FROM products p JOIN storefront_products sp ON sp.product_id=p.id
    WHERE sp.storefront_id=$1 AND p.active ORDER BY p.sku`, [storefrontId]);
  return result.rows.map(p => ({ id: p.id as string, sku: p.sku as string, name: p.name as string,
    unitPriceMinor: Number(p.retail_price_minor), currency: 'RUB' as const, volumeMl: p.volume_ml as number | null }));
}

export function validateItems(items: Item[]) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) throw new DomainError('INVALID_ITEMS');
  const ids = new Set<string>();
  for (const item of items) {
    if (!new RegExp(uuidPattern).test(item.productId) || ids.has(item.productId.toLowerCase())) throw new DomainError('INVALID_ITEMS');
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 999) throw new DomainError('INVALID_QUANTITY');
    ids.add(item.productId.toLowerCase());
  }
}

export async function quoteInTransaction(db: PoolClient, slug: string, items: Item[]) {
  validateItems(items);
  const store = await storefront(db, slug);
  await db.query("SELECT pg_advisory_xact_lock_shared(hashtext('zdorovyakov:promotions'))");
  const now = (await db.query<{now: Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  const ids = items.map(i => i.productId.toLowerCase()).sort();
  const products = await db.query(`SELECT p.* FROM products p
    JOIN storefront_products sp ON sp.product_id=p.id
    WHERE sp.storefront_id=$1 AND p.id=ANY($2::uuid[]) AND p.active ORDER BY p.id FOR SHARE OF p`, [store.id, ids]);
  if (products.rows.length !== ids.length) throw new DomainError('PRODUCT_NOT_AVAILABLE', 404);
  const lines = [];
  for (const p of products.rows) {
    const promotions = await db.query(`SELECT pr.* FROM promotions pr JOIN promotion_products pp ON pp.promotion_id=pr.id
      WHERE pp.product_id=$1 AND pr.active AND pr.starts_at <= $2 AND pr.ends_at > $2`, [p.id, now]);
    if (promotions.rows.length > 1) throw new DomainError('PROMOTION_CONFIGURATION_CONFLICT', 503);
    const promo = promotions.rows[0];
    let campaign: Campaign | undefined;
    if (promo) {
      const rules = await db.query('SELECT min_quantity, discount_bps FROM promotion_rules WHERE promotion_id=$1', [promo.id]);
      campaign = { id: promo.id, name: promo.name, active: promo.active, startsAt: promo.starts_at, endsAt: promo.ends_at,
        rules: rules.rows.map(r => ({ minQuantity: r.min_quantity, discountBps: r.discount_bps })) };
    }
    const item = items.find(i => i.productId.toLowerCase() === p.id)!;
    lines.push({ productId: p.id as string, sku: p.sku as string, name: p.name as string,
      purchaseUnitPriceMinor: Number(p.purchase_price_minor), ...priceLine(Number(p.retail_price_minor), item.quantity, campaign, now) });
  }
  const subtotalMinor = lines.reduce((sum, l) => sum + l.subtotalMinor, 0);
  const discountMinor = lines.reduce((sum, l) => sum + l.discountMinor, 0);
  return { storefrontId: store.id, currency: 'RUB' as const, calculatedAt: now.toISOString(), lines,
    subtotalMinor, discountMinor, itemsTotalMinor: subtotalMinor-discountMinor,
    shippingMinor: null, totalMinor: null, deliveryMessage: 'Стоимость доставки уточняется' };
}

export function publicQuote(quote: Awaited<ReturnType<typeof quoteInTransaction>>) {
  return { storefrontId: quote.storefrontId, currency: quote.currency, calculatedAt: quote.calculatedAt,
    lines: quote.lines.map(l => ({ productId: l.productId, sku: l.sku, name: l.name, quantity: l.quantity,
      unitPriceMinor: l.unitPriceMinor, saleUnitPriceMinor: l.saleUnitPriceMinor, discountBps: l.discountBps,
      subtotalMinor: l.subtotalMinor, discountMinor: l.discountMinor, totalMinor: l.totalMinor, promotion: l.promotion })),
    subtotalMinor: quote.subtotalMinor, discountMinor: quote.discountMinor, itemsTotalMinor: quote.itemsTotalMinor,
    shippingMinor: null, totalMinor: null, deliveryMessage: quote.deliveryMessage };
}

export async function quote(pool: Pool, slug: string, items: Item[]) {
  return publicQuote(await transaction(pool, client => quoteInTransaction(client, slug, items)));
}

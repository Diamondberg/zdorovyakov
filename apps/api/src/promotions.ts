import type { Pool } from 'pg';
import { transaction } from '../../../db/migrate.js';
import { DomainError } from './errors.js';
import { uuidPattern } from './catalog.js';
import type { Rule } from './pricing.js';

// Trusted internal operation; never registered as an anonymous HTTP route.
export async function savePromotion(pool: Pool, input: {
  id?: string; name: string; startsAt: Date; endsAt: Date; active: boolean; productIds: string[]; rules: Rule[];
}, context?:{actorId:string;expectedVersion?:number}) {
  if (!input.name.trim() || input.name.length > 200 || !Number.isFinite(+input.startsAt) ||
    !Number.isFinite(+input.endsAt) || input.endsAt <= input.startsAt ||
    !input.productIds.length || new Set(input.productIds).size !== input.productIds.length ||
    input.productIds.some(id => !new RegExp(uuidPattern).test(id)) ||
    !input.rules.length || new Set(input.rules.map(r => r.minQuantity)).size !== input.rules.length ||
    input.rules.some(r => !Number.isInteger(r.minQuantity) || r.minQuantity < 1 || r.minQuantity > 999 ||
      !Number.isInteger(r.discountBps) || r.discountBps < 0 || r.discountBps > 10000)) throw new DomainError('INVALID_PROMOTION');
  return transaction(pool, async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('zdorovyakov:promotions'))");
    if(input.id&&context) {
      const old=(await db.query('SELECT version FROM promotions WHERE id=$1 FOR UPDATE',[input.id])).rows[0];
      if(!old) throw new DomainError('PROMOTION_NOT_FOUND',404);
      if(old.version!==context.expectedVersion) throw new DomainError('VERSION_CONFLICT',409);
    }
    if (input.active) {
      const conflicts = await db.query(`SELECT p.id FROM promotions p JOIN promotion_products pp ON pp.promotion_id=p.id
        WHERE p.active AND ($1::uuid IS NULL OR p.id<>$1) AND pp.product_id=ANY($2::uuid[])
        AND p.starts_at < $4 AND p.ends_at > $3 LIMIT 1`, [input.id ?? null, input.productIds, input.startsAt, input.endsAt]);
      if (conflicts.rowCount) throw new DomainError('PROMOTION_OVERLAP', 409);
    }
    let id: string;
    if (input.id) {
      const result = await db.query('UPDATE promotions SET name=$2, starts_at=$3, ends_at=$4, active=$5,version=version+1 WHERE id=$1 RETURNING id',
        [input.id, input.name, input.startsAt, input.endsAt, input.active]);
      if (!result.rows[0]) throw new DomainError('PROMOTION_NOT_FOUND', 404);
      id = result.rows[0].id;
      await db.query('DELETE FROM promotion_products WHERE promotion_id=$1', [id]);
      await db.query('DELETE FROM promotion_rules WHERE promotion_id=$1', [id]);
    } else {
      id = (await db.query('INSERT INTO promotions(name, starts_at, ends_at, active) VALUES ($1,$2,$3,$4) RETURNING id',
        [input.name, input.startsAt, input.endsAt, input.active])).rows[0].id;
    }
    for (const productId of input.productIds) await db.query('INSERT INTO promotion_products VALUES ($1,$2)', [id, productId]);
    for (const rule of input.rules) await db.query('INSERT INTO promotion_rules(promotion_id,min_quantity,discount_bps) VALUES ($1,$2,$3)',
      [id, rule.minQuantity, rule.discountBps]);
    await db.query("INSERT INTO audit_logs(admin_id,action,entity_type,entity_id,redacted_changes) VALUES ($2,'promotion.saved','promotion',$1,$3)", [id,context?.actorId??null,{active:input.active,startsAt:input.startsAt,endsAt:input.endsAt,rules:input.rules,productIds:input.productIds}]);
    return id;
  });
}

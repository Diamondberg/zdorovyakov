import { DomainError } from './errors.js';

export const MAX_QUANTITY = 999;
export type Rule = { minQuantity: number; discountBps: number };
export type Campaign = { id: string; name: string; startsAt: Date; endsAt: Date; active: boolean; rules: Rule[] };

export function priceLine(unitPriceMinor: number, quantity: number, campaign?: Campaign, now = new Date()) {
  if (!Number.isSafeInteger(unitPriceMinor) || unitPriceMinor < 0 || unitPriceMinor > 100000000) throw new DomainError('INVALID_PRICE');
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) throw new DomainError('INVALID_QUANTITY');
  const enabled = campaign && campaign.active && now >= campaign.startsAt && now < campaign.endsAt;
  const rule = enabled ? [...campaign.rules].sort((a,b) => b.minQuantity-a.minQuantity).find(r => quantity >= r.minQuantity) : undefined;
  const discountBps = rule?.discountBps ?? 0;
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > 10000) throw new DomainError('INVALID_DISCOUNT');
  // Round each unit half up to the nearest kopeck; then multiply by quantity.
  // BigInt makes the rounding rule explicit and independent from binary floats.
  const saleUnitPriceMinor = Number((BigInt(unitPriceMinor) * BigInt(10000 - discountBps) + 5000n) / 10000n);
  const subtotalMinor = unitPriceMinor * quantity;
  const totalMinor = saleUnitPriceMinor * quantity;
  return { quantity, unitPriceMinor, saleUnitPriceMinor, discountBps, subtotalMinor,
    discountMinor: subtotalMinor - totalMinor, totalMinor,
    promotion: enabled ? { id: campaign.id, name: campaign.name, startsAt: campaign.startsAt.toISOString(), endsAt: campaign.endsAt.toISOString() } : null };
}

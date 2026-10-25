import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceLine, type Campaign } from '../apps/api/src/pricing.js';
import { normalizePhone } from '../apps/api/src/orders.js';

const now = new Date('2026-10-25T00:00:00Z');
const promo:Campaign = {id:'test',name:'Test only',active:true,startsAt:now,endsAt:new Date(+now+60000),
  rules:[{minQuantity:6,discountBps:1000},{minQuantity:9,discountBps:1500}]};
for (const [quantity,total] of [[1,47000],[3,141000],[5,235000],[6,253800],[8,338400],[9,359550],[10,399500]]) {
  test(`pricing ${quantity} bottles`, () => assert.equal(priceLine(47000,quantity!,promo,now).totalMinor,total));
}
test('promotion boundaries: inclusive start, exclusive end, inactive and absent', () => {
  assert.equal(priceLine(47000,9,promo,new Date(+now-1)).totalMinor,423000);
  assert.equal(priceLine(47000,9,promo,now).totalMinor,359550);
  assert.equal(priceLine(47000,9,promo,promo.endsAt).totalMinor,423000);
  assert.equal(priceLine(47000,9,{...promo,active:false},now).totalMinor,423000);
  assert.equal(priceLine(47000,9).totalMinor,423000);
});
test('unit half-up rounding in kopecks is deterministic', () => {
  assert.equal(priceLine(1,9,{...promo,rules:[{minQuantity:1,discountBps:5000}]},now).totalMinor,9);
});
test('reject malformed quantities and amounts', () => {
  for (const n of [0,-1,1.5,1000,NaN,Infinity]) assert.throws(() => priceLine(47000,n));
  for (const n of [-1,0.5,Number.MAX_SAFE_INTEGER,NaN]) assert.throws(() => priceLine(n,1));
});
test('normalize Russian phone without claiming SMS verification', () => {
  assert.equal(normalizePhone('8 (999) 111-22-33'),'+79991112233');
  assert.equal(normalizePhone('+7 999 111 22 33'),'+79991112233');
  for(const value of ['7999','+19991112233','79991112233abc']) assert.throws(() => normalizePhone(value));
});

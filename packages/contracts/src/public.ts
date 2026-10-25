// Public schemas are explicit field allowlists, never the database row structure.
const money = { type: 'integer', minimum: 0 };
const nullableMoney = { anyOf: [money, { type: 'null' }] };
const string = { type: 'string' };
export const storefrontSchema = {
  type: 'object', additionalProperties: false, required: ['id','slug','domain','name'],
  properties: { id: string, slug: string, domain: string, name: string },
};
export const productSchema = {
  type: 'object', additionalProperties: false,
  required: ['id','sku','name','unitPriceMinor','currency','volumeMl'],
  properties: { id: string, sku: string, name: string, unitPriceMinor: money, currency: {const:'RUB', type:'string'},
    volumeMl: { anyOf: [{type:'integer'}, {type:'null'}] } },
};
const promotionSchema = { anyOf: [{ type:'null' }, {
  type:'object', additionalProperties: false, required:['id','name','startsAt','endsAt'],
  properties: { id:string, name:string, startsAt:string, endsAt:string },
}] };
export const quoteSchema = {
  type:'object', additionalProperties:false,
  required:['storefrontId','currency','calculatedAt','lines','subtotalMinor','discountMinor','itemsTotalMinor','shippingMinor','totalMinor','deliveryMessage'],
  properties: { storefrontId:string, currency:{type:'string',const:'RUB'}, calculatedAt:string,
    lines:{ type:'array', items:{type:'object',additionalProperties:false,
      required:['productId','sku','name','quantity','unitPriceMinor','saleUnitPriceMinor','discountBps','subtotalMinor','discountMinor','totalMinor','promotion'],
      properties:{ productId:string,sku:string,name:string,quantity:{type:'integer'},unitPriceMinor:money,
        saleUnitPriceMinor:money,discountBps:{type:'integer'},subtotalMinor:money,discountMinor:money,totalMinor:money,promotion:promotionSchema } } },
    subtotalMinor:money,discountMinor:money,itemsTotalMinor:money,shippingMinor:nullableMoney,totalMinor:nullableMoney,deliveryMessage:string },
};

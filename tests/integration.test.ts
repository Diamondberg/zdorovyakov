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
  assert.deepEqual(await migrate(db.pool),['001_core.sql','002_initial_catalog.sql']);
  productId=(await db.pool.query('SELECT id FROM products')).rows[0].id;
  app=await buildApp(db.pool);
}, {timeout:120000});
after(async () => { await app?.close(); await db?.pool.end(); await db?.postgres.stop(); });

test('migration repeat/concurrency, checksum and failure rollback',async () => {
  assert.deepEqual(await migrate(db.pool),[]);
  assert.deepEqual(await Promise.all([migrate(db.pool),migrate(db.pool)]),[[],[]]);
  const scratch=await mkdtemp(join(tmpdir(),'zdorovyakov-migrations-'));
  for(const name of await readdir(migrationsDir)) if(name.endsWith('.sql')) await copyFile(join(migrationsDir,name),join(scratch,name));
  await writeFile(join(scratch,'003_broken.sql'),'CREATE TABLE rollback_probe (id int); SELECT * FROM missing_table_for_test;');
  await assert.rejects(migrate(db.pool,scratch));
  assert.equal((await db.pool.query("SELECT to_regclass('rollback_probe') AS value")).rows[0].value,null);
  assert.equal((await db.pool.query('SELECT count(*) FROM schema_migrations')).rows[0].count,'2');
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

import {randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {testPostgres} from '../tests/helpers/postgres.js';
import {migrate} from '../db/migrate.js';
import {passwordHash} from '../apps/api/src/admin/auth.js';
import {buildApp} from '../apps/api/src/app.js';
import {createOrder} from '../apps/api/src/orders.js';
const db=await testPostgres();await migrate(db.pool);
const password=randomBytes(18).toString('hex');const email='preview@example.invalid';
await db.pool.query("INSERT INTO admin_users(email,password_hash,role) VALUES ($1,$2,'owner')",[email,await passwordHash(password)]);
const product=(await db.pool.query('SELECT id FROM products LIMIT 1')).rows[0];
await createOrder(db.pool,{storefrontSlug:'vodny-propolis',idempotencyKey:crypto.randomUUID(),items:[{productId:product.id,quantity:6}],
  verifiedEmail:{email:'synthetic-preview@example.invalid',verifiedAt:new Date(Date.now()-1000)},recipient:{firstName:'Тестовый',lastName:'Покупатель',phone:'+79990000000'},shipping:{country:'Тест',city:'Тестовый город',address:'Условный адрес'}});
await mkdir('tmp',{recursive:true});await writeFile('tmp/preview-login.json',JSON.stringify({email,password}),{mode:0o600});
const app=await buildApp(db.pool,{adminOrigin:'http://127.0.0.1:5187',secureCookies:false});
await app.listen({host:'127.0.0.1',port:5187});
console.log('Local QA preview: http://127.0.0.1:5187/admin/ — synthetic data, ephemeral database, credentials in ignored tmp/preview-login.json.');
let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await app.close();await db.pool.end();await db.postgres.stop();};
process.once('SIGINT',()=>{void stop();});process.once('SIGTERM',()=>{void stop();});

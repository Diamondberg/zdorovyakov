import pg from 'pg';
import { passwordHash } from '../apps/api/src/admin/auth.js';
import { transaction } from '../db/migrate.js';
const url=process.env.DATABASE_URL;
const email=process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password=process.env.ADMIN_BOOTSTRAP_PASSWORD;
if(process.env.NODE_ENV==='production'||!url||!['127.0.0.1','localhost'].includes(new URL(url).hostname)) throw new Error('This bootstrap command is local development only');
if(!email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!password) throw new Error('Set ADMIN_EMAIL and ADMIN_BOOTSTRAP_PASSWORD in a local ignored env file');
const hash=await passwordHash(password);
const pool=new pg.Pool({connectionString:url});
try {
  await transaction(pool,async db=>{
    await db.query("SELECT pg_advisory_xact_lock(hashtext('admin:bootstrap'))");
    if((await db.query('SELECT 1 FROM admin_users LIMIT 1')).rowCount) throw new Error('Administrator already exists; bootstrap does not replace users');
    const row=(await db.query("INSERT INTO admin_users(email,password_hash,role) VALUES ($1,$2,'owner') RETURNING id",[email,hash])).rows[0];
    await db.query("INSERT INTO audit_logs(admin_id,action,entity_type,entity_id) VALUES ($1,'admin.created','admin',$1)",[row.id]);
  });console.log('Local owner created. Remove bootstrap password from local env after use.');
} catch {console.error('Admin bootstrap failed; no credentials logged. Existing users are not overwritten.');process.exitCode=1;}
finally {await pool.end();}

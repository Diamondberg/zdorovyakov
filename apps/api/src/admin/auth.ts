import { createHash,randomBytes,scrypt,timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import type { FastifyRequest } from 'fastify';
import { transaction } from '../../../../db/migrate.js';
import { DomainError } from '../errors.js';

export type Actor={id:string;email:string;role:'owner'|'manager'};
export const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
export const csrfFor=(token:string)=>digest(`csrf:${token}`);
export async function passwordHash(password:string) {
  if(password.length<14||password.length>256) throw new DomainError('PASSWORD_LENGTH');
  const salt=randomBytes(16).toString('hex');
  const key=await new Promise<Buffer>((resolve,reject)=>scrypt(password,salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024},(e,k)=>e?reject(e):resolve(k)));
  return `scrypt$32768$8$3$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password:string,hash:string) {
  const match=/^scrypt\$32768\$8\$3\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(hash);
  if(!match||password.length>256) return false;
  const key=await new Promise<Buffer>((resolve,reject)=>scrypt(password,match[1]!,64,{N:32768,r:8,p:3,maxmem:64*1024*1024},(e,k)=>e?reject(e):resolve(k)));
  return timingSafeEqual(key,Buffer.from(match[2]!,'hex'));
}
let dummy:Promise<string>|undefined;
async function consume(pool:Pool,scope:string,key:string,max:number) {
  const result=await pool.query(`INSERT INTO rate_limit_buckets(scope,key_hash,window_start,count,expires_at)
    VALUES ($1,$2,date_bin('15 minutes',clock_timestamp(),'2000-01-01'::timestamptz),1,clock_timestamp()+interval '30 minutes')
    ON CONFLICT(scope,key_hash,window_start) DO UPDATE SET count=rate_limit_buckets.count+1 RETURNING count`,[scope,digest(key)]);
  if(result.rows[0].count>max) throw new DomainError('LOGIN_RATE_LIMITED',429);
}
export async function login(pool:Pool,email:string,password:string,ip:string,previous?:string) {
  email=email.trim().toLowerCase();
  await consume(pool,'admin-login-ip',ip,20); await consume(pool,'admin-login-email',email,10);
  const row=(await pool.query('SELECT id,email,role,password_hash FROM admin_users WHERE lower(email)=$1 AND active',[email])).rows[0];
  dummy??=passwordHash(randomBytes(32).toString('hex'));
  if(!await verifyPassword(password,row?.password_hash??await dummy)||!row) throw new DomainError('INVALID_CREDENTIALS',401);
  const token=randomBytes(32).toString('hex');
  await transaction(pool,async db=>{
    if(previous&&/^[a-f0-9]{64}$/.test(previous)) await db.query('UPDATE admin_sessions SET revoked_at=now() WHERE token_hash=$1',[digest(previous)]);
    await db.query("INSERT INTO admin_sessions(token_hash,admin_id,expires_at) VALUES ($1,$2,now()+interval '8 hours')",[digest(token),row.id]);
    await db.query("INSERT INTO audit_logs(admin_id,action,entity_type,entity_id) VALUES ($1,'admin.login','admin',$1)",[row.id]);
  });
  return {token,actor:{id:row.id,email:row.email,role:row.role} as Actor,csrfToken:csrfFor(token)};
}
export async function session(pool:Pool,token?:string):Promise<Actor> {
  if(!token||!/^[a-f0-9]{64}$/.test(token)) throw new DomainError('UNAUTHENTICATED',401);
  const row=(await pool.query(`SELECT a.id,a.email,a.role FROM admin_sessions s JOIN admin_users a ON a.id=s.admin_id
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND a.active`,[digest(token)])).rows[0];
  if(!row) throw new DomainError('UNAUTHENTICATED',401);
  return row as Actor;
}
export function requireCsrf(request:FastifyRequest,token:string) {
  const header=request.headers['x-csrf-token'];
  if(typeof header!=='string'||!/^[a-f0-9]{64}$/.test(header)||!timingSafeEqual(Buffer.from(header,'hex'),Buffer.from(csrfFor(token),'hex'))) throw new DomainError('CSRF_REJECTED',403);
}
export function owner(actor:Actor) {if(actor.role!=='owner') throw new DomainError('FORBIDDEN',403);}

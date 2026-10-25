import { PostgresCluster } from '../../scripts/postgres-cluster.js';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import pg from 'pg';

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve,reject) => { socket.once('error',reject); socket.listen(0,'127.0.0.1',resolve); });
  const port = (socket.address() as {port:number}).port;
  await new Promise<void>((resolve,reject) => socket.close(e => e ? reject(e) : resolve()));
  return port;
}

export async function testPostgres() {
  if(process.env.TEST_DATABASE_URL) {
    const url=new URL(process.env.TEST_DATABASE_URL);
    if(url.pathname!=='/zdorovyakov_test' || !['127.0.0.1','localhost'].includes(url.hostname)) {
      throw new Error('TEST_DATABASE_URL must target a fresh loopback database named zdorovyakov_test');
    }
    const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:10,connectionTimeoutMillis:5000,statement_timeout:10000});
    const tables=await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    if(tables.rowCount) { await pool.end(); throw new Error('Integration tests require a fresh disposable database; existing tables detected'); }
    return {pool,postgres:{stop:async()=>{}},directory:''};
  }
  const directory = await mkdtemp(join(tmpdir(),'zdorovyakov-test-'));
  const port = await freePort();
  const password = randomBytes(32).toString('hex');
  const postgres = new PostgresCluster({directory,password,port});
  try { await postgres.initialise(); await postgres.start(); }
  catch(error) { await postgres.stop(); throw error; }
  const pool = new pg.Pool({host:'127.0.0.1',port,user:'postgres',password,database:'postgres',max:10,
    connectionTimeoutMillis:5000,statement_timeout:10000});
  return {pool,postgres,directory};
}

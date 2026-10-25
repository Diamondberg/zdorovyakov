import { PostgresCluster } from './postgres-cluster.js';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

if (process.env.NODE_ENV === 'production') throw new Error('Local database helper is development only');
const directory=resolve('tmp/local-postgres');
const configPath=resolve('tmp/local-db.json');
await mkdir(resolve('tmp'),{recursive:true});
let config:{password:string;port:number};
let fresh=false;
try { config=JSON.parse(await readFile(configPath,'utf8')); }
catch(error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  config={password:randomBytes(32).toString('hex'),port:55432}; fresh=true;
  await writeFile(configPath,JSON.stringify(config),{flag:'wx',mode:0o600});
}
const db=new PostgresCluster({directory,password:config.password,port:config.port});
if(fresh) await db.initialise();
await db.start();
await writeFile(resolve('tmp/local-db.env'),`DATABASE_URL=postgresql://postgres:${config.password}@127.0.0.1:${config.port}/postgres\n`,{mode:0o600});
console.log('PostgreSQL is listening on 127.0.0.1:55432. Credentials saved in ignored tmp/local-db.env.');
console.log('Next: npm run db:migrate, then npm run dev. Stop with Ctrl+C; local data is retained.');
const stop=async () => { await db.stop(); };
process.once('SIGINT',()=>{void stop();});
process.once('SIGTERM',()=>{void stop();});

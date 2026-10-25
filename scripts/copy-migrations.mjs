import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist/db/migrations',{recursive:true});
await cp('db/migrations','dist/db/migrations',{recursive:true});

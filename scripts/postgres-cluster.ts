import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';

const run = promisify(execFile);
async function nativePath(path:string) {
  if(process.platform!=='win32') return path;
  const result=await run('powershell.exe',['-NoProfile','-NonInteractive','-File',resolve('scripts/windows-short-path.ps1'),'-LiteralPath',path],{windowsHide:true});
  const short=result.stdout.trim();
  if(!short || /[^\x00-\x7F]/.test(short)) throw new Error('PostgreSQL requires an ASCII native path on Windows. Enable short paths or use an ASCII project directory.');
  return short;
}

// Local-only native PostgreSQL. No services, OS users, permissions or PATH changes.
export class PostgresCluster {
  private child?:ChildProcess;
  private binaries?:{initdb:string;postgres:string;pg_ctl:string};
  constructor(private options:{directory:string;port:number;password:string}) {}
  private async paths() {
    if(!this.binaries) {
      const platform=process.platform==='win32'?'windows':process.platform;
      const binaryPackage=await import(`@embedded-postgres/${platform}-${process.arch}`);
      this.binaries={initdb:await nativePath(binaryPackage.initdb),postgres:await nativePath(binaryPackage.postgres),pg_ctl:await nativePath(binaryPackage.pg_ctl)};
    }
    return this.binaries;
  }
  async initialise() {
    const bin=await this.paths();
    await mkdir(this.options.directory,{recursive:true});
    const directory=await nativePath(this.options.directory);
    const passwordFile=join(this.options.directory,'init-password');
    await writeFile(passwordFile,this.options.password+'\n',{mode:0o600,flag:'wx'});
    try {
      // initdb needs an empty data subdirectory; password lives in the parent.
      await run(bin.initdb,['-D',join(directory,'data'),'--encoding=UTF8','--locale=C','--lc-messages=C',
        '--auth=scram-sha-256','--username=postgres',`--pwfile=${await nativePath(passwordFile)}`],{windowsHide:true,timeout:60000});
    } finally { await unlink(passwordFile); }
  }
  async start() {
    const bin=await this.paths();
    const directory=await nativePath(join(this.options.directory,'data'));
    const child=spawn(bin.postgres,['-D',directory,'-h','127.0.0.1','-p',String(this.options.port)],{windowsHide:true,stdio:'ignore'});
    this.child=child;
    let failed=false;
    child.once('error',()=>{failed=true;});
    child.once('exit',()=>{failed=true;});
    for(let i=0;i<100;i++) {
      if(failed) throw new Error('Local PostgreSQL failed to start');
      const client=new pg.Client({host:'127.0.0.1',port:this.options.port,user:'postgres',password:this.options.password,database:'postgres',connectionTimeoutMillis:500});
      try { await client.connect(); await client.query('SELECT 1'); await client.end(); return; }
      catch { await client.end().catch(()=>{}); await new Promise(r=>setTimeout(r,100)); }
    }
    throw new Error('Timed out starting local PostgreSQL');
  }
  async stop() {
    if(!this.child || this.child.exitCode!==null) return;
    const bin=await this.paths();
    await run(bin.pg_ctl,['-D',await nativePath(join(this.options.directory,'data')),'stop','-m','fast','-w','-t','15'],{windowsHide:true,timeout:20000});
    this.child=undefined;
  }
}

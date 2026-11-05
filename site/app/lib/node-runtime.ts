import 'server-only';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, chmodSync, lstatSync } from 'node:fs';
import { mkdir, open, readFile, link, unlink } from 'node:fs/promises';
import path from 'node:path';

// Persisted data is outside the application checkout and owned by the service account.
function dataDir():string {
 const root=process.env.ALLOCATION_DATA_DIR;
 if (!root || !path.isAbsolute(root)) throw new Error('ALLOCATION_DATA_DIR must be an absolute directory.');
 return root;
}
let connection:DatabaseSync|undefined;
type Primitive = string|number|bigint|null|Uint8Array;
class LocalStatement {
  readonly sql:string;
  readonly args:Primitive[];
  constructor(sql:string,args:Primitive[]=[]){this.sql=sql;this.args=args;}
  bind(...args:Primitive[]) { return new LocalStatement(this.sql,args); }
  first<T>():Promise<T|null> { return Promise.resolve((database().prepare(this.sql).get(...this.args) as T|undefined) ?? null); }
  all<T>():Promise<{results:T[]}> { return Promise.resolve({results:database().prepare(this.sql).all(...this.args) as T[]}); }
  run():Promise<{success:boolean;meta:{changes:number}}> {
    const out=database().prepare(this.sql).run(...this.args);
    return Promise.resolve({success:true,meta:{changes:Number(out.changes)}});
  }
}
function database():DatabaseSync {
 if(connection)return connection;
 const DATA_DIR=dataDir();
 mkdirSync(DATA_DIR,{recursive:true,mode:0o700});
 const db=new DatabaseSync(path.join(DATA_DIR,'ledger.sqlite'));
 db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
 // Migrations are schema-only, checksum verified, and applied as one locked transaction.
 db.exec('BEGIN IMMEDIATE');
 try {
   db.exec('CREATE TABLE IF NOT EXISTS local_schema_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)');
   const dir=path.join(process.cwd(),'drizzle');
   const files=readdirSync(dir).filter(x=>/^\d{4}_[a-z0-9_]+\.sql$/.test(x)).sort();
   if(files.length===0)throw new Error('Missing database migrations.');
   for(const name of files){
     const sql=readFileSync(path.join(dir,name),'utf8');
     const digest=createHash('sha256').update(sql).digest('hex');
     const old=db.prepare('SELECT sha256 FROM local_schema_migrations WHERE name=?').get(name) as {sha256:string}|undefined;
     if(old && old.sha256!==digest)throw new Error(`Migration changed: ${name}`);
     if(!old){db.exec(sql);db.prepare('INSERT INTO local_schema_migrations(name,sha256) VALUES(?,?)').run(name,digest);}
   }
   db.exec('COMMIT');
 } catch(e){try{db.exec('ROLLBACK');}finally{db.close();}throw e;}
 try{chmodSync(path.join(DATA_DIR,'ledger.sqlite'),0o600);}catch{}
 connection=db;return db;
}
const localDB={
 prepare(sql:string){return new LocalStatement(sql);},
 async batch(statements:LocalStatement[]){
   const db=database();db.exec('BEGIN IMMEDIATE');
   try{
     const results=statements.map(s=>{const r=db.prepare(s.sql).run(...s.args);return {success:true,meta:{changes:Number(r.changes)}};});
     db.exec('COMMIT');return results;
   } catch(e){db.exec('ROLLBACK');throw e;}
 }
};

function filePath(key:string){
 if(!key||key.startsWith('/')||key.includes('\\')||key.split('/').some(x=>!x||x==='.'||x==='..'))throw new Error('Invalid object key.');
 return path.join(dataDir(),'objects',...key.split('/'));
}
async function getObject(key:string){
 let raw:Buffer;
 try{raw=await readFile(filePath(key));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
 if(raw.length<4)throw new Error('Invalid stored object.');
 const length=raw.readUInt32BE(0);
 if(length>4096||raw.length<4+length)throw new Error('Invalid stored metadata.');
 const meta=JSON.parse(raw.subarray(4,4+length).toString('utf8')) as {contentType:string};
 const contents=raw.subarray(4+length);
 return {size:contents.byteLength,httpMetadata:{contentType:meta.contentType},arrayBuffer:async()=>contents.buffer.slice(contents.byteOffset,contents.byteOffset+contents.byteLength)};
}
const localBucket={
 async get(key:string){return getObject(key);},
 async put(key:string,value:Uint8Array,options:{httpMetadata:{contentType:string}}){
   const target=filePath(key),root=dataDir();
   await mkdir(root,{recursive:true,mode:0o700});
   const relative=path.relative(root,path.dirname(target));
   let parent=root;
   for(const part of relative.split(path.sep).filter(Boolean)){
    const next=path.join(parent,part);
    try{
     await mkdir(next,{mode:0o700});
     if(process.platform!=='win32'){const dir=await open(parent,'r');try{await dir.sync();}finally{await dir.close();}}
    }catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    parent=next;
   }
   const meta=Buffer.from(JSON.stringify({contentType:options.httpMetadata.contentType}),'utf8');
   const header=Buffer.alloc(4);header.writeUInt32BE(meta.length);
   const temporary=path.join(path.dirname(target),`.${randomUUID()}.tmp`);
   const fd=await open(temporary,'wx',0o600);
   try {await fd.writeFile(Buffer.concat([header,meta,Buffer.from(value)]));await fd.sync();}finally{await fd.close();}
   try{
    await link(temporary,target);
    if(process.platform!=='win32'){
     // Persist the directory entry before a transaction records this object.
     const dir=await open(path.dirname(target),'r');
     try{await dir.sync();}finally{await dir.close();}
    }
    return {key};
   }
   catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')return null;throw e;}
   finally{await unlink(temporary);}
 }
};
function readHexSecret(environmentName:string):string|undefined{
  const file=process.env[environmentName];
  if(!file||!path.isAbsolute(file))return undefined;
  try{
    const info=lstatSync(file);
    if(!info.isFile()||info.isSymbolicLink()||info.size>1024)return undefined;
    if(process.platform!=='win32'&&((info.mode&0o077)!==0||(process.getuid&&info.uid!==process.getuid())))return undefined;
    const key=readFileSync(file,'utf8').trim();
    return /^[a-f0-9]{64,}$/i.test(key)?key:undefined;
  }catch{return undefined;}
}
export const env={
 DB:localDB as unknown as D1Database,
 BUCKET:localBucket as unknown as R2Bucket,
 get ALLOCATION_RATE_KEY(){return readHexSecret('ALLOCATION_RATE_KEY_FILE');},
 get ALLOCATION_SYNC_TOKEN(){return readHexSecret('ALLOCATION_SYNC_TOKEN_FILE');},
};

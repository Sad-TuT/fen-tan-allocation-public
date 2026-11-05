#!/usr/bin/env node
// Online SQLite snapshot + immutable object backup. No secrets directory is read.
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,readdir,lstat,copyFile,rename,rm,realpath,chmod,mkdtemp,open,unlink} from 'node:fs/promises';
import path from 'node:path';

const sha=b=>createHash('sha256').update(b).digest('hex');
const backupName=/^backup-\d{8}T\d{6}Z-[a-f\d]{8}$/;
const root=process.env.ALLOCATION_DATA_DIR;
const dest=process.env.ALLOCATION_BACKUP_DIR;
function absolute(v,n){if(!v||!path.isAbsolute(v))throw new Error(`${n} must be an absolute path`);return path.resolve(v);}
function safeKey(key){if(typeof key!=='string'||!key||key.startsWith('/')||key.includes('\\')||key.split('/').some(x=>!x||x==='.'||x==='..'))throw new Error('Unsafe object key');return key;}
function within(root,part){const resolved=path.resolve(root,...safeKey(part).split('/'));if(!resolved.startsWith(root+path.sep))throw new Error('Object escapes root');return resolved;}
async function privateDir(p){await mkdir(p,{recursive:true,mode:0o700});const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink())throw new Error('Directory is not a real directory');if(process.platform!=='win32'&&((process.getuid&&s.uid!==process.getuid())||(s.mode&0o077)))throw new Error('Backup directory must be owned by the service user and private (0700)');}
async function listFiles(dir,prefix=''){
 let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT'&&!prefix)return [];throw e;}
 const out=[];
 for(const e of entries){if(/^\.[a-f\d-]+\.tmp$/i.test(e.name))continue;const rel=prefix?`${prefix}/${e.name}`:e.name;safeKey(rel);if(e.isSymbolicLink())throw new Error('Symbolic links in object storage are forbidden');if(e.isDirectory())out.push(...await listFiles(path.join(dir,e.name),rel));else if(e.isFile())out.push(rel);else throw new Error('Unexpected object filesystem entry');}
 return out.sort();
}
async function syncFile(file){const f=await open(file,'r+');try{await f.sync();}finally{await f.close();}}
async function syncDirs(dir){if(process.platform==='win32')return;for(const e of await readdir(dir,{withFileTypes:true})){if(e.isSymbolicLink())throw new Error('Unexpected symlink in backup');if(e.isDirectory())await syncDirs(path.join(dir,e.name));}const f=await open(dir,'r');try{await f.sync();}finally{await f.close();}}
async function writeSynced(file,data){const f=await open(file,'wx',0o600);try{await f.writeFile(data);await f.sync();}finally{await f.close();}}
function objectBytes(raw){if(raw.length<4)throw new Error('Invalid object header');const n=raw.readUInt32BE(0);if(n>4096||raw.length<4+n)throw new Error('Invalid object metadata');const meta=JSON.parse(raw.subarray(4,4+n).toString('utf8'));if(typeof meta.contentType!=='string')throw new Error('Missing object type');return raw.subarray(4+n);}
function snapshotDb(source,target){const db=new DatabaseSync(source,{readOnly:true});try{db.exec('PRAGMA busy_timeout=5000');db.prepare('VACUUM INTO ?').run(target);}finally{db.close();}}
function inspectDb(file){
 const db=new DatabaseSync(file,{readOnly:true});
 try{
  const integrity=db.prepare('PRAGMA integrity_check').all();
  if(integrity.length!==1||Object.values(integrity[0])[0]!=='ok')throw new Error('SQLite integrity check failed');
  const foreign=db.prepare('PRAGMA foreign_key_check').all();
  if(foreign.length)throw new Error('SQLite foreign key check failed');
  // Older databases were created before the declarative foreign keys and
  // therefore need explicit orphan checks. These queries also keep backups
  // safe while a migrated database is being rolled forward.
  const orphanReviews=db.prepare(`SELECT r.id FROM allocation_reviews r
    LEFT JOIN allocation_batches b ON b.id=r.batch_id WHERE b.id IS NULL LIMIT 1`).get();
  if(orphanReviews)throw new Error(`SQLite orphan review: ${orphanReviews.id}`);
  const orphanWorkspace=db.prepare(`SELECT w.id FROM allocation_workspace w
    LEFT JOIN allocation_batches b ON b.id=w.last_batch_id
    WHERE w.last_batch_id IS NOT NULL AND b.id IS NULL LIMIT 1`).get();
  if(orphanWorkspace)throw new Error(`SQLite orphan workspace last_batch_id: ${orphanWorkspace.id}`);
  const orphanEvents=db.prepare(`SELECT e.id FROM allocation_events e
    LEFT JOIN allocation_batches b ON b.id=e.batch_id
    WHERE e.batch_id IS NOT NULL AND b.id IS NULL LIMIT 1`).get();
  if(orphanEvents)throw new Error(`SQLite orphan event: ${orphanEvents.id}`);
  const rows=[];
  for(const name of ['allocation_workspace','allocation_batches','allocation_reviews'])
   for(const x of db.prepare(`SELECT data_key FROM ${name} WHERE data_key IS NOT NULL`).all())rows.push(x.data_key);
  // The per-batch file workspace was introduced later than the shared ledger.
  // Keep backups compatible with pre-migration databases while validating every
  // immutable task snapshot once the table exists.
  if(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='processing_jobs'").get())
   for(const x of db.prepare('SELECT data_key FROM processing_jobs WHERE data_key IS NOT NULL').all())rows.push(x.data_key);
  return rows;
 }finally{db.close();}
}
async function validateReferences(dir){
 const keys=inspectDb(path.join(dir,'ledger.sqlite'));
 const objectRoot=path.join(dir,'objects');
 async function get(key){return objectBytes(await readFile(within(objectRoot,key)));}
 function find(x,out){if(!x||typeof x!=='object')return;if(!Array.isArray(x)){const candidate=typeof x.fileKey==='string'?x.fileKey:typeof x.key==='string'?x.key:null;const k=candidate&&/^(inputs|taxes|tax-overrides|batches|outputs|workspace|reviews|processing-jobs)\//.test(candidate)?candidate:null;if(k){if(typeof x.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(x.sha256))throw new Error(`Referenced object missing valid digest: ${k}`);out.push([safeKey(k),x.sha256.toLowerCase()]);}for(const v of Object.values(x))find(v,out);}else for(const v of x)find(v,out);}
 let checked=0;
 for(const key of keys){const bytes=await get(safeKey(key));let json;try{json=JSON.parse(bytes.toString('utf8'));}catch{throw new Error('Referenced state JSON cannot be decoded');}const refs=[];find(json,refs);const unique=new Map(refs);for(const [k,expected] of unique){if(sha(await get(k))!==expected)throw new Error(`Referenced object digest mismatch: ${k}`);checked++;}}
 return {stateObjects:keys.length,checks:checked};
}
async function makeManifest(dir){const files=['ledger.sqlite',...(await listFiles(path.join(dir,'objects'))).map(x=>`objects/${x}`)];const entries=[];for(const rel of files){const file=within(dir,rel);const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Invalid backup file');const bytes=await readFile(file);entries.push({path:rel,size:bytes.length,sha256:sha(bytes)});}return {version:1,createdAt:new Date().toISOString(),files:entries};}
async function verify(dir){
 const manifest=JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8'));
 if(manifest.version!==1||!Array.isArray(manifest.files))throw new Error('Invalid backup manifest');
 const actual=await makeManifest(dir);if(JSON.stringify(actual.files)!==JSON.stringify(manifest.files))throw new Error('Backup files do not match manifest');
 return {...await validateReferences(dir),files:actual.files.length};
}
async function copyTree(source,target){await privateDir(target);for(const rel of await listFiles(source)){const targetFile=within(target,rel);await privateDir(path.dirname(targetFile));const data=await readFile(within(source,rel));objectBytes(data);await writeSynced(targetFile,data);}}
async function create(){
 const data=absolute(root,'ALLOCATION_DATA_DIR'),destination=absolute(dest,'ALLOCATION_BACKUP_DIR');await privateDir(destination);
 const dataReal=await realpath(data),destReal=await realpath(destination);
 if(destReal===dataReal||destReal.startsWith(dataReal+path.sep)||dataReal.startsWith(destReal+path.sep))throw new Error('Backup and data directories must be separate');
 const src=path.join(dataReal,'ledger.sqlite'),st=await lstat(src);if(!st.isFile()||st.isSymbolicLink())throw new Error('Live database missing or unsafe');
 const keep=Number(process.env.ALLOCATION_BACKUP_KEEP??'7');if(!Number.isSafeInteger(keep)||keep<1||keep>365)throw new Error('ALLOCATION_BACKUP_KEEP must be 1..365');
 let lock;try{lock=await open(path.join(destReal,'.backup.lock'),'wx',0o600);}catch(e){if(e.code==='EEXIST')throw new Error('Another backup is running or a stale backup lock requires investigation');throw e;}
 try{
 const date=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');const name=`backup-${date}-${randomUUID().slice(0,8)}`;
 const temporary=path.join(destReal,`.${name}.tmp`),final=path.join(destReal,name);await privateDir(temporary);
 try{
  snapshotDb(src,path.join(temporary,'ledger.sqlite'));if(process.platform!=='win32')await chmod(path.join(temporary,'ledger.sqlite'),0o600);
  await copyTree(path.join(dataReal,'objects'),path.join(temporary,'objects'));
  const references=await validateReferences(temporary);const manifest=await makeManifest(temporary);await writeSynced(path.join(temporary,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  await verify(temporary);
  // Restore drill: reconstruct in a separate temporary directory and reverify.
  const restore=await mkdtemp(path.join(destReal,'.restore-check-'));try{await copyFile(path.join(temporary,'ledger.sqlite'),path.join(restore,'ledger.sqlite'));await copyTree(path.join(temporary,'objects'),path.join(restore,'objects'));await copyFile(path.join(temporary,'manifest.json'),path.join(restore,'manifest.json'));await verify(restore);}finally{await rm(restore,{recursive:true,force:true});}
  await syncFile(path.join(temporary,'ledger.sqlite'));await syncDirs(temporary);await rename(temporary,final);if(process.platform!=='win32'){const d=await open(destReal,'r');try{await d.sync();}finally{await d.close();}}
  const existing=await Promise.all((await readdir(destReal,{withFileTypes:true})).filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&backupName.test(e.name)).map(async e=>({name:e.name,mtime:(await lstat(path.join(destReal,e.name))).mtimeMs})));
  existing.sort((a,b)=>b.mtime-a.mtime||b.name.localeCompare(a.name));
  for(const old of existing.slice(keep)){const target=path.resolve(destReal,old.name);if(path.dirname(target)!==destReal||!backupName.test(path.basename(target)))throw new Error('Unsafe retention path');await rm(target,{recursive:true,force:false});}
  console.log(JSON.stringify({ok:true,backup:final,files:manifest.files.length,...references,restoreTest:'passed'}));
 }catch(e){try{await rm(temporary,{recursive:true,force:true});}catch{}throw e;}
 }finally{await lock.close();await unlink(path.join(destReal,'.backup.lock'));}
}
try{const mode=process.argv[2]??'create';if(mode==='create')await create();else if(mode==='verify'){const dir=absolute(process.argv[3],'backup directory');console.log(JSON.stringify({ok:true,...await verify(dir)}));}else throw new Error('Usage: allocation-backup.mjs [create|verify /path/to/backup]');}
catch(e){console.error(`BACKUP FAILED: ${e instanceof Error?e.message:'unknown error'}`);process.exitCode=1;}

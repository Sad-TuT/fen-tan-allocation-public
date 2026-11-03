import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';

registerHooks({resolve(specifier:string,context:any,next:any){if(specifier==='server-only')return {url:'data:text/javascript,export default {}',shortCircuit:true};return next(specifier,context);}});
const base=path.resolve('work-runtime-tests');
await import('node:fs/promises').then(fs=>fs.mkdir(base,{recursive:true}));
const root=await mkdtemp(path.join(base,'isolated-'));
process.env.ALLOCATION_DATA_DIR=root;
const {env}=await import(new URL('../app/lib/node-runtime.ts', import.meta.url).href);
function child(mode:string,id?:string):Promise<any>{
 return new Promise((resolve,reject)=>{
  const p=spawn(process.execPath,['--experimental-strip-types',path.resolve('tests/node-runtime-child.mjs'),mode,...(id?[id]:[])],{env:{...process.env,ALLOCATION_DATA_DIR:root},cwd:process.cwd()});
  let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);
  p.on('error',reject);p.on('close',code=>{if(code!==0)reject(new Error(err));else try{resolve(JSON.parse(out));}catch(e){reject(e);}});
 });
}
test('SQLite and private objects survive restart, transactions roll back, and version race has one winner',async()=>{
 try{
  await env.DB.prepare("INSERT INTO allocation_workspace(id,version,updated_at) VALUES('main',0,'now')").run();
  const opts={httpMetadata:{contentType:'application/octet-stream'}} as any;
  assert.ok(await env.BUCKET.put('evidence/nested/test.bin',new TextEncoder().encode('first'),opts));
  assert.equal(await env.BUCKET.put('evidence/nested/test.bin',new TextEncoder().encode('overwrite'),opts),null);
  assert.equal(Buffer.from(await (await env.BUCKET.get('evidence/nested/test.bin'))!.arrayBuffer()).toString(),'first');
  await assert.rejects(()=>env.BUCKET.put('../escape',new Uint8Array(),opts));
  await assert.rejects(()=>env.DB.batch([
   env.DB.prepare("UPDATE allocation_workspace SET version=7 WHERE id='main'"),
   env.DB.prepare("INSERT INTO allocation_workspace(id,version,updated_at) VALUES('main',0,'duplicate')"),
  ]));
  assert.equal((await env.DB.prepare("SELECT version FROM allocation_workspace WHERE id='main'").first())?.version,0);
  const before=await child('read');assert.deepEqual(before,{version:0,bytes:'first'});
  const races=await Promise.all([child('race','race-a'),child('race','race-b')]);
  assert.equal(races.reduce((n,r)=>n+r.changes,0),1);
  assert.equal(races.reduce((n,r)=>n+r.event,0),1);
  const after=await child('read');assert.deepEqual(after,{version:1,bytes:'first'});
  if(process.platform!=='win32'){
   assert.equal((await stat(path.join(root,'ledger.sqlite'))).mode & 0o077,0);
   assert.equal((await stat(path.join(root,'objects','evidence','nested','test.bin'))).mode & 0o077,0);
  }
 }finally{
  // The connection remains live for this process; Windows cannot remove it here.
  // The test path contains only isolated synthetic data and is ignored by Git.
 }
});

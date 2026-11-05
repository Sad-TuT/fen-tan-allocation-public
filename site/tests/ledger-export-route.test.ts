import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';

const token='a'.repeat(64);
(globalThis as any).__ledgerZipArgs=null;
registerHooks({resolve(specifier:string,context:any,next:any){
  if(context.parentURL?.endsWith('/api/ledger/export/route.ts')&&specifier==='../../../lib/node-runtime'){
    return {url:`data:text/javascript,export const env={get ALLOCATION_SYNC_TOKEN(){return '${token}'}}`,shortCircuit:true};
  }
  if(context.parentURL?.endsWith('/api/ledger/export/route.ts')&&specifier==='../../../lib/app-auth'){
    return {url:'data:text/javascript,export async function getAppUser(){return null}',shortCircuit:true};
  }
  if(context.parentURL?.endsWith('/api/ledger/export/route.ts')&&specifier==='../../../lib/persistence'){
    return {url:'data:text/javascript,export async function loadWorkspace(){return {version:12,state:{sources:[{id:"s1",name:"第一来源",priority:1,fileName:"第一来源.xlsx",fileKey:"inputs/s1.xlsx",sha256:"source-hash",originalCents:1000,rows:[{amountCents:600,historicUsed:false},{amountCents:400,historicUsed:false}],history:[]}],taxFile:null,taxOverrideFile:null,productHistory:[{batchId:"b1",product:"旧商品"}]}}};export async function readFile(){return {bytes:new TextEncoder().encode("source-bytes")}}',shortCircuit:true};
  }
  if(context.parentURL?.endsWith('/api/ledger/export/route.ts')&&specifier==='../../../lib/spreadsheets'){
    return {url:'data:text/javascript,export async function digest(value){const s=typeof value==="string"?value:new TextDecoder().decode(value);return s.includes("source-bytes")?"source-hash":"ledger-hash"};export async function zipFiles(folder,files,manifest){globalThis.__ledgerZipArgs={folder,files,manifest};return new Uint8Array([80,75,5,6,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0])}',shortCircuit:true};
  }
  return next(specifier,context);
}});

const route=await import(new URL('../app/api/ledger/export/route.ts',import.meta.url).href);
const request=(authorization?:string)=>new Request('http://localhost:3028/api/ledger/export',{headers:authorization?{authorization}:{}});

test('ledger export requires the dedicated bearer token',async()=>{
  assert.equal((await route.GET(request())).status,401);
  assert.equal((await route.GET(request(`Bearer ${'b'.repeat(64)}`))).status,401);
});

test('ledger export binds source hashes, balance conservation and workspace version to the archive',async()=>{
  const response=await route.GET(request(`Bearer ${token}`));
  assert.equal(response.status,200);
  assert.equal(response.headers.get('x-allocation-workspace-version'),'12');
  assert.equal(response.headers.get('x-allocation-ledger-sha256'),'ledger-hash');
  const args=(globalThis as any).__ledgerZipArgs;
  const manifest=JSON.parse(args.manifest['账簿清单.json']);
  assert.equal(args.folder,'网站账簿快照_v12');
  assert.equal(args.files.length,1);
  assert.equal(manifest.workspaceVersion,12);
  assert.equal(manifest.stateDigest,'ledger-hash');
  assert.equal(manifest.sources[0].availableCents,1000);
  assert.equal(manifest.sources[0].usedCents,0);
  assert.equal(manifest.sources[0].sha256,'source-hash');
  assert.match(manifest.instruction,/唯一正式账簿/);
  assert.equal('exportedAt' in manifest,false);
  await route.GET(request(`Bearer ${token}`));
  const repeated=JSON.parse((globalThis as any).__ledgerZipArgs.manifest['账簿清单.json']);
  assert.deepEqual(repeated,manifest);
});

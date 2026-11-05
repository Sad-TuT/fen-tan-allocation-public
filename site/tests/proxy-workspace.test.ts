import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {chmod,mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

(globalThis as any).__workspaceTestUser=null;
registerHooks({resolve(specifier:string,context:any,next:any){
 if(context.parentURL?.endsWith('/api/workspace/route.ts')&&specifier==='../../lib/app-auth')return {url:'data:text/javascript,export async function getAppUser(){return globalThis.__workspaceTestUser}',shortCircuit:true};
 if(context.parentURL?.endsWith('/api/workspace/route.ts')&&specifier==='../../lib/workflow')return {url:'data:text/javascript,export async function stateSummary(){return {version:0}};export async function importSource(){return {ok:true}};export async function importTax(){return {ok:true}};export async function importTaxOverrides(){return {ok:true}};export async function simulate(){return {ok:true}};export async function prepareBatch(){return {ok:true}};export async function finalize(){return {ok:true}};export async function getBatch(){return null};export async function getReviews(){return []}',shortCircuit:true};
 if(context.parentURL?.includes('/app/')&&specifier.startsWith('.')&&!/\.[cm]?[jt]sx?$/.test(specifier))return next(new URL(specifier+'.ts',context.parentURL).href,context);
 return next(specifier,context);
}});
const route=await import(new URL('../app/api/workspace/route.ts',import.meta.url).href);
function request(method:'GET'|'POST',host:string,origin?:string,proto='https',commitToken?:string){
 const headers=new Headers({host,'x-forwarded-proto':proto});if(origin)headers.set('origin',origin);if(method==='POST')headers.set('content-type','application/json');
 if(commitToken)headers.set('x-allocation-commit-token',commitToken);
 return new Request('http://localhost:3028/api/workspace',{method,headers,...(method==='POST'?{body:JSON.stringify({action:'commit',id:'synthetic'})}:{})});
}

test('workspace GET and writes enforce auth, roles, and public host/origin',async()=>{
 const previous=process.env.ALLOCATION_PUBLIC_ORIGIN,previousCommit=process.env.ALLOCATION_COMMIT_TOKEN_FILE;
 const secret='c'.repeat(64),temporary=await mkdtemp(path.join(os.tmpdir(),'allocation-commit-'));
 const tokenFile=path.join(temporary,'commit-token');
 await writeFile(tokenFile,secret);
 await chmod(tokenFile,0o600);
 process.env.ALLOCATION_PUBLIC_ORIGIN='https://allocation.example.invalid';
 process.env.ALLOCATION_COMMIT_TOKEN_FILE=tokenFile;
 try{
  const publicGet=request('GET','allocation.example.invalid');
  assert.equal((await route.GET(publicGet)).status,401);
  assert.equal((await route.GET(request('GET','evil.invalid'))).status,403);
  (globalThis as any).__workspaceTestUser={userId:'viewer',displayName:'viewer',email:'',role:'viewer',mustChangePassword:false};
  assert.equal((await route.GET(publicGet)).status,200);
  assert.equal((await route.POST(request('POST','allocation.example.invalid','https://allocation.example.invalid'))).status,403);
  (globalThis as any).__workspaceTestUser={userId:'operator',displayName:'operator',email:'',role:'operator',mustChangePassword:false};
  assert.equal((await route.POST(request('POST','allocation.example.invalid','https://evil.invalid'))).status,403);
  assert.equal((await route.POST(request('POST','evil.invalid','https://allocation.example.invalid'))).status,403);
  assert.equal((await route.POST(request('POST','allocation.example.invalid','https://allocation.example.invalid','http'))).status,403);
  assert.equal((await route.POST(request('POST','allocation.example.invalid','https://allocation.example.invalid'))).status,403);
  assert.equal((await route.POST(request('POST','allocation.example.invalid','https://allocation.example.invalid','https','d'.repeat(64)))).status,403);
  assert.equal((await route.POST(request('POST','allocation.example.invalid','https://allocation.example.invalid','https',secret))).status,200);
  (globalThis as any).__workspaceTestUser.mustChangePassword=true;
  assert.equal((await route.GET(publicGet)).status,403);
 }finally{
  (globalThis as any).__workspaceTestUser=null;
  if(previous===undefined)delete process.env.ALLOCATION_PUBLIC_ORIGIN;else process.env.ALLOCATION_PUBLIC_ORIGIN=previous;
  if(previousCommit===undefined)delete process.env.ALLOCATION_COMMIT_TOKEN_FILE;else process.env.ALLOCATION_COMMIT_TOKEN_FILE=previousCommit;
  await rm(temporary,{recursive:true,force:true});
 }
});

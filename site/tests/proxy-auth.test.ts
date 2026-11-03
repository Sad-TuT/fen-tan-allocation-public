import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {registerHooks} from 'node:module';
import {scryptSync} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import path from 'node:path';

const env:Record<string,unknown>={};
(globalThis as any).__proxyAuthEnv=env;
registerHooks({resolve(specifier:string,context:any,next:any){
 if(specifier==='./node-runtime'&&context.parentURL?.endsWith('/app-auth.ts'))return {url:'data:text/javascript,export const env=globalThis.__proxyAuthEnv',shortCircuit:true};
 if(specifier==='next/headers')return {url:'data:text/javascript,export async function headers(){return new Headers()}',shortCircuit:true};
 if(context.parentURL?.includes('/app/')&&specifier.startsWith('.')&&!/\.[cm]?[jt]sx?$/.test(specifier))return next(new URL(specifier+'.ts',context.parentURL).href,context);
 return next(specifier,context);
}});
const {loginAccount}=await import(new URL('../app/lib/app-auth.ts',import.meta.url).href);

test('public login enforces configured origin and does not trust forwarded client IP',async()=>{
 const previous=process.env.ALLOCATION_PUBLIC_ORIGIN;
 process.env.ALLOCATION_PUBLIC_ORIGIN='https://allocation.example.invalid';
 const db=new DatabaseSync(':memory:');
 try{
  for(const f of (await readdir('drizzle')).filter(x=>/^\d+.*\.sql$/.test(x)).sort())db.exec(await readFile(path.join('drizzle',f),'utf8'));
  function statement(query:string,args:any[]=[]):any{return {
   bind:(...values:any[])=>statement(query,values),
   first:async()=>db.prepare(query).get(...args)??null,
   run:async()=>({success:true,meta:{changes:Number(db.prepare(query).run(...args).changes)}}),
  };}
  env.DB={prepare:statement};env.ALLOCATION_RATE_KEY='a'.repeat(64);
  const salt='00112233445566778899aabbccddeeff',pass='Synthetic-Password-Only-123',now=Date.now();
  const hash=scryptSync(pass,Buffer.from(salt,'hex'),32,{N:32768,r:8,p:3,maxmem:48*1024*1024}).toString('hex');
  db.prepare("INSERT INTO app_users(id,username,display_name,role,password_salt,password_hash,password_iterations,password_version,must_change_password,disabled,created_at,updated_at) VALUES('u','sample','Test','admin',?,?,32768,1,0,0,?,?)").run(salt,'scrypt$32768$8$3$'+hash,now,now);
  const attempt=async({host='allocation.example.invalid',origin='https://allocation.example.invalid',proto='https',ip='198.51.100.1',password=pass}={})=>{
   const headers=new Headers({host,origin,'x-forwarded-proto':proto,'x-forwarded-for':ip,'content-type':'application/json'});
   return loginAccount(new Request('http://localhost:3028/api/app-auth/login',{method:'POST',headers,body:JSON.stringify({username:'sample',password})}));
  };
  const cross=await attempt({origin:'https://evil.invalid'});assert.equal(cross.status,400);
  const spoof=await attempt({host:'evil.invalid'});assert.equal(spoof.status,400);
  const insecure=await attempt({proto:'http'});assert.equal(insecure.status,400);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM app_sessions').get()?.n),0);
  const good=await attempt();assert.equal(good.status,200);
  assert.match(good.headers.get('set-cookie')??'',/Secure; SameSite=Strict/);
  let limited=false;
  for(let i=0;i<10;i++){const res=await attempt({ip:`203.0.113.${i+1}`,password:'wrong'});if(res.status===429){limited=true;break;}}
  assert.ok(limited,'rotating untrusted X-Forwarded-For must not bypass rate limits');
 }finally{db.close();if(previous===undefined)delete process.env.ALLOCATION_PUBLIC_ORIGIN;else process.env.ALLOCATION_PUBLIC_ORIGIN=previous;}
});

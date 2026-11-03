import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {registerHooks} from 'node:module';
import {readdir,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {scryptSync,randomUUID} from 'node:crypto';

// Real SQLite and actual route handlers, isolated from the real D1/R2 account.
const env:Record<string,unknown>={};
(globalThis as any).__appAuthTestEnv=env;
(globalThis as any).__appAuthRequestHeaders=new Headers();
registerHooks({resolve(specifier:string,context:any,next:any){
  if(specifier==='./node-runtime'&&context.parentURL?.endsWith('/app-auth.ts'))return {url:'data:text/javascript,export const env=globalThis.__appAuthTestEnv',shortCircuit:true};
  if(specifier==='next/headers')return {url:'data:text/javascript,export async function headers(){return globalThis.__appAuthRequestHeaders}',shortCircuit:true};
  if(context.parentURL?.includes('/app/')&&specifier.startsWith('.')&&!/\.[cm]?[jt]sx?$/.test(specifier))return next(new URL(specifier+'.ts',context.parentURL).href,context);
  return next(specifier,context);
}});
const project=fileURLToPath(new URL('../',import.meta.url));
const paths=['initialize','login','logout','users','change-password','change-credentials'];
const routes:Record<string,any>={};
for(const name of paths)routes[name]=await import(new URL(`../app/api/app-auth/${name}/route.ts`,import.meta.url).href);
const {isPlatformOwner}=await import(new URL('../app/lib/app-auth.ts',import.meta.url).href);
const BASE='http://localhost:3000', BOOT='aa'.repeat(32), RATE='bb'.repeat(32), ADMIN='Passphrase-Admin-Number-29', NEXT='Another-Strong-Passphrase-30', TEMP='Temporary-Passphrase-2026';
function fixture(){
  const db=new DatabaseSync(':memory:');
  const statement=(query:string,bindings:any[]=[]):any=>({
    bind:(...args:any[])=>statement(query,args),
    first:async()=>db.prepare(query).get(...bindings)??null,
    all:async()=>({results:db.prepare(query).all(...bindings)}),
    run:async()=>({success:true,meta:{changes:Number(db.prepare(query).run(...bindings).changes)}}),
    _sync:()=>({success:true,meta:{changes:Number(db.prepare(query).run(...bindings).changes)}}),
  });
  env.DB={prepare:statement,batch:async(statements:any[])=>{db.exec('BEGIN');try{const results=statements.map(s=>s._sync());db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}}};
  env.ALLOCATION_BOOTSTRAP_TOKEN=BOOT;env.ALLOCATION_RATE_KEY=RATE;env.ALLOCATION_OWNER_EMAIL='owner@example.invalid';
  return db;
}
async function migrations(db:DatabaseSync){
 const dir=path.join(project,'drizzle');for(const filename of (await readdir(dir)).filter(x=>/^\d+.*\.sql$/.test(x)).sort())db.exec((await readFile(path.join(dir,filename),'utf8')).replace(/--> statement-breakpoint/g,''));
}
type Options={cookie?:string;origin?:string|null;ip?:string;owner?:boolean};
async function request(name:string,body?:Record<string,unknown>,options:Options={}){
 const method=body?'POST':'GET';const h=new Headers({'cf-connecting-ip':options.ip??'203.0.113.7'});if(body)h.set('content-type','application/json');if(options.origin!==null&&body)h.set('origin',options.origin??BASE);if(options.cookie)h.set('cookie',options.cookie);if(name==='initialize'&&options.owner!==false){h.set('oai-authenticated-user-id','owner-id');h.set('oai-authenticated-user-email','owner@example.invalid');}
 const req=new Request(BASE+'/api/app-auth/'+name,{method,headers:h,...(body?{body:JSON.stringify(body)}:{})});(globalThis as any).__appAuthRequestHeaders=req.headers;
 const response:Response=await routes[name][method](req);const raw=await response.text();let data:any;try{data=JSON.parse(raw);}catch{data=raw;}return {response,data,raw};
}
function session(result:{response:Response}){const value=result.response.headers.get('set-cookie');assert.ok(value,'登录响应必须设置会话Cookie');assert.match(value,/\bsecure\b/i);assert.match(value,/\bhttponly\b/i);assert.match(value,/samesite=(strict|lax)/i);assert.match(value,/path=\//i);assert.doesNotMatch(value,/\bdomain=/i);return value.split(';',1)[0];}
function failed(s:number){assert.ok(s>=400&&s<600,`预期失败状态，收到${s}`);}
async function setup(){const db=fixture();await migrations(db);const salt='00112233445566778899aabbccddeeff',hash=scryptSync(ADMIN,Buffer.from(salt,'hex'),32,{N:32768,r:8,p:3,maxmem:48*1024*1024}).toString('hex'),now=Date.now();db.prepare("INSERT INTO app_users (id,username,platform_owner_id,display_name,role,password_salt,password_hash,password_iterations,password_version,must_change_password,disabled,created_at,updated_at) VALUES (?,?,?,'测试管理员','admin',?,?,32768,1,0,0,?,?)").run(randomUUID(),'admin','owner-id',salt,'scrypt$32768$8$3$'+hash,now,now);return db;}
async function signIn(username:string,password:string,options:Options={}){const r=await request('login',{username,password},options);assert.ok(r.response.ok,r.raw);return session(r);}
async function users(cookie:string){const r=await request('users',undefined,{cookie});assert.ok(r.response.ok,r.raw);const list=Array.isArray(r.data)?r.data:r.data.users;assert.ok(Array.isArray(list),'用户列表必须是数组');return list;}

test('web setup rejects all requests including spoofed platform identity',async()=>{
 const db=await setup();try{const values={username:'other',password:ADMIN,displayName:'测试'};
 assert.equal((await request('initialize',values,{owner:false})).response.status,403);
 assert.equal((await request('initialize',values)).response.status,403);
 assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM app_users').get()?.n),1);
 assert.equal(await isPlatformOwner('owner-id'),true);assert.equal(await isPlatformOwner('another-id'),false);
 }finally{db.close();}
});

test('login rejects invalid origins and makes wrong password/unknown username indistinguishable',async()=>{
 const db=await setup();try{
 failed((await request('login',{username:'admin',password:ADMIN},{origin:'https://attacker.invalid'})).response.status);
 failed((await request('login',{username:'admin',password:ADMIN},{origin:null})).response.status);
 const a=await request('login',{username:'admin',password:'incorrect-password'},{ip:'203.0.113.8'}), b=await request('login',{username:'absent',password:'incorrect-password'},{ip:'203.0.113.9'});
 failed(a.response.status);assert.equal(a.response.status,b.response.status);assert.deepEqual(a.data,b.data);
 const good=await request('login',{username:'admin',password:ADMIN},{ip:'203.0.113.10'});assert.ok(good.response.ok,good.raw);session(good);
 }finally{db.close();}
});

test('only admin can administer users; session tokens are not stored in plaintext',async()=>{
 const db=await setup();try{
 const storedUser=db.prepare("SELECT password_hash,password_iterations FROM app_users WHERE username='admin'").get() as {password_hash:string;password_iterations:number};assert.match(storedUser.password_hash,/^scrypt\$32768\$8\$3\$[0-9a-f]{64}$/);assert.equal(storedUser.password_iterations,32768);assert.ok(!storedUser.password_hash.includes(ADMIN));
 failed((await request('users')).response.status);const admin=await signIn('admin',ADMIN);
 const sessionTable=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%session%'").all() as any[])[0];assert.ok(sessionTable,'必须有服务端会话表');const stored=JSON.stringify(db.prepare(`SELECT * FROM "${String(sessionTable.name).replace(/"/g,'""')}"`).all());assert.ok(!stored.includes(admin.split('=',2)[1]),'数据库不能存明文会话令牌');
 const created=await request('users',{action:'create',username:'operator',password:TEMP,displayName:'测试操作员',role:'operator'},{cookie:admin});assert.ok(created.response.ok,created.raw);
 assert.equal((db.prepare("SELECT platform_owner_id FROM app_users WHERE username='operator'").get() as {platform_owner_id:string|null}).platform_owner_id,null);
 const op=await signIn('operator',TEMP,{ip:'203.0.113.11'});failed((await request('users',undefined,{cookie:op})).response.status);failed((await request('users',{action:'create',username:'intruder',password:TEMP,displayName:'测试',role:'admin'},{cookie:op})).response.status);
 failed((await request('users',undefined,{cookie:`${admin}; ${admin}`})).response.status);
 }finally{db.close();}
});

test('new user must change password; change revokes current and other sessions',async()=>{
 const db=await setup();try{const admin=await signIn('admin',ADMIN);const created=await request('users',{action:'create',username:'operator',password:TEMP,displayName:'操作员',role:'operator'},{cookie:admin});assert.ok(created.response.ok,created.raw);
 const a=await signIn('operator',TEMP,{ip:'203.0.113.11'}),b=await signIn('operator',TEMP,{ip:'203.0.113.12'});
 const bad=await request('change-password',{oldPassword:'incorrect-pass',newPassword:NEXT},{cookie:a});failed(bad.response.status);
 const changed=await request('change-password',{oldPassword:TEMP,newPassword:NEXT},{cookie:a});assert.ok(changed.response.ok,changed.raw);assert.equal(changed.data.ok,true);
 // The protected management route rejects old sessions, regardless of role.
 const second=await request('change-password',{oldPassword:NEXT,newPassword:ADMIN},{cookie:b});failed(second.response.status);
 const old=await request('login',{username:'operator',password:TEMP},{ip:'203.0.113.13'});failed(old.response.status);await signIn('operator',NEXT,{ip:'203.0.113.14'});
 }finally{db.close();}
});

test('disabling or resetting an account revokes its sessions and last admin cannot be disabled',async()=>{
 const db=await setup();try{const admin=await signIn('admin',ADMIN);const created=await request('users',{action:'create',username:'operator',password:TEMP,displayName:'操作员',role:'operator'},{cookie:admin});assert.ok(created.response.ok,created.raw);
 const list=await users(admin);const op=list.find((u:any)=>u.username==='operator');const own=list.find((u:any)=>u.username==='admin');assert.ok(op?.id||op?.userId);assert.ok(own?.id||own?.userId);const opId=op.id??op.userId, ownId=own.id??own.userId;
 const first=await signIn('operator',TEMP,{ip:'203.0.113.20'});const reset=await request('users',{action:'reset',userId:opId,password:NEXT},{cookie:admin});assert.ok(reset.response.ok,reset.raw);failed((await request('change-password',{oldPassword:TEMP,newPassword:ADMIN},{cookie:first})).response.status);
 const second=await signIn('operator',NEXT,{ip:'203.0.113.21'});const disabled=await request('users',{action:'disable',userId:opId},{cookie:admin});assert.ok(disabled.response.ok,disabled.raw);failed((await request('change-password',{oldPassword:NEXT,newPassword:ADMIN},{cookie:second})).response.status);failed((await request('login',{username:'operator',password:NEXT},{ip:'203.0.113.22'})).response.status);
 failed((await request('users',{action:'disable',userId:ownId},{cookie:admin})).response.status);assert.ok((await request('users',undefined,{cookie:admin})).response.ok);
 }finally{db.close();}
});

test('one account is rate-limited even when its requests originate from multiple IPs',async()=>{
 const db=await setup();try{let limited=false;for(let i=0;i<24;i++){const r=await request('login',{username:'admin',password:'incorrect-password'},{ip:`203.0.113.${30+i}`});if(r.response.status===429){limited=true;break;}}assert.ok(limited,'同账号多IP尝试必须有限速');}finally{db.close();}
});

test('one IP is rate-limited even when using many account names',async()=>{
 const db=await setup();try{let limited=false;for(let i=0;i<130;i++){const r=await request('login',{username:`absent-${i}`,password:'incorrect-password'},{ip:'203.0.113.200'});if(r.response.status===429){limited=true;break;}}assert.ok(limited,'同IP多账号尝试必须有限速');}finally{db.close();}
});

test('logout revokes the server-side session and rejects cross-origin requests',async()=>{
 const db=await setup();try{const admin=await signIn('admin',ADMIN);failed((await request('logout',{}, {cookie:admin,origin:'https://attacker.invalid'})).response.status);assert.ok((await request('users',undefined,{cookie:admin})).response.ok);const logged=await request('logout',{}, {cookie:admin});assert.ok(logged.response.ok,logged.raw);failed((await request('users',undefined,{cookie:admin})).response.status);}finally{db.close();}
});

test('UI account contract supports disable, re-enable, and password reset',async()=>{
 const db=await setup();try{
 const admin=await signIn('admin',ADMIN);
 assert.ok((await request('users',{action:'create',username:'viewer',displayName:'仅查看',role:'viewer',password:TEMP},{cookie:admin})).response.ok);
 const viewer=(await users(admin)).find((u:any)=>u.username==='viewer');assert.equal(viewer.displayName,'仅查看');assert.equal(viewer.disabled,false);assert.equal(viewer.mustChangePassword,true);
 assert.ok((await request('users',{action:'disable',id:viewer.id,disabled:true},{cookie:admin})).response.ok);
 assert.ok((await request('users',{action:'disable',id:viewer.id,disabled:false},{cookie:admin})).response.ok);
 assert.ok((await request('users',{action:'reset',id:viewer.id,password:NEXT},{cookie:admin})).response.ok);
 await signIn('viewer',NEXT,{ip:'203.0.113.77'});
 }finally{db.close();}
});

test('expired rate-limit keys are cleaned and active-key table has a hard cap',async()=>{
 const db=await setup();try{
 db.prepare('INSERT INTO app_auth_limits(key,window_start,attempts) VALUES(?,?,?)').run('expired-test-key',Date.now()-60*60*1000,1);
 await request('login',{username:'nobody',password:'bad-password'},{ip:'203.0.113.78'});
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM app_auth_limits WHERE key='expired-test-key'").get()?.n,0);
 const insert=db.prepare('INSERT INTO app_auth_limits(key,window_start,attempts) VALUES(?,?,?)');db.exec('BEGIN');for(let i=0;i<10000;i++)insert.run(`cap-${i}`,Date.now(),1);db.exec('COMMIT');
 const result=await request('login',{username:'another-account',password:'bad-password'},{ip:'203.0.113.79'});assert.equal(result.response.status,429);assert.ok(Number(db.prepare('SELECT COUNT(*) AS n FROM app_auth_limits').get()?.n)<=10004);
 }finally{db.close();}
});

test('owner may rename itself and choose a six-character password with current credentials; all sessions are revoked',async()=>{
 const db=await setup();try{
  const a=await signIn('admin',ADMIN,{ip:'203.0.113.31'}),b=await signIn('admin',ADMIN,{ip:'203.0.113.32'});
  const original=db.prepare("SELECT id,platform_owner_id FROM app_users WHERE username='admin'").get() as {id:string;platform_owner_id:string};
  // A newly reset account can change both credentials while password change is required.
  assert.ok((await request('users',{action:'reset',id:original.id,password:ADMIN},{cookie:a})).response.ok);
  const forced=await signIn('admin',ADMIN,{ip:'203.0.113.33'});
  const concurrent=await signIn('admin',ADMIN,{ip:'203.0.113.36'});
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM app_sessions WHERE user_id=?').get(original.id)?.n),2,'变更前须存在两个有效会话');
  const params={username:'xy',oldPassword:ADMIN,newPassword:'654321'};
  failed((await request('change-credentials',params,{cookie:forced,origin:'https://attacker.invalid'})).response.status);
  failed((await request('change-credentials',{...params,oldPassword:'wrong-password'},{cookie:forced})).response.status);
  failed((await request('change-credentials',{...params,username:'x'},{cookie:forced})).response.status);
  const changed=await request('change-credentials',params,{cookie:forced});assert.ok(changed.response.ok,changed.raw);
  assert.match(changed.response.headers.get('set-cookie')??'',/Max-Age=0/i);
  const row=db.prepare("SELECT id,platform_owner_id,must_change_password,password_hash FROM app_users WHERE username='xy'").get() as {id:string;platform_owner_id:string;must_change_password:number;password_hash:string};
  assert.equal(row.id,original.id);assert.equal(row.platform_owner_id,original.platform_owner_id);assert.equal(row.must_change_password,0);assert.match(row.password_hash,/^scrypt\$/);assert.ok(!row.password_hash.includes('654321'));
  failed((await request('users',undefined,{cookie:a})).response.status);failed((await request('users',undefined,{cookie:b})).response.status);failed((await request('users',undefined,{cookie:forced})).response.status);failed((await request('change-password',{oldPassword:ADMIN,newPassword:NEXT},{cookie:concurrent})).response.status);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM app_sessions WHERE user_id=?').get(original.id)?.n),0,'变更后须撤销所有会话');
  failed((await request('login',{username:'admin',password:ADMIN},{ip:'203.0.113.34'})).response.status);
  const newSession=await signIn('xy','654321',{ip:'203.0.113.35'});assert.ok((await request('users',undefined,{cookie:newSession})).response.ok);
 }finally{db.close();}
});

test('other admins and ordinary accounts cannot use owner-only credential change or short passwords',async()=>{
 const db=await setup();try{
  const admin=await signIn('admin',ADMIN,{ip:'203.0.113.40'});
  failed((await request('users',{action:'create',username:'viewer',displayName:'查看',role:'viewer',password:'654321'},{cookie:admin})).response.status);
  assert.ok((await request('users',{action:'create',username:'viewer',displayName:'查看',role:'viewer',password:TEMP},{cookie:admin})).response.ok);
  assert.ok((await request('users',{action:'create',username:'other-admin',displayName:'管理员',role:'admin',password:TEMP},{cookie:admin})).response.ok);
  const viewer=await signIn('viewer',TEMP,{ip:'203.0.113.41'}),other=await signIn('other-admin',TEMP,{ip:'203.0.113.42'});
  failed((await request('change-credentials',{username:'zz',oldPassword:TEMP,newPassword:'654321'},{cookie:viewer})).response.status);
  failed((await request('change-credentials',{username:'zz',oldPassword:TEMP,newPassword:'654321'},{cookie:other})).response.status);
  failed((await request('change-password',{oldPassword:TEMP,newPassword:'654321'},{cookie:viewer})).response.status);
 }finally{db.close();}
});

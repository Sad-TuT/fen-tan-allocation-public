import { env } from './node-runtime';
import { headers } from 'next/headers';
import { scryptSync, timingSafeEqual } from 'node:crypto';
import {hasTrustedOrigin,requestAddress} from './request-security';

export type AppRole='admin'|'operator'|'viewer';
export type AppUser={userId:string;displayName:string;email:string;role:AppRole;mustChangePassword:boolean};
type UserRow={id:string;username:string;display_name:string;role:AppRole;platform_owner_id:string|null;password_salt:string;password_hash:string;password_iterations:number;password_version:number;must_change_password:number;disabled:number};
// OWASP's scrypt alternative N=2^15, r=8, p=3 uses ~32 MiB. Keep the
// full algorithm and parameters in the stored hash for future migrations.
const SESSION='__Host-allocation_session';const ITERATIONS=32768;const SCRYPT_PREFIX='scrypt$32768$8$3$';const SESSION_MS=8*60*60*1000;const WINDOW=15*60*1000;const USER_MAX=8;const IP_MAX=60;
const settings=env as unknown as {DB?:D1Database;ALLOCATION_BOOTSTRAP_TOKEN?:string;ALLOCATION_OWNER_EMAIL?:string;ALLOCATION_RATE_KEY?:string};
function db():D1Database {if(!settings.DB)throw new Error('认证数据库不可用');return settings.DB;}
const encoder=new TextEncoder();
function hex(data:Uint8Array):string{return Array.from(data,x=>x.toString(16).padStart(2,'0')).join('');}
function unhex(s:string):Uint8Array {if(!/^(?:[a-f0-9]{2})+$/i.test(s))throw new Error('认证资料格式无效');return Uint8Array.from(s.match(/../g)!,x=>parseInt(x,16));}
function randomHex(n:number):string{const b=new Uint8Array(n);crypto.getRandomValues(b);return hex(b);}
async function hash(s:string):Promise<string>{return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(s))));}
async function derive(password:string,salt:string,iterations=ITERATIONS):Promise<string>{if(iterations!==ITERATIONS)throw new Error('不支持的密码参数。');const key=scryptSync(encoder.encode(password),unhex(salt),32,{N:ITERATIONS,r:8,p:3,maxmem:48*1024*1024});return SCRYPT_PREFIX+hex(key);}
function equalHex(a:string,b:string):boolean {try{const x=unhex(a),y=unhex(b);return x.length===y.length&&timingSafeEqual(x,y);}catch{return false;}}
function equalPasswordHash(a:string,b:string):boolean {return a.startsWith(SCRYPT_PREFIX)&&b.startsWith(SCRYPT_PREFIX)&&equalHex(a.slice(SCRYPT_PREFIX.length),b.slice(SCRYPT_PREFIX.length));}
function normalizeUsername(value:unknown):string{if(typeof value!=='string')return '';const s=value.trim().toLowerCase();return /^[a-z0-9][a-z0-9_.-]{1,63}$/.test(s)?s:'';}
function goodPassword(value:unknown):value is string {return typeof value==='string'&&Array.from(value).length>=12&&encoder.encode(value).length<=512;}
function goodOwnerPassword(value:unknown):value is string {return typeof value==='string'&&Array.from(value).length>=6&&encoder.encode(value).length<=512;}
function displayName(value:unknown):string {if(typeof value!=='string'||!value.trim()||value.trim().length>80)throw new Error('请填写1至80字的显示名称。');return value.trim();}
function role(value:unknown):AppRole {if(value==='admin'||value==='operator'||value==='viewer')return value;throw new Error('请选择有效的账号角色。');}
function sameOrigin(request:Request):boolean {return hasTrustedOrigin(request);}
async function body(request:Request):Promise<Record<string,unknown>> {
  if(!sameOrigin(request))throw new Error('请求来源无效。');
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw new Error('请求格式无效。');
  const announced=Number(request.headers.get('content-length')??0);if(announced>8192)throw new Error('请求过大。');
  const reader=request.body?.getReader();if(!reader)throw new Error('请求为空。');const chunks:Uint8Array[]=[];let length=0;
  while(true){const x=await reader.read();if(x.done)break;length+=x.value.length;if(length>8192){await reader.cancel();throw new Error('请求过大。');}chunks.push(x.value);}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let parsed:unknown;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('请求格式无效。');}if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw new Error('请求格式无效。');return parsed as Record<string,unknown>;
}
function response(error:string,status:number):Response{return Response.json({error},{status,headers:{'Cache-Control':'no-store'}});}
function tokenFromCookie(value:string|null):string|null {const values=(value??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(`${SESSION}=`)).map(x=>x.slice(SESSION.length+1));return values.length===1&&/^[a-f0-9]{64}$/.test(values[0])?values[0]:null;}
function sessionCookie(token:string,expiresAt:number):string{return `${SESSION}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0,Math.floor((expiresAt-Date.now())/1000))}`;}
function clearCookie():string{return `${SESSION}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;}
async function sessionUser(cookie:string|null):Promise<(AppUser&{sessionHash:string})|null>{const raw=tokenFromCookie(cookie);if(!raw)return null;const sessionHash=await hash(raw);const row=await db().prepare('SELECT u.id,u.display_name,u.role,u.must_change_password FROM app_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0 AND s.password_version=u.password_version').bind(sessionHash,Date.now()).first<UserRow>();if(!row||!['admin','operator','viewer'].includes(row.role))return null;return{userId:row.id,displayName:row.display_name,email:'',role:row.role,mustChangePassword:!!row.must_change_password,sessionHash};}
export async function getAppUser():Promise<AppUser|null>{const h=await headers();const u=await sessionUser(h.get('cookie'));if(!u)return null;const {sessionHash:_,...safe}=u;return safe;}
// Never accept forwarded client IP headers from a request. In public mode the
// trusted proxy must separately enforce per-client IP limits; this provides a
// fail-closed global ceiling in addition to the account-specific limiter.
function clientIP(request:Request):string {const address=requestAddress(request);if(!address)throw new Error('请求地址不受信任。');return address.mode==='local'?'local':'public-proxy';}
async function rateKey(value:string):Promise<string>{const key=settings.ALLOCATION_RATE_KEY;if(!key||key.length<32)throw new Error('登录限流尚未配置。');const h=await crypto.subtle.importKey('raw',encoder.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(new Uint8Array(await crypto.subtle.sign('HMAC',h,encoder.encode(value))));}
async function rateLimit(request:Request,account:string):Promise<boolean>{
 const now=Date.now();const [ipKey,userKey]=await Promise.all([rateKey('ip:'+clientIP(request)),rateKey('user:'+account)]);
 // Remove expired keys in bounded batches; never let unbounded random usernames
 // grow the auth table forever. Refuse new keys if capacity is reached.
 await db().prepare('DELETE FROM app_auth_limits WHERE key IN (SELECT key FROM app_auth_limits WHERE window_start<=? LIMIT 200)').bind(now-WINDOW).run();
 const sql='INSERT INTO app_auth_limits (key,window_start,attempts) SELECT ?,?,1 WHERE EXISTS (SELECT 1 FROM app_auth_limits WHERE key=?) OR (SELECT COUNT(*) FROM app_auth_limits)<10000 ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN app_auth_limits.window_start<=? THEN 1 ELSE app_auth_limits.attempts+1 END, window_start=CASE WHEN app_auth_limits.window_start<=? THEN excluded.window_start ELSE app_auth_limits.window_start END RETURNING attempts';
 async function hit(key:string):Promise<number>{const row=await db().prepare(sql).bind(key,now,key,now-WINDOW,now-WINDOW).first<{attempts:number}>();return row?Number(row.attempts):Infinity;}
 if(await hit('ip:'+ipKey)>IP_MAX)return false;
 return await hit('user:'+userKey)<=USER_MAX;
}
async function credentials(password:string):Promise<{salt:string;passwordHash:string}>{const salt=randomHex(16);return{salt,passwordHash:await derive(password,salt)};}
function assertAdmin(user:AppUser|null):asserts user is AppUser {if(!user||user.role!=='admin'||user.mustChangePassword)throw new Error('需要管理员权限。');}
// The one-time bootstrap is available only while the site remains owner-private.
// The token is a server-side enable flag: it is never sent to a browser. Remove
// it after initialization, before allowing anonymous visitors at the gateway.
export async function isPlatformOwner(userId:string):Promise<boolean>{if(!userId||userId.length>255)return false;return !!await db().prepare('SELECT 1 AS present FROM app_users WHERE platform_owner_id=? LIMIT 1').bind(userId).first<{present:number}>();}
export async function canInitializeAccount():Promise<boolean>{return false;}
export async function initializeAccount(_request:Request):Promise<Response>{return response('管理员只能在服务器本机初始化。',403);}
export async function loginAccount(request:Request):Promise<Response>{try{const v=await body(request);const username=normalizeUsername(v.username),password=typeof v.password==='string'&&encoder.encode(v.password).length<=512?v.password:'';if(!await rateLimit(request,username||'invalid'))return response('请求过多，请稍后再试。',429);const row=username?await db().prepare('SELECT * FROM app_users WHERE username=?').bind(username).first<UserRow>():null;const derived=await derive(password,row?.password_salt??'00000000000000000000000000000000',row?.password_iterations??ITERATIONS);if(!row||row.disabled||!equalPasswordHash(derived,row.password_hash))return response('账号或密码错误。',401);const token=randomHex(32),tokenHash=await hash(token),now=Date.now(),expiry=now+SESSION_MS;const result=await db().prepare('INSERT INTO app_sessions (token_hash,user_id,password_version,created_at,expires_at) SELECT ?,id,password_version,?,? FROM app_users WHERE id=? AND disabled=0 AND password_version=? AND password_hash=?').bind(tokenHash,now,expiry,row.id,row.password_version,row.password_hash).run();if(result.meta.changes!==1)return response('账号或密码错误。',401);return Response.json({ok:true,mustChangePassword:!!row.must_change_password},{headers:{'Set-Cookie':sessionCookie(token,expiry),'Cache-Control':'no-store'}});}catch(e){return response(e instanceof Error?e.message:'登录失败。',400);}}
export async function logoutAccount(request:Request):Promise<Response>{try{await body(request);const raw=tokenFromCookie(request.headers.get('cookie'));if(raw)await db().prepare('DELETE FROM app_sessions WHERE token_hash=?').bind(await hash(raw)).run();return Response.json({ok:true},{headers:{'Set-Cookie':clearCookie(),'Cache-Control':'no-store'}});}catch(e){return response(e instanceof Error?e.message:'退出失败。',400);}}
export async function listUsers(request:Request):Promise<Response>{try{const u=await sessionUser(request.headers.get('cookie'));assertAdmin(u);const result=await db().prepare('SELECT id,username,display_name AS displayName,role,disabled,must_change_password AS mustChangePassword,created_at AS createdAt FROM app_users ORDER BY created_at').all<Record<string,unknown>>();return Response.json({users:result.results.map(row=>({...row,disabled:!!row.disabled,mustChangePassword:!!row.mustChangePassword}))},{headers:{'Cache-Control':'no-store'}});}catch{return response('需要管理员权限。',403);}}
export async function manageUsers(request:Request):Promise<Response>{try{const v=await body(request),u=await sessionUser(request.headers.get('cookie'));assertAdmin(u);const now=Date.now();if(v.action==='create'){const username=normalizeUsername(v.username);if(!username||!goodPassword(v.password))throw new Error('账号需为2至64位英文、数字或._-；密码至少12个字符。');const c=await credentials(v.password);await db().prepare('INSERT INTO app_users (id,username,display_name,role,password_salt,password_hash,password_iterations,password_version,must_change_password,disabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,1,0,?,?)').bind(crypto.randomUUID(),username,displayName(v.displayName),role(v.role),c.salt,c.passwordHash,ITERATIONS,now,now).run();}
 else if(v.action==='disable'){const id=typeof v.id==='string'?v.id:v.userId;const disable=v.disabled===undefined?true:v.disabled;if(typeof id!=='string'||typeof disable!=='boolean'||id===u.userId)throw new Error('账号或操作无效，不能停用当前账号。');const result=await db().batch([db().prepare("UPDATE app_users SET disabled=?,password_version=password_version+1,updated_at=? WHERE id=? AND disabled<>? AND (?=0 OR role<>'admin' OR (SELECT COUNT(*) FROM app_users WHERE role='admin' AND disabled=0)>1)").bind(disable?1:0,now,id,disable?1:0,disable?1:0),db().prepare('DELETE FROM app_sessions WHERE user_id=?').bind(id)]);if(result[0].meta.changes!==1)throw new Error('账号不存在、状态未变化，或不能停用最后一位管理员。');}
 else if(v.action==='reset'){const id=typeof v.id==='string'?v.id:v.userId;const password=typeof v.password==='string'?v.password:v.newPassword;if(typeof id!=='string'||!goodPassword(password))throw new Error('账号或新密码不符合要求。');const c=await credentials(password);const result=await db().batch([db().prepare('UPDATE app_users SET password_salt=?,password_hash=?,password_iterations=?,password_version=password_version+1,must_change_password=1,updated_at=? WHERE id=? AND disabled=0').bind(c.salt,c.passwordHash,ITERATIONS,now,id),db().prepare('DELETE FROM app_sessions WHERE user_id=? AND EXISTS (SELECT 1 FROM app_users WHERE id=? AND password_hash=?)').bind(id,id,c.passwordHash)]);if(result[0].meta.changes!==1)throw new Error('账号不存在或已禁用。');}
 else throw new Error('不支持此操作。');return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}});}catch(e){return response(e instanceof Error?e.message:'操作失败。',400);}}
export async function changePassword(request:Request):Promise<Response>{try{const v=await body(request),u=await sessionUser(request.headers.get('cookie'));if(!u)return response('请先登录。',401);if(!await rateLimit(request,'change:'+u.userId))return response('请求过多，请稍后再试。',429);if(typeof v.oldPassword!=='string'||encoder.encode(v.oldPassword).length>512||!goodPassword(v.newPassword))throw new Error('原密码或新密码不符合要求；新密码至少12个字符。');const row=await db().prepare('SELECT * FROM app_users WHERE id=? AND disabled=0').bind(u.userId).first<UserRow>();if(!row||!equalPasswordHash(await derive(v.oldPassword,row.password_salt,row.password_iterations),row.password_hash))return response('原密码错误。',401);const c=await credentials(v.newPassword),now=Date.now();const result=await db().batch([db().prepare('UPDATE app_users SET password_salt=?,password_hash=?,password_iterations=?,password_version=password_version+1,must_change_password=0,updated_at=? WHERE id=? AND disabled=0 AND password_version=? AND password_hash=? AND EXISTS (SELECT 1 FROM app_sessions WHERE token_hash=? AND user_id=? AND expires_at>?)').bind(c.salt,c.passwordHash,ITERATIONS,now,row.id,row.password_version,row.password_hash,u.sessionHash,row.id,now),db().prepare('DELETE FROM app_sessions WHERE user_id=? AND EXISTS (SELECT 1 FROM app_users WHERE id=? AND password_hash=?)').bind(row.id,row.id,c.passwordHash)]);if(result[0].meta.changes!==1)throw new Error('账号状态已变化，请重新登录。');return Response.json({ok:true},{headers:{'Set-Cookie':clearCookie(),'Cache-Control':'no-store'}});}catch(e){return response(e instanceof Error?e.message:'修改密码失败。',400);}}

// Self-service administrator credential changes require the existing session and
// password. A forced-password-change session may also use this endpoint, since
// it is constrained to its own account and verifies the current password.
export async function changeCredentials(request:Request):Promise<Response>{try{
 const v=await body(request),u=await sessionUser(request.headers.get('cookie'));
 if(!u)return response('请先登录。',401);
 if(u.role!=='admin')return response('需要管理员权限。',403);
 if(!await rateLimit(request,'change:'+u.userId))return response('请求过多，请稍后再试。',429);
 const username=normalizeUsername(v.username);
 if(!username||typeof v.oldPassword!=='string'||encoder.encode(v.oldPassword).length>512||!goodOwnerPassword(v.newPassword))throw new Error('账号需为2至64位英文、数字或._-；新密码至少6个字符。');
 const row=await db().prepare('SELECT * FROM app_users WHERE id=? AND disabled=0 AND role=\'admin\'').bind(u.userId).first<UserRow>();
 if(!row?.platform_owner_id)return response('只有网站所有者可以执行此操作。',403);
 if(!row||!equalPasswordHash(await derive(v.oldPassword,row.password_salt,row.password_iterations),row.password_hash))return response('原密码错误。',401);
 const c=await credentials(v.newPassword),now=Date.now();
 const result=await db().batch([
  db().prepare('UPDATE app_users SET username=?,password_salt=?,password_hash=?,password_iterations=?,password_version=password_version+1,must_change_password=0,updated_at=? WHERE id=? AND role=\'admin\' AND disabled=0 AND password_version=? AND password_hash=? AND EXISTS (SELECT 1 FROM app_sessions WHERE token_hash=? AND user_id=? AND expires_at>?)').bind(username,c.salt,c.passwordHash,ITERATIONS,now,row.id,row.password_version,row.password_hash,u.sessionHash,row.id,now),
  db().prepare('DELETE FROM app_sessions WHERE user_id=? AND EXISTS (SELECT 1 FROM app_users WHERE id=? AND password_hash=?)').bind(row.id,row.id,c.passwordHash),
 ]);
 if(result[0].meta.changes!==1)throw new Error('账号状态已变化，请重新登录。');
 return Response.json({ok:true},{headers:{'Set-Cookie':clearCookie(),'Cache-Control':'no-store'}});
}catch(e){return response(e instanceof Error&&e.message.includes('UNIQUE constraint failed')?'该账号已存在。':e instanceof Error?e.message:'修改账号失败。',400);}}

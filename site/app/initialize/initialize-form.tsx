'use client';
import {PasswordInput} from '@/components/ui/password-input';
import {useState,type FormEvent} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from '@/components/ui/card';

export default function InitializeForm(){
 const [username,setUsername]=useState(''),[displayName,setDisplayName]=useState(''),[password,setPassword]=useState(''),[confirmation,setConfirmation]=useState('');
 const [busy,setBusy]=useState(false),[done,setDone]=useState(false),[error,setError]=useState('');
 async function submit(e:FormEvent){
  e.preventDefault();if(busy)return;
  if(password!==confirmation){setError('两次输入的密码不一致。');return;}
  setBusy(true);setError('');
  try{
   const r=await fetch('/api/app-auth/initialize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,displayName,password})});
   const result=await r.json() as {ok?:boolean;error?:string};
   if(!r.ok||!result.ok)throw new Error(result.error||'创建失败，请稍后重试。');
   setPassword('');setConfirmation('');setDone(true);
  }catch(e){setError(e instanceof Error?e.message:'创建失败，请稍后重试。');}
  finally{setBusy(false);}
 }
 return <main className="auth-screen"><div className="auth-brand">分摊 <span>Allocation</span></div><Card className="auth-card"><CardHeader><CardTitle>创建管理员账号</CardTitle><CardDescription>此入口仅供网站负责人首次设置。请直接在这里设置密码，不要发送给他人。</CardDescription></CardHeader><CardContent>{done?<><p className="auth-status" role="status">管理员账号已创建，请使用新账号登录。</p><a href="/login">前往登录</a></>:<form className="auth-form" onSubmit={submit}>
 <div className="field"><Label htmlFor="setup-name">显示名称</Label><Input id="setup-name" value={displayName} onChange={e=>setDisplayName(e.target.value)} required maxLength={80} disabled={busy}/></div>
 <div className="field"><Label htmlFor="setup-username">登录账号</Label><Input id="setup-username" autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} required minLength={2} maxLength={64} disabled={busy}/><span className="auth-help">2 至 64 位英文字母、数字或 . _ -</span></div>
 <div className="field"><Label htmlFor="setup-password">设置密码</Label><PasswordInput id="setup-password" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} required minLength={12} maxLength={256} disabled={busy}/><span className="auth-help">至少 12 个字符，请使用不易猜测的密码。</span></div>
 <div className="field"><Label htmlFor="setup-confirmation">确认密码</Label><PasswordInput id="setup-confirmation" autoComplete="new-password" value={confirmation} onChange={e=>setConfirmation(e.target.value)} required minLength={12} maxLength={256} disabled={busy}/></div>
 {error&&<p className="auth-error" role="alert">{error}</p>}<Button type="submit" disabled={busy}>{busy?'正在创建…':'创建管理员账号'}</Button></form>}</CardContent></Card></main>;
}

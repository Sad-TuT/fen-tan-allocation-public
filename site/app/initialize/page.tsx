import {canInitializeAccount} from '../lib/app-auth';
import InitializeForm from './initialize-form';

export const dynamic='force-dynamic';

export default async function InitializePage(){
 let available=false;
 try {available=await canInitializeAccount();} catch {available=false;}
 if(!available)return <main className="auth-screen"><div className="auth-brand">分摊 <span>Allocation</span></div><div className="auth-card"><h1>初始化入口不可用</h1><p>请联系网站负责人，或使用已有账号登录。</p><a href="/login">返回登录</a></div></main>;
 return <InitializeForm/>;
}

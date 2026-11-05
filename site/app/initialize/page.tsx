import {canInitializeAccount} from '../lib/app-auth';
import InitializeForm from './initialize-form';
import {Button} from '@/components/ui/button';
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from '@/components/ui/card';

export const dynamic='force-dynamic';

export default async function InitializePage(){
 let available=false;
 try {available=await canInitializeAccount();} catch {available=false;}
 if(!available)return <main className="auth-screen"><div className="auth-brand">分摊 <span>Allocation</span></div><Card className="auth-card"><CardHeader><CardTitle>初始化入口不可用</CardTitle><CardDescription>网站已经完成初始化。请使用管理员分配的账号登录；如需重置或新增账号，请联系网站负责人。</CardDescription></CardHeader><CardContent><Button asChild><a href="/login">返回登录</a></Button></CardContent></Card></main>;
 return <InitializeForm/>;
}

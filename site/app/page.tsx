import { redirect } from 'next/navigation';
import Dashboard from './dashboard';
import { PasswordChange } from './account-panel';
import { getAppUser } from './lib/app-auth';
export const dynamic = 'force-dynamic';
export default async function Home(){const user=await getAppUser();if(!user)redirect('/login');if(user.mustChangePassword)return <PasswordChange forced />;return <Dashboard user={{name:user.displayName,email:user.email??'',role:user.role,id:user.userId}}/>;}

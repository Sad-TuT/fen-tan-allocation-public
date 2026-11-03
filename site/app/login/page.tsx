import { redirect } from 'next/navigation';
import { getAppUser } from '../lib/app-auth';
import LoginForm from './login-form';
export const dynamic='force-dynamic';
export default async function LoginPage(){if(await getAppUser())redirect('/');return <LoginForm/>;}

import Link from 'next/link';
import {Button} from '@/components/ui/button';
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from '@/components/ui/card';

// 默认 404 是 Next 的英文页面；这里换成与全站一致的中文空状态。
export default function NotFound(){
 return <main className="auth-screen">
  <div className="auth-brand">分摊 <span>Allocation</span></div>
  <Card className="auth-card">
   <CardHeader>
    <CardTitle>页面不存在</CardTitle>
        <CardDescription>这个地址没有对应的页面，可能是链接输入有误，或该批次记录不存在。</CardDescription>
   </CardHeader>
   <CardContent>
    <Button asChild><Link href="/">返回工作台</Link></Button>
   </CardContent>
  </Card>
 </main>;
}

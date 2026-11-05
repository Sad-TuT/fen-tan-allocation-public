'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

// 默认错误边界是 Next 的英文页面；这里换成中文说明，并且不泄露错误细节。
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // 只把错误留在浏览器控制台，便于排查；不向用户展示堆栈。
    console.error(error);
  }, [error]);

  return (
    <main className="auth-screen">
      <div className="auth-brand">分摊 <span>Allocation</span></div>
      <Card className="auth-card">
        <CardHeader>
          <CardTitle>页面暂时无法显示</CardTitle>
          <CardDescription>刚才的操作没有完成。请先回到工作台核对批次和余额状态，再决定是否重试，避免重复提交。</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="account-actions">
            <Button onClick={() => window.location.assign('/')}>返回工作台</Button>
            <Button variant="ghost" onClick={reset}>重新加载</Button>
          </div>
          {error.digest && <p className="field-note">问题编号：{error.digest}</p>}
        </CardContent>
      </Card>
    </main>
  );
}

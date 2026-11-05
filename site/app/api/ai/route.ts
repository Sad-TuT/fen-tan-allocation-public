import { getAppUser } from '../../lib/app-auth';
import { aiAsk, aiConfigured, aiParseDraft, aiPrecheck } from '../../lib/ai';
import { hasTrustedOrigin, requestAddress } from '../../lib/request-security';

export const dynamic = 'force-dynamic';

const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: Request) {
  if (!requestAddress(request)) return reply({ error: '请求地址不受信任。' }, 403);
  const user = await getAppUser();
  if (!user) return reply({ error: '请先登录。' }, 401);
  if (user.mustChangePassword) return reply({ error: '请先修改初始密码。' }, 403);
  if (!hasTrustedOrigin(request)) return reply({ error: '来源不受信任' }, 403);
  if (!aiConfigured()) return reply({ error: 'AI 尚未配置：服务器缺少 DEEPSEEK_API_KEY。' }, 503);
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return reply({ error: '请求格式无效。' }, 415);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad body');
    body = parsed as Record<string, unknown>;
  } catch {
    return reply({ error: '请求格式无效。' }, 415);
  }
  const action = String(body.action ?? '');
  try {
    if (action === 'parse') return reply({ ok: true, ...(await aiParseDraft(String(body.text ?? ''), user.userId)) });
    if (action === 'precheck') return reply({ ok: true, ...(await aiPrecheck(String(body.batchId ?? ''), user.userId)) });
    if (action === 'ask') return reply({ ok: true, ...(await aiAsk(String(body.question ?? ''), user.userId)) });
    return reply({ error: '不支持此操作。' }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI 处理失败。';
    const status = message.startsWith('请求过多') ? 429 : message.startsWith('AI 尚未配置') ? 503 : 400;
    return reply({ error: message }, status);
  }
}

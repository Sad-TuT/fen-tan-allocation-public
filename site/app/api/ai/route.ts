import { getAppUser } from '../../lib/app-auth';
import { aiConfigured, aiWorkspaceMessage, aiWorkspacePrecheck } from '../../lib/ai';
import { hasTrustedOrigin, requestAddress } from '../../lib/request-security';

export const dynamic = 'force-dynamic';

const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function readBoundedJson(request: Request, maxBytes: number): Promise<Record<string, unknown> | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('body limit exceeded').catch(() => undefined);
        throw Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' });
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

export async function GET(request: Request) {
  if (!requestAddress(request)) return reply({ error: '请求地址不受信任。' }, 403);
  const user = await getAppUser();
  if (!user) return reply({ error: '请先登录。' }, 401);
  if (user.mustChangePassword) return reply({ error: '请先修改初始密码。' }, 403);
  return reply({ configured: aiConfigured() });
}

export async function POST(request: Request) {
  if (!requestAddress(request)) return reply({ error: '请求地址不受信任。' }, 403);
  const user = await getAppUser();
  if (!user) return reply({ error: '请先登录。' }, 401);
  if (user.mustChangePassword) return reply({ error: '请先修改初始密码。' }, 403);
  if (!hasTrustedOrigin(request)) return reply({ error: '来源不受信任' }, 403);
  if (!aiConfigured()) return reply({ error: 'AI 服务尚未就绪，可以继续手动录入，或稍后重试。' }, 503);
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return reply({ error: '请求格式无效。' }, 415);
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) return reply({ error: '请求格式无效。' }, 415);
    if (contentLength > 48 * 1024) return reply({ error: '本次AI请求过长，请缩短问题或减少发送的表格行。' }, 413);
  }
  let body: Record<string, unknown> | null;
  try { body = await readBoundedJson(request, 48 * 1024); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'BODY_TOO_LARGE') return reply({ error: '本次AI请求过长，请缩短问题或减少发送的表格行。' }, 413);
    return reply({ error: '请求格式无效。' }, 415);
  }
  if (!body) return reply({ error: '请求格式无效。' }, 415);
  const action = String(body.action ?? '');
  try {
    if (action === 'workspace') {
      const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
      return reply({ ok: true, ...(await aiWorkspaceMessage({
        message: String(body.message ?? ''),
        userId: user.userId,
        ...(typeof body.jobId === 'string' ? { jobId: body.jobId } : {}),
        history,
        ...(body.visibleData && typeof body.visibleData === 'object' ? { visibleData: body.visibleData } : {}),
        signal: request.signal,
      })) });
    }
    if (action === 'workspace-precheck') return reply({ ok: true, ...(await aiWorkspacePrecheck({ jobId: String(body.jobId ?? ''), userId: user.userId, signal: request.signal })) });
    return reply({ error: '不支持此操作。' }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI 处理失败。';
    const status = message.startsWith('请求过多') ? 429 : message.startsWith('AI 尚未配置') || message.startsWith('AI 服务尚未就绪') ? 503 : message.startsWith('AI 服务') || message.startsWith('AI 没有返回') ? 502 : 400;
    return reply({ error: message }, status);
  }
}

import { getAppUser } from "../../lib/app-auth";
import { hasTrustedOrigin, requestAddress } from "../../lib/request-security";
import { tryAcquireUploadSlot } from "../../lib/upload-gate";
import {
  adoptProcessingJob, createProcessingJob, discardProcessingJob,
  downloadProcessingJobFile, getProcessingJob, listProcessingJobs, prepareProcessingJob,
  previewProcessingJobFile, ProcessingJobError, simulateProcessingJob, uploadProcessingJobFile, pasteSourceProcessingJob,
} from "../../lib/processing-jobs";

export const dynamic = "force-dynamic";
const reply = (value: unknown, status = 200, extra: Record<string, string> = {}) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store", ...extra } });

async function boundedBytes(request: Request, maximum: number): Promise<Uint8Array> {
  if (!request.body) throw new ProcessingJobError("请求内容为空。", 400, "EMPTY_REQUEST");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new ProcessingJobError("请求超过大小限制。", 413, "REQUEST_TOO_LARGE");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
function parseSmallInteger(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  if (!/^\d{1,8}$/.test(value)) throw new ProcessingJobError("分页参数无效。");
  return Number(value);
}
async function signedIn(request: Request) {
  const user = await getAppUser();
  if (!user) throw new ProcessingJobError("请先登录。", 401, "UNAUTHENTICATED");
  if (user.mustChangePassword) throw new ProcessingJobError("请先修改初始密码。", 403, "PASSWORD_CHANGE_REQUIRED");
  if (!requestAddress(request)) throw new ProcessingJobError("请求地址不受信任。", 403, "UNTRUSTED_ADDRESS");
  return user;
}
function publicError(error: unknown): Response {
  const value = error as { status?: unknown; code?: unknown; ambiguities?: unknown };
  const status = typeof value?.status === "number" && value.status >= 400 && value.status < 600 ? value.status : 400;
  const message = error instanceof Error ? error.message : "任务操作失败，请核对本批资料。";
  if (value?.code === "AMBIGUOUS_ASSIGNMENT" && Array.isArray(value.ambiguities)) {
    return reply({ error: message, code: value.code, ambiguities: value.ambiguities }, 400);
  }
  return reply({ error: message, code: typeof value?.code === "string" ? value.code : "PROCESSING_JOB_ERROR" }, status);
}

export async function GET(request: Request) {
  try {
    const user = await signedIn(request);
    const params = new URL(request.url).searchParams;
    const id = params.get("id");
    if (!id) return reply(await listProcessingJobs(user));
    const downloadId = params.get("download");
    if (downloadId) {
      const { file, bytes } = await downloadProcessingJobFile(id, downloadId, user);
      const disposition = "attachment; filename*=UTF-8''" + encodeURIComponent(file.fileName);
      const output = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(output).set(bytes);
      return new Response(output, {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": file.role === "tax-overrides" ? "application/json; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": disposition,
          "Content-Length": String(bytes.byteLength),
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    const fileId = params.get("file");
    if (fileId) {
      const release = tryAcquireUploadSlot();
      if (!release) return reply({ error: "文件预览任务已满，请稍后重试。", code: "PREVIEW_BUSY" }, 429, { "Retry-After": "5" });
      try {
        const preview = await previewProcessingJobFile({
          id, fileId, sheetName: params.get("sheet"), offset: parseSmallInteger(params.get("offset"), 0),
          limit: parseSmallInteger(params.get("limit"), 50), search: params.get("search"),
        }, user);
        return reply(preview);
      } finally { release(); }
    }
    return reply({ job: await getProcessingJob(id, user) });
  } catch (error) { return publicError(error); }
}

export async function POST(request: Request) {
  let user: Awaited<ReturnType<typeof getAppUser>>;
  try { user = await signedIn(request); }
  catch (error) { return publicError(error); }
  if (!user) return reply({ error: "请先登录。", code: "UNAUTHENTICATED" }, 401);
  if (!hasTrustedOrigin(request)) return reply({ error: "请求来源不受信任。", code: "UNTRUSTED_ORIGIN" }, 403);
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  try {
    const contentLength = request.headers.get("content-length");
    if (contentLength !== null) {
      if (!/^\d{1,9}$/.test(contentLength) || Number(contentLength) <= 0) throw new ProcessingJobError("请求大小无效。");
    }
    if (contentType.startsWith("multipart/form-data")) {
      if (contentLength === null || Number(contentLength) > 12 * 1024 * 1024) throw new ProcessingJobError("上传请求必须有有效长度且不超过12MB。", 413, "REQUEST_TOO_LARGE");
      const release = tryAcquireUploadSlot();
      if (!release) return reply({ error: "当前文件处理任务已满，请稍后重试。", code: "UPLOAD_BUSY" }, 429, { "Retry-After": "15" });
      try {
        const bytes = await boundedBytes(request, 12 * 1024 * 1024);
        const headers = new Headers(request.headers);
        headers.delete("content-length");
        const boundedBody = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(boundedBody).set(bytes);
        const bounded = new Request(request.url, { method: "POST", headers, body: boundedBody });
        const form = await bounded.formData();
        const action = String(form.get("action") ?? "");
        const id = String(form.get("id") ?? "");
        const revision = Number(form.get("revision"));
        if (action === "upload") {
          const file = form.get("file");
          if (!(file instanceof File) || !file.size || file.size > 10 * 1024 * 1024) throw new ProcessingJobError("文件为空或超过10MB上限。", 413, "FILE_TOO_LARGE");
          const job = await uploadProcessingJobFile({
            id, revision, role: form.get("role"), name: file.name, bytes: new Uint8Array(await file.arrayBuffer()),
            priority: form.has("priority") ? Number(form.get("priority")) : undefined,
            allowBlankDepartment: String(form.get("allowBlankDepartment") ?? "") === "true",
          }, user);
          return reply({ job });
        }
        return reply({ error: "不支持的文件操作。", code: "UNSUPPORTED_ACTION" }, 400);
      } finally { release(); }
    }
    if (!contentType.startsWith("application/json")) throw new ProcessingJobError("请求格式无效。", 415, "UNSUPPORTED_MEDIA_TYPE");
    if (contentLength !== null && Number(contentLength) > 1_048_576) throw new ProcessingJobError("请求内容超过1MB上限。", 413, "REQUEST_TOO_LARGE");
    const bodyBytes = await boundedBytes(request, 1_048_576);
    let body: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      body = value as Record<string, unknown>;
    } catch { throw new ProcessingJobError("请求内容必须是有效的JSON对象。", 400, "INVALID_JSON"); }
    const action = String(body.action ?? "");
    let job;
    if (action === "create") job = await createProcessingJob(user);
    else if (action === "simulate") {
      return reply(await simulateProcessingJob({
        id: body.id, revision: body.revision, product: body.product, price: body.price, quantity: body.quantity,
        assignments: body.assignments,
      }, user));
    } else if (action === "prepare") {
      return reply(await prepareProcessingJob({
        id: body.id, revision: body.revision, product: body.product, price: body.price, quantity: body.quantity,
        assignments: body.assignments,
      }, user));
    } else if (action === "adopt") {
      job = await adoptProcessingJob({ id: body.id, revision: body.revision, ack: body.ack, fileHashes: body.fileHashes }, user);
    } else if (action === "discard") {
      job = await discardProcessingJob({ id: body.id, revision: body.revision, reason: body.reason }, user);
    } else if (action === "paste-source") {
      job = await pasteSourceProcessingJob({
        id: body.id, revision: body.revision, text: body.text,
        name: body.fileName, priority: body.priority, ackAvailableOnly: body.ackAvailableOnly,
      }, user);
    } else {
      throw new ProcessingJobError("不支持的任务操作。", 400, "UNSUPPORTED_ACTION");
    }
    return reply({ job });
  } catch (error) { return publicError(error); }
}

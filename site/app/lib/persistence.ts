import { env } from "./node-runtime";
import {
  assertTwoIndependentReviews, normalizeFinancials, stableJSONString,
  validateReviewReport, type FinancialResults, type ReviewReport,
} from "./review-policy";

const WORKSPACE_ID = "main";
const EMPTY_STATE = { sources: [], taxes: [], productHistory: [] };
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const JSON_TYPE = "application/json; charset=utf-8";
type Row = Record<string, unknown>;

export type StoredBatch = {
  id: string; product: string; createdAt: string; createdBy: string;
  versionAtCreation: number; status: string; data: Record<string, any>;
  completedAt?: string | null;
};

function db(): D1Database {
  if (!env.DB) throw new Error("当前网站尚未配置共享数据库DB。");
  return env.DB;
}
function bucket(): R2Bucket {
  if (!env.BUCKET) throw new Error("当前网站尚未配置文件存储BUCKET。");
  return env.BUCKET;
}
function text(value: unknown, label: string, max = 300): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label}无效。`);
  return value;
}
function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("余额版本无效。");
  return value;
}
function validKey(key: string): string {
  text(key, "文件标识", 1000);
  if (key.startsWith("/") || key.includes("\\") || key.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("文件标识包含无效路径。");
  }
  return key;
}
function bytesForJSON(value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(stableJSONString(value));
  if (bytes.byteLength > MAX_JSON_BYTES) throw new Error("数据超过本网站单批容量，请拆分来源或批次。");
  return bytes;
}
async function hash(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function initialize(): Promise<void> {
  await db().prepare("INSERT OR IGNORE INTO allocation_workspace (id, version, data_key, last_batch_id, updated_at) VALUES (?, 0, NULL, NULL, ?)")
    .bind(WORKSPACE_ID, new Date().toISOString()).run();
}
async function readJSON(key: string): Promise<any> {
  const file = await readFile(key);
  if (!file) throw new Error("已登记的数据文件缺失，请停止操作并核对存储。");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
}
async function writeJSON(prefix: string, value: unknown): Promise<string> {
  const bytes = bytesForJSON(value);
  const key = `${prefix}/${crypto.randomUUID()}.json`;
  await storeFile(key, bytes, JSON_TYPE);
  return key;
}
async function event(kind: string, actor: string, detail: unknown, batchId: string | null = null): Promise<void> {
  await db().prepare("INSERT INTO allocation_events (id, kind, batch_id, actor, created_at, detail_json) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), kind, batchId, actor, new Date().toISOString(), stableJSONString(detail)).run();
}

/** File keys are immutable: retries may re-store identical bytes, never replace an audited file. */
export async function storeFile(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  validKey(key);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_FILE_BYTES) throw new Error("文件超过20MB容量限制或文件内容无效。");
  text(contentType, "文件类型", 200);
  const digest = await hash(bytes);
  const stored = await bucket().put(key, bytes as any, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType }, customMetadata: { sha256: digest },
  });
  if (stored) return;
  const existing = await bucket().get(key);
  if (!existing || await hash(new Uint8Array(await existing.arrayBuffer())) !== digest) {
    throw new Error("同名文件已存在且内容不同，已阻止覆盖已登记或已核验文件。");
  }
}

export async function readFile(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const object = await bucket().get(validKey(key));
  if (!object) return null;
  if (object.size > MAX_FILE_BYTES) throw new Error("存储文件超过本网站处理容量。");
  return { bytes: new Uint8Array(await object.arrayBuffer()), contentType: object.httpMetadata?.contentType || "application/octet-stream" };
}

export async function loadWorkspace(): Promise<{ version: number; state: any }> {
  await initialize();
  const row = await db().prepare("SELECT version, data_key FROM allocation_workspace WHERE id = ?").bind(WORKSPACE_ID).first<Row>();
  if (!row) throw new Error("余额账簿初始化失败。");
  return { version: version(row.version), state: row.data_key ? await readJSON(String(row.data_key)) : JSON.parse(JSON.stringify(EMPTY_STATE)) };
}

export async function saveWorkspace(expectedVersion: number, state: any, actor: string): Promise<void> {
  version(expectedVersion); text(actor, "操作人");
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("账簿数据无效。");
  await initialize();
  const key = await writeJSON("workspace", state);
  const at = new Date().toISOString();
  const token = crypto.randomUUID();
  const results = await db().batch([
    db().prepare("UPDATE allocation_workspace SET data_key = ?, version = version + 1, last_batch_id = NULL, updated_at = ? WHERE id = ? AND version = ?")
      .bind(key, at, WORKSPACE_ID, expectedVersion),
    db().prepare("INSERT INTO allocation_events (id, kind, batch_id, actor, created_at, detail_json) SELECT ?, 'workspace_updated', NULL, ?, ?, ? WHERE EXISTS (SELECT 1 FROM allocation_workspace WHERE id = ? AND version = ? AND data_key = ?)")
      .bind(token, actor, at, stableJSONString({ previousVersion: expectedVersion, nextVersion: expectedVersion + 1 }), WORKSPACE_ID, expectedVersion + 1, key),
  ]);
  if (results[0].meta.changes !== 1) throw new Error("当前余额已发生变化，请刷新并重新导入或试算。");
}

export async function createBatch(batch: StoredBatch): Promise<void> {
  text(batch.id, "批次编号"); text(batch.product, "商品名称"); text(batch.createdBy, "创建人"); text(batch.createdAt, "创建时间");
  version(batch.versionAtCreation);
  if (batch.status !== "awaiting_review") throw new Error("新批次必须先进入待双agent核验状态。");
  const expectation = batch.data;
  if (!expectation || !/^[a-f\d]{64}$/i.test(expectation.reviewDigest)) throw new Error("缺少待核验版本摘要。");
  const financials = normalizeFinancials(expectation.expectedFinancials);
  await validateManifest(expectation.manifest);
  const workspace = await loadWorkspace();
  if (workspace.version !== batch.versionAtCreation) throw new Error("试算使用的余额版本已过期，请重新试算。");
  const key = await writeJSON("batches", batch.data);
  const result = await db().prepare("INSERT INTO allocation_batches (id, product, created_at, created_by, version_at_creation, status, data_key, total_cents, quantity, review_digest, completed_at) SELECT ?, ?, ?, ?, ?, 'awaiting_review', ?, ?, ?, ?, NULL WHERE EXISTS (SELECT 1 FROM allocation_workspace WHERE id = ? AND version = ?)")
    .bind(batch.id, batch.product, batch.createdAt, batch.createdBy, batch.versionAtCreation, key, financials.totalCents, financials.quantity, String(expectation.reviewDigest).toLowerCase(), WORKSPACE_ID, batch.versionAtCreation).run();
  if (result.meta.changes !== 1) throw new Error("试算保存前余额已变化，请重新试算。");
  await event("batch_created", batch.createdBy, { versionAtCreation: batch.versionAtCreation, totalCents: financials.totalCents, quantity: financials.quantity }, batch.id);
}

function batchSummary(row: Row) {
  return {
    id: String(row.id), product: String(row.product), createdAt: String(row.created_at), createdBy: String(row.created_by),
    versionAtCreation: Number(row.version_at_creation), status: String(row.status),
    totalCents: Number(row.total_cents), quantity: Number(row.quantity), reviewDigest: String(row.review_digest),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
  };
}

export async function getBatch(id: string): Promise<StoredBatch | null> {
  const row = await db().prepare("SELECT * FROM allocation_batches WHERE id = ?").bind(text(id, "批次编号")).first<Row>();
  return row ? { ...batchSummary(row), data: await readJSON(String(row.data_key)) } : null;
}

export async function listBatches(): Promise<any[]> {
  await initialize();
  const rows = await db().prepare("SELECT b.*, w.version AS current_version, (SELECT COUNT(*) FROM allocation_reviews r WHERE r.batch_id = b.id AND r.status = 'passed') AS passed_reviews FROM allocation_batches b JOIN allocation_workspace w ON w.id = ? ORDER BY b.created_at DESC, b.id DESC LIMIT 100")
    .bind(WORKSPACE_ID).all<Row>();
  return rows.results.map((row) => ({ ...batchSummary(row), passedReviews: Number(row.passed_reviews), isStale: row.status === "awaiting_review" && Number(row.version_at_creation) !== Number(row.current_version) }));
}

export async function getReviews(batchId: string): Promise<any[]> {
  const rows = await db().prepare("SELECT * FROM allocation_reviews WHERE batch_id = ? ORDER BY submitted_at, id").bind(text(batchId, "批次编号")).all<Row>();
  return Promise.all(rows.results.map(async (row) => ({
    ...await readJSON(String(row.data_key)), submittedAt: String(row.submitted_at), submittedBy: String(row.submitted_by),
  })));
}

/** Server callers expose this through authenticated MCP only, never a browser approval button. */
export async function submitReview(batchId: string, value: unknown, actor: string): Promise<void> {
  text(actor, "提交人");
  const batch = await getBatch(batchId);
  if (!batch) throw new Error("批次不存在。");
  if (batch.status !== "awaiting_review") throw new Error("已入账批次不能替换或追加核验报告。");
  const workspace = await loadWorkspace();
  if (workspace.version !== batch.versionAtCreation) throw new Error("批次余额版本已过期，请重新试算后核验。");
  const report = validateReviewReport(batch.data as any, value);
  const existing = await getReviews(batchId);
  const same = existing.find((item) => item.reviewerId === report.reviewerId || item.reviewerRunId === report.reviewerRunId);
  if (same) {
    const normalized = validateReviewReport(batch.data as any, same);
    if (stableJSONString(normalized) === stableJSONString(report)) return;
    throw new Error("同一agent或执行编号已有不可变核验报告，请保留原报告并创建修正后的新批次。");
  }
  if (existing.length >= 2) throw new Error("本批已保存两份独立报告，不能追加报告覆盖原结论。");
  const key = await writeJSON("reviews", report);
  const at = new Date().toISOString();
  const result = await db().prepare("INSERT INTO allocation_reviews (id, batch_id, reviewer_id, reviewer_run_id, status, review_digest, data_key, submitted_at, submitted_by) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM allocation_reviews WHERE batch_id = ?) < 2 AND EXISTS (SELECT 1 FROM allocation_batches b JOIN allocation_workspace w ON w.id = ? WHERE b.id = ? AND b.status = 'awaiting_review' AND b.version_at_creation = w.version)")
    .bind(crypto.randomUUID(), batchId, report.reviewerId, report.reviewerRunId, report.status, report.reviewDigest, key, at, actor, batchId, WORKSPACE_ID, batchId).run();
  if (result.meta.changes !== 1) throw new Error("报告保存时批次或余额发生变化，请刷新核对。");
  await event("review_submitted", actor, { reviewerId: report.reviewerId, reviewerRunId: report.reviewerRunId, status: report.status, reviewDigest: report.reviewDigest }, batchId);
}

async function validateManifest(value: unknown): Promise<void> {
  if (!Array.isArray(value) || value.length < 4 || value.length > 30) throw new Error("正式结果文件清单不完整。");
  const keys = new Set<string>();
  for (const file of value) {
    if (!file || typeof file !== "object") throw new Error("结果文件清单无效。");
    const key = validKey(file.key); text(file.name, "文件名", 500); text(file.role, "文件用途", 100);
    if (keys.has(key) || !/^[a-f\d]{64}$/i.test(file.sha256)) throw new Error("文件标识重复或SHA-256无效。");
    keys.add(key);
    const actual = await readFile(key);
    if (!actual || await hash(actual.bytes) !== file.sha256.toLowerCase()) throw new Error(`结果文件缺失或已改变：${file.name}。`);
  }
}

export async function commitBatch(batchId: string, nextState: any, actor: string): Promise<StoredBatch> {
  text(actor, "操作人");
  const batch = await getBatch(batchId);
  if (!batch) throw new Error("批次不存在。");
  if (batch.status === "completed" || batch.status === "completed_with_tax_pending") return batch;
  if (batch.status !== "awaiting_review") throw new Error("当前批次不允许入账。");
  if (stableJSONString(nextState) !== stableJSONString(batch.data.nextState)) throw new Error("提交的下一批余额与已核验版本不一致。");
  const reviews = await getReviews(batchId);
  assertTwoIndependentReviews(batch.data as any, reviews);
  await validateManifest(batch.data.manifest);
  const workspace = await loadWorkspace();
  if (workspace.version !== batch.versionAtCreation) throw new Error("当前余额已被其他操作更新，请重新试算并双审。");
  const key = await writeJSON("workspace", batch.data.nextState);
  const at = new Date().toISOString();
  const status = Number(batch.data.taxPending || 0) > 0 ? "completed_with_tax_pending" : "completed";
  const results = await db().batch([
    db().prepare("UPDATE allocation_workspace SET data_key = ?, version = version + 1, last_batch_id = ?, updated_at = ? WHERE id = ? AND version = ? AND EXISTS (SELECT 1 FROM allocation_batches WHERE id = ? AND status = 'awaiting_review') AND (SELECT COUNT(*) FROM allocation_reviews WHERE batch_id = ? AND status = 'passed' AND review_digest = ?) = 2 AND (SELECT COUNT(*) FROM allocation_reviews WHERE batch_id = ?) = 2")
      .bind(key, batchId, at, WORKSPACE_ID, batch.versionAtCreation, batchId, batchId, batch.data.reviewDigest.toLowerCase(), batchId),
    db().prepare("UPDATE allocation_batches SET status = ?, completed_at = ? WHERE id = ? AND status = 'awaiting_review' AND EXISTS (SELECT 1 FROM allocation_workspace WHERE id = ? AND version = ? AND last_batch_id = ? AND data_key = ?)")
      .bind(status, at, batchId, WORKSPACE_ID, batch.versionAtCreation + 1, batchId, key),
    db().prepare("INSERT INTO allocation_events (id, kind, batch_id, actor, created_at, detail_json) SELECT ?, 'batch_committed', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM allocation_workspace WHERE id = ? AND version = ? AND last_batch_id = ? AND data_key = ?) AND EXISTS (SELECT 1 FROM allocation_batches WHERE id = ? AND status = ?) ON CONFLICT(id) DO NOTHING")
      .bind(`commit-${batchId}`, batchId, actor, at, stableJSONString({ previousVersion: batch.versionAtCreation, nextVersion: batch.versionAtCreation + 1, status }), WORKSPACE_ID, batch.versionAtCreation + 1, batchId, key, batchId, status),
  ]);
  const actual = await getBatch(batchId);
  if (results[0].meta.changes !== 1) {
    if (actual && (actual.status === "completed" || actual.status === "completed_with_tax_pending")) return actual;
    throw new Error("入账时余额版本或双审状态发生变化，本次未扣减金额。");
  }
  if (!actual || actual.status !== status) throw new Error("入账状态异常，请停止后续操作并核对账簿。");
  return actual;
}

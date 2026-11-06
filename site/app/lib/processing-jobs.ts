import "server-only";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { env } from "./node-runtime";
import { ALLOCATION_RULE_VERSION, planAllocation, validateAllocationPlan } from "./allocation";
import {
  assertDistinctSourceBalance, digest, generateBatchFiles, parseSource, parseTaxOverrides, parseTaxes, type ImportedSource,
  type ProductHistory, type TaxOverride, type TaxRecord,
} from "./spreadsheets";
import { normalizeSpreadsheetNamespaces } from "./xlsx-namespace-compat";
import { validateXlsxArchive } from "./xlsx-limits";
import { sourceFromClipboard } from "./paste-source";
import type {
  ProcessingFile, ProcessingFileRole, ProcessingJob, ProcessingJobPreview, ProcessingJobSummary,
  ProcessingJobStatus, ProcessingSourceSummary,
} from "./processing-job-types";
import type { AppUser } from "./app-auth";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_JOB_FILES = 30;
const MAX_JOB_SOURCES = 10;
const MAX_PREVIEW_COLUMNS = 100;
const MAX_PREVIEW_ROWS = 100;
const MAX_PREVIEW_SEARCH_ROWS = 25_000;
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const JSON_TYPE = "application/json; charset=utf-8";
type DbRow = Record<string, unknown>;
type StoredFile = ProcessingFile & { key: string };
type JobRow = DbRow & {
  id: string; owner_id: string; parent_job_id: string | null; status: ProcessingJobStatus; revision: number;
  data_key: string; source_fingerprint: string; product: string | null; total_cents: number | null;
  quantity: number | null; created_at: string; updated_at: string; adopted_at: string | null;
  adopted_by: string | null; discarded_at: string | null; discard_reason: string | null;
};
type JobData = {
  schemaVersion: 1; revision: number; createdAt: string; updatedAt: string; parentJobId: string | null;
  sources: ImportedSource[]; taxes: TaxRecord[]; taxOverrides: TaxOverride[]; taxFileId: string | null;
  taxOverrideFileId: string | null; templateFileId: string | null; productHistory: ProductHistory[];
  product: string | null; priceCents: number | null; quantity: number | null;
  plan: ReturnType<typeof planAllocation> | null; files: StoredFile[];
  planStale?: boolean;
  nextSourceFiles: { sourceId: string; fileId: string }[]; taxPending: number;
  adoptedAt: string | null; adoptedBy: string | null; discardedAt: string | null;
  discardReason: string | null; warnings: string[];
};

export class ProcessingJobError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 400, code = "PROCESSING_JOB_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "ProcessingJobError";
  }
}
function db(): D1Database {
  if (!env.DB) throw new ProcessingJobError("任务数据库尚未配置。", 503, "STORAGE_UNAVAILABLE");
  return env.DB;
}
function bucket(): R2Bucket {
  if (!env.BUCKET) throw new ProcessingJobError("任务文件存储尚未配置。", 503, "STORAGE_UNAVAILABLE");
  return env.BUCKET;
}
function ensureWriter(user: AppUser): void {
  if (user.mustChangePassword) throw new ProcessingJobError("请先修改初始密码。", 403, "PASSWORD_CHANGE_REQUIRED");
  if (user.role === "viewer") throw new ProcessingJobError("查看账号不能修改任务。", 403, "FORBIDDEN");
}
function validateId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ProcessingJobError("任务编号无效。", 400, "INVALID_JOB_ID");
  }
  return value.toLowerCase();
}
function revisionNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ProcessingJobError("任务版本无效，请刷新后重试。");
  return value;
}
function safeName(value: unknown): string {
  if (typeof value !== "string") throw new ProcessingJobError("文件名无效。");
  const name = value.trim().replace(/[\u0000-\u001f\u007f]/g, "_").split(/[\\/]/).pop() ?? "";
  if (!name || name.length > 180 || name === "." || name === "..") throw new ProcessingJobError("文件名无效或过长。");
  return name;
}
function ownerFilter(user: AppUser, column: string): { sql: string; args: string[] } {
  return user.role === "admin" ? { sql: "", args: [] } : { sql: " AND " + column + " = ?", args: [user.userId] };
}
function objectPrefix(id: string): string { return "processing-jobs/" + id; }
function newId(): string { return randomUUID(); }
async function readObject(key: string): Promise<Uint8Array> {
  const result = await bucket().get(key);
  if (!result) throw new ProcessingJobError("任务文件缺失，请停止操作并核实存储。", 500, "OBJECT_MISSING");
  if (result.size > MAX_UPLOAD_BYTES) throw new ProcessingJobError("任务文件超过处理上限。", 413, "FILE_TOO_LARGE");
  return new Uint8Array(await result.arrayBuffer());
}
async function writeObject(key: string, bytes: Uint8Array, contentType: string, sha: string): Promise<void> {
  const payload = bytes.slice().buffer as ArrayBuffer;
  const stored = await bucket().put(key, payload, {
    onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType }, customMetadata: { sha256: sha },
  });
  if (stored) return;
  const existing = await bucket().get(key);
  if (!existing || await digest(new Uint8Array(await existing.arrayBuffer())) !== sha) {
    throw new ProcessingJobError("同名任务文件已经存在且内容不同，已阻止覆盖。", 409, "FILE_COLLISION");
  }
}
async function writeJson(jobId: string, version: number, data: JobData): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  if (bytes.byteLength > 16 * 1024 * 1024) throw new ProcessingJobError("本批资料展开后过大，请拆分来源表后重试。", 413, "JOB_DATA_TOO_LARGE");
  const sha = await digest(bytes);
  const key = objectPrefix(jobId) + "/state/r" + version + "-" + sha + ".json";
  await writeObject(key, bytes, JSON_TYPE, sha);
  return key;
}
async function writeFile(jobId: string, role: ProcessingFileRole, name: string, bytes: Uint8Array, sourceId?: string, priority?: number): Promise<StoredFile> {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.byteLength > MAX_UPLOAD_BYTES) throw new ProcessingJobError("文件为空或超过10MB上限。", 413, "FILE_TOO_LARGE");
  const fileName = safeName(name);
  const sha256 = await digest(bytes);
  const extension = role === "tax-overrides" ? "json" : "xlsx";
  const id = newId();
  const key = objectPrefix(jobId) + "/files/" + role + "/" + sha256 + "." + extension;
  await writeObject(key, bytes, extension === "json" ? JSON_TYPE : XLSX_TYPE, sha256);
  return { id, role, fileName, size: bytes.byteLength, sha256, createdAt: new Date().toISOString(), sourceId, priority, key };
}
function publicFile(file: StoredFile): ProcessingFile {
  return {
    id: file.id, role: file.role, fileName: file.fileName, size: file.size, sha256: file.sha256,
    createdAt: file.createdAt, sourceId: file.sourceId, priority: file.priority, sheetNames: file.sheetNames,
  };
}
function trimSource(source: ImportedSource): ImportedSource {
  // The original immutable workbook is the readable evidence. Persist only
  // rows used by the allocator; copying every raw Excel cell triples job JSON.
  return { ...source, rows: source.rows.map(row => ({ ...row, rawValues: [] })) };
}
function fingerprint(sources: ImportedSource[]): string {
  return JSON.stringify([...sources].sort((a, b) => a.priority - b.priority).map(source => [source.priority, source.sha256]));
}
function sourceSummary(sources: ImportedSource[]): ProcessingSourceSummary[] {
  return [...sources].sort((a, b) => a.priority - b.priority).map(source => ({
    id: source.id, name: source.name, priority: source.priority, originalCents: source.originalCents,
    availableCents: source.rows.filter(row => !row.historicUsed).reduce((sum, row) => sum + row.amountCents, 0),
    usedCents: source.history.reduce((sum, history) => sum + history.usedCents, 0),
    rowCount: source.rows.filter(row => !row.historicUsed).length, fileName: source.fileName, sha256: source.sha256,
  }));
}
function collectHistory(sources: ImportedSource[]): ProductHistory[] {
  const history = new Map<string, ProductHistory>();
  for (const source of sources) for (const entry of source.history) history.set(entry.batchId, { batchId: entry.batchId, product: entry.product });
  return [...history.values()];
}
function blankData(parentJobId: string | null): JobData {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, revision: 0, createdAt: now, updatedAt: now, parentJobId,
    sources: [], taxes: [], taxOverrides: [], taxFileId: null, taxOverrideFileId: null, templateFileId: null,
    productHistory: [], product: null, priceCents: null, quantity: null, plan: null, files: [],
    nextSourceFiles: [], taxPending: 0, adoptedAt: null, adoptedBy: null, discardedAt: null,
    discardReason: null, warnings: [],
  };
}
function publicJob(row: JobRow, data: JobData): ProcessingJob {
  const sources = sourceSummary(data.sources);
  const tax = data.files.find(file => file.id === data.taxFileId);
  const template = data.files.find(file => file.id === data.templateFileId);
  return {
    id: row.id, status: row.status, revision: Number(row.revision), product: data.product,
    totalCents: data.plan?.totalCents ?? null, quantity: data.quantity,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    parentJobId: row.parent_job_id ? String(row.parent_job_id) : null,
    sourceCount: sources.length, fileCount: data.files.length, priceCents: data.priceCents,
    sources, taxCount: data.taxes.length,
    taxFile: tax ? { name: tax.fileName, sha256: tax.sha256 } : null,
    taxOverrideCount: data.taxOverrides.length,
    taxOverrideFile: data.files.find(file => file.id === data.taxOverrideFileId)
      ? { name: data.files.find(file => file.id === data.taxOverrideFileId)!.fileName, sha256: data.files.find(file => file.id === data.taxOverrideFileId)!.sha256 }
      : null,
    templateFile: template ? { name: template.fileName, sha256: template.sha256 } : null,
    files: data.files.map(publicFile), plan: data.plan, taxPending: data.taxPending,
    adoptedAt: row.adopted_at ? String(row.adopted_at) : null,
    adoptedBy: row.adopted_by ? String(row.adopted_by) : null,
    discardedAt: row.discarded_at ? String(row.discarded_at) : null,
    discardReason: row.discard_reason ? String(row.discard_reason) : null,
    planStale: !!data.plan && data.plan.ruleVersion !== ALLOCATION_RULE_VERSION,
    warnings: data.warnings,
  };
}
async function getRow(id: string, user: AppUser): Promise<JobRow> {
  const owner = ownerFilter(user, "owner_id");
  const row = await db().prepare("SELECT * FROM processing_jobs WHERE id = ?" + owner.sql).bind(id, ...owner.args).first<JobRow>();
  if (!row) throw new ProcessingJobError("找不到本批任务。", 404, "JOB_NOT_FOUND");
  return row;
}
async function loadData(row: JobRow): Promise<JobData> {
  const bytes = await readObject(String(row.data_key));
  try {
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as JobData;
    if (data.schemaVersion !== 1 || data.revision !== Number(row.revision) || data.parentJobId !== row.parent_job_id) throw new Error("version mismatch");
    return data;
  } catch {
    throw new ProcessingJobError("本批任务状态损坏或版本不一致，请停止操作。", 500, "JOB_DATA_INVALID");
  }
}
async function loadJob(idValue: unknown, user: AppUser): Promise<{ row: JobRow; data: JobData }> {
  const row = await getRow(validateId(idValue), user);
  return { row, data: await loadData(row) };
}
async function saveJob(row: JobRow, user: AppUser, data: JobData, eventType: string, detail: Record<string, unknown>, status: ProcessingJobStatus = row.status) {
  const nextRevision = Number(row.revision) + 1;
  const updatedAt = new Date().toISOString();
  const nextData = { ...data, revision: nextRevision, updatedAt };
  const key = await writeJson(row.id, nextRevision, nextData);
  const results = await db().batch([
    db().prepare("UPDATE processing_jobs SET data_key=?, source_fingerprint=?, status=?, revision=?, product=?, total_cents=?, quantity=?, updated_at=?, adopted_at=?, adopted_by=?, discarded_at=?, discard_reason=? WHERE id=? AND owner_id=? AND revision=? AND status=? AND data_key=?")
      .bind(key, fingerprint(nextData.sources), status, nextRevision, nextData.product, nextData.plan?.totalCents ?? null, nextData.quantity,
        updatedAt, nextData.adoptedAt, nextData.adoptedBy, nextData.discardedAt, nextData.discardReason,
        row.id, row.owner_id, Number(row.revision), row.status, row.data_key),
    db().prepare("INSERT INTO processing_job_events (id,job_id,actor_id,event_type,revision,created_at,detail_json) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM processing_jobs WHERE id=? AND owner_id=? AND revision=? AND data_key=?)")
      .bind(newId(), row.id, user.userId, eventType, nextRevision, updatedAt, JSON.stringify(detail), row.id, row.owner_id, nextRevision, key),
  ]);
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) throw new ProcessingJobError("本批任务已被其他操作更新，请刷新后重试。", 409, "STALE_REVISION");
  return { row: await getRow(row.id, user), data: nextData };
}
async function insertBlankJob(user: AppUser, data: JobData): Promise<ProcessingJob> {
  ensureWriter(user);
  const id = newId();
  const initial = { ...data, schemaVersion: 1 as const, revision: 0, parentJobId: null };
  const key = await writeJson(id, 0, initial);
  const createdAt = new Date().toISOString();
  const inserted = await db().batch([
    db().prepare("INSERT INTO processing_jobs (id,owner_id,parent_job_id,status,revision,data_key,source_fingerprint,created_at,updated_at) VALUES (?,?,NULL,'draft',0,?,?,?,?)")
      .bind(id, user.userId, key, fingerprint(initial.sources), createdAt, createdAt),
    db().prepare("INSERT INTO processing_job_events (id,job_id,actor_id,event_type,revision,created_at,detail_json) VALUES (?, ?, ?, 'job_created', 0, ?, ?)")
      .bind(newId(), id, user.userId, createdAt, JSON.stringify({ parentJobId: null })),
  ]);
  if (inserted[0].meta.changes !== 1 || inserted[1].meta.changes !== 1) throw new ProcessingJobError("未能创建新批次，请刷新后重试。", 409, "JOB_CREATE_FAILED");
  const row = await getRow(id, user);
  return publicJob(row, initial);
}
async function verifiedBytes(file: StoredFile): Promise<Uint8Array> {
  const bytes = await readObject(file.key);
  if (await digest(bytes) !== file.sha256) throw new ProcessingJobError("文件校验失败：" + file.fileName + "。", 409, "FILE_HASH_MISMATCH");
  return bytes;
}

export async function createProcessingJob(user: AppUser): Promise<ProcessingJob> {
  ensureWriter(user);
  return insertBlankJob(user, blankData(null));
}
export async function listProcessingJobs(user: AppUser): Promise<{ jobs: ProcessingJobSummary[]; summary: { total: number; draft: number; prepared: number; adopted: number; discarded: number } }> {
  if (user.mustChangePassword) throw new ProcessingJobError("请先修改初始密码。", 403, "PASSWORD_CHANGE_REQUIRED");
  const owner = ownerFilter(user, "owner_id");
  const result = await db().prepare("SELECT * FROM processing_jobs WHERE 1=1" + owner.sql + " ORDER BY created_at DESC, id DESC LIMIT 200")
    .bind(...owner.args).all<JobRow>();
  const summary = { total: result.results.length, draft: 0, prepared: 0, adopted: 0, discarded: 0 };
  const jobs: ProcessingJobSummary[] = [];
  for (const row of result.results) {
    summary[row.status] += 1;
    const data = await loadData(row);
    jobs.push({
      id: row.id, status: row.status, revision: Number(row.revision), product: row.product,
      totalCents: row.total_cents === null ? null : Number(row.total_cents),
      quantity: row.quantity === null ? null : Number(row.quantity),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      parentJobId: row.parent_job_id ? String(row.parent_job_id) : null,
      sourceCount: data.sources.length, fileCount: data.files.length,
    });
  }
  return { jobs, summary };
}
export async function getProcessingJob(id: unknown, user: AppUser): Promise<ProcessingJob> {
  if (user.mustChangePassword) throw new ProcessingJobError("请先修改初始密码。", 403, "PASSWORD_CHANGE_REQUIRED");
  const { row, data } = await loadJob(id, user);
  return publicJob(row, data);
}
export async function uploadProcessingJobFile(
  input: { id: unknown; revision: unknown; role: unknown; name: unknown; bytes: Uint8Array; sourceNumber?: unknown; priority?: unknown; allowBlankDepartment?: unknown },
  user: AppUser,
): Promise<ProcessingJob> {
  ensureWriter(user);
  const id = validateId(input.id);
  const version = revisionNumber(input.revision);
  const role = input.role;
  if (role !== "source" && role !== "tax" && role !== "tax-overrides" && role !== "template") throw new ProcessingJobError("资料类型无效。");
  if (!(input.bytes instanceof Uint8Array) || !input.bytes.byteLength || input.bytes.byteLength > MAX_UPLOAD_BYTES) throw new ProcessingJobError("文件为空或超过10MB上限。", 413, "FILE_TOO_LARGE");
  const name = safeName(input.name);
  if (role === "tax-overrides" ? !name.toLowerCase().endsWith(".json") : !name.toLowerCase().endsWith(".xlsx")) {
    throw new ProcessingJobError(role === "tax-overrides" ? "请上传JSON税务修正文件。" : "请上传XLSX文件。");
  }
  const { row, data } = await loadJob(id, user);
  const uploadSha = await digest(input.bytes);
  const replay = data.files.find(file => file.role === role && file.sha256 === uploadSha && file.fileName === name);
  if (replay) {
    const selected = role === "source"
      ? data.sources.some(source => source.id === replay.sourceId && source.priority === Number(input.sourceNumber ?? input.priority) && source.allowBlankDepartment === (input.allowBlankDepartment === true))
      : role === "tax" ? data.taxFileId === replay.id
      : role === "tax-overrides" ? data.taxOverrideFileId === replay.id
      : data.templateFileId === replay.id;
    if (selected && row.status === "draft") return publicJob(row, data);
  }
  if (Number(row.revision) !== version) throw new ProcessingJobError("本批任务已更新，请刷新后重试。", 409, "STALE_REVISION");
  if (row.status !== "draft") throw new ProcessingJobError("本批资料已冻结，不能继续修改。请新建一批。", 409, "JOB_FROZEN");
  if (data.files.length >= MAX_JOB_FILES) throw new ProcessingJobError("单批资料数量已达上限。", 413, "TOO_MANY_FILES");
  const changed = structuredClone(data);
  let file: StoredFile;
  if (role === "source") {
    if (changed.sources.length >= MAX_JOB_SOURCES) throw new ProcessingJobError(`每批最多上传${MAX_JOB_SOURCES}份资金表。`, 413, "TOO_MANY_SOURCES");
    const sourceNumber = Number(input.sourceNumber ?? input.priority);
    if (!Number.isSafeInteger(sourceNumber) || sourceNumber !== changed.sources.length + 1) throw new ProcessingJobError("资金表来源编号已变化，请刷新页面后重新上传。");
    const parsed = await parseSource(input.bytes, name, sourceNumber);
    if (changed.sources.some(source => source.sha256 === parsed.sha256 || source.id === parsed.id)) throw new ProcessingJobError("本批已经包含这份金额来源，请检查上传版本。");
    parsed.allowBlankDepartment = input.allowBlankDepartment === true;
    await assertDistinctSourceBalance(parsed, changed.sources);
    const compact = trimSource(parsed);
    file = await writeFile(id, role, name, input.bytes, compact.id, sourceNumber);
    compact.fileKey = file.key;
    compact.fileName = file.fileName;
    changed.sources = [...changed.sources, compact];
    changed.productHistory = collectHistory(changed.sources);
  } else if (role === "tax") {
    const taxes = await parseTaxes(input.bytes);
    file = await writeFile(id, role, name, input.bytes);
    changed.taxes = taxes;
    changed.taxFileId = file.id;
  } else if (role === "tax-overrides") {
    const overrides = await parseTaxOverrides(input.bytes);
    file = await writeFile(id, role, name, input.bytes);
    changed.taxOverrides = overrides;
    changed.taxOverrideFileId = file.id;
  } else {
    validateXlsxArchive(input.bytes);
    const workbook = new ExcelJS.Workbook();
    try { await workbook.xlsx.load(input.bytes as never); }
    catch {
      const compatible = await normalizeSpreadsheetNamespaces(input.bytes);
      if (!compatible) throw new ProcessingJobError("开票模板无法读取，请检查文件后重试。");
      await workbook.xlsx.load(compatible as never);
    }
    if (!workbook.worksheets.length) throw new ProcessingJobError("开票模板没有工作表。");
    file = await writeFile(id, role, name, input.bytes);
    changed.templateFileId = file.id;
  }
  changed.files.push(file);
  const saved = await saveJob(row, user, changed, "file_uploaded", {
    role, fileName: name, sha256: file.sha256, priority: file.priority ?? null,
  });
  return publicJob(saved.row, saved.data);
}
export async function pasteSourceProcessingJob(
  input: { id: unknown; revision: unknown; text: unknown; name?: unknown; sourceNumber?: unknown; priority?: unknown; ackAvailableOnly: unknown },
  user: AppUser,
): Promise<ProcessingJob> {
  ensureWriter(user);
  if (input.ackAvailableOnly !== true) throw new ProcessingJobError("请确认粘贴的只是当前可用余额明细；粘贴内容不保留Excel颜色和红字历史。", 400, "AVAILABLE_ONLY_ACK_REQUIRED");
  if (typeof input.text !== "string" || !input.text.trim()) throw new ProcessingJobError("请粘贴表格中的资金明细。", 400, "EMPTY_PASTE");
  const bytes = new TextEncoder().encode(input.text);
  if (bytes.byteLength > 1_048_576) throw new ProcessingJobError("粘贴文本不能超过1MB。", 413, "PASTE_TOO_LARGE");
  const sourceNumber = Number(input.sourceNumber ?? input.priority);
  if (!Number.isSafeInteger(sourceNumber) || sourceNumber < 1 || sourceNumber > MAX_JOB_SOURCES) throw new ProcessingJobError(`每批最多导入${MAX_JOB_SOURCES}份资金表。`);
  const name = safeName(input.name ?? "粘贴的资金明细.xlsx");
  const workbook = await sourceFromClipboard(input.text);
  if (!(workbook instanceof Uint8Array) || workbook.byteLength > MAX_UPLOAD_BYTES) throw new ProcessingJobError("粘贴内容转换后的Excel文件超过10MB上限。", 413, "FILE_TOO_LARGE");
  return uploadProcessingJobFile({
    id: input.id, revision: input.revision, role: "source", name: name.toLowerCase().endsWith(".xlsx") ? name : name + ".xlsx",
    bytes: workbook, sourceNumber, allowBlankDepartment: false,
  }, user);
}
function makePlan(data: JobData, productValue: unknown, priceValue: unknown, quantityValue: unknown, assignmentsValue?: unknown) {
  const product = typeof productValue === "string" ? productValue.trim() : "";
  if (!product || product.length > 80) throw new ProcessingJobError("请填写1至80字的商品名称。");
  if (!data.sources.length) throw new ProcessingJobError("请先上传至少一份金额来源表。");
  if (!Number.isSafeInteger(quantityValue) || Number(quantityValue) <= 0 || Number(quantityValue) > 1_000_000) throw new ProcessingJobError("数量必须为1到100万之间的正整数。");
  if (assignmentsValue !== undefined && !Array.isArray(assignmentsValue)) throw new ProcessingJobError("部门归属格式无效，请重新试算。");
  if (Array.isArray(assignmentsValue) && assignmentsValue.length > 0) {
    throw new ProcessingJobError("当前分组规则不允许人工补填部门；来源中空白部门行会独立成组。请重新试算。", 409, "DEPARTMENT_ASSIGNMENTS_NOT_ALLOWED");
  }
  const priceCents = typeof priceValue === "string" || typeof priceValue === "number" ? exactPriceCents(priceValue) : NaN;
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) throw new ProcessingJobError("单价必须是大于0且最多两位小数的金额。");
  const plan = planAllocation(data.sources, priceCents, Number(quantityValue));
  const validation = validateAllocationPlan(data.sources, priceCents, Number(quantityValue), plan);
  if (!validation.valid) throw new ProcessingJobError("内部核对未通过：" + validation.errors.join("；"), 400, "PLAN_INVALID");
  return plan;
}export async function simulateProcessingJob(
  input: { id: unknown; revision: unknown; product: unknown; price: unknown; quantity: unknown; assignments?: unknown },
  user: AppUser,
): Promise<{ job: ProcessingJob; simulation: ReturnType<typeof planAllocation> }> {
  if (user.mustChangePassword) throw new ProcessingJobError("请先修改初始密码。", 403, "PASSWORD_CHANGE_REQUIRED");
  const { row, data } = await loadJob(input.id, user);
  if (Number(row.revision) !== revisionNumber(input.revision)) throw new ProcessingJobError("本批资料已变化，请刷新后重新试算。", 409, "STALE_REVISION");
  if (row.status !== "draft") throw new ProcessingJobError("只有草稿任务可以试算。", 409, "JOB_FROZEN");
  return { job: publicJob(row, data), simulation: makePlan(data, input.product, input.price, input.quantity, input.assignments) };
}
function mappedOutputRole(role: string): ProcessingFileRole {
  if (role === "invoice") return "invoice";
  if (role === "audit") return "audit";
  if (role.endsWith("_marked")) return "source-marked";
  if (role.endsWith("_remaining")) return "source-remaining";
  throw new ProcessingJobError("分摊引擎返回未知结果文件类型。", 500, "OUTPUT_ROLE_INVALID");
}
async function clarifyAudit(bytes: Uint8Array): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  validateXlsxArchive(bytes);
  await workbook.xlsx.load(bytes as never);
  const sheet = workbook.getWorksheet("本批核对");
  if (!sheet) throw new ProcessingJobError("核对文件缺少必需的核对工作表。", 500, "AUDIT_SHEET_MISSING");
  sheet.addRow(["处理状态", "候选文件，待人工核对；本批结果仅供归档和下载。"]);
  for (let row = 1; row <= sheet.rowCount; row++) {
    if (String(sheet.getCell(row, 1).value ?? "").includes("双agent")) {
      sheet.getCell(row, 2).value = "本批按文件模式生成候选，由用户和独立复核流程核对；不会自动带入下一批。";
    }
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
async function prepareFiles(jobId: string, data: JobData, plan: ReturnType<typeof planAllocation>, product: string, priceCents: number, quantity: number) {
  const template = data.files.find(file => file.id === data.templateFileId && file.role === "template");
  if (!template) throw new ProcessingJobError("请先上传开票模板。");
  const sourceBuffers: Record<string, Uint8Array> = {};
  for (const source of data.sources) {
    const file = data.files.find(item => item.role === "source" && item.sourceId === source.id);
    if (!file) throw new ProcessingJobError("找不到金额来源“" + source.name + "”的原始文件。", 500, "SOURCE_FILE_MISSING");
    sourceBuffers[source.id] = await verifiedBytes(file);
  }
  const generated = await generateBatchFiles({
    batchId: jobId, batchCreatedAt: data.createdAt, product, priceCents, quantity, sources: data.sources,
    plan, taxes: data.taxes, taxOverrides: data.taxOverrides, sourceBuffers,
    template: await verifiedBytes(template), productHistory: data.productHistory,
  });
  const files: StoredFile[] = [];
  for (const result of generated.files) {
    const role = mappedOutputRole(result.role);
    const bytes = role === "audit" ? await clarifyAudit(result.bytes) : result.bytes;
    const name = safeName(result.name);
    files.push(await writeFile(jobId, role, name, bytes, result.sourceId));
  }
  const nextSourceFiles: { sourceId: string; fileId: string }[] = [];
  for (const source of data.sources) {
    const file = files.find(item => item.sourceId === source.id && item.role === "source-remaining");
    if (!file) throw new ProcessingJobError("来源“" + source.name + "”没有生成剩余余额文件。", 500, "REMAINING_FILE_MISSING");
    nextSourceFiles.push({ sourceId: source.id, fileId: file.id });
  }
  return { files, nextSourceFiles, taxPending: generated.taxPending };
}
export async function prepareProcessingJob(
  input: { id: unknown; revision: unknown; product: unknown; price: unknown; quantity: unknown; assignments?: unknown },
  user: AppUser,
): Promise<{ job: ProcessingJob; simulation: ReturnType<typeof planAllocation> }> {
  ensureWriter(user);
  const id = validateId(input.id);
  const { row, data } = await loadJob(id, user);
  const expectedRevision = revisionNumber(input.revision);
  const product = typeof input.product === "string" ? input.product.trim() : "";
  const priceCents = (typeof input.price === "string" || typeof input.price === "number")
    ? exactPriceCents(input.price) : NaN;
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) throw new ProcessingJobError("单价必须是大于0且最多两位小数的金额。");
  if (row.status === "prepared" && !publicJob(row, data).planStale && Number(row.revision) === expectedRevision + 1 && data.product === product && data.priceCents === priceCents && data.quantity === input.quantity && JSON.stringify(data.plan?.departmentAssignments ?? []) === JSON.stringify(input.assignments ?? [])) {
    return { job: publicJob(row, data), simulation: data.plan! };
  }
  if (Number(row.revision) !== expectedRevision) throw new ProcessingJobError("本批资料已变化，请刷新后重新试算。", 409, "STALE_REVISION");
  if (row.status !== "draft") throw new ProcessingJobError("本批已生成候选文件，不能重复生成。", 409, "JOB_FROZEN");
  const plan = makePlan(data, product, String(priceCents / 100), input.quantity, input.assignments);
  const generated = await prepareFiles(id, data, plan, product, priceCents, Number(input.quantity));
  const next: JobData = {
    ...structuredClone(data), product, priceCents, quantity: Number(input.quantity),
    plan, files: [...data.files, ...generated.files], nextSourceFiles: generated.nextSourceFiles,
    taxPending: generated.taxPending,
    warnings: generated.taxPending ? [generated.taxPending + "条开票明细需要人工补充税务资料。"] : [],
  };
  const saved = await saveJob(row, user, next, "candidate_prepared", {
    product, totalCents: plan.totalCents, quantity: plan.quantity,
    sourceCount: data.sources.length, outputCount: generated.files.length,
    inputHashes: [data.files.find(file => file.id === data.templateFileId)?.sha256, ...data.sources.map(source => source.sha256)],
  }, "prepared");
  return { job: publicJob(saved.row, saved.data), simulation: plan };
}
function exactPriceCents(value: string | number): number {
  const text = String(value).trim();
  if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(text)) return NaN;
  const parts = text.split(".");
  const cents = Number(parts[0]) * 100 + Number((parts[1] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : NaN;
}
export async function adoptProcessingJob(input: { id: unknown; revision: unknown; ack: unknown; fileHashes: unknown }, user: AppUser): Promise<ProcessingJob> {
  ensureWriter(user);
  const id = validateId(input.id);
  const revision = revisionNumber(input.revision);
  if (input.ack !== "I_REVIEWED_FILES") throw new ProcessingJobError("请先确认已查看本批所有生成文件。", 400, "REVIEW_ACK_REQUIRED");
  const { row, data } = await loadJob(id, user);
  if (row.status !== "prepared" && row.status !== "adopted") throw new ProcessingJobError("只有待人工核对的本批候选可以确认完成。", 409, "JOB_NOT_PREPARED");
  const outputs = data.files.filter(file => ["invoice", "source-marked", "source-remaining", "audit"].includes(file.role));
  if (row.status === "adopted") {
    const repeated = input.fileHashes as Record<string, unknown> | null;
    const matches = !!repeated && typeof repeated === "object" &&
      Object.keys(repeated).length === outputs.length &&
      outputs.every(file => repeated[file.id] === file.sha256);
    if (matches) return publicJob(row, data);
    throw new ProcessingJobError("本批已完成，但文件版本与保存记录不同。", 409, "ADOPTED_FILE_MISMATCH");
  }
  if (data.plan?.ruleVersion !== ALLOCATION_RULE_VERSION) {
    throw new ProcessingJobError("该候选文件按旧部门分组规则生成，不能直接确认完成。请保留原始输入并重新按当前规则试算。", 409, "ALLOCATION_RULE_VERSION_STALE");
  }
  const recomputed = planAllocation(data.sources, data.plan.priceCents, data.plan.quantity);
  const replay = validateAllocationPlan(data.sources, data.plan.priceCents, data.plan.quantity, data.plan);
  if (!replay.valid || JSON.stringify(data.plan) !== JSON.stringify(recomputed)) {
    throw new ProcessingJobError("候选方案与当前确定性分摊规则重算结果不一致，不能确认完成。请重新试算并核对文件。", 409, "PLAN_REPLAY_MISMATCH");
  }
  if (Number(row.revision) !== revision) throw new ProcessingJobError("本批任务已变化，请刷新后重试。", 409, "STALE_REVISION");
  const hashes = input.fileHashes;
  if (!hashes || typeof hashes !== "object" || Array.isArray(hashes)) throw new ProcessingJobError("请确认所有候选文件版本。");
  const supplied = hashes as Record<string, unknown>;
  if (Object.keys(supplied).sort().join("\0") !== outputs.map(file => file.id).sort().join("\0") ||
      outputs.some(file => supplied[file.id] !== file.sha256)) throw new ProcessingJobError("候选文件清单与保存版本不一致，请刷新后重新查看。", 409, "FILE_CONFIRMATION_MISMATCH");
  for (const file of data.files) await verifiedBytes(file);
  const sourceHashes = data.sources.map(source => source.sha256);
  const adoptedAt = new Date().toISOString();
  const nextRevision = revision + 1;
  const next = { ...data, revision: nextRevision, updatedAt: adoptedAt, adoptedAt, adoptedBy: user.userId };
  const key = await writeJson(row.id, nextRevision, next);
  const statements = [
    db().prepare("UPDATE processing_jobs SET data_key=?,status='adopted',revision=?,updated_at=?,adopted_at=?,adopted_by=? WHERE id=? AND owner_id=? AND status='prepared' AND revision=? AND data_key=?")
      .bind(key, nextRevision, adoptedAt, adoptedAt, user.userId, row.id, row.owner_id, revision, row.data_key),
    db().prepare("INSERT INTO processing_job_events (id,job_id,actor_id,event_type,revision,created_at,detail_json) SELECT ?,?,?, 'candidate_adopted',?,?,? WHERE EXISTS (SELECT 1 FROM processing_jobs WHERE id=? AND status='adopted' AND revision=? AND data_key=?)")
      .bind(newId(), row.id, user.userId, nextRevision, adoptedAt, JSON.stringify({
        outputCount: outputs.length, outputHashes: Object.fromEntries(outputs.map(file => [file.id, file.sha256])), sourceHashes,
      }), row.id, nextRevision, key),
  ];
  const results = await db().batch(statements);
  if (results.some(item => item.meta.changes !== 1)) {
    throw new ProcessingJobError("本批完成状态已被其他操作更新，请刷新后重试。", 409, "STALE_REVISION");
  }
  return publicJob(await getRow(row.id, user), next);
}
export async function discardProcessingJob(input: { id: unknown; revision: unknown; reason: unknown }, user: AppUser): Promise<ProcessingJob> {
  ensureWriter(user);
  const { row, data } = await loadJob(input.id, user);
  if (row.status === "discarded" && typeof input.reason === "string" && input.reason.trim() === data.discardReason) return publicJob(row, data);
  if (Number(row.revision) !== revisionNumber(input.revision)) throw new ProcessingJobError("本批任务已变化，请刷新后重试。", 409, "STALE_REVISION");
  if (typeof input.reason !== "string" || input.reason.trim().length < 2 || input.reason.trim().length > 300) throw new ProcessingJobError("请写明2到300字的作废原因。");
  const now = new Date().toISOString();
  const nextRevision = Number(row.revision) + 1;
  const next = { ...data, revision: nextRevision, updatedAt: now, discardedAt: now, discardReason: input.reason.trim() };
  const key = await writeJson(row.id, nextRevision, next);
  const owner = ownerFilter(user, "owner_id");
  const statements = [
    db().prepare("UPDATE processing_jobs SET data_key=?,status='discarded',revision=?,updated_at=?,discarded_at=?,discard_reason=? WHERE id=?" + owner.sql + " AND revision=? AND status=? AND data_key=?")
      .bind(key, nextRevision, now, now, input.reason.trim(), row.id, ...owner.args, Number(row.revision), row.status, row.data_key),
    db().prepare("INSERT INTO processing_job_events (id,job_id,actor_id,event_type,revision,created_at,detail_json) SELECT ?,?,?,'job_discarded',?,?,? WHERE EXISTS (SELECT 1 FROM processing_jobs WHERE id=? AND status='discarded' AND revision=? AND data_key=?)")
      .bind(newId(), row.id, user.userId, nextRevision, now, JSON.stringify({ reason: input.reason.trim(), previousStatus: row.status }), row.id, nextRevision, key),
  ];
  const result = await db().batch(statements);
  if (result[0].meta.changes !== 1 || result[1].meta.changes !== 1) throw new ProcessingJobError("本批任务已被其他操作更新，请刷新后重试。", 409, "STALE_REVISION");
  return publicJob(await getRow(row.id, user), next);
}
async function loadPreviewWorkbook(file: StoredFile, bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  if (file.role === "tax-overrides") throw new ProcessingJobError("税务修正是JSON资料，请下载查看。", 415, "JSON_PREVIEW_UNSUPPORTED");
  validateXlsxArchive(bytes);
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(bytes as never); }
  catch {
    const compatible = await normalizeSpreadsheetNamespaces(bytes);
    if (!compatible) throw new ProcessingJobError("文件无法作为工作簿预览。", 400, "PREVIEW_UNAVAILABLE");
    try { await workbook.xlsx.load(compatible as never); }
    catch { throw new ProcessingJobError("文件无法作为工作簿预览。", 400, "PREVIEW_UNAVAILABLE"); }
  }
  return workbook;
}
function safeCell(value: unknown): unknown {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value ?? null;
  if (typeof value === "string") return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, 20_000);
  if (typeof value !== "object") return String(value).slice(0, 1000);
  const cell = value as Record<string, unknown>;
  if (typeof cell.formula === "string") return { formula: cell.formula.slice(0, 500), cached: safeCell(cell.result) };
  if (cell.sharedFormula) return { formula: "[共享公式]", cached: safeCell(cell.result) };
  if (typeof cell.text === "string") return safeCell(cell.text);
  if (Array.isArray(cell.richText)) return cell.richText.slice(0, 30).map(part => safeCell((part as Record<string, unknown>).text)).join("");
  if (typeof cell.hyperlink === "string") return safeCell(cell.text ?? cell.hyperlink);
  if (Array.isArray(cell.error)) return "[单元格错误]";
  return "[复杂单元格]";
}
export async function previewProcessingJobFile(
  input: { id: unknown; fileId: unknown; sheetName?: unknown; offset?: unknown; limit?: unknown; search?: unknown },
  user: AppUser,
): Promise<ProcessingJobPreview> {
  if (user.mustChangePassword) throw new ProcessingJobError("请先修改初始密码。", 403, "PASSWORD_CHANGE_REQUIRED");
  const { data } = await loadJob(input.id, user);
  const file = data.files.find(item => item.id === input.fileId);
  if (!file) throw new ProcessingJobError("找不到本批文件。", 404, "FILE_NOT_FOUND");
  if (file.role === "tax-overrides") {
    let parsed: { entities?: Record<string, Record<string, unknown>> };
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await verifiedBytes(file))); }
    catch { throw new ProcessingJobError("税务修正文件无法读取。", 400, "PREVIEW_UNAVAILABLE"); }
    const entries = Object.entries(parsed.entities ?? {});
    const offset = input.offset === undefined ? 0 : Number(input.offset);
    const limit = input.limit === undefined ? 50 : Number(input.limit);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > entries.length || !Number.isSafeInteger(limit) || limit < 1) throw new ProcessingJobError("预览分页参数无效。");
    const columns = ["法律主体编码", "实际主体名称", "主体类型", "统一信用代码", "注册地址", "开户行", "银行账号", "确认原因", "适用范围"];
    const search = typeof input.search === "string" ? input.search.trim().slice(0, 120).toLocaleLowerCase("zh-CN") : "";
    const allRows = entries.map(([code, item], index) => ({
      sourceRow: index + 2,
      values: [code, item.name, item.kind, item.credit, item.address, item.bank, item.account, item.reason,
        JSON.stringify(item.scope ?? { batch_ids: item.batch_ids, applies_to_all_future_batches: item.applies_to_all_future_batches })]
        .map(value => safeCell(value ?? null)),
    })).filter(row => !search || row.values.some(value => String(value ?? "").toLocaleLowerCase("zh-CN").includes(search)));
    const pageSize = Math.min(MAX_PREVIEW_ROWS, limit);
    return { file: publicFile(file), sheets: ["税务修正"], sheet: { name: "税务修正", totalRows: allRows.length, offset, limit: pageSize, columns: columns.map((label, index) => ({ index: index + 1, label })), rows: allRows.slice(offset, offset + pageSize) } };
  }
  const workbook = await loadPreviewWorkbook(file, await verifiedBytes(file));
  const sheets = workbook.worksheets.slice(0, 100).map(sheet => sheet.name);
  const selected = typeof input.sheetName === "string" && input.sheetName ? input.sheetName : sheets[0];
  if (!selected || !sheets.includes(selected)) throw new ProcessingJobError("工作表不存在。");
  const worksheet = workbook.getWorksheet(selected);
  if (!worksheet) throw new ProcessingJobError("工作表不存在。");
  const offset = input.offset === undefined ? 0 : Number(input.offset);
  const limit = input.limit === undefined ? 50 : Number(input.limit);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > worksheet.rowCount) throw new ProcessingJobError("预览起始行无效。");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new ProcessingJobError("预览行数无效。");
  const pageSize = Math.min(MAX_PREVIEW_ROWS, limit);
  const query = typeof input.search === "string" ? input.search.trim().slice(0, 120).toLocaleLowerCase("zh-CN") : "";
  const columnCount = Math.min(MAX_PREVIEW_COLUMNS, worksheet.columnCount);
  const source = data.sources.find(item => item.id === file.sourceId);
  const headerRow = file.role === "source" ? source?.headerRow ?? 1 : 1;
  const columns = Array.from({ length: columnCount }, (_, index) => ({
    index: index + 1,
    label: String(safeCell(worksheet.getRow(headerRow).getCell(index + 1).value) ?? ""),
  }));
  const rows: { sourceRow: number; values: unknown[] }[] = [];
  let matched = 0;
  for (let physical = 1; physical <= Math.min(worksheet.rowCount, MAX_PREVIEW_SEARCH_ROWS); physical++) {
    const values = Array.from({ length: columnCount }, (_, index) => safeCell(worksheet.getRow(physical).getCell(index + 1).value));
    if (query && !values.some(value => String(value ?? "").toLocaleLowerCase("zh-CN").includes(query))) continue;
    if (matched++ < offset) continue;
    rows.push({ sourceRow: physical, values });
    if (rows.length >= pageSize) break;
  }
  return { file: publicFile(file), sheets, sheet: { name: worksheet.name, totalRows: worksheet.rowCount, offset, limit: pageSize, columns, rows } };
}
export async function downloadProcessingJobFile(id: unknown, fileId: unknown, user: AppUser): Promise<{ file: ProcessingFile; bytes: Uint8Array }> {
  if (user.mustChangePassword) throw new ProcessingJobError("请先修改初始密码。", 403, "PASSWORD_CHANGE_REQUIRED");
  const { data } = await loadJob(id, user);
  const file = data.files.find(item => item.id === fileId);
  if (!file) throw new ProcessingJobError("找不到本批文件。", 404, "FILE_NOT_FOUND");
  return { file: publicFile(file), bytes: await verifiedBytes(file) };
}
export type ProcessingAIContext = {
  jobId: string; status: ProcessingJobStatus; revision: number; product: string | null;
  priceCents: number | null; quantity: number | null; totalCents: number | null;
  sources: { name: string; priority: number; availableCents: number; usedCents: number; rowCount: number }[];
  taxCount: number; hasTemplate: boolean; warnings: string[];
  prepared?: {
    fileCount: number; taxPending: number; groupCount: number; totalCents: number; planValid: true;
    sourceSummaries: { sourceName: string; usedCents: number; remainingCents: number; differenceCents: number }[];
    risksSummary: { missingDepartmentGroups: number; sourceDifferenceGroups: number };
  };
};
export async function getProcessingAIJobContext(id: unknown, userId: string, options: { includePrepared?: boolean } = {}): Promise<ProcessingAIContext> {
  const user: AppUser = { userId, role: "operator", displayName: "", email: "", mustChangePassword: false };
  const { row, data } = await loadJob(id, user);
  const context: ProcessingAIContext = {
    jobId: row.id, status: row.status, revision: Number(row.revision), product: data.product,
    priceCents: data.priceCents, quantity: data.quantity, totalCents: data.plan?.totalCents ?? null,
      sources: sourceSummary(data.sources).map(source => ({
      name: source.name, priority: source.priority, availableCents: source.availableCents,
      usedCents: source.usedCents, rowCount: source.rowCount,
    })),
    taxCount: data.taxes.length, hasTemplate: Boolean(data.templateFileId),
    warnings: data.warnings.slice(0, 20).map(warning => warning.slice(0, 200)),
  };
  if (options.includePrepared && data.plan) {
    if (data.plan.ruleVersion !== ALLOCATION_RULE_VERSION) {
      throw new ProcessingJobError("该候选方案按旧分组规则生成，AI摘要不能把它标记为当前规则有效。请使用原始资金文件按新规则重算。", 409, "ALLOCATION_RULE_VERSION_STALE");
    }
    const replay = validateAllocationPlan(data.sources, data.plan.priceCents, data.plan.quantity, data.plan);
    const deterministic = planAllocation(data.sources, data.plan.priceCents, data.plan.quantity);
    if (!replay.valid || JSON.stringify(deterministic) !== JSON.stringify(data.plan)) {
      throw new ProcessingJobError("候选方案与当前分组规则重新计算结果不一致，AI预检无法开始。", 409, "PLAN_REPLAY_MISMATCH");
    }
    const groups = data.plan.groups;
    context.prepared = {
      fileCount: data.files.filter(file => ["invoice", "source-marked", "source-remaining", "audit"].includes(file.role)).length,
      taxPending: data.taxPending, groupCount: groups.length, totalCents: data.plan.totalCents, planValid: true,
      sourceSummaries: data.plan.sourceSummaries.map(source => ({
        sourceName: source.name, usedCents: source.usedCents, remainingCents: source.remainingCents, differenceCents: source.differenceCents,
      })),
      risksSummary: {
        missingDepartmentGroups: groups.filter(group => !group.department || !group.useCenter).length,
        sourceDifferenceGroups: data.plan.sourceSummaries.filter(source => source.differenceCents !== 0).length,
      },
    };
  }
  return context;
}

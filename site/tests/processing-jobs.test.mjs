import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { url: 'data:text/javascript,export default {}', shortCircuit: true };
  if (context.parentURL?.includes('/app/') && specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    return next(new URL(specifier + '.ts', context.parentURL).href, context);
  }
  return next(specifier, context);
} });

const workRoot = path.resolve('work-runtime-tests');
await mkdir(workRoot, { recursive: true });
const dataRoot = await mkdtemp(path.join(workRoot, 'processing-jobs-'));
process.env.ALLOCATION_DATA_DIR = dataRoot;

const { env } = await import(new URL('../app/lib/node-runtime.ts', import.meta.url).href);
const persistence = await import(new URL('../app/lib/persistence.ts', import.meta.url).href);
const jobs = await import(new URL('../app/lib/processing-jobs.ts', import.meta.url).href);
const hashes = (job) => Object.fromEntries(job.files.filter(file => ['invoice', 'source-marked', 'source-remaining', 'audit'].includes(file.role)).map(file => [file.id, file.sha256]));
const bytes = async workbook => new Uint8Array(await workbook.xlsx.writeBuffer());

async function addUser(id, role = 'operator') {
  await env.DB.prepare('INSERT INTO app_users (id,username,display_name,role,password_salt,password_hash,password_iterations,password_version,must_change_password,disabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, id, id, role, '00'.repeat(16), 'synthetic', 32768, 1, 0, 0, Date.now(), Date.now()).run();
  return { userId: id, displayName: id, email: '', role, mustChangePassword: false };
}
async function sourceFile(applicant, amount, name, department = '研发部门', useCenter = '研发中心', costCenter = '成本一') {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('金额来源');
  const headers = ['申领人', '申领部门', '使用部门', '成本中心', '成本', '费用承担法律主体', '备注', '申领用途'];
  sheet.getRow(3).values = headers;
  sheet.getCell('D2').value = amount;
  sheet.getCell('E2').value = amount;
  sheet.getRow(4).values = [applicant, department, useCenter, costCenter, amount, '合成公司（L000001）', '合成备注', '产品验证'];
  return { bytes: await bytes(workbook), name };
}
async function taxFile() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('税务');
  sheet.addRow(['法律主体编码', '实际主体名称', '当前主体类型', '社会统一信用代码', '注册地址', '开户行', '银行基本户账号']);
  sheet.addRow(['L000001', '合成公司', '小规模纳税人', '000099998888777766', '合成路1号', '合成银行', '000000000000012345']);
  return bytes(workbook);
}
async function templateFile() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('开票');
  sheet.getCell('A1').value = 'EP-SYNTHETIC';
  sheet.getRow(3).values = ['申领人', '申领部门', '使用中心', '成本中心', '部门使用金额', '费用承担法律主体', '开票明细', '申领用途', '单价', '数量', '总计金额'];
  return bytes(workbook);
}
async function upload(user, job, role, source, priority) {
  const next = await jobs.uploadProcessingJobFile({
    id: job.id, revision: job.revision, role, name: source.name, bytes: source.bytes, priority,
  }, user);
  return next;
}
async function prepare(user, job, product, price = '3', quantity = 33) {
  return jobs.prepareProcessingJob({ id: job.id, revision: job.revision, product, price, quantity }, user);
}
async function flipObject(key) {
  const objectPath = path.join(dataRoot, 'objects', ...key.split('/'));
  const original = await readFile(objectPath);
  const changed = Buffer.from(original);
  changed[changed.length - 1] ^= 1;
  await writeFile(objectPath, changed);
  return async () => writeFile(objectPath, original);
}

test('file-processing batches preserve cents, hash-bound review, lineage, and legacy workspace isolation', async () => {
  const owner = await addUser('operator-a');
  const other = await addUser('operator-b');
  const viewer = await addUser('viewer-c', 'viewer');
  const originalWorkspace = await persistence.loadWorkspace();
  assert.equal(originalWorkspace.version, 0);

  let job = await jobs.createProcessingJob(owner);
  assert.equal(job.product, null);
  assert.equal(job.sources.length, 0);
  const sourceOne = await sourceFile('员工甲', 500, '第一来源.xlsx');
  const sourceTwo = await sourceFile('员工乙', 397, '第二来源.xlsx', '财务部门', '财务中心', '成本二');
  job = await upload(owner, job, 'source', sourceOne, 1);
  job = await upload(owner, job, 'source', sourceTwo, 2);

  job = await jobs.uploadProcessingJobFile({
    id: job.id, revision: job.revision, role: 'tax', name: '税务.xlsx', bytes: await taxFile(),
  }, owner);
  const overrideBytes = new TextEncoder().encode(JSON.stringify({
    entities: { L000001: { confirmed_by_user: true, reason: '仅本批合成核验', credit: '000012345678901234', scope: { batch_ids: [job.id] } } },
  }));
  job = await jobs.uploadProcessingJobFile({
    id: job.id, revision: job.revision, role: 'tax-overrides', name: '税务修正.json', bytes: overrideBytes,
  }, owner);
  const templateBytes = await templateFile();
  job = await jobs.uploadProcessingJobFile({
    id: job.id, revision: job.revision, role: 'template', name: '模板.xlsx', bytes: templateBytes,
  }, owner);
  await assert.rejects(jobs.uploadProcessingJobFile({
    id: job.id, revision: job.revision, role: 'source', name: 'forbidden.xlsx', bytes: sourceOne.bytes, priority: 3,
  }, viewer), /查看账号/);

  const dryRun = await jobs.simulateProcessingJob({
    id: job.id, revision: job.revision, product: '合成商品', price: '3.00', quantity: 33,
  }, owner);
  assert.equal(dryRun.simulation.totalCents, 9900);
  assert.equal(dryRun.simulation.availableCents, 89700);
  assert.equal((await persistence.loadWorkspace()).version, 0);

  const preparedResult = await prepare(owner, job, '合成商品');
  job = preparedResult.job;
  assert.equal(job.status, 'prepared');
  assert.equal(job.plan.totalCents, 9900);
  assert.equal(job.plan.remainingCents, 79800);
  assert.equal(job.files.filter(file => ['invoice', 'source-marked', 'source-remaining', 'audit'].includes(file.role)).length, 6);
  assert.equal(job.taxPending, 0);

  const context = await jobs.getProcessingAIJobContext(job.id, owner.userId, { includePrepared: true });
  assert.equal(context.prepared?.totalCents, 9900);
  assert.equal(JSON.stringify(context).includes('000000000000012345'), false);
  assert.equal(JSON.stringify(context).includes('000012345678901234'), false);

  const invoiceFile = job.files.find(file => file.role === 'invoice');
  const invoicePreview = await jobs.previewProcessingJobFile({ id: job.id, fileId: invoiceFile.id, limit: 20 }, owner);
  assert.equal(invoicePreview.sheet.name, '开票');
  assert.equal(invoicePreview.sheet.rows.length > 0, true);
  const invoiceDownload = await jobs.downloadProcessingJobFile(job.id, invoiceFile.id, owner);
  assert.equal(createHash('sha256').update(invoiceDownload.bytes).digest('hex'), invoiceFile.sha256);
  const shared = await jobs.getProcessingJob(job.id, other).catch(error => error);
  assert.equal(shared.status, 404);

  const wrongHash = { ...hashes(job), [invoiceFile.id]: '0'.repeat(64) };
  await assert.rejects(jobs.adoptProcessingJob({
    id: job.id, revision: job.revision, ack: 'I_REVIEWED_FILES', fileHashes: wrongHash,
  }, owner), /版本不一致/);
  const persistedState = await env.DB.prepare('SELECT data_key FROM processing_jobs WHERE id=?').bind(job.id).first();
  const persisted = JSON.parse(new TextDecoder().decode(await (await env.BUCKET.get(persistedState.data_key)).arrayBuffer()));
  const originalFile = job.files.find(file => file.role === 'invoice');
  const originalManifestEntry = persisted.files.find(file => file.id === originalFile.id);
  const restore = await flipObject(originalManifestEntry.key);
  await assert.rejects(jobs.adoptProcessingJob({
    id: job.id, revision: job.revision, ack: 'I_REVIEWED_FILES', fileHashes: hashes(job),
  }, owner), /文件校验失败/);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS count FROM processing_active_sources WHERE job_id=?').bind(job.id).first()).count, 0);
  await restore();

  job = await jobs.adoptProcessingJob({
    id: job.id, revision: job.revision, ack: 'I_REVIEWED_FILES', fileHashes: hashes(job),
  }, owner);
  assert.equal(job.status, 'adopted');
  assert.equal((await persistence.loadWorkspace()).version, 0);

  const disguised = await sourceFile('员工甲', 500, '改名资金表.xlsx');
  const disguisedWorkbook = new ExcelJS.Workbook();
  await disguisedWorkbook.xlsx.load(disguised.bytes);
  disguisedWorkbook.getWorksheet('金额来源').getCell('A1').value = '更改无关格式形成新文件哈希';
  const alteredBytes = await bytes(disguisedWorkbook);
  let replay = await jobs.createProcessingJob(owner);
  replay = await jobs.uploadProcessingJobFile({ id: replay.id, revision: replay.revision, role: 'source', name: '改名资金表.xlsx', bytes: alteredBytes, priority: 1 }, owner);
  replay = await jobs.uploadProcessingJobFile({ id: replay.id, revision: replay.revision, role: 'template', name: '模板.xlsx', bytes: templateBytes }, owner);
  replay = (await prepare(owner, replay, '重复余额尝试')).job;
  await assert.rejects(jobs.adoptProcessingJob({
    id: replay.id, revision: replay.revision, ack: 'I_REVIEWED_FILES', fileHashes: hashes(replay),
  }, owner), /同一金额余额/);
  assert.equal(Number((await env.DB.prepare('SELECT COUNT(*) AS count FROM processing_active_sources WHERE job_id=?').bind(replay.id).first()).count), 0);

  const next = await jobs.continueProcessingJob(job.id, job.revision, owner);
  assert.equal(next.status, 'draft');
  assert.equal(next.product, null);
  assert.equal(next.priceCents, null);
  assert.equal(next.quantity, null);
  assert.equal(next.parentJobId, job.id);
  assert.equal(next.sources.reduce((sum, source) => sum + source.availableCents, 0), 79800);
  await assert.rejects(jobs.discardProcessingJob({ id: job.id, revision: job.revision, reason: '试图回滚' }, owner), /后续批次/);
  const second = await prepare(owner, next, '下一批商品', '3', 33);
  assert.equal(second.job.product, '下一批商品');
  assert.equal(second.job.taxPending, 1);
  assert.equal((await persistence.loadWorkspace()).version, 0);

  const secondSummary = await jobs.listProcessingJobs(owner);
  assert.equal(secondSummary.summary.prepared, 2);
  assert.equal(secondSummary.summary.adopted, 1);
});

test('adopt versus discard CAS leaves source reservations consistent', async () => {
  const user = await addUser('operator-race');
  const first = await sourceFile('争用员工', 701, '争用资金.xlsx');
  let job = await jobs.createProcessingJob(user);
  job = await upload(user, job, 'source', first, 1);
  job = await jobs.uploadProcessingJobFile({ id: job.id, revision: job.revision, role: 'template', name: '争用模板.xlsx', bytes: await templateFile() }, user);
  job = (await prepare(user, job, '争用商品', '3', 33)).job;
  const candidates = hashes(job);
  const result = await Promise.allSettled([
    jobs.adoptProcessingJob({ id: job.id, revision: job.revision, ack: 'I_REVIEWED_FILES', fileHashes: candidates }, user),
    jobs.discardProcessingJob({ id: job.id, revision: job.revision, reason: '合成并发作废测试' }, user),
  ]);
  const current = await jobs.getProcessingJob(job.id, user);
  const locked = Number((await env.DB.prepare('SELECT COUNT(*) AS count FROM processing_active_sources WHERE job_id=?').bind(job.id).first()).count);
  if (current.status === 'adopted') assert.equal(locked, 1);
  else { assert.equal(current.status, 'discarded'); assert.equal(locked, 0); }
  assert.equal(result.some(item => item.status === 'fulfilled'), true);
});

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
const jobs = await import(new URL('../app/lib/processing-jobs.ts', import.meta.url).href);
const hashes = (job) => Object.fromEntries(job.files.filter(file => ['invoice', 'source-marked', 'source-remaining', 'audit'].includes(file.role)).map(file => [file.id, file.sha256]));
const bytes = async workbook => new Uint8Array(await workbook.xlsx.writeBuffer());
const workspaceSnapshot = () => env.DB.prepare("SELECT version,data_key,last_batch_id FROM allocation_workspace WHERE id='main'").first();
const storeObject = (key, input, contentType = 'application/json; charset=utf-8') => env.BUCKET.put(key, input, { httpMetadata: { contentType } });

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

test('file-processing batches preserve cents, hash-bound review, and require a fresh balance upload for every job', async () => {
  const owner = await addUser('operator-a');
  const other = await addUser('operator-b');
  const viewer = await addUser('viewer-c', 'viewer');
  assert.equal(await workspaceSnapshot(), null);

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
  assert.equal(await workspaceSnapshot(), null);

  const preparedResult = await prepare(owner, job, '合成商品');
  job = preparedResult.job;
  assert.equal(job.status, 'prepared');
  assert.equal(job.plan.totalCents, 9900);
  assert.equal(job.plan.remainingCents, 79800);
  assert.equal(job.files.filter(file => ['invoice', 'source-marked', 'source-remaining', 'audit'].includes(file.role)).length, 6);
  assert.equal(job.taxPending, 0);
  const outputFiles = job.files.filter(file => ['invoice', 'source-marked', 'source-remaining', 'audit'].includes(file.role));
  assert.ok(outputFiles.every(file => /^\d{8}_合成商品_批次[0-9a-f]{8}_/i.test(file.fileName)), 'outputs use date, product and batch id in the filename');
  assert.ok(outputFiles.some(file => file.fileName.includes('_来源01_已用标红.xlsx')));
  assert.ok(outputFiles.some(file => file.fileName.includes('_来源02_剩余.xlsx')));

  const context = await jobs.getProcessingAIJobContext(job.id, owner.userId, { includePrepared: true });
  assert.equal(context.prepared?.totalCents, 9900);
  assert.equal(JSON.stringify(context).includes('000000000000012345'), false);
  assert.equal(JSON.stringify(context).includes('000012345678901234'), false);

  // Historical candidates remain readable but cannot be recommitted under a
  // new grouping rule or presented to AI as validated under current policy.
  const stateRow = await env.DB.prepare('SELECT data_key FROM processing_jobs WHERE id=?').bind(job.id).first();
  const originalStateKey = stateRow.data_key;
  const object = await env.BUCKET.get(originalStateKey);
  const objectBytes = Buffer.from(await object.arrayBuffer());
  const legacyState = JSON.parse(objectBytes.toString('utf8'));
  legacyState.plan.ruleVersion = 'department-compat-v3';
  const legacyStateKey = `processing-jobs/${job.id}/states/synthetic-legacy-rule.json`;
  await storeObject(legacyStateKey, Buffer.from(JSON.stringify(legacyState)));
  await env.DB.prepare('UPDATE processing_jobs SET data_key=? WHERE id=?').bind(legacyStateKey, job.id).run();
  const legacyJob = await jobs.getProcessingJob(job.id, owner);
  assert.equal(legacyJob.planStale, true);
  await assert.rejects(jobs.getProcessingAIJobContext(job.id, owner.userId, { includePrepared: true }), /旧分组规则/);
  await assert.rejects(jobs.adoptProcessingJob({
    id: job.id, revision: job.revision, ack: 'I_REVIEWED_FILES', fileHashes: hashes(job),
  }, owner), /旧部门分组规则/);
  assert.equal(Number((await env.DB.prepare('SELECT COUNT(*) AS count FROM processing_active_sources WHERE job_id=?').bind(job.id).first()).count), 0);
  await env.DB.prepare('UPDATE processing_jobs SET data_key=? WHERE id=?').bind(originalStateKey, job.id).run();

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
  assert.equal(await workspaceSnapshot(), null);

  const disguised = await sourceFile('员工甲', 500, '改名资金表.xlsx');
  const disguisedWorkbook = new ExcelJS.Workbook();
  await disguisedWorkbook.xlsx.load(disguised.bytes);
  disguisedWorkbook.getWorksheet('金额来源').getCell('A1').value = '更改无关格式形成新文件哈希';
  const alteredBytes = await bytes(disguisedWorkbook);
  let replay = await jobs.createProcessingJob(owner);
  replay = await jobs.uploadProcessingJobFile({ id: replay.id, revision: replay.revision, role: 'source', name: '改名资金表.xlsx', bytes: alteredBytes, priority: 1 }, owner);
  replay = await jobs.uploadProcessingJobFile({ id: replay.id, revision: replay.revision, role: 'template', name: '模板.xlsx', bytes: templateBytes }, owner);
  replay = (await prepare(owner, replay, '重复余额尝试')).job;
  replay = await jobs.adoptProcessingJob({
    id: replay.id, revision: replay.revision, ack: 'I_REVIEWED_FILES', fileHashes: hashes(replay),
  }, owner);
  assert.equal(replay.status, 'adopted');
  assert.equal(Number((await env.DB.prepare('SELECT COUNT(*) AS count FROM processing_active_sources WHERE job_id=?').bind(replay.id).first()).count), 0);

  const next = await jobs.createProcessingJob(owner);
  assert.equal(next.status, 'draft');
  assert.equal(next.product, null);
  assert.equal(next.priceCents, null);
  assert.equal(next.quantity, null);
  assert.equal(next.parentJobId, null);
  assert.equal(next.sources.length, 0);
  assert.equal(await workspaceSnapshot(), null);

  const secondSummary = await jobs.listProcessingJobs(owner);
  assert.equal(secondSummary.summary.prepared, 0);
  assert.equal(secondSummary.summary.adopted, 2);
  assert.equal(secondSummary.summary.draft, 1);
});

test('a batch accepts at most 10 equal source files and rejects the 11th on the server', async () => {
  const owner = await addUser('operator-source-cap');
  let job = await jobs.createProcessingJob(owner);
  for (let index = 1; index <= 10; index++) {
    const source = await sourceFile(`员工${index}`, 400 + index, `资金来源${String(index).padStart(2, '0')}.xlsx`, `部门${index}`, `中心${index}`, `成本${index}`);
    job = await upload(owner, job, 'source', source, index);
  }
  assert.equal(job.sources.length, 10);
  const overflow = await sourceFile('员工11', 411, '资金来源11.xlsx', '部门11', '中心11', '成本11');
  await assert.rejects(upload(owner, job, 'source', overflow, 11), /最多上传10份资金表/);
});

test('temporary batches delete records and files while adopted audit batches are protected', async () => {
  const owner = await addUser('operator-delete-owner');
  const viewer = await addUser('viewer-delete-denied', 'viewer');
  const admin = await addUser('admin-delete', 'admin');
  let draft = await jobs.createProcessingJob(owner);
  draft = await upload(owner, draft, 'source', await sourceFile('删除测试员工', 600, '删除测试资金.xlsx'), 1);
  draft = await jobs.uploadProcessingJobFile({
    id: draft.id, revision: draft.revision, role: 'template', name: '删除测试模板.xlsx', bytes: await templateFile(),
  }, owner);
  const draftPrefix = `processing-jobs/${draft.id}/`;
  const beforeDelete = await env.BUCKET.list({ prefix: draftPrefix });
  assert.ok(beforeDelete.objects.length >= 3);

  await assert.rejects(
    jobs.deleteProcessingJob({ id: draft.id, revision: draft.revision }, viewer),
    /查看账号不能修改任务/,
  );
  await assert.rejects(
    jobs.deleteProcessingJob({ id: draft.id, revision: draft.revision + 1 }, owner),
    /刷新后重试/,
  );
  await jobs.deleteProcessingJob({ id: draft.id, revision: draft.revision }, owner);
  assert.equal(await jobs.getProcessingJob(draft.id, owner).catch(error => error.status), 404);
  assert.equal(Number((await env.DB.prepare('SELECT COUNT(*) AS count FROM processing_job_events WHERE job_id=?').bind(draft.id).first()).count), 0);
  assert.equal(Number((await env.DB.prepare('SELECT COUNT(*) AS count FROM processing_active_sources WHERE job_id=?').bind(draft.id).first()).count), 0);
  assert.equal((await env.BUCKET.list({ prefix: draftPrefix })).objects.length, 0);

  let adopted = await jobs.createProcessingJob(owner);
  adopted = await upload(owner, adopted, 'source', await sourceFile('正式员工', 900, '正式资金.xlsx'), 1);
  adopted = await jobs.uploadProcessingJobFile({
    id: adopted.id, revision: adopted.revision, role: 'template', name: '正式模板.xlsx', bytes: await templateFile(),
  }, owner);
  adopted = (await prepare(owner, adopted, '正式商品', '3', 33)).job;
  adopted = await jobs.adoptProcessingJob({
    id: adopted.id, revision: adopted.revision, ack: 'I_REVIEWED_FILES', fileHashes: hashes(adopted),
  }, owner);
  await assert.rejects(
    jobs.deleteProcessingJob({ id: adopted.id, revision: adopted.revision }, owner),
    /已完成批次不能删除/,
  );
  assert.equal((await jobs.getProcessingJob(adopted.id, owner)).status, 'adopted');

  let adminDraft = await jobs.createProcessingJob(owner);
  adminDraft = await upload(owner, adminDraft, 'source', await sourceFile('管理员删除员工', 450, '管理员删除资金.xlsx'), 1);
  await jobs.deleteProcessingJob({ id: adminDraft.id, revision: adminDraft.revision }, admin);
  assert.equal(await jobs.getProcessingJob(adminDraft.id, owner).catch(error => error.status), 404);
});

test('batch numbers are stable sequential labels and are not reused after deletion', async () => {
  const owner = await addUser('operator-number-labels');
  const first = await jobs.createProcessingJob(owner);
  const second = await jobs.createProcessingJob(owner);
  assert.ok(Number.isSafeInteger(first.batchNumber) && first.batchNumber >= 1);
  assert.equal(second.batchNumber, first.batchNumber + 1);

  const listed = await jobs.listProcessingJobs(owner);
  assert.deepEqual(
    listed.jobs.map(job => job.batchNumber).sort((a, b) => a - b),
    [first.batchNumber, second.batchNumber],
  );

  await jobs.deleteProcessingJob({ id: first.id, revision: first.revision }, owner);
  const third = await jobs.createProcessingJob(owner);
  assert.equal(third.batchNumber, second.batchNumber + 1);
});

test('each row with a blank department remains an independent exact-allocation group', async () => {
  const owner = await addUser('operator-blank-groups');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('金额来源');
  sheet.getRow(3).values = ['申领人','申领部门','使用部门','成本中心','成本','费用承担法律主体','','申领用途'];
  sheet.getCell('D2').value = 2;
  sheet.getCell('E2').value = 2;
  sheet.getRow(4).values = ['同一申领人','','','同一成本',1,'合成公司（L000001）','','同一用途'];
  sheet.getRow(5).values = ['同一申领人','','','同一成本',1,'合成公司（L000001）','','同一用途'];
  const source = { bytes: await bytes(workbook), name: '两条空白部门行.xlsx' };
  let job = await jobs.createProcessingJob(owner);
  job = await upload(owner, job, 'source', source, 1);

  await assert.rejects(jobs.simulateProcessingJob({
    id: job.id, revision: job.revision, product: '合成产品', price: '1', quantity: 2,
    assignments: [{ sourceId: job.sources[0].id, rowId: 'fabricated-row', department: '猜测部门', useCenter: '猜测中心' }],
  }, owner), /不允许人工补填部门/);

  const { simulation } = await jobs.simulateProcessingJob({
    id: job.id, revision: job.revision, product: '合成产品', price: '1', quantity: 2,
  }, owner);
  assert.equal(simulation.totalCents, 200);
  assert.equal(simulation.groups.length, 2);
  assert.notEqual(simulation.groups[0].key, simulation.groups[1].key);
  assert.ok(simulation.groups.every(group => group.department === '' && group.useCenter === '' && group.availableCents === 100));
});

test('adopt versus discard does not create cross-batch source reservations', async () => {
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
  assert.ok(current.status === 'adopted' || current.status === 'discarded');
  assert.equal(locked, 0);
  assert.equal(result.some(item => item.status === 'fulfilled'), true);
});

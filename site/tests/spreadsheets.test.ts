import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { build } from 'esbuild';

const project = fileURLToPath(new URL('../', import.meta.url));
const work = path.join(project, 'work', 'excel-io-tests');
await mkdir(work, { recursive: true });
// Bundle application TS locally to retain its normal extensionless imports.
// No business code, dependency input, real client workbook or ledger is changed.
const bundle = path.join(work, 'spreadsheets-under-test.mjs');
await build({ entryPoints: [path.join(project, 'app/lib/spreadsheets.ts')], outfile: bundle,
  bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
const io = await import(new URL(`file:///${bundle.replace(/\\/g, '/')}`).href);
// @ts-ignore Node's native TypeScript runner needs the explicit extension.
const { planAllocation } = await import('../app/lib/allocation.ts');

const sourceHeaders = ['申领人', '申领部门', '使用部门', '成本中心', '成本', '费用承担法律主体', '备注', '申领用途'];
const invoiceHeaders = ['申领人', '申领部门', '使用部门', '成本中心', '部门使用金额', '费用承担法律主体', '开票明细', '申领用途', '单价', '数量', '总计金额', '备注'];
const EP = 'EP202602120005（需要更改）';
const normalEntity = '示例（北京）有限公司（L100001）';

function row(amount: number, overrides: Record<string, unknown> = {}): unknown[] {
  const fields = { applicant: '跨表人', department: '部门', useCenter: '中心', costCenter: '成本中心', legalEntity: normalEntity, purpose: '员工礼品', note: '应保留的原备注', ...overrides };
  return [fields.applicant, fields.department, fields.useCenter, fields.costCenter, amount, fields.legalEntity, fields.note, fields.purpose];
}
async function workbookBytes(wb: ExcelJS.Workbook): Promise<Uint8Array> { return new Uint8Array(await wb.xlsx.writeBuffer()); }
async function open(bytes: Uint8Array): Promise<ExcelJS.Workbook> { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(bytes as never); return wb; }
function value(cell: ExcelJS.Cell): any { const v = cell.value; return cell.type === ExcelJS.ValueType.Formula ? cell.result : v; }
function exactCents(v: unknown): number {
  const text = String(v); assert.match(text, /^\d+(?:\.\d{1,2})?$/);
  const [a, b = ''] = text.split('.'); return Number(a) * 100 + Number(b.padEnd(2, '0'));
}
function isRed(cell: ExcelJS.Cell): boolean { return cell.font?.color?.argb?.slice(-6).toUpperCase() === 'FF0000'; }
function costs(ws: ExcelJS.Worksheet): { row: number; amount: number; red: boolean; applicant: string; purpose: string }[] {
  const result = [];
  for (let r = 4; r <= ws.rowCount; r++) {
    const v = value(ws.getCell(r, 5)); if (typeof v !== 'number') continue;
    result.push({ row: r, amount: exactCents(v), red: isRed(ws.getCell(r, 5)), applicant: String(value(ws.getCell(r, 1))), purpose: String(value(ws.getCell(r, 8))) });
  }
  return result;
}
function sum(items: { amount: number }[]): number { return items.reduce((n, x) => n + x.amount, 0); }
async function sourceFile(name: string, priority: number, rows: unknown[][], historic = 0, options: { headerRow?: number; historicalRedRow?: number } = {}) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('金额来源');
  const headerRow = options.headerRow ?? 3;
  ws.getRow(headerRow).values = sourceHeaders;
  rows.forEach((r, index) => { const target = ws.getRow(headerRow + index + 1); target.values = r as ExcelJS.CellValue[]; target.height = 32; target.eachCell(c => { c.font = { name: 'Arial', size: 11 }; c.alignment = { wrapText: true }; }); });
  const available = rows.reduce((a, r) => a + exactCents(r[4]), 0);
  ws.getCell('D2').value = (available + historic) / 100;
  ws.getCell('E2').value = { formula: `SUM(E${headerRow + 1}:E${headerRow + rows.length})`, result: available / 100 };
  if (historic) { ws.getCell('I1').value = '旧产品'; ws.getCell('I2').value = historic / 100; }
  if (options.historicalRedRow) ws.getCell(options.historicalRedRow, 5).font = { color: { argb: 'FFFF0000' } };
  const bytes = await workbookBytes(wb); return { bytes, source: await io.parseSource(bytes, name, priority) };
}
async function template(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('开票单');
  ws.getCell('A1').value = EP; ws.getRow(3).values = invoiceHeaders;
  for (let c = 1; c <= 12; c++) { ws.getCell(4, c).font = { name: 'Arial', size: 11 }; ws.getColumn(c).width = c === 7 ? 45 : 22; }
  ws.getRow(4).height = 28; return workbookBytes(wb);
}
async function generate(sourcePairs: any[], priceCents: number, quantity: number, taxes: any[] = [], templateOverride?: Uint8Array) {
  const sources = sourcePairs.map(x => x.source); const plan = planAllocation(sources, priceCents, quantity);
  const result = await io.generateBatchFiles({ batchId: 'test-current-batch', batchCreatedAt: '2026-11-05T00:00:00.000Z', product: '香蕉牛', priceCents, quantity, sources, plan, taxes,
    sourceBuffers: Object.fromEntries(sourcePairs.map(x => [x.source.id, x.bytes])), template: templateOverride ?? await template(), productHistory: [{ batchId: 'old-batch', product: '旧产品' }] });
  return { ...result, sources, plan };
}

test('two-source cross-group outputs independently reconcile exact use, split rows, top ledgers and six files', async () => {
  // Independent arithmetic: 10.50 + 389.50 = 400.00; 33 * 3 = 99.00;
  // FIFO uses 10.50 and 88.50, leaving exactly 301.00 in source 2.
  const first = await sourceFile('第一来源.xlsx', 1, [row(10.5)], 725);
  const second = await sourceFile('第二来源.xlsx', 2, [row(389.5, { legalEntity: '【L100001】示例（北京）有限公司' })], 50000);
  const output = await generate([first, second], 3300, 3);
  assert.equal(output.files.length, 6);
  const expected = [
    { source: first.source, before: 1050, used: 1050, remaining: 0, previous: 725, original: 1775 },
    { source: second.source, before: 38950, used: 8850, remaining: 30100, previous: 50000, original: 88950 },
  ];
  for (const oracle of expected) {
    const markedFile = output.files.find((x: any) => x.role === `${oracle.source.id}_marked`)!;
    const remainingFile = output.files.find((x: any) => x.role === `${oracle.source.id}_remaining`)!;
    await writeFile(path.join(work, markedFile.name), markedFile.bytes); await writeFile(path.join(work, remainingFile.name), remainingFile.bytes);
    const marked = (await open(markedFile.bytes)).worksheets[0]; const remaining = (await open(remainingFile.bytes)).worksheets[0];
    const markedRows = costs(marked); const remainingRows = costs(remaining);
    assert.equal(sum(markedRows), oracle.before, 'marked split rows preserve original current amount');
    assert.equal(sum(markedRows.filter(x => x.red)), oracle.used);
    assert.equal(sum(markedRows.filter(x => !x.red)), oracle.remaining);
    assert.equal(sum(remainingRows), oracle.remaining); assert.ok(remainingRows.every(x => !x.red));
    for (const ws of [marked, remaining]) {
      assert.deepEqual(Array.from({ length: 8 }, (_, c) => value(ws.getCell(3, c + 1))), sourceHeaders, 'header cells stay in their original columns');
      assert.equal(exactCents(value(ws.getCell('D2'))), oracle.original);
      assert.equal(exactCents(value(ws.getCell('E2'))), oracle.remaining);
      assert.equal(value(ws.getCell('I1')), '旧产品'); assert.equal(exactCents(value(ws.getCell('I2'))), oracle.previous);
      assert.equal(value(ws.getCell('J1')), '香蕉牛'); assert.equal(exactCents(value(ws.getCell('J2'))), oracle.used);
      assert.equal(exactCents(value(ws.getCell('C2'))), oracle.original); assert.equal(value(ws.getCell('G2')), 0);
      assert.equal(oracle.original, oracle.remaining + oracle.previous + oracle.used);
      assert.match(String((ws.getCell('C2').value as any).formula), /J2/);
    }
  }
  const invoiceFile = output.files.find((x: any) => x.role === 'invoice')!; const invoice = (await open(invoiceFile.bytes)).worksheets[0];
  assert.equal(value(invoice.getCell('A1')), EP); assert.equal(value(invoice.getCell('I2')), 33);
  assert.equal(value(invoice.getCell('J2')), 3); assert.equal(value(invoice.getCell('K2')), 99);
  assert.equal(value(invoice.getCell('E4')), 99); assert.equal(value(invoice.getCell('J4')), 3); assert.equal(value(invoice.getCell('K4')), 99);
  assert.match(output.folderName, /（旧产品／香蕉牛）$/);
});

test('remaining file keeps original record identity after partial split and re-import', async () => {
  const first = await sourceFile('第一来源.xlsx', 1, [row(10.5)]);
  const second = await sourceFile('第二来源.xlsx', 2, [row(389.5)]);
  const output = await generate([first, second], 3300, 3);
  const file = output.files.find((x: any) => x.role === `${second.source.id}_remaining`)!;
  const imported = await io.parseSource(file.bytes, file.name, 2);
  assert.equal(imported.id, second.source.id); assert.equal(imported.rows.length, 1);
  assert.equal(imported.rows[0].id, second.source.rows[0].id);
  assert.equal(imported.rows[0].originalFile, '第二来源.xlsx'); assert.equal(imported.rows[0].originalRow, 4);
  assert.equal(imported.rows[0].amountCents, 30100); assert.equal(imported.rows[0].sheetRow, 4);
  assert.equal(imported.history.at(-1).batchId, 'test-current-batch'); assert.equal(imported.history.at(-1).usedCents, 8850);
});

test('stripping remaining-table metadata cannot hide an equivalent balance from duplicate detection', async () => {
  const first = await sourceFile('第一来源.xlsx', 1, [row(10.5)]);
  const second = await sourceFile('第二来源.xlsx', 2, [row(389.5)]);
  const output = await generate([first, second], 3300, 3);
  const remaining = output.files.find((x: any) => x.role === `${second.source.id}_remaining`)!;
  const wb = await open(remaining.bytes);
  const metadata = wb.getWorksheet('_分摊元数据'); assert.ok(metadata); wb.removeWorksheet(metadata!.id);
  const sheet = wb.getWorksheet('金额来源')!;
  sheet.getCell('H4').value = `${String(value(sheet.getCell('H4')))} `;
  sheet.getCell('J1').value = `${String(value(sheet.getCell('J1')))} `;
  const stripped = await io.parseSource(await workbookBytes(wb), '重新命名.xlsx', 9);
  assert.notEqual(stripped.id, second.source.id);
  assert.notEqual(stripped.sha256, second.source.sha256);
  await assert.rejects(io.assertDistinctSourceBalance(stripped, output.nextSources), /自动检查不能用新编号.*证明/);
});

test('a resaved original balance cannot return after later batches changed the current ledger', async () => {
  const first = await sourceFile('第一来源.xlsx', 1, [row(10.5)]);
  const second = await sourceFile('第二来源.xlsx', 2, [row(389.5)]);
  const output = await generate([first, second], 3300, 3);
  const wb = await open(second.bytes); wb.getWorksheet('金额来源')!.getCell('H2').value = 'changed-only-in-format-review';
  const resaved = await io.parseSource(await workbookBytes(wb), '原表另存.xlsx', 9);
  assert.notEqual(resaved.sha256, second.source.sha256);
  await assert.rejects(io.assertDistinctSourceBalance(resaved, output.nextSources), /自动检查不能用新编号.*证明/);
});

test('editing row text or splitting rows cannot disguise the same monetary balance', async () => {
  const original = await sourceFile('第一来源.xlsx', 1, [row(500)]);
  const relabelled = await open(original.bytes);
  const ws = relabelled.getWorksheet('金额来源')!;
  ws.getCell('H4').value = `${String(value(ws.getCell('H4')))} `;
  const relabelledSource = await io.parseSource(await workbookBytes(relabelled), '仅改用途空格.xlsx', 2);
  await assert.rejects(io.assertDistinctSourceBalance(relabelledSource, [original.source]), /自动检查不能用新编号.*证明/);

  const split = await open(original.bytes);
  const splitSheet = split.getWorksheet('金额来源')!;
  splitSheet.getCell('E4').value = 200;
  splitSheet.getRow(5).values = [String(value(splitSheet.getCell('A4'))), String(value(splitSheet.getCell('B4'))), String(value(splitSheet.getCell('C4'))), String(value(splitSheet.getCell('D4'))), 300, String(value(splitSheet.getCell('F4'))), String(value(splitSheet.getCell('G4'))), String(value(splitSheet.getCell('H4')))];
  splitSheet.getCell('E2').value = { formula: 'SUM(E4:E5)', result: 500 };
  const splitSource = await io.parseSource(await workbookBytes(split), '拆成两行.xlsx', 2);
  await assert.rejects(io.assertDistinctSourceBalance(splitSource, [original.source]), /自动检查不能用新编号.*证明/);
});

test('a repeated monetary balance is rejected even with a new audited source reference', async () => {
  const first = await sourceFile('第一来源.xlsx', 1, [row(500)]);
  const independent = await sourceFile('另一笔同额来源.xlsx', 2, [row(500, { costCenter: '另一成本中心' })]);
  independent.source.sourceReference = 'FIN-2026-0002';
  independent.source.importAttestation = { mode: 'attested-independent', confirmedBy: 'operator-1', confirmedAt: '2026-11-05T00:00:00.000Z', reference: 'FIN-2026-0002' };
  await assert.rejects(io.assertDistinctSourceBalance(independent.source, [first.source]), /自动检查不能用新编号.*证明/);
});

test('a source reference is globally unique even when the monetary balance differs', async () => {
  const first = await sourceFile('第一来源.xlsx', 1, [row(500)]);
  first.source.sourceReference = 'FIN-SAME';
  const different = await sourceFile('不同金额来源.xlsx', 2, [row(600)]);
  different.source.sourceReference = 'fin-same';
  different.source.importAttestation = { mode: 'attested-independent', confirmedBy: 'operator-1', confirmedAt: '2026-11-05T00:00:00.000Z', reference: 'fin-same' };
  await assert.rejects(io.assertDistinctSourceBalance(different.source, [first.source]), /已经使用/);
});

test('distinct unused sources at different initial totals can be imported together', async () => {
  const first = await sourceFile('第一来源.xlsx', 1, [row(500)]);
  first.source.sourceReference = 'OPENING-1';
  const second = await sourceFile('第二来源.xlsx', 2, [row(900, { applicant: '另一申领人', purpose: '另一申领用途' })]);
  second.source.sourceReference = 'OPENING-2';
  second.source.importAttestation = { mode: 'attested-independent', confirmedBy: 'operator-1', confirmedAt: '2026-11-05T00:00:00.000Z', reference: 'OPENING-2' };
  await io.assertDistinctSourceBalance(second.source, [first.source]);
});

test('changing both opening and history totals cannot disguise the same available balance', async () => {
  const first = await sourceFile('第一来源.xlsx', 1, [row(400)], 10000);
  first.source.sourceReference = 'OPENING-1';
  const altered = await sourceFile('改写原额和历史.xlsx', 2, [row(400)], 20000);
  altered.source.sourceReference = 'OPENING-2';
  altered.source.importAttestation = { mode: 'attested-independent', confirmedBy: 'operator-2', confirmedAt: '2026-11-05T00:00:00.000Z', reference: 'OPENING-2' };
  await assert.rejects(io.assertDistinctSourceBalance(altered.source, [first.source]), /自动检查不能用新编号.*证明/);
});

test('changing every monetary total cannot disguise a copied set of source rows', async () => {
  const first = await sourceFile('第一来源.xlsx', 1, [row(400)], 10000);
  first.source.sourceReference = 'OPENING-1';
  const altered = await sourceFile('同时改写三类金额.xlsx', 2, [row(399)], 20000);
  altered.source.sourceReference = 'OPENING-2';
  altered.source.importAttestation = { mode: 'attested-independent', confirmedBy: 'operator-2', confirmedAt: '2026-11-05T00:00:00.000Z', reference: 'OPENING-2' };
  await assert.rejects(io.assertDistinctSourceBalance(altered.source, [first.source]), /自动检查不能用新编号.*证明/);
});

test('splitting a copied row and changing every monetary total is still rejected', async () => {
  const first = await sourceFile('第一来源.xlsx', 1, [row(400)], 10000);
  first.source.sourceReference = 'OPENING-1';
  const altered = await sourceFile('拆行并改写全部金额.xlsx', 2, [row(200), row(199)], 20000);
  altered.source.sourceReference = 'OPENING-2';
  altered.source.importAttestation = { mode: 'attested-independent', confirmedBy: 'operator-2', confirmedAt: '2026-11-05T00:00:00.000Z', reference: 'OPENING-2' };
  await assert.rejects(io.assertDistinctSourceBalance(altered.source, [first.source]), /自动检查不能用新编号.*证明/);
});

test('changing one business field with all monetary totals is rejected as partial overlap', async () => {
  const first = await sourceFile('第一来源.xlsx', 1, [row(400)], 10000);
  first.source.sourceReference = 'OPENING-1';
  const altered = await sourceFile('仅改用途和金额.xlsx', 2, [row(399, { purpose: '用途1' })], 20000);
  altered.source.sourceReference = 'OPENING-2';
  altered.source.importAttestation = { mode: 'attested-independent', confirmedBy: 'operator-2', confirmedAt: '2026-11-05T00:00:00.000Z', reference: 'OPENING-2' };
  await assert.rejects(io.assertDistinctSourceBalance(altered.source, [first.source]), /自动检查不能用新编号.*证明/);
});

test('different omitted field positions do not create a false five-field overlap', async () => {
  const first = await sourceFile('第一来源.xlsx', 1, [row(100, { applicant: '甲', department: '同', useCenter: '同', costCenter: '成本一', purpose: '用途' })]);
  first.source.sourceReference = 'OPENING-1';
  const second = await sourceFile('第二来源.xlsx', 2, [row(200, { applicant: '甲', department: '部门二', useCenter: '同', costCenter: '同', purpose: '用途' })]);
  second.source.sourceReference = 'OPENING-2';
  second.source.importAttestation = { mode: 'attested-independent', confirmedBy: 'operator-2', confirmedAt: '2026-11-05T00:00:00.000Z', reference: 'OPENING-2' };
  await io.assertDistinctSourceBalance(second.source, [first.source]);
});

test('fully exhausted remaining file can be re-imported as a zero balance without losing historical ledger', async () => {
  const first = await sourceFile('第一来源.xlsx', 1, [row(10.5)], 725);
  const second = await sourceFile('第二来源.xlsx', 2, [row(389.5)]);
  const output = await generate([first, second], 3300, 3);
  const file = output.files.find((x: any) => x.role === `${first.source.id}_remaining`)!;
  const imported = await io.parseSource(file.bytes, file.name, 1);
  assert.equal(imported.rows.length, 0); assert.equal(imported.originalCents, 1775);
  assert.equal(imported.history.reduce((s: number, h: any) => s + h.usedCents, 0), 1775);
});

test('tax branches, text identifiers, pending red fill and legal-entity blocks survive final workbook export', async () => {
  const small = '小规模公司（L100002）', simple = '简易征收公司（L100003）', english = 'Example International Limited（L900001）', pending = '资料缺失公司（L100004）';
  const first = await sourceFile('第一来源.xlsx', 1, [
    row(33, { applicant: '一般甲' }), row(33, { applicant: '小规模', legalEntity: small }),
    row(33, { applicant: '一般乙', legalEntity: 'L100001 示例（北京）有限公司' }), row(33, { applicant: '简易', legalEntity: simple }),
    row(33, { applicant: '英文', legalEntity: english }), row(33, { applicant: '待补', legalEntity: pending }),
  ]);
  const second = await sourceFile('第二来源.xlsx', 2, [row(299.99, { applicant: '未用记录' })]);
  const taxBook = new ExcelJS.Workbook(), taxes = taxBook.addWorksheet('税务');
  taxes.addRow(['法律主体编码', '实际主体名称', '当前主体类型', '社会统一信用代码', '注册地址', '开户行', '银行基本户账号']);
  taxes.addRows([
    ['L100001', '示例（北京）有限公司', '一般纳税人-一般征收', '001100000000000001', '注册地址原文', '开户行原文', '00012345678901234'],
    ['L100002', '小规模公司', '小规模纳税人', '001100000000000002', '', '', ''],
    ['L100003', '简易征收公司', '一般纳税人-简易征收', '001100000000000003', '', '', ''],
  ]);
  const parsed = await io.parseTaxes(await workbookBytes(taxBook));
  assert.equal(parsed[0].credit, '001100000000000001'); assert.equal(parsed[0].account, '00012345678901234');
  const output = await generate([first, second], 3300, 6, parsed);
  for (const [source, expectedBefore, expectedUsed, expectedRemaining] of [[first.source, 19800, 19800, 0], [second.source, 29999, 0, 29999]] as const) {
    const marked = (await open(output.files.find((x: any) => x.role === `${source.id}_marked`)!.bytes)).worksheets[0];
    const remaining = (await open(output.files.find((x: any) => x.role === `${source.id}_remaining`)!.bytes)).worksheets[0];
    assert.equal(sum(costs(marked)), expectedBefore); assert.equal(sum(costs(marked).filter(r => r.red)), expectedUsed); assert.equal(sum(costs(remaining)), expectedRemaining);
  }
  const file = output.files.find((x: any) => x.role === 'invoice')!;
  const ws = (await open(file.bytes)).worksheets[0];
  const names = Array.from({ length: 6 }, (_, i) => value(ws.getCell(i + 4, 1)));
  assert.deepEqual(names, ['一般乙', '一般甲', '小规模', '待补', '简易', '英文']);
  const expectedNormal = ['示例（北京）有限公司', '001100000000000001', '注册地址原文', '开户行原文', '00012345678901234', '', '专票'].join('\n');
  assert.equal(value(ws.getCell('G4')), expectedNormal); assert.equal(value(ws.getCell('G5')), expectedNormal);
  assert.equal(value(ws.getCell('G6')), '001100000000000002'); assert.equal(value(ws.getCell('G8')), '001100000000000003');
  assert.equal(value(ws.getCell('G9')), '形式发票'); assert.equal(value(ws.getCell('G7')) ?? '', '');
  assert.equal((ws.getCell('G7').fill as ExcelJS.FillPattern).fgColor?.argb, 'FFFF0000');
  assert.equal(output.taxPending, 1); assert.equal(value(ws.getCell('K2')), 198); assert.equal(value(ws.getCell('J2')), 6);
  assert.equal(Array.from({ length: 6 }, (_, i) => exactCents(value(ws.getCell(i + 4, 5)))).reduce((a, b) => a + b, 0), 19800);
});

test('conditional formatting on the cost column fails closed instead of treating runtime-used money as available', async () => {
  const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('金额来源');
  ws.getRow(3).values=sourceHeaders;ws.getRow(4).values=row(33) as ExcelJS.CellValue[];
  ws.getCell('D2').value=33;ws.getCell('E2').value={formula:'SUM(E4:E4)',result:33};
  ws.addConditionalFormatting({ref:'E4:E4',rules:[{type:'expression',priority:1,formulae:['$F4="已用"'],style:{font:{color:{argb:'FFFF0000'}}}}]});
  await assert.rejects(io.parseSource(await workbookBytes(wb),'条件红字.xlsx',1),/成本列E含有条件格式/);
});

test('a non-red conditional format on the cost column also fails closed', async () => {
  const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('金额来源');
  ws.getRow(3).values=sourceHeaders;ws.getRow(4).values=row(33) as ExcelJS.CellValue[];
  ws.getCell('D2').value=33;ws.getCell('E2').value={formula:'SUM(E4:E4)',result:33};
  ws.addConditionalFormatting({ref:'E4:E4',rules:[{type:'expression',priority:1,formulae:['$F4="已用"'],style:{font:{color:{argb:'FF0000FF'}}}}]});
  await assert.rejects(io.parseSource(await workbookBytes(wb),'条件蓝字.xlsx',1),/成本列E含有条件格式/);
});

test('conditional formatting with multiple whitespace-separated ranges fails closed', async () => {
  const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('金额来源');
  ws.getRow(3).values=sourceHeaders;ws.getRow(4).values=row(500) as ExcelJS.CellValue[];
  ws.getCell('D2').value=500;ws.getCell('E2').value={formula:'SUM(E4:E4)',result:500};
  ws.addConditionalFormatting({ref:'E4:E5 E10:E20',rules:[{type:'expression',priority:1,formulae:['$F4="已用"'],style:{font:{color:{argb:'FFFF0000'}}}}]});
  await assert.rejects(io.parseSource(await workbookBytes(wb),'多范围条件红字.xlsx',1),/成本列E含有条件格式/);
});

test('tax decisions require a unique code and honor only explicitly scoped overrides',()=>{
  const taxes=[{code:'L100001',name:'示例公司',kind:'一般纳税人-一般征收',credit:'001',address:'地址 行',bank:'银行支',account:'0001',sourceRow:2,issues:[]}];
  assert.equal(io.taxDecision('示例公司',taxes).mode,'pending');
  assert.equal(io.taxDecision('示例公司(L100001)(L100002)',taxes).mode,'pending');
  const override=io.parseTaxOverrides(new TextEncoder().encode(JSON.stringify({entities:{L100001:{
    confirmed_by_user:true,reason:'本批确认',address:'地址',bank:'银行支行',scope:{batch_ids:['batch-a']},
  }}})));
  return override.then((parsed:any[])=>{
    assert.match(io.taxDecision('示例公司(L100001)',taxes,parsed,'batch-a').text,/地址\n银行支行/);
    assert.equal(io.taxDecision('示例公司(L100001)',taxes,parsed,'batch-b').mode,'pending');
    return io.parseTaxOverrides(new TextEncoder().encode(JSON.stringify({entities:{L100001:{
      confirmed_by_user:true,reason:'未来授权',address:'地址',bank:'银行支行',
      scope:{applies_to_all_future_batches:true,effective_from_utc:'2026-11-05T00:00:00Z'},
    }}}))).then((future:any[])=>{
      assert.match(io.taxDecision('示例公司(L100001)',taxes,future,'batch-c','2026-11-05T08:00:00+08:00').text,/银行支行/);
      assert.equal(io.taxDecision('示例公司(L100001)',taxes,future,'batch-old','2026-11-04T23:59:59+08:00').mode,'pending');
    });
  });
});

test('future tax authorization requires an explicit effective timestamp',async()=>{
  await assert.rejects(io.parseTaxOverrides(new TextEncoder().encode(JSON.stringify({entities:{L100001:{
    confirmed_by_user:true,reason:'未来授权',address:'地址',
    scope:{applies_to_all_future_batches:true},
  }}}))),/effective_from_utc/);
});

test('tax authorization cannot mix explicit batches with future batches',async()=>{
  await assert.rejects(io.parseTaxOverrides(new TextEncoder().encode(JSON.stringify({entities:{L100001:{
    confirmed_by_user:true,reason:'范围冲突',address:'地址',
    scope:{batch_ids:['batch-a'],applies_to_all_future_batches:true,effective_from_utc:'2026-11-05T00:00:00Z'},
  }}}))),/不能同时声明 batch_ids 和未来批次授权/);
});

test('nested and top-level tax scopes cannot hide one another',async()=>{
  await assert.rejects(io.parseTaxOverrides(new TextEncoder().encode(JSON.stringify({entities:{L100001:{
    confirmed_by_user:true,reason:'嵌套冲突',address:'地址',batch_ids:[],
    scope:{batch_ids:['batch-a'],applies_to_all_future_batches:true,effective_from_utc:'2026-11-05T00:00:00Z'},
  }}}))),/batch_ids 重复声明/);
});

test('identical rows are preserved as distinct source records and red rows after full use', async () => {
  const first = await sourceFile('第一来源.xlsx', 1, [row(66), row(66)]);
  const second = await sourceFile('第二来源.xlsx', 2, [row(299.99, { applicant: '未用' })]);
  const output = await generate([first, second], 3300, 4);
  const marked = (await open(output.files.find((x: any) => x.role === `${first.source.id}_marked`)!.bytes)).worksheets[0];
  const redRows = costs(marked).filter(r => r.red); assert.equal(redRows.length, 2); assert.deepEqual(redRows.map(r => r.amount), [6600, 6600]);
  assert.equal(sum(costs(marked)), 13200, 'two identical raw records must not be retained twice during rebuild');
  const trace = (await open(output.files.find((x: any) => x.role === 'audit')!.bytes)).getWorksheet('源行使用与拆分')!;
  assert.equal(trace.rowCount, 3); assert.notEqual(value(trace.getCell(2, 4)), value(trace.getCell(3, 4)));
});

test('ambiguous tax code or numeric account remains pending rather than guessed', async () => {
  const normal = { code: 'L100001', name: '示例（北京）有限公司', kind: '一般纳税人-一般征收', credit: '911100000000000000', address: '地址', bank: '银行', account: '0001234', sourceRow: 2, issues: [] };
  assert.equal(io.taxDecision(normalEntity, [normal, { ...normal, sourceRow: 3 }]).mode, 'pending');
  assert.equal(io.taxDecision(normalEntity, [{ ...normal, issues: ['银行账号在来源中为数值，请确认精度。'] }]).mode, 'pending');
  assert.equal(io.taxDecision(normalEntity, [{ ...normal, name: '另一个公司' }]).mode, 'pending');
});

test('a cached-zero cost formula is skipped without losing the other available records', async () => {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('来源'); ws.getRow(3).values = sourceHeaders;
  ws.getRow(4).values = row(700) as ExcelJS.CellValue[];
  ws.getRow(5).values = row(0, { applicant: '零金额公式' }) as ExcelJS.CellValue[];
  ws.getCell('E5').value = { formula: '0', result: 0 }; ws.getCell('D2').value = 700; ws.getCell('E2').value = 700;
  const imported = await io.parseSource(await workbookBytes(wb), '含零金额公式.xlsx', 1);
  assert.equal(imported.rows.length, 1); assert.equal(imported.rows[0].amountCents, 70000);
});

test('historical red rows stay excluded and marked re-import does not duplicate split row identity', async () => {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('来源'); ws.getRow(3).values = sourceHeaders;
  ws.getRow(4).values = row(100, { applicant: '历史已用' }) as ExcelJS.CellValue[];
  ws.getRow(5).values = row(700) as ExcelJS.CellValue[]; ws.getCell('E4').font = { color: { argb: 'FFFF0000' } };
  ws.getCell('D2').value = 800; ws.getCell('E2').value = 700; ws.getCell('I1').value = '旧产品'; ws.getCell('I2').value = 100;
  const bytes = await workbookBytes(wb), source = await io.parseSource(bytes, '含历史红字.xlsx', 1);
  const output = await generate([{ bytes, source }], 3300, 1);
  const file = output.files.find((x: any) => x.role === `${source.id}_marked`)!;
  await writeFile(path.join(work, 'historical-marked-case.xlsx'), file.bytes);
  const marked = (await open(file.bytes)).worksheets[0];
  assert.equal(sum(costs(marked)), 80000, 'all marked source rows, including historical use, must preserve 800 yuan');
  assert.equal(sum(costs(marked).filter(r => r.red)), 13300); assert.equal(sum(costs(marked).filter(r => !r.red)), 66700);
  const imported = await io.parseSource(file.bytes, file.name, 1);
  assert.equal(new Set(imported.rows.map((r: any) => r.id)).size, imported.rows.length, 'split used and remaining records require distinct import IDs');
  const again = planAllocation([imported], 3300, 1); assert.equal(again.availableCents, 66700);
});

test('shifted source amount column is either explicitly rejected or has a correct exported sum formula', async () => {
  // The parser advertises label mapping. An accepted layout must remain correct
  // after native Excel recalculation, rather than only have a plausible cache.
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('来源');
  ws.getRow(3).values = ['申领人', '申领部门', '使用部门', '成本中心', '费用承担法律主体', '成本', '备注', '申领用途'];
  ws.getRow(4).values = ['甲', '部门', '中心', '成本中心', normalEntity, 33, '备注', '用途'];
  ws.getCell('D2').value = 33; ws.getCell('F2').value = 33;
  const bytes = await workbookBytes(wb); let source: any;
  try { source = await io.parseSource(bytes, '列位置变化.xlsx', 1); } catch (e) { assert.match(String(e), /格式|布局|列|表头/); return; }
  // Consume 33 out of 700 so the remaining SUM cannot accidentally look right at zero.
  source.rows[0].amountCents = 70000; source.originalCents = 70000;
  ws.getCell('F4').value = 700; ws.getCell('D2').value = 700; ws.getCell('F2').value = 700;
  const output = await generate([{ source, bytes: await workbookBytes(wb) }], 3300, 1);
  const exported = (await open(output.files.find((x: any) => x.role === `${source.id}_remaining`)!.bytes)).worksheets[0];
  assert.match(String((exported.getCell('E2').value as any).formula), /F4/, 'remaining formula must sum actual source amount column F');
  assert.equal(value(exported.getCell('F4')), 667); assert.equal(value(exported.getCell('E4')), normalEntity);
});

test('nonempty source detail columns after H retain their values, text IDs and styles in marked and remaining files', async () => {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('来源'); ws.getRow(3).values = sourceHeaders;
  ws.getCell('J3').value = '补充业务备注'; ws.getCell('K3').value = '外部文本编号';
  ws.getRow(4).values = row(700) as ExcelJS.CellValue[];
  ws.getCell('J4').value = '原始备注应完整保留'; ws.getCell('J4').font = { italic: true, name: 'Arial' };
  ws.getCell('K4').value = '0000123'; ws.getCell('K4').numFmt = '@';
  ws.getCell('D2').value = 800; ws.getCell('E2').value = 700; ws.getCell('I1').value = '旧产品'; ws.getCell('I2').value = 100;
  const bytes = await workbookBytes(wb), source = await io.parseSource(bytes, '带后置备注.xlsx', 1);
  const output = await generate([{ bytes, source }], 3300, 1);
  const marked = (await open(output.files.find((x: any) => x.role === `${source.id}_marked`)!.bytes)).worksheets[0];
  const remaining = (await open(output.files.find((x: any) => x.role === `${source.id}_remaining`)!.bytes)).worksheets[0];
  for (const [sheet, rows] of [[marked, [4, 5]], [remaining, [4]]] as const) {
    assert.equal(value(sheet.getCell('J3')), '补充业务备注'); assert.equal(value(sheet.getCell('K3')), '外部文本编号');
    for (const r of rows) {
      assert.equal(value(sheet.getCell(r, 10)), '原始备注应完整保留'); assert.equal(sheet.getCell(r, 10).font.italic, true);
      assert.equal(value(sheet.getCell(r, 11)), '0000123'); assert.equal(sheet.getCell(r, 11).numFmt, '@');
    }
  }
  assert.equal(sum(costs(marked)), 70000); assert.equal(sum(costs(remaining)), 66700);
});

test('reordered template headers receive correct money, tax, quantity and dynamic summary formulas while preserving EP', async () => {
  const first = await sourceFile('第一来源.xlsx', 1, [row(700, { applicant: '换列人员' })]);
  const second = await sourceFile('第二来源.xlsx', 2, [row(500, { applicant: '未用人员' })]);
  const templateBook = new ExcelJS.Workbook(), ws = templateBook.addWorksheet('换列模板');
  ws.getCell('A1').value = EP;
  ws.getRow(3).values = ['总计金额', '开票明细', '申领人', '单价', '费用承担法律主体', '数量', '申领用途', '成本中心', '申领部门', '部门使用金额', '使用中心', '备注'];
  for (let c = 1; c <= 12; c++) ws.getCell(4, c).font = { name: 'Arial', size: 11 };
  const record = { code: 'L100001', name: '示例（北京）有限公司', kind: '一般纳税人-一般征收', credit: '001100000000000001', address: '注册地址', bank: '开户银行', account: '000000000001', sourceRow: 2, issues: [] };
  const output = await generate([first, second], 3300, 1, [record], await workbookBytes(templateBook));
  const exported = (await open(output.files.find((x: any) => x.role === 'invoice')!.bytes)).worksheets[0];
  assert.equal(value(exported.getCell('A1')), EP);
  assert.equal(value(exported.getCell('C4')), '换列人员'); assert.equal(value(exported.getCell('E4')), normalEntity);
  assert.equal(value(exported.getCell('A4')), 33); assert.equal(value(exported.getCell('J4')), 33); assert.equal(value(exported.getCell('D4')), 33);
  assert.equal(value(exported.getCell('F4')), 1); assert.equal(value(exported.getCell('K4')), '中心');
  assert.equal(value(exported.getCell('B4')), ['示例（北京）有限公司', record.credit, record.address, record.bank, record.account, '', '专票'].join('\n'));
  assert.equal(value(exported.getCell('D2')), 33); assert.equal(value(exported.getCell('F2')), 1); assert.equal(value(exported.getCell('A2')), 33);
  assert.equal((exported.getCell('F2').value as any).formula, 'SUM(F4:F4)'); assert.equal((exported.getCell('A2').value as any).formula, 'SUM(A4:A4)');
});


test('explicit source blank-department authorization survives remaining workbook metadata', async () => {
  const first = await sourceFile('部门例外来源.xlsx', 2, [row(33, { department: '' })]);
  first.source.allowBlankDepartment = true;
  const output = await generate([first], 3300, 1);
  const exported = output.files.find((x: any) => x.role === `${first.source.id}_remaining`)!;
  const imported = await io.parseSource(exported.bytes, exported.name, 2);
  assert.equal(imported.id, first.source.id);
  assert.equal(imported.allowBlankDepartment, true);
});

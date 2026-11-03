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
  const result = await io.generateBatchFiles({ batchId: 'test-current-batch', product: '香蕉牛', priceCents, quantity, sources, plan, taxes,
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
  const second = await sourceFile('第二来源.xlsx', 2, [row(700, { applicant: '未用记录' })]);
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
  for (const [source, expectedBefore, expectedUsed, expectedRemaining] of [[first.source, 19800, 19800, 0], [second.source, 70000, 0, 70000]] as const) {
    const marked = (await open(output.files.find((x: any) => x.role === `${source.id}_marked`)!.bytes)).worksheets[0];
    const remaining = (await open(output.files.find((x: any) => x.role === `${source.id}_remaining`)!.bytes)).worksheets[0];
    assert.equal(sum(costs(marked)), expectedBefore); assert.equal(sum(costs(marked).filter(r => r.red)), expectedUsed); assert.equal(sum(costs(remaining)), expectedRemaining);
  }
  const file = output.files.find((x: any) => x.role === 'invoice')!;
  const ws = (await open(file.bytes)).worksheets[0];
  const names = Array.from({ length: 6 }, (_, i) => value(ws.getCell(i + 4, 1)));
  assert.deepEqual(names, ['一般甲', '一般乙', '小规模', '简易', '英文', '待补']);
  const expectedNormal = ['示例（北京）有限公司', '001100000000000001', '注册地址原文', '开户行原文', '00012345678901234', '', '专票'].join('\n');
  assert.equal(value(ws.getCell('G4')), expectedNormal); assert.equal(value(ws.getCell('G5')), expectedNormal);
  assert.equal(value(ws.getCell('G6')), '001100000000000002'); assert.equal(value(ws.getCell('G7')), '001100000000000003');
  assert.equal(value(ws.getCell('G8')), '形式发票'); assert.equal(value(ws.getCell('G9')) ?? '', '');
  assert.equal((ws.getCell('G9').fill as ExcelJS.FillPattern).fgColor?.argb, 'FFFF0000');
  assert.equal(output.taxPending, 1); assert.equal(value(ws.getCell('K2')), 198); assert.equal(value(ws.getCell('J2')), 6);
  assert.equal(Array.from({ length: 6 }, (_, i) => exactCents(value(ws.getCell(i + 4, 5)))).reduce((a, b) => a + b, 0), 19800);
});

test('identical rows are preserved as distinct source records and red rows after full use', async () => {
  const first = await sourceFile('第一来源.xlsx', 1, [row(66), row(66)]);
  const second = await sourceFile('第二来源.xlsx', 2, [row(700, { applicant: '未用' })]);
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

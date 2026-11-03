import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { build } from 'esbuild';

const project = fileURLToPath(new URL('../', import.meta.url));
const work = path.join(project, 'work', 'xlsx-namespace-tests');
await mkdir(work, { recursive: true });
const output = path.join(work, 'spreadsheets.mjs');
await build({ entryPoints: [path.join(project, 'app/lib/spreadsheets.ts')], outfile: output,
  bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
const io = await import(pathToFileURL(output).href);
const compatOutput = path.join(work, 'compat.mjs');
await build({ entryPoints: [path.join(project, 'app/lib/xlsx-namespace-compat.ts')], outfile: compatOutput,
  bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
const compat = await import(pathToFileURL(compatOutput).href);

test('prefixed OOXML keeps source bytes, exact rows, formulas, text and styles in the compatibility copy', async () => {
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('来源');
  ws.getRow(3).values = ['申领人', '申领部门', '使用部门', '成本中心', '成本', '费用承担法律主体', '备注', '申领用途'];
  ws.getRow(4).values = ['人员', '部门', '中心', '成本中心', 700.5, '示例公司（L100001）', '原备注 x:sheet & <x:sheet>', '用途'];
  ws.getCell('E4').numFmt = '0.00';
  ws.getCell('E4').font = { bold: true, color: { argb: 'FF112233' } };
  ws.getCell('E2').value = { formula: 'SUM(E4:E4)', result: 700.5 };
  ws.getCell('D2').value = 800.5;
  ws.getCell('I1').value = '旧商品'; ws.getCell('I2').value = 100;
  const original = new Uint8Array(await wb.xlsx.writeBuffer());
  const zip = await JSZip.loadAsync(original);
  for (const name of ['xl/workbook.xml', 'xl/styles.xml', 'xl/sharedStrings.xml']) {
    const entry = zip.file(name); if (!entry) continue;
    let xml = await entry.async('string');
    xml = xml.replace(/xmlns="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main"/, 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"');
    xml = xml.replace(/<(\/?)((?![!?])[A-Za-z_][\w.-]*)(?=\s|\/?>)/g, '<$1x:$2');
    zip.file(name, xml);
  }
  const prefixed = await zip.generateAsync({ type: 'uint8array' });
  const hashBefore = await io.digest(prefixed);
  const before = await io.parseSource(original, '普通.xlsx', 2);
  const parsed = await io.parseSource(prefixed, '前缀.xlsx', 2);
  assert.equal(await io.digest(prefixed), hashBefore);
  assert.equal(parsed.sha256, hashBefore);
  assert.equal(parsed.originalCents, 80050);
  assert.deepEqual(parsed.rows.map((r: any) => r.rawValues), before.rows.map((r: any) => r.rawValues));
  assert.deepEqual(parsed.history.map((h: any) => [h.product, h.usedCents]), [['旧商品', 10000]]);
  const normalized = await compat.normalizeSpreadsheetNamespaces(prefixed);
  const restored = new ExcelJS.Workbook(); await restored.xlsx.load(normalized as never);
  const sheet = restored.worksheets[0];
  assert.equal((sheet.getCell('E2').value as any).formula, 'SUM(E4:E4)');
  assert.equal(sheet.getCell('E2').result, 700.5);
  assert.equal(sheet.getCell('E4').numFmt, '0.00');
  assert.equal(sheet.getCell('E4').font.bold, true);
  assert.equal(sheet.getCell('E4').font.color?.argb, 'FF112233');
  assert.equal(sheet.getCell('G4').value, '原备注 x:sheet & <x:sheet>');
  assert.equal(await io.digest(prefixed), hashBefore);
});

test('namespace rebinding and potentially changed unprefixed elements are not rewritten', async () => {
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  for (const xml of [
    `<x:workbook xmlns:x="${ns}"><x:sheets xmlns:x="urn:other"/></x:workbook>`,
    `<x:workbook xmlns:x="${ns}"><sheets/></x:workbook>`,
    `<x:workbook xmlns:x="${ns}"><x:sheets xmlns="urn:other"/></x:workbook>`,
  ]) {
    const zip = new JSZip(); zip.file('xl/workbook.xml', xml);
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    await assert.rejects(compat.normalizeSpreadsheetNamespaces(bytes), /不能安全兼容/);
  }
});

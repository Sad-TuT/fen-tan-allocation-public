import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { build } from "esbuild";

const site = fileURLToPath(new URL("../", import.meta.url));
const work = path.join(site, "work", "paste-source-tests");
await mkdir(work, { recursive: true });
const bundle = path.join(work, "paste-source-under-test.mjs");
await build({
  entryPoints: [path.join(site, "app/lib/paste-source.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  logLevel: "silent",
});
const conversion = await import(new URL(`file:///${bundle.replace(/\\/g, "/")}`).href);
const parserBundle = path.join(work, "spreadsheets-under-test.mjs");
await build({
  entryPoints: [path.join(site, "app/lib/spreadsheets.ts")],
  outfile: parserBundle,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  logLevel: "silent",
});
const parser = await import(new URL(`file:///${parserBundle.replace(/\\/g, "/")}`).href);

async function importedSource(clipboard: string) {
  const bytes = await conversion.sourceFromClipboard(clipboard) as Uint8Array;
  const result = await parser.parseSource(bytes, "粘贴资金明细.xlsx", 1);
  return { bytes, source: result };
}

test("pasted full balance keeps header identity, quoted rows, exact cents and historical ledger", async () => {
  const tsv = [
    "\uFEFF\t\t\t\t\t\t\t\t上批商品",
    "\t\t\t100.35\t80.35\t\t0\t\t20.00",
    "申领人\t申领部门\t使用部门\t成本中心\t成本\t费用承担法律主体\t备注\t申领用途\t产品说明",
    '00001234\t"研究部\n一组"\t渠道\t中心-09\t39.90\t示例公司（L100001）\t"备注含“表格\t明细”"\t员工礼品\t"一号商品"',
    '00100567\t财务部\t销售\t中心-10\t40.45\t另一个主体（L100002）\t普通备注\t客户礼品\t"二号商品"',
  ].join("\r\n");
  const { bytes, source } = await importedSource(tsv);
  assert.equal(source.headerRow, 3);
  assert.equal(source.originalCents, 10_035);
  assert.equal(source.history.length, 1);
  assert.equal(source.history[0].usedCents, 2_000);
  assert.equal(source.history[0].product, "上批商品");
  assert.deepEqual(source.rows.map((row: { amountCents: number }) => row.amountCents), [3_990, 4_045]);
  assert.equal(source.rows[0].applicant, "00001234");
  assert.equal(source.rows[0].department, "研究部\n一组");
  assert.equal(source.rows[0].rawValues[6], "备注含“表格\t明细”");
  assert.equal(source.rows[1].applicant, "00100567");
  assert.ok(source.rows.every((row: { historicUsed: boolean }) => !row.historicUsed));

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as never);
  const sheet = workbook.getWorksheet("金额来源")!;
  assert.equal(sheet.getCell("D2").value, 100.35);
  assert.equal(sheet.getCell("E2").value, 80.35);
  assert.equal(sheet.getCell("G2").value, 0);
  assert.equal(sheet.getCell("I1").value, "上批商品");
  assert.equal(sheet.getCell("I2").value, 20);
  assert.equal(sheet.getCell("A4").value, "00001234");
});

test("pasting only header and current detail creates a clean new opening balance", async () => {
  const result = await importedSource([
    "申领人\t申领部门\t使用中心\t成本中心\t金额\t费用承担法律主体\t备注\t申领用途",
    "员工-01\t一部\t华东\tCC-01\t1,200.30\t示例公司（L100001）\t保留原文\t办公室用品",
  ].join("\n"));
  assert.equal(result.source.originalCents, 120_030);
  assert.equal(result.source.history.length, 0);
  assert.equal(result.source.rows[0].amountCents, 120_030);
  assert.equal(result.source.rows[0].rawValues[6], "保留原文");
});

test("rejects missing and duplicated required columns", async () => {
  const missing = "申领人\t部门\t成本\n小明\t一部\t10";
  await assert.rejects(() => conversion.sourceFromClipboard(missing), /完整表头/);
  const duplicate = "申领人\t申领人\t申领部门\t使用部门\t成本中心\t成本\t费用承担法律主体\t申领用途\nA\tB\t一部\t华东\tCC-1\t10\t示例主体（L100001）\t礼品";
  await assert.rejects(() => conversion.sourceFromClipboard(duplicate), /重复列/);
});

test("rejects formula amounts and malformed quoted clipboard cells", async () => {
  const prefix = "申领人\t申领部门\t使用部门\t成本中心\t成本\t费用承担法律主体\t备注\t申领用途\n";
  await assert.rejects(() => conversion.sourceFromClipboard(`${prefix}小明\t一部\t华东\tCC-1\t=SUM(1,2)\t示例主体（L100001）\t\t礼品`), /公式/);
  await assert.rejects(() => conversion.sourceFromClipboard(`${prefix}小明\t"一部\t华东\tCC-1\t10\t示例主体（L100001）\t\t礼品`), /引号没有闭合/);
  await assert.rejects(() => conversion.sourceFromClipboard("x".repeat(1024 * 1024 + 1)), /1 MB/);
});

test("rejects bad money and edited history totals instead of guessing", async () => {
  const header = "申领人\t申领部门\t使用部门\t成本中心\t成本\t费用承担法律主体\t备注\t申领用途";
  await assert.rejects(() => conversion.sourceFromClipboard(`${header}\n小明\t一部\t华东\tCC-1\t10.001\t示例主体（L100001）\t\t礼品`), /最多两位小数/);
  const inconsistent = [
    "\t\t\t\t\t\t\t\t上批商品",
    "\t\t\t100\t\t\t\t\t20",
    header,
    "小明\t一部\t华东\tCC-1\t10.00\t示例主体（L100001）\t\t礼品",
  ].join("\n");
  await assert.rejects(() => conversion.sourceFromClipboard(inconsistent), /对账/);
});

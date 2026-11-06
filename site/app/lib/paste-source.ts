import ExcelJS from "exceljs";
import { cents, parseSource } from "./spreadsheets";

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_ROWS = 20_000;
const MAX_COLUMNS = 64;
const MAX_CELL_CHARACTERS = 10_000;

const HEADERS: Record<string, string[]> = {
  applicant: ["申领人"],
  department: ["申领部门"],
  useCenter: ["使用部门", "使用中心"],
  costCenter: ["成本中心"],
  amount: ["成本", "金额"],
  legalEntity: ["费用承担法律主体"],
  purpose: ["申领用途"],
};

type Table = { rows: string[][]; headerIndex: number; columns: Record<string, number> };

function fail(message: string): never { throw new Error(message); }

/** Parse Excel's tab-separated clipboard format, including CSV-style quoted tabs and newlines. */
function parseTsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;

  const pushField = () => {
    if (field.length > MAX_CELL_CHARACTERS) fail("单元格内容过长，请缩小复制范围后重试。");
    row.push(field);
    field = "";
    closedQuote = false;
    if (row.length > MAX_COLUMNS) fail(`每行最多支持 ${MAX_COLUMNS} 列，请只复制资金明细所需列。`);
  };
  const pushRow = () => {
    pushField();
    if (rows.length >= MAX_ROWS) fail(`一次最多粘贴 ${MAX_ROWS.toLocaleString("zh-CN")} 行，请拆分后上传。`);
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += character;
      }
      if (field.length > MAX_CELL_CHARACTERS) fail("单元格内容过长，请缩小复制范围后重试。");
      continue;
    }

    if (closedQuote && character !== "\t" && character !== "\r" && character !== "\n") {
      fail("粘贴内容的引号格式无效，请从 Excel 重新复制。" );
    }
    if (character === '"') {
      if (field.length) fail("粘贴内容的引号格式无效，请从 Excel 重新复制。" );
      quoted = true;
    } else if (character === "\t") {
      pushField();
    } else if (character === "\r" || character === "\n") {
      pushRow();
      if (character === "\r" && input[index + 1] === "\n") index++;
    } else {
      field += character;
      if (field.length > MAX_CELL_CHARACTERS) fail("单元格内容过长，请缩小复制范围后重试。");
    }
  }
  if (quoted) fail("粘贴内容的引号没有闭合，请从 Excel 重新复制。" );
  if (field.length || row.length) pushRow();
  while (rows.length && rows.at(-1)!.every((cell) => cell === "")) rows.pop();
  return rows;
}

function locateTable(rows: string[][]): Table {
  const required = Object.keys(HEADERS);
  for (let rowIndex = 0; rowIndex < Math.min(20, rows.length); rowIndex++) {
    const columns: Record<string, number> = {};
    const duplicate = new Set<string>();
    for (let column = 0; column < rows[rowIndex].length; column++) {
      const label = rows[rowIndex][column].trim();
      for (const [field, aliases] of Object.entries(HEADERS)) {
        if (!aliases.includes(label)) continue;
        if (columns[field] !== undefined) duplicate.add(field);
        columns[field] = column;
      }
    }
    if (required.every((field) => columns[field] !== undefined)) {
      if (duplicate.size) fail("表头有重复列，请检查申领人、部门、金额等字段后重新粘贴。");
      return { rows, headerIndex: rowIndex, columns };
    }
  }
  return fail("未找到完整表头。请复制包含申领人、申领部门、使用部门或使用中心、成本中心、成本、费用承担法律主体和申领用途的资金明细。" );
}

function preciseCents(raw: string, sourceRow: number): number {
  const value = raw.trim();
  if (value.startsWith("=") || value.startsWith("'= ") || value.startsWith("'=")) fail(`第 ${sourceRow} 行的成本是公式，请先复制计算后的金额值再粘贴。`);
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(value)) {
    return fail(`第 ${sourceRow} 行的成本“${value}”格式无效，请粘贴非负且最多两位小数的金额值。`);
  }
  try {
    return cents(value);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("金额“")) {
      throw new Error(`第 ${sourceRow} 行的成本无法精确处理：${error.message}`);
    }
    throw error;
  }
}

/**
 * Convert a copied Excel balance table into a validated XLSX input.
 * Clipboard text does not retain cell colors. The caller must obtain the
 * user's explicit acknowledgement that this contains only confirmed,
 * currently unused balance rows before calling this function.
 */
export async function sourceFromClipboard(text: string): Promise<Uint8Array> {
  if (typeof text !== "string" || !text.trim()) fail("请先从 Excel 复制资金明细后再粘贴。");
  if (text.length > MAX_TEXT_BYTES) fail("粘贴内容超过 1 MB，请缩小范围或上传 Excel 文件。");
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength > MAX_TEXT_BYTES) fail("粘贴内容超过 1 MB，请缩小范围或上传 Excel 文件。");
  if (text.includes("\u0000")) fail("粘贴内容含有无法读取的字符，请从 Excel 重新复制。");

  const input = text.replace(/^\uFEFF/, "");
  const table = locateTable(parseTsv(input));
  const headers = table.rows[table.headerIndex];
  const width = headers.length;
  if (!width || width > MAX_COLUMNS) fail(`每行最多支持 ${MAX_COLUMNS} 列，请只复制资金明细所需列。`);

  const dataRows = table.rows.slice(table.headerIndex + 1).filter((values) => values.some((value) => value !== ""));
  if (!dataRows.length) fail("没有找到资金明细行，请连同表头一起复制。");

  let availableCents = 0;
  const normalizedRows: string[][] = [];
  for (let index = 0; index < dataRows.length; index++) {
    const sourceRow = table.headerIndex + index + 2;
    const values = dataRows[index];
    if (values.length > width && values.slice(width).some((value) => value !== "")) {
      fail(`第 ${sourceRow} 行的数据列数超出表头，请确认复制范围。`);
    }
    const row = Array.from({ length: width }, (_, column) => values[column] ?? "");
    const rawAmount = row[table.columns.amount];
    if (!rawAmount.trim()) fail(`第 ${sourceRow} 行有其他内容，但缺少成本金额。`);
    const amountCents = preciseCents(rawAmount, sourceRow);
    if (amountCents <= 0) fail(`第 ${sourceRow} 行的成本必须大于 0。`);
    availableCents += amountCents;
    if (!Number.isSafeInteger(availableCents)) fail("资金合计超出精确处理范围，请拆分后重试。");
    row[table.columns.amount] = String(amountCents / 100);
    normalizedRows.push(row);
  }

  // A copied subset can lose source history and red-font information. Carry
  // the previous top ledger only when a complete standard A1 range was copied.
  const hasStandardControlRows = table.headerIndex === 2 && headers.length >= 8;
  const previousHistory: { column: number; product: string; cents: number }[] = [];
  let originalCents = availableCents;
  if (hasStandardControlRows) {
    const header = table.rows[table.headerIndex];
    const openingCell = table.rows[1]?.[3] ?? "";
    if (openingCell.trim()) {
      if (openingCell.trim().startsWith("=")) fail("第 2 行原总额是公式，请从 Excel 复制计算后的单元格值。" );
      originalCents = preciseCents(openingCell, 2);
    }
    for (let column = 8; column < Math.max(header.length, table.rows[0]?.length ?? 0, table.rows[1]?.length ?? 0); column++) {
      const product = (table.rows[0]?.[column] ?? "").trim();
      if (!product || /原总额|剩余|累计|差额/.test(product)) continue;
      const used = (table.rows[1]?.[column] ?? "").trim();
      if (!used) fail(`第 2 行缺少“${product}”的历史使用金额。请复制完整的剩余资金表。`);
      if (used.startsWith("=")) fail(`第 2 行“${product}”是公式，请复制已计算的金额值。`);
      const cents = preciseCents(used, 2);
      previousHistory.push({ column, product, cents });
    }
    const previousCents = previousHistory.reduce((sum, entry) => sum + entry.cents, 0);
    if (!Number.isSafeInteger(previousCents) || originalCents !== availableCents + previousCents) {
      fail("资金表顶部对账与粘贴明细不一致。请复制完整的剩余资金明细，包含顶部的历史登记。");
    }
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "分摊工作台";
  const sheet = workbook.addWorksheet("金额来源");
  sheet.getCell("C1").value = "对账";
  sheet.getCell("C2").value = originalCents / 100;
  sheet.getCell("D1").value = "原总额";
  sheet.getCell("D2").value = originalCents / 100;
  sheet.getCell("E1").value = "剩余可用";
  sheet.getCell("E2").value = availableCents / 100;
  sheet.getCell("G1").value = "差额";
  sheet.getCell("G2").value = 0;
  for (const entry of previousHistory) {
    const cell = entry.column + 1;
    sheet.getCell(1, cell).value = entry.product;
    sheet.getCell(2, cell).value = entry.cents / 100;
  }
  sheet.getRow(3).values = headers;
  normalizedRows.forEach((values, index) => { sheet.getRow(index + 4).values = values; });
  sheet.views = [{ state: "frozen", ySplit: 3 }];

  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
  // Reuse the production parser to verify headers, exact row amounts and top ledger.
  await parseSource(bytes, "粘贴资金明细.xlsx", 1);
  return bytes;
}

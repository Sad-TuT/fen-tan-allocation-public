export const CORE_REVIEW_CHECKS = [
  "EXACT_TOTAL", "QUANTITY", "GROUPING", "REMAINDER", "SOURCE_BALANCE",
  "ROW_SPLITS", "TOP_LEDGER", "FIRST_SOURCE_OPTIMUM", "TAX_SCOPE", "FINAL_FILES",
] as const;

export type FinancialResults = {
  totalCents: number;
  quantity: number;
  sourceUsed: Record<string, number>;
  sourceRemaining: Record<string, number>;
};

export type ReviewReport = {
  reviewerId: string;
  reviewerRunId: string;
  origin: "codex_subagent";
  status: "passed" | "failed";
  reviewDigest: string;
  financials: FinancialResults;
  checks: string[];
  issues: string[];
  unverified: string[];
  summary?: string;
  evidence?: string[];
};

export type ReviewExpectation = {
  reviewDigest: string;
  expectedFinancials: FinancialResults;
};

export class ReviewPolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ReviewPolicyError";
  }
}

const fail = (code: string, message: string): never => {
  throw new ReviewPolicyError(code, message);
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("INVALID_REPORT", `${label}必须为对象。`);
  }
  return value as Record<string, unknown>;
}

function nonempty(value: unknown, label: string, max = 160): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    return fail("INVALID_REPORT", `${label}缺失或长度不合规。`);
  }
  return value;
}

function list(value: unknown, label: string, max = 200): string[] {
  if (!Array.isArray(value) || value.length > max ||
      value.some((x) => typeof x !== "string" || !x.trim() || x.length > 4096)) {
    return fail("INVALID_REPORT", `${label}必须为有效的文字列表。`);
  }
  return [...value] as string[];
}

function money(value: unknown, label: string, positive = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) ||
      (positive ? value <= 0 : value < 0)) {
    return fail("INVALID_FINANCIALS", `${label}必须为精确且有效的整数。`);
  }
  return value;
}

function amountMap(value: unknown, label: string): Record<string, number> {
  const entries = Object.entries(record(value, label));
  if (entries.length === 0 || entries.length > 100) {
    return fail("INVALID_FINANCIALS", `${label}必须包含来源。`);
  }
  return Object.fromEntries(entries.map(([key, amount]) => [
    nonempty(key, "来源编号"), money(amount, `${label}/${key}`),
  ]));
}

export function normalizeFinancials(value: unknown): FinancialResults {
  const data = record(value, "核算结果");
  if (Object.keys(data).sort().join(",") !== "quantity,sourceRemaining,sourceUsed,totalCents") {
    return fail("INVALID_FINANCIALS", "核算结果字段不完整或包含未知字段。");
  }
  const totalCents = money(data.totalCents, "总金额（分）", true);
  const quantity = money(data.quantity, "总数量", true);
  const sourceUsed = amountMap(data.sourceUsed, "各来源用额");
  const sourceRemaining = amountMap(data.sourceRemaining, "各来源余额");
  if (Object.keys(sourceUsed).sort().join("\0") !== Object.keys(sourceRemaining).sort().join("\0")) {
    return fail("INVALID_FINANCIALS", "用额与余额的来源编号不一致。");
  }
  let used = 0;
  for (const amount of Object.values(sourceUsed)) {
    used += amount;
    if (!Number.isSafeInteger(used)) return fail("INVALID_FINANCIALS", "来源用额超出精确计算范围。");
  }
  if (used !== totalCents) return fail("INVALID_FINANCIALS", "各来源用额之和与总金额不一致。");
  return { totalCents, quantity, sourceUsed, sourceRemaining };
}

/** Canonical JSON for comparisons; financial values are separately integer-validated. */
export function stableJSONString(value: unknown): string {
  const result = JSON.stringify(value, (_key, item) => {
    if (typeof item === "number" && !Number.isFinite(item)) {
      return fail("INVALID_JSON", "JSON包含非有限数值。");
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
    }
    return item;
  });
  if (typeof result !== "string") return fail("INVALID_JSON", "数据不能保存为JSON。");
  return result;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f\d]{64}$/i.test(value)) {
    return fail("INVALID_DIGEST", "核验版本摘要必须是SHA-256。");
  }
  return value.toLowerCase();
}

/** A failed review may record discrepant actual results, but can never authorize posting. */
export function validateReviewReport(expectation: ReviewExpectation, value: unknown): ReviewReport {
  const data = record(value, "核验报告");
  const expectedDigest = digest(expectation.reviewDigest);
  const reportDigest = digest(data.reviewDigest);
  if (reportDigest !== expectedDigest) return fail("STALE_REVIEW", "报告对应的文件版本与待入账版本不一致。");
  if (data.origin !== "codex_subagent") return fail("INVALID_ORIGIN", "报告必须由Codex独立子agent核验流程提交。");
  if (data.status !== "passed" && data.status !== "failed") return fail("INVALID_REPORT", "核验状态无效。");
  const report: ReviewReport = {
    reviewerId: nonempty(data.reviewerId, "复核agent编号"),
    reviewerRunId: nonempty(data.reviewerRunId, "复核执行编号"),
    origin: "codex_subagent",
    status: data.status,
    reviewDigest: reportDigest,
    financials: normalizeFinancials(data.financials),
    checks: list(data.checks, "核验项目"),
    issues: list(data.issues, "异常"),
    unverified: list(data.unverified, "未验证项目"),
  };
  if (data.summary !== undefined) report.summary = nonempty(data.summary, "核验摘要", 8000);
  if (data.evidence !== undefined) report.evidence = list(data.evidence, "核验证据");
  if (report.status === "passed") {
    if (report.issues.length || report.unverified.length) {
      return fail("UNRESOLVED_REVIEW", "含异常或未验证项的报告不能标为通过。");
    }
    if (!CORE_REVIEW_CHECKS.every((check) => report.checks.includes(check))) {
      return fail("INCOMPLETE_REVIEW", "通过报告未覆盖全部核心计算核验项目。");
    }
    const expected = normalizeFinancials(expectation.expectedFinancials);
    if (stableJSONString(report.financials) !== stableJSONString(expected)) {
      return fail("FINANCIAL_MISMATCH", "独立复算结果与待入账金额不一致。");
    }
  }
  return report;
}

export function assertTwoIndependentReviews(expectation: ReviewExpectation, values: unknown[]): [ReviewReport, ReviewReport] {
  if (!Array.isArray(values) || values.length !== 2) {
    return fail("TWO_REVIEWS_REQUIRED", "必须保存两名独立agent的完整核验报告后才能入账。");
  }
  const submittedBy = values.map((value) => nonempty(record(value, "核验报告").submittedBy, "复核凭据身份"));
  const reports = values.map((value) => validateReviewReport(expectation, value));
  if (reports.some((report) => report.status !== "passed")) {
    return fail("REVIEW_FAILED", "存在未通过的核验报告，请先处理问题。");
  }
  if (submittedBy[0] === submittedBy[1] || reports[0].reviewerId === reports[1].reviewerId || reports[0].reviewerRunId === reports[1].reviewerRunId) {
    return fail("REVIEWERS_NOT_INDEPENDENT", "必须是两名不同agent、两次独立执行的核验结果。");
  }
  if (reports.some((report, index) => report.reviewerId !== submittedBy[index])) {
    return fail("REVIEW_IDENTITY_MISMATCH", "复核报告声明的agent身份与提交凭据身份不一致。");
  }
  if (stableJSONString(reports[0].financials) !== stableJSONString(reports[1].financials)) {
    return fail("REVIEW_DISAGREEMENT", "两名agent的独立核算结果不一致。");
  }
  return reports as [ReviewReport, ReviewReport];
}

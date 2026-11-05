/** Financial arithmetic is in integer cents. This module never changes its inputs. */
export interface SourceRow {
  [key: string]: unknown;
  id: string;
  sourceId: string;
  originalFile: string;
  originalRow: number;
  applicant: string;
  department: string;
  useCenter: string;
  costCenter: string;
  legalEntity: string;
  purpose: string;
  amountCents: number;
  historicUsed?: boolean;
  /** A user-confirmed assignment retained only in source metadata, never written back to an Excel business cell. */
  departmentResolution?: { department: string; useCenter: string };
}

export interface SourceHistory {
  batchId: string;
  product: string;
  usedCents: number;
}

export interface Source {
  id: string;
  name: string;
  priority: number;
  /** Explicit authorization for this source; absent is false. */
  allowBlankDepartment?: boolean;
  /** Unique external accounting reference supplied for an independently added source. */
  sourceReference?: string;
  /** Audit record explaining how this source entered the authoritative ledger. */
  importAttestation?: {
    mode: "opening" | "attested-independent";
    confirmedBy: string;
    confirmedAt: string;
    reference: string;
  };
  /** Immutable balance fingerprints seen for this source lineage. */
  balanceFingerprints?: string[];
  originalCents: number;
  history: SourceHistory[];
  rows: SourceRow[];
}

export interface NormalizedLegalEntity {
  name: string;
  code: string | null;
  key: string;
  recognized: boolean;
}

export interface SourceUse {
  sourceId: string;
  rowId: string;
  originalFile: string;
  originalRow: number;
  originalCents: number;
  usedCents: number;
  remainingCents: number;
  groupKey: string;
  status: "full" | "partial";
}

export interface AllocationGroup {
  key: string;
  applicant: string;
  department: string;
  useCenter: string;
  costCenter: string;
  legalEntity: string;
  purpose: string;
  normalizedLegalEntity: NormalizedLegalEntity;
  availableCents: number;
  firstSourceAvailableCents: number;
  usedCents: number;
  quantity: number;
  qty: number;
  remainderCents: number;
  sourceUses: SourceUse[];
}

export interface SourceSummary {
  sourceId: string;
  name: string;
  priority: number;
  originalCents: number;
  previousUsedCents: number;
  beforeCents: number;
  usedCents: number;
  remainingCents: number;
  cumulativeUsedCents: number;
  differenceCents: number;
}

export interface AllocationExclusion {
  sourceId: string;
  rowId: string;
  originalFile: string;
  originalRow: number;
  amountCents: number;
  reason: string;
}

export const ALLOCATION_RULE_VERSION = "department-exact-v4" as const;

export interface AllocationPlan {
  ruleVersion: typeof ALLOCATION_RULE_VERSION;
  departmentAssignments: DepartmentAssignment[];
  groupMembership: {key:string;rows:{sourceId:string;rowId:string;amountCents:number}[]}[];
  status: "solved";
  priceCents: number;
  quantity: number;
  totalCents: number;
  availableCents: number;
  eligibleCents: number;
  usedCents: number;
  remainingCents: number;
  groups: AllocationGroup[];
  sourceUses: SourceUse[];
  sourceSummaries: SourceSummary[];
  warnings: string[];
  exclusions: AllocationExclusion[];
  proof: {
    method: "exact_dynamic_programming";
    exact: true;
    primaryObjective: "maximize_first_source_contribution";
    primaryValueCents: number;
    secondaryObjective: "minimize_group_count";
    secondaryValue: number;
    blankDepartmentIndependent: true;
    activeGroups: number;
    dpCells: number;
  };
}

export interface AllocationLimits {
  maxQuantity?: number;
  maxDpCells?: number;
  maxRows?: number;
}

export class AllocationError extends Error {
  code: "INVALID_INPUT" | "LEDGER_MISMATCH" | "UNSATISFIABLE" | "LIMIT_EXCEEDED" | "AMBIGUOUS_ASSIGNMENT";
  ambiguities?: DepartmentAmbiguity[];
  constructor(code: AllocationError["code"], message: string) {
    super(message);
    this.name = "AllocationError";
    this.code = code;
  }
}

export type DepartmentAssignment = {sourceId:string;rowId:string;department:string;useCenter:string};
export type DepartmentAmbiguity = DepartmentAssignment & {originalFile:string;originalRow:number;amountCents:number;applicant:string;costCenter:string;legalEntity:string;purpose:string;candidates:{department:string;useCenter:string}[]};

const DEFAULT_LIMITS = { maxQuantity: 100_000, maxDpCells: 8_000_000, maxRows: 30_000 };
const OPEN_PAIRS: Record<string, string> = { "(": ")", "（": "）", "[": "]", "【": "】" };
const REQUIRED_FIELDS = ["applicant", "costCenter", "legalEntity", "purpose"] as const;
const FIELD_NAMES = { applicant: "申领人", useCenter: "使用中心", costCenter: "成本中心", legalEntity: "费用承担法律主体", purpose: "申领用途" };

function fail(message: string): never { throw new AllocationError("INVALID_INPUT", message); }
function integer(value: number, label: string, min = 0): number {
  if (!Number.isSafeInteger(value) || value < min) fail(`${label}必须是大于等于${min}的安全整数；金额单位为分。`);
  return value;
}
function add(a: number, b: number, label = "合计金额"): number {
  const value = a + b;
  if (!Number.isSafeInteger(value)) fail(`${label}超出安全整数范围。`);
  return value;
}
function sum(values: number[]): number { return values.reduce((a, b) => add(a, b), 0); }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }

/** Only the legal-entity field allows code/name order and paired-code-wrapper changes. */
export function normalizeLegalEntity(raw: string): NormalizedLegalEntity {
  if (typeof raw !== "string") fail("费用承担法律主体必须保留为文本。");
  const text = raw.trim();
  const matches = [...text.matchAll(/(?<![A-Za-z0-9_-])([A-Za-z][A-Za-z0-9_-]*\d[A-Za-z0-9_-]*)(?![A-Za-z0-9_-])/g)];
  const conventional = matches.filter(m => /^[A-Za-z]\d{6}$/.test(m[1]));
  // Project sources and the tax master use one confirmed code shape: one
  // Latin letter followed by six digits. A digit-containing company name is
  // not evidence of a company code; unknown formats stay isolated for review.
  const candidates = conventional.length === 1 ? conventional : [];
  if (candidates.length === 1) {
    const match = candidates[0];
    const code = match[1];
    const left = text.slice(0, match.index).trim();
    const right = text.slice((match.index ?? 0) + code.length).trim();
    const pairs = Object.entries(OPEN_PAIRS);
    const neutralName = (name: string) => {
      if (!name) return null;
      const stack: string[] = [];
      for (const char of name) {
        if (OPEN_PAIRS[char]) stack.push(OPEN_PAIRS[char]);
        else if (Object.values(OPEN_PAIRS).includes(char)) {
          if (stack.pop() !== char) return null;
        }
      }
      return stack.length ? null : name;
    };
    for (const [opening, closing] of pairs) {
      // 名称在代码前：仅移除紧贴代码的一对括号，保留名称内部括号。
      if (left.endsWith(opening) && right.startsWith(closing)) {
        const name = neutralName(left.slice(0, -opening.length).trim() + right.slice(closing.length).trim());
        if (name) return { name, code, key: JSON.stringify(["coded", name, code]), recognized: true };
      }
      // 代码在名称前：允许代码后的一对括号包围名称。
      if (!left && right.startsWith(opening) && right.endsWith(closing)) {
        const name = right.slice(opening.length, -closing.length).trim();
        if (neutralName(name)) return { name, code, key: JSON.stringify(["coded", name, code]), recognized: true };
      }
    }
    if (!left && right) {
      const name = right.trim();
      if (neutralName(name)) return { name, code, key: JSON.stringify(["coded", name, code]), recognized: true };
    }
    if (left && !right) {
      const name = left.trim();
      if (neutralName(name)) return { name, code, key: JSON.stringify(["coded", name, code]), recognized: true };
    }
  }
  // Unknown/ambiguous expressions match only their exact original text. Never guess a code.
  return { name: raw, code: null, key: JSON.stringify(["raw", raw]), recognized: false };
}

function rowKey(row: SourceRow): string {
  return JSON.stringify([row.applicant, row.department, row.useCenter, row.costCenter, normalizeLegalEntity(row.legalEntity).key, row.purpose]);
}

function requiredKey(row: SourceRow): string {
  return JSON.stringify([row.applicant, row.costCenter, normalizeLegalEntity(row.legalEntity).key, row.purpose]);
}
function departmentValue(s: string): string { return nonempty(s) ? s : ""; }

interface InternalGroup {
  key: string;
  row: SourceRow;
  legal: NormalizedLegalEntity;
  rows: SourceRow[];
  amount: number;
  first: number;
}

function inspectSources(sources: Source[], maxRows: number, assignments: DepartmentAssignment[] = []) {
  if (!Array.isArray(assignments)) fail("部门补填数据格式无效。");
  if (assignments.length) fail("当前规则禁止补填部门；申领部门或使用中心为空时，该来源行必须独立计算。");
  if (!Array.isArray(sources) || !sources.length) fail("请先导入至少一个金额来源。");
  const ordered = sources.map((s, index) => ({ s, index })).sort((a, b) => a.s.priority - b.s.priority || a.index - b.index).map(x => x.s);
  const sourceIds = new Set<string>();
  const eligibleRows: SourceRow[] = [];
  const exclusions: AllocationExclusion[] = [];
  const before = new Map<string, number>();
  const previous = new Map<string, number>();
  let rowCount = 0;
  for (const source of ordered) {
    if (!nonempty(source.id) || sourceIds.has(source.id)) fail("金额来源编号不能为空或重复。");
    sourceIds.add(source.id);
    if (!nonempty(source.name)) fail(`来源${source.id}缺少名称。`);
    integer(source.priority, "来源优先级");
    if (source.allowBlankDepartment !== undefined && typeof source.allowBlankDepartment !== "boolean") fail(`来源${source.name}的空申领部门授权必须为布尔值。`);
    if (source.balanceFingerprints !== undefined && (!Array.isArray(source.balanceFingerprints) || source.balanceFingerprints.length > 10000
      || source.balanceFingerprints.some(value => typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)))) {
      fail(`来源${source.name}的余额内容指纹记录无效。`);
    }
    integer(source.originalCents, "来源原始总额");
    if (!Array.isArray(source.rows) || !Array.isArray(source.history)) fail(`来源${source.name}缺少明细或历史登记。`);
    rowCount += source.rows.length;
    if (rowCount > maxRows) throw new AllocationError("LIMIT_EXCEEDED", "来源记录超过已验证的计算规模上限，尚未判定能否精确分摊。请分批导入或联系管理员。");
    const historyIds = new Set<string>();
    let previousUsed = 0;
    for (const h of source.history) {
      if (!nonempty(h.batchId) || historyIds.has(h.batchId) || !nonempty(h.product)) fail(`来源${source.name}的历史批次编号重复或资料不完整。`);
      historyIds.add(h.batchId);
      previousUsed = add(previousUsed, integer(h.usedCents, "历史使用金额"));
    }
    previous.set(source.id, previousUsed);
    const rowIds = new Set<string>();
    let available = 0;
    let historicalRed = 0;
    const rows = source.rows.map((row, index) => ({ row, index })).sort((a, b) => a.row.originalRow - b.row.originalRow || a.index - b.index).map(x => x.row);
    for (const row of rows) {
      if (!nonempty(row.id) || rowIds.has(row.id)) fail(`来源${source.name}的行标识为空或重复；不能按内容去重。`);
      rowIds.add(row.id);
      if (row.sourceId !== source.id) fail(`来源${source.name}存在来源编号不一致的记录。`);
      if (!nonempty(row.originalFile)) fail(`来源${source.name}存在缺少原始文件的记录。`);
      integer(row.originalRow, "原始行号", 1);
      integer(row.amountCents, "原记录金额");
      for (const field of ["applicant", "department", "useCenter", "costCenter", "legalEntity", "purpose"] as const) {
        if (typeof row[field] !== "string") fail(`来源${source.name}第${row.originalRow}行的${field}必须为文本，空部门请使用空字符串。`);
      }
      if (row.historicUsed !== undefined && typeof row.historicUsed !== "boolean") fail("历史已用标识必须为布尔值。");
      if (row.departmentResolution !== undefined && (!row.departmentResolution || typeof row.departmentResolution !== "object"
        || typeof row.departmentResolution.department !== "string" || typeof row.departmentResolution.useCenter !== "string")) {
        fail(`来源${source.name}第${row.originalRow}行保存的部门归属格式无效。`);
      }
      const exclude = (reason: string) => exclusions.push({ sourceId: source.id, rowId: row.id, originalFile: row.originalFile, originalRow: row.originalRow, amountCents: row.amountCents, reason });
      if (row.historicUsed) {
        historicalRed = add(historicalRed, row.amountCents);
        exclude("历史红字已使用，不参与本批分摊。");
        continue;
      }
      available = add(available, row.amountCents);
      const missing: string[] = REQUIRED_FIELDS.filter(field => !nonempty(row[field]));
      if (missing.length) { exclude(`缺少必填信息：${missing.map(field => (FIELD_NAMES as Record<string, string>)[field] || "申领部门").join("、")}。`); continue; }
      if (!row.amountCents) { exclude("金额为0，不参与本批分摊。"); continue; }
      eligibleRows.push(row);
    }
    if (historicalRed > previousUsed) throw new AllocationError("LEDGER_MISMATCH", `来源${source.name}的历史红字金额大于已登记历史用额，请先核实历史记录。`);
    if (add(available, previousUsed) !== source.originalCents) throw new AllocationError("LEDGER_MISMATCH", `来源${source.name}对账不平：原总额不等于当前可用明细加历史累计已用。请先核实，不能倒算或改写基准。`);
    before.set(source.id, available);
  }
  const allGroups: InternalGroup[] = [];
  const exactGroups = new Map<string, InternalGroup>();
  for (const row of eligibleRows) {
    const department = departmentValue(row.department);
    const useCenter = departmentValue(row.useCenter);
    const independent = !department || !useCenter;
    const key = independent
      ? JSON.stringify(["independent-blank", row.sourceId, row.id])
      : rowKey(row);
    let group = exactGroups.get(key);
    if (!group) {
      group = {
        key,
        row: { ...row, department, useCenter },
        legal: normalizeLegalEntity(row.legalEntity),
        rows: [],
        amount: 0,
        first: 0,
      };
      exactGroups.set(key, group);
      allGroups.push(group);
    }
    group.rows.push(row);
    group.amount = add(group.amount, row.amountCents);
    if (row.sourceId === ordered[0].id) group.first = add(group.first, row.amountCents);
  }
  return { ordered, allGroups, exclusions, before, previous, effectiveAssignments: [] as DepartmentAssignment[] };
}

interface Options { min: number; max: number; step: number; full: number | null }
function groupOptions(amount: number, price: number, quantity: number): Options {
  // Remaining cents must be 0, or >=30,000 and divisible by 100.
  const max = Math.min(quantity, Math.floor((amount - 30_000) / price));
  let step = 1;
  const a = price % 100;
  let b = 100;
  let gcd = a;
  while (b) { const next = gcd % b; gcd = b; b = next; }
  step = 100 / gcd;
  let min = 0;
  for (let q = 1; q <= step; q++) {
    if (((price % 100) * q) % 100 === amount % 100) { min = q; break; }
  }
  const last = min && max >= min ? min + Math.floor((max - min) / step) * step : 0;
  const full = amount % price === 0 && amount / price <= quantity ? amount / price : null;
  return { min: last ? min : 0, max: last, step, full: full && full > 0 ? full : null };
}

function stableEntityBlocks<T extends { normalizedLegalEntity: NormalizedLegalEntity }>(groups: T[]): T[] {
  const blocks = new Map<string, T[]>();
  for (const group of groups) {
    const key = group.normalizedLegalEntity.key;
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key)!.push(group);
  }
  return [...blocks.values()].flat();
}

/**
 * Exact DP in quantity units. Sliding maxima evaluate arithmetic-progressive choices
 * in O(groups × quantity), rather than enumerating every previous-state/choice pair.
 * For every reachable total it stores the greatest first-source contribution, then
 * the fewest selected groups. Equal scores preserve earlier groups deterministically.
 */
export function planAllocation(sources: Source[], priceCents: number, quantity: number, limits: AllocationLimits = {}, assignments: DepartmentAssignment[] = []): AllocationPlan {
  integer(priceCents, "单价", 1);
  integer(quantity, "数量", 1);
  const totalCents = priceCents * quantity;
  integer(totalCents, "目标金额", 1);
  const cap = { ...DEFAULT_LIMITS, ...limits };
  integer(cap.maxQuantity, "数量计算上限", 1);
  integer(cap.maxDpCells, "状态计算上限", 1);
  integer(cap.maxRows, "记录计算上限", 1);
  if (quantity > cap.maxQuantity) throw new AllocationError("LIMIT_EXCEEDED", "目标数量超过已验证的计算上限，尚未判定能否精确分摊。请联系管理员。");
  const inspected = inspectSources(sources, cap.maxRows, assignments);
    const { ordered, allGroups, exclusions, before, previous } = inspected;
  const active = allGroups.map(group => ({ group, options: groupOptions(group.amount, priceCents, quantity) })).filter(x => x.options.max > 0 || x.options.full !== null);
  const dpCells = active.length * (quantity + 1);
  if (!Number.isSafeInteger(dpCells) || dpCells > cap.maxDpCells) throw new AllocationError("LIMIT_EXCEEDED", `本批需要${dpCells}个精确计算状态，超过已验证上限${cap.maxDpCells}；尚未判定能否精确分摊，不会以近似结果入账。`);
  const eligibleCents = sum(allGroups.map(g => g.amount));
  const availableCents = sum([...before.values()]);
  const capacity = sum(active.map(({ options }) => Math.max(options.max, options.full ?? 0)));
  if (eligibleCents < totalCents || capacity < quantity) throw new AllocationError("UNSATISFIABLE", `按当前分组、整除及余款规则，可用金额不足以精确完成${quantity}件；不能通过取整或改写金额凑齐。`);

  let prevFirst = new Float64Array(quantity + 1).fill(-Infinity);
  let prevCount = new Int32Array(quantity + 1).fill(0x3fffffff);
  prevFirst[0] = 0;
  prevCount[0] = 0;
  const traces: Int32Array[] = [];
  for (const { group, options } of active) {
    const nextFirst = prevFirst.slice();
    const nextCount = prevCount.slice();
    const choices = new Int32Array(quantity + 1);
    const choose = (total: number, previousQuantity: number) => {
      if (prevFirst[previousQuantity] === -Infinity) return;
      const q = total - previousQuantity;
      const primary = prevFirst[previousQuantity] + Math.min(priceCents * q, group.first);
      const count = prevCount[previousQuantity] + 1;
      if (primary > nextFirst[total] || (primary === nextFirst[total] && count < nextCount[total])) {
        nextFirst[total] = primary;
        nextCount[total] = count;
        choices[total] = q;
      }
    };
    const range = (lower: number, upper: number, linear: boolean) => {
      if (!lower || lower > upper) return;
      const queues: number[][] = Array.from({ length: options.step }, () => []);
      const heads = new Int32Array(options.step);
      const score = (x: number) => prevFirst[x] - (linear ? priceCents * x : 0);
      for (let total = lower; total <= quantity; total++) {
        const entering = total - lower;
        const residue = entering % options.step;
        const queue = queues[residue];
        if (prevFirst[entering] !== -Infinity) {
          while (queue.length > heads[residue]) {
            const last = queue[queue.length - 1];
            if (score(entering) > score(last) || (score(entering) === score(last) && prevCount[entering] <= prevCount[last])) queue.pop();
            else break;
          }
          queue.push(entering);
        }
        while (heads[residue] < queue.length && queue[heads[residue]] < total - upper) heads[residue]++;
        if (heads[residue] < queue.length) choose(total, queue[heads[residue]]);
      }
    };
    if (options.max) {
      const boundary = Math.floor(group.first / priceCents);
      const lowLast = options.min + Math.floor((Math.min(options.max, boundary) - options.min) / options.step) * options.step;
      if (lowLast >= options.min) range(options.min, lowLast, true);
      const highFirst = options.min + Math.max(0, Math.ceil((boundary + 1 - options.min) / options.step)) * options.step;
      if (highFirst <= options.max) range(highFirst, options.max, false);
    }
    if (options.full !== null) for (let total = options.full; total <= quantity; total++) choose(total, total - options.full);
    traces.push(choices);
    prevFirst = nextFirst;
    prevCount = nextCount;
  }
  if (prevFirst[quantity] === -Infinity) throw new AllocationError("UNSATISFIABLE", `已完成精确计算，当前来源在既定规则下无法恰好分摊${quantity}件。请补充合规来源或确认调整本批参数。`);

  const selected: { group: InternalGroup; quantity: number }[] = [];
  let remainingQuantity = quantity;
  for (let index = active.length - 1; index >= 0; index--) {
    const q = traces[index][remainingQuantity];
    if (q) selected.push({ group: active[index].group, quantity: q });
    remainingQuantity -= q;
  }
  if (remainingQuantity !== 0) throw new Error("精确DP回溯不一致，禁止交付。");
  selected.reverse();
  const groups = stableEntityBlocks(selected.map(({ group, quantity: q }): AllocationGroup => {
    const usedCents = q * priceCents;
    let left = usedCents;
    const sourceUses: SourceUse[] = [];
    for (const row of group.rows) {
      const used = Math.min(left, row.amountCents);
      if (used) sourceUses.push({ sourceId: row.sourceId, rowId: row.id, originalFile: row.originalFile, originalRow: row.originalRow, originalCents: row.amountCents, usedCents: used, remainingCents: row.amountCents - used, groupKey: group.key, status: used === row.amountCents ? "full" : "partial" });
      left -= used;
      if (!left) break;
    }
    return { key: group.key, applicant: group.row.applicant, department: group.row.department, useCenter: group.row.useCenter, costCenter: group.row.costCenter, legalEntity: group.row.legalEntity, purpose: group.row.purpose, normalizedLegalEntity: group.legal, availableCents: group.amount, firstSourceAvailableCents: group.first, usedCents, quantity: q, qty: q, remainderCents: group.amount - usedCents, sourceUses };
  }));
  const sourceUses = groups.flatMap(g => g.sourceUses);
  const sourceSummaries = ordered.map((source): SourceSummary => {
    const usedCents = sum(sourceUses.filter(u => u.sourceId === source.id).map(u => u.usedCents));
    const beforeCents = before.get(source.id)!;
    const previousUsedCents = previous.get(source.id)!;
    const remainingCents = beforeCents - usedCents;
    const cumulativeUsedCents = add(previousUsedCents, usedCents);
    return { sourceId: source.id, name: source.name, priority: source.priority, originalCents: source.originalCents, previousUsedCents, beforeCents, usedCents, remainingCents, cumulativeUsedCents, differenceCents: source.originalCents - remainingCents - cumulativeUsedCents };
  });
  const warnings: string[] = [];
  const missingCount = exclusions.filter(e => e.reason.startsWith("缺少必填信息")).length;
  if (missingCount) warnings.push(`${missingCount}条来源记录缺少必填信息，已排除本批分摊并完整保留余额。`);
  if (allGroups.some(g => !g.legal.recognized)) warnings.push("部分法律主体无法唯一识别公司代码，仅按原文精确匹配；开票资料需单独核实。");
  if (new Set(ordered.map(s => s.priority)).size !== ordered.length) warnings.push("有来源使用相同优先级，已按导入顺序稳定排列，请确认此顺序符合预期。");
  return { ruleVersion: ALLOCATION_RULE_VERSION, departmentAssignments: inspected.effectiveAssignments, groupMembership:allGroups.map(g=>({key:g.key,rows:g.rows.map(r=>({sourceId:r.sourceId,rowId:r.id,amountCents:r.amountCents}))})), status: "solved", priceCents, quantity, totalCents, availableCents, eligibleCents, usedCents: totalCents, remainingCents: availableCents - totalCents, groups, sourceUses, sourceSummaries, warnings, exclusions, proof: { method: "exact_dynamic_programming", exact: true, primaryObjective: "maximize_first_source_contribution", primaryValueCents: prevFirst[quantity], secondaryObjective: "minimize_group_count", secondaryValue: prevCount[quantity], blankDepartmentIndependent:true, activeGroups: active.length, dpCells } };
}

export interface AllocationValidation {
  valid: boolean;
  passed: boolean;
  checks: number;
  errors: string[];
  optimality: "not_independently_recomputed";
}

/** Rebuilds source groups and FIFO from the inputs. It does not use plan totals as evidence. */
export function validateAllocationPlan(sources: Source[], priceCents: number, quantity: number, plan: AllocationPlan): AllocationValidation {
  const errors: string[] = [];
  let checks = 0;
  const check = (condition: boolean, message: string) => { checks++; if (!condition) errors.push(message); };
  // Stored JSON may reorder object properties; compare explicit fields and row order.
  const usesKey = (uses: SourceUse[]) => JSON.stringify(uses.map(u => [u.sourceId,u.rowId,u.originalFile,u.originalRow,u.originalCents,u.usedCents,u.remainingCents,u.groupKey,u.status]));
  const exclusionsKey = (items: AllocationExclusion[]) => JSON.stringify(items.map(e => [e.sourceId,e.rowId,e.originalFile,e.originalRow,e.amountCents,e.reason]));
  try {
    integer(priceCents, "单价", 1); integer(quantity, "数量", 1); integer(priceCents * quantity, "目标金额", 1);
    check(plan.ruleVersion === ALLOCATION_RULE_VERSION, "批次使用旧分组规则，请重新试算并进行双重核验。");
    const { ordered, allGroups, before, previous, exclusions } = inspectSources(sources, DEFAULT_LIMITS.maxRows,plan.departmentAssignments);
    const membershipKey=(groups:typeof plan.groupMembership)=>JSON.stringify(groups.map(g=>[g.key,g.rows.map(r=>[r.sourceId,r.rowId,r.amountCents])]));
    check(Array.isArray(plan.groupMembership)&&membershipKey(plan.groupMembership)===membershipKey(allGroups.map(g=>({key:g.key,rows:g.rows.map(r=>({sourceId:r.sourceId,rowId:r.id,amountCents:r.amountCents}))}))),"冻结的全部来源行归组与来源重算不一致。");
    // Separate replay of *all* eligible original rows, including unused
    // balances, without using the internal grouping map as source evidence.
    const originalRows=new Map<string,SourceRow>();
    for(const source of sources)for(const row of source.rows)if(!row.historicUsed&&row.amountCents>0&&REQUIRED_FIELDS.every(field=>nonempty(row[field])))originalRows.set(JSON.stringify([source.id,row.id]),row);
    const assignedRows=new Set<string>();
    if(Array.isArray(plan.groupMembership))for(const membership of plan.groupMembership){
      const originals:SourceRow[]=[];
      for(const ref of membership.rows){
        const id=JSON.stringify([ref.sourceId,ref.rowId]), original=originalRows.get(id);
        check(!!original&&!assignedRows.has(id),"来源行不存在或被重复分组。");
        if(original){check(original.amountCents===ref.amountCents,"冻结来源行金额不一致。");originals.push(original);assignedRows.add(id);}
      }
      if(!originals.length){check(false,"分组缺少来源原始行。");continue;}
      const first=originals[0];
      check(originals.every(row=>requiredKey(row)===requiredKey(first)),"同组申领人、成本中心、主体或用途不一致。");
      for(const field of ['department','useCenter'] as const)check(new Set(originals.map(row=>departmentValue(row[field])).filter(Boolean)).size<=1,`同组${field}存在冲突的非空值。`);
      const hasBlankDepartment = originals.some(row => !departmentValue(row.department) || !departmentValue(row.useCenter));
      check(!hasBlankDepartment || originals.length === 1, "申领部门或使用中心为空时，该来源行必须独立成组。");
      check(hasBlankDepartment || originals.every(row => row.department === first.department && row.useCenter === first.useCenter), "申领部门和使用中心必须完整且逐字一致后才能合并。");
    }
    check(assignedRows.size===originalRows.size,"不是每一条可参与来源行都被唯一归组。");
    const available = sum([...before.values()]);
    const rawGroups = new Map(allGroups.map(g => [g.key, g]));
    const actualUses = new Map<string, SourceUse>();
    const selectedKeys = new Set<string>();
    const perSource = new Map(ordered.map(s => [s.id, 0]));
    let actualTotal = 0;
    let actualQuantity = 0;
    for (const group of plan.groups) {
      const raw = rawGroups.get(group.key);
      check(!!raw, "选用了不存在或字段不完整的分组。");
      if (!raw) continue;
      for (const field of ["department", "useCenter"] as const) {
        const unique = new Set(raw.rows.map(row => departmentValue(row[field])).filter(Boolean));
        check(unique.size <= 1, `同组${field}存在不同非空值。`);
        check(group[field] === (unique.values().next().value ?? ""), `开票${field}与来源原值不一致。`);
      }
      check(!raw.rows.some(row => !departmentValue(row.department) || !departmentValue(row.useCenter)) || raw.rows.length === 1, "空白部门记录只能独立计算。");
      check(!selectedKeys.has(group.key), "同一分组被重复列入。");
      selectedKeys.add(group.key);
      check(Number.isSafeInteger(group.quantity) && group.quantity > 0, "分组数量不是正整数。");
      check(group.qty === group.quantity, "分组数量别名不一致。");
      check(group.usedCents === group.quantity * priceCents && group.usedCents > 0, "分组金额不是单价的整数倍。");
      check(group.usedCents <= raw.amount, "分组金额超过可用来源。");
      const remainder = raw.amount - group.usedCents;
      check(remainder === 0 || (remainder >= 30_000 && remainder % 100 === 0), "合并分组的余款不合规。");
      check(group.remainderCents === remainder && group.availableCents === raw.amount && group.firstSourceAvailableCents === raw.first, "分组余额或原额与来源不一致。");
      for (const field of ["applicant", "department", "useCenter", "costCenter", "purpose"] as const) check(group[field] === raw.row[field], `分组${field}与来源不一致。`);
      check(normalizeLegalEntity(group.legalEntity).key === raw.legal.key && group.normalizedLegalEntity.key === raw.legal.key && group.normalizedLegalEntity.name === raw.legal.name && group.normalizedLegalEntity.code === raw.legal.code && group.normalizedLegalEntity.recognized === raw.legal.recognized, "分组法律主体与来源不一致。");
      let left = group.usedCents;
      const expected: SourceUse[] = [];
      for (const row of raw.rows) {
        const used = Math.min(Math.max(0, left), row.amountCents);
        if (used) expected.push({ sourceId: row.sourceId, rowId: row.id, originalFile: row.originalFile, originalRow: row.originalRow, originalCents: row.amountCents, usedCents: used, remainingCents: row.amountCents - used, groupKey: raw.key, status: used === row.amountCents ? "full" : "partial" });
        left -= used;
      }
      check(left === 0, "按源行顺序无法覆盖本组使用金额。");
      check(usesKey(group.sourceUses) === usesKey(expected), "源行使用或拆分不符合来源优先及FIFO规则。");
      for (const use of group.sourceUses) {
        const id = JSON.stringify([use.sourceId, use.rowId]);
        check(!actualUses.has(id), "同一来源行被重复使用。");
        actualUses.set(id, use);
        check(Number.isSafeInteger(use.usedCents) && use.usedCents > 0 && use.usedCents + use.remainingCents === use.originalCents, "原行拆分金额不守恒。");
        if (perSource.has(use.sourceId)) perSource.set(use.sourceId, add(perSource.get(use.sourceId)!, use.usedCents));
        else check(false, "用了未知来源。");
      }
      check(sum(group.sourceUses.map(u => u.usedCents)) === group.usedCents, "逐行用额之和不等于本组用额。");
      actualTotal = add(actualTotal, group.usedCents);
      actualQuantity = add(actualQuantity, group.quantity);
    }
    check(actualTotal === priceCents * quantity && actualQuantity === quantity, "实际分组金额或数量未精确达到本批目标。");
    check(plan.priceCents === priceCents && plan.quantity === quantity && plan.totalCents === actualTotal && plan.usedCents === actualTotal, "计划汇总与逐组复算不一致。");
    check(plan.status === "solved" && plan.eligibleCents === sum(allGroups.map(g => g.amount)), "计划状态或可参与分组金额不一致。");
    check(plan.availableCents === available && plan.remainingCents === available - actualTotal, "整体余额不一致。");
    check(exclusionsKey(plan.exclusions) === exclusionsKey(exclusions), "排除记录与原始资料不一致。");
    check(usesKey(plan.sourceUses) === usesKey(plan.groups.flatMap(g => g.sourceUses)), "扁平源行明细与分组明细不一致。");
    check(plan.sourceSummaries.length === ordered.length, "来源汇总数量不一致。");
    for (const [index, source] of ordered.entries()) {
      const s = plan.sourceSummaries[index];
      if (!s) continue;
      const used = perSource.get(source.id)!;
      const remaining = before.get(source.id)! - used;
      check(s.sourceId === source.id && s.name === source.name && s.priority === source.priority, "来源名称、顺序或优先级丢失。");
      check(s.originalCents === source.originalCents && s.beforeCents === before.get(source.id) && s.previousUsedCents === previous.get(source.id), "来源原额、历史用额或期初金额不一致。");
      check(s.usedCents === used && s.remainingCents === remaining && remaining >= 0, "来源使用或余款不一致。");
      check(s.cumulativeUsedCents === add(previous.get(source.id)!, used) && s.differenceCents === 0 && source.originalCents === remaining + s.cumulativeUsedCents, "顶部原总额＝剩余＋累计已用未成立。");
    }
    const expectedOrder = stableEntityBlocks(allGroups.filter(g => selectedKeys.has(g.key)).map(g => ({ key: g.key, normalizedLegalEntity: g.legal }))).map(g => g.key);
    check(JSON.stringify(plan.groups.map(g => g.key)) === JSON.stringify(expectedOrder), "同一法律主体未稳定连续列示。");
    check(plan.proof.primaryValueCents === perSource.get(ordered[0].id) && plan.proof.secondaryValue === plan.groups.length, "求解证明中的目标值与实际金额不一致。");
    check(plan.proof.blankDepartmentIndependent === true,"空白部门独立分组规则未绑定最优性说明。");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  // Optimality requires a separately implemented solver/auditor; this function proves feasibility and reconciliation only.
  return { valid: errors.length === 0, passed: errors.length === 0, checks, errors, optimality: "not_independently_recomputed" };
}

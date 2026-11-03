import assert from "node:assert/strict";
import test from "node:test";
// @ts-ignore Node's native TypeScript test runner requires the explicit .ts extension.
import { AllocationError, normalizeLegalEntity, planAllocation, validateAllocationPlan } from "../app/lib/allocation.ts";
// @ts-ignore Node's native TypeScript test runner requires the explicit .ts extension.
import type { Source, SourceRow } from "../app/lib/allocation.ts";

let nextId = 0;
function row(amountCents: number, overrides: Partial<SourceRow> = {}): SourceRow {
  const id = `r${nextId++}`;
  return { id, sourceId: "s1", originalFile: "source.xlsx", originalRow: nextId + 3, applicant: "甲", department: "部门", useCenter: "使用中心", costCenter: "成本中心", legalEntity: "示例（北京）有限公司（L100001）", purpose: "员工礼品", amountCents, ...overrides };
}
function source(id: string, priority: number, rows: SourceRow[], history: Source["history"] = []): Source {
  return { id, priority, name: id, originalCents: rows.filter(r => !r.historicUsed).reduce((a, r) => a + r.amountCents, 0) + history.reduce((a, h) => a + h.usedCents, 0), history, rows: rows.map(r => ({ ...r, sourceId: id })) };
}
function unsat(fn: () => unknown) { assert.throws(fn, (e: unknown) => e instanceof AllocationError && e.code === "UNSATISFIABLE"); }

test("legal entity changes only the name/code ordering and paired code wrapper", () => {
  const a = normalizeLegalEntity("示例（北京）有限公司（L100001）");
  for (const value of ["L100001 示例（北京）有限公司", "【L100001】示例（北京）有限公司", "示例（北京）有限公司[L100001]"]) assert.equal(normalizeLegalEntity(value).key, a.key);
  assert.notEqual(normalizeLegalEntity("另一个公司（L100001）").key, a.key);
  assert.notEqual(normalizeLegalEntity("示例（北京）有限公司（L100002）").key, a.key);
  assert.equal(a.name, "示例（北京）有限公司");
  assert.equal(a.code, "L100001");
});

test("blank department matches only blank; other fields stay exact", () => {
  const sources = [{ ...source("s1", 1, [row(3300, { department: "" }), row(3300, { department: "部门" }), row(3300, { department: "", purpose: "员工礼品 " })]), allowBlankDepartment: true }];
  const result = planAllocation(sources, 3300, 3);
  assert.equal(result.groups.length, 3);
  assert.equal(validateAllocationPlan(sources, 3300, 3, result).valid, true);
});


test("blank department requires explicit source authorization and is independently checked", () => {
  const first = source("first", 1, [row(3300, { department: "" }), row(3300, { applicant: "有部门" })]);
  const second = { ...source("second", 2, [row(3300, { department: "" })]), allowBlankDepartment: true };
  const third = source("third", 3, [row(3300, { department: "" })]);
  const sources = [first, second, third];
  const plan = planAllocation(sources, 3300, 2);
  assert.deepEqual(plan.sourceSummaries.map(s => s.usedCents), [3300, 3300, 0]);
  assert.equal(plan.sourceSummaries[0].remainingCents, 3300);
  assert.equal(plan.sourceSummaries[2].remainingCents, 3300);
  assert.equal(plan.exclusions.length, 2);
  assert.ok(plan.exclusions.every(x => x.reason.includes("申领部门")));
  assert.equal(validateAllocationPlan(sources, 3300, 2, plan).valid, true);
  const revoked = structuredClone(sources); revoked[1].allowBlankDepartment = false;
  const validation = validateAllocationPlan(revoked, 3300, 2, plan);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(e => e.includes("未经该来源授权")));
  const reordered = structuredClone(sources); reordered[0].priority = 3; reordered[1].priority = 1; reordered[2].priority = 2;
  const reorderedPlan = planAllocation(reordered, 3300, 2);
  assert.equal(reorderedPlan.sourceUses.some(use => use.sourceId === "second"), true);
  assert.equal(reorderedPlan.sourceUses.some(use => use.sourceId === "third"), false);
});

test("cross-source group uses FIFO and allows non-price-multiple source contributions", () => {
  const sources = [source("s1", 1, [row(1050)]), source("s2", 2, [row(38950, { legalEntity: "【L100001】示例（北京）有限公司" })])];
  const result = planAllocation(sources, 3300, 3);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].remainderCents, 30100);
  assert.deepEqual(result.sourceSummaries.map(s => s.usedCents), [1050, 8850]);
  assert.deepEqual(result.sourceUses.map(u => u.remainingCents), [0, 30100]);
  assert.equal(validateAllocationPlan(sources, 3300, 3, result).valid, true);
});

test("remainder is strictly above 300 yuan and no cents are rounded away", () => {
  unsat(() => planAllocation([source("s1", 1, [row(39900)])], 3300, 3));
  assert.equal(planAllocation([source("s1", 1, [row(40000)])], 3300, 3).groups[0].remainderCents, 30100);
  unsat(() => planAllocation([source("s1", 1, [row(40050)])], 3300, 3));
  assert.equal(planAllocation([source("s1", 1, [row(20025), row(19975)])], 3300, 3).groups.length, 1);
});

test("first-source use dominates fewer groups, and fewer groups breaks primary ties", () => {
  const sources = [source("s1", 1, [row(3300, { applicant: "第一表" })]), source("s2", 2, [row(6600, { applicant: "独立大组" }), row(3300, { applicant: "独立小组" })])];
  const result = planAllocation(sources, 3300, 2);
  assert.equal(result.sourceSummaries[0].usedCents, 3300);
  assert.equal(result.groups.length, 2);
  const tied = planAllocation([source("s1", 1, [row(6600, { applicant: "大组" }), row(3300, { applicant: "小组一" }), row(3300, { applicant: "小组二" })])], 3300, 2);
  assert.equal(tied.groups.length, 1);
  assert.equal(tied.groups[0].applicant, "大组");
});

test("duplicate-looking source rows remain distinct and are not deduplicated", () => {
  const sources = [source("s1", 1, [row(3300), row(3300)])];
  const result = planAllocation(sources, 3300, 2);
  assert.equal(result.sourceUses.length, 2);
  assert.equal(result.sourceUses[0].usedCents, 3300);
  assert.equal(result.sourceUses[1].usedCents, 3300);
  const bad = structuredClone(sources);
  bad[0].rows[1].id = bad[0].rows[0].id;
  assert.throws(() => planAllocation(bad, 3300, 2), /行标识为空或重复/);
});

test("historical red amounts are excluded once and history reconciles with the original baseline", () => {
  const sources = [source("s1", 1, [row(3300, { historicUsed: true }), row(6600)], [{ batchId: "old", product: "旧产品", usedCents: 3300 }])];
  const result = planAllocation(sources, 3300, 2);
  assert.equal(result.availableCents, 6600);
  assert.equal(result.sourceSummaries[0].originalCents, 9900);
  assert.equal(result.sourceSummaries[0].cumulativeUsedCents, 9900);
  assert.equal(result.sourceSummaries[0].differenceCents, 0);
  assert.equal(result.exclusions.length, 1);
  const bad = structuredClone(sources);
  bad[0].originalCents++;
  assert.throws(() => planAllocation(bad, 3300, 2), (e: unknown) => e instanceof AllocationError && e.code === "LEDGER_MISMATCH");
});

test("missing use center is excluded while its money stays in the balance", () => {
  const sources = [source("s1", 1, [row(100000, { useCenter: "" }), row(6600)])];
  const result = planAllocation(sources, 3300, 2);
  assert.equal(result.exclusions.length, 1);
  assert.equal(result.sourceSummaries[0].remainingCents, 100000);
  assert.equal(result.eligibleCents, 6600);
});

test("same entity is contiguous but six-field groups are never merged merely by entity", () => {
  const sources = [source("s1", 1, [row(3300, { applicant: "A1" }), row(3300, { applicant: "B1", legalEntity: "另一公司（L100002）" }), row(3300, { applicant: "A2" })])];
  const result = planAllocation(sources, 3300, 3);
  assert.deepEqual(result.groups.map(g => g.applicant), ["A1", "A2", "B1"]);
  assert.equal(result.groups.length, 3);
  assert.equal(validateAllocationPlan(sources, 3300, 3, result).valid, true);
});

test("input objects and source tracing extras are not changed", () => {
  const sources = [source("s1", 1, [row(40000, { sheetRow: 17, rawValues: ["原文", 400] })])];
  const snapshot = JSON.stringify(sources);
  planAllocation(sources, 3300, 3);
  assert.equal(JSON.stringify(sources), snapshot);
});

test("resource limits report unverified scale rather than financial impossibility", () => {
  assert.throws(() => planAllocation([source("s1", 1, [row(6600)])], 3300, 2, { maxDpCells: 1 }), (e: unknown) => e instanceof AllocationError && e.code === "LIMIT_EXCEEDED");
});

test("independent replay rejects modified amounts, FIFO and source ledgers", () => {
  const sources = [source("s1", 1, [row(1050)]), source("s2", 2, [row(38950)])];
  const result = planAllocation(sources, 3300, 3);
  assert.equal(validateAllocationPlan(sources, 3300, 3, result).passed, true);
  const badAmount = structuredClone(result);
  badAmount.groups[0].usedCents++;
  assert.equal(validateAllocationPlan(sources, 3300, 3, badAmount).passed, false);
  const badFifo = structuredClone(result);
  badFifo.groups[0].sourceUses.reverse();
  assert.equal(validateAllocationPlan(sources, 3300, 3, badFifo).passed, false);
  const badLedger = structuredClone(result);
  badLedger.sourceSummaries[1].remainingCents++;
  assert.equal(validateAllocationPlan(sources, 3300, 3, badLedger).passed, false);
  const badTaxIdentity = structuredClone(result);
  badTaxIdentity.groups[0].normalizedLegalEntity.code = "L999999";
  assert.equal(validateAllocationPlan(sources, 3300, 3, badTaxIdentity).passed, false);
  assert.equal(validateAllocationPlan(sources, 3300, 3, result).optimality, "not_independently_recomputed");
});

/** Deliberately simple exhaustive oracle, independent of the optimized DP. */
function brute(groups: { amount: number; first: number }[], price: number, target: number): { first: number; count: number } | null {
  let best: { first: number; count: number } | null = null;
  const visit = (index: number, units: number, first: number, count: number) => {
    if (index === groups.length) {
      if (units === target && (!best || first > best.first || (first === best.first && count < best.count))) best = { first, count };
      return;
    }
    const group = groups[index];
    for (let q = 0; q <= target - units; q++) {
      const used = price * q;
      const remainder = group.amount - used;
      if (q && (used > group.amount || !(remainder === 0 || (remainder > 30000 && remainder % 100 === 0)))) continue;
      visit(index + 1, units + q, first + Math.min(used, group.first), count + Number(q > 0));
    }
  };
  visit(0, 0, 0, 0);
  return best;
}

test("optimized DP matches an independent exhaustive oracle on 250 deterministic mixed-cent cases", () => {
  let seed = 8675309;
  const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const prices = [50, 100, 125, 2500, 3333, 5000, 10000, 20000];
  for (let sample = 0; sample < 250; sample++) {
    const price = prices[random(prices.length)];
    const target = 1 + random(8);
    const count = 2 + random(3);
    const groups = Array.from({ length: count }, () => {
      const amount = price * (1 + random(8)) + (random(3) ? 0 : 30100 + random(3) * 25);
      const first = random(amount + 1);
      return { amount, first };
    });
    const sources = [source("s1", 1, groups.filter(g => g.first > 0).map(g => row(g.first, { applicant: String(groups.indexOf(g)) }))), source("s2", 2, groups.filter(g => g.amount > g.first).map(g => row(g.amount - g.first, { applicant: String(groups.indexOf(g)) })))];
    const expected = brute(groups, price, target);
    if (!expected) unsat(() => planAllocation(sources, price, target));
    else {
      const result = planAllocation(sources, price, target);
      assert.equal(result.proof.primaryValueCents, expected.first, `case ${sample}: first-source optimum`);
      assert.equal(result.groups.length, expected.count, `case ${sample}: minimum groups`);
      assert.equal(validateAllocationPlan(sources, price, target, result).passed, true, `case ${sample}: source replay`);
    }
  }
});

test("3000-unit target with 1000 legal groups uses bounded exact states", () => {
  const sources = [source("s1", 1, Array.from({ length: 1000 }, (_, n) => row(35000, { applicant: `员工${n}` })))];
  const result = planAllocation(sources, 3500, 3000);
  assert.equal(result.usedCents, 10500000);
  assert.equal(result.proof.primaryValueCents, 10500000);
  assert.equal(result.groups.length, 300);
  assert.equal(result.proof.dpCells, 3001000);
  assert.equal(validateAllocationPlan(sources, 3500, 3000, result).passed, true);
});

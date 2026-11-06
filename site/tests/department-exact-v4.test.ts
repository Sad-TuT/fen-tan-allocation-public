import test from "node:test";
import assert from "node:assert/strict";
// @ts-ignore Node's native TypeScript test runner requires the explicit .ts extension.
import { planAllocation, validateAllocationPlan, type Source, type SourceRow } from "../app/lib/allocation.ts";

let sequence = 0;
function row(amountCents: number, changes: Partial<SourceRow> = {}): SourceRow {
  const n = ++sequence;
  return {
    id: `r${n}`,
    sourceId: "s1",
    originalFile: "synthetic.xlsx",
    originalRow: n + 3,
    applicant: "申请人",
    department: "部门甲",
    useCenter: "中心甲",
    costCenter: "成本中心",
    legalEntity: "示例公司（L100001）",
    purpose: "用途",
    amountCents,
    ...changes,
  };
}
function source(id: string, priority: number, rows: SourceRow[]): Source {
  const owned = rows.map(item => ({ ...item, sourceId: id }));
  return { id, name: id, priority, originalCents: owned.reduce((total, item) => total + item.amountCents, 0), history: [], rows: owned };
}

test("two exact nonblank department rows merge and cross-source exact rows can merge", () => {
  const sources = [
    source("s1", 1, [row(10_500, { department: "部门甲", useCenter: "中心甲" })]),
    source("s2", 2, [row(9_500, { department: "部门甲", useCenter: "中心甲" }), row(30_100, { department: "部门甲", useCenter: "中心甲" })]),
  ];
  const plan = planAllocation(sources, 10_000, 2);
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0].department, "部门甲");
  assert.equal(plan.groups[0].useCenter, "中心甲");
  assert.equal(plan.groups[0].usedCents, 20_000);
  assert.deepEqual(plan.sourceSummaries.map(item => item.usedCents), [10_500, 9_500]);
  assert.equal(validateAllocationPlan(sources, 10_000, 2, plan).valid, true);
});

test("a blank department cannot merge with a nonblank row", () => {
  const sources = [source("s1", 1, [
    row(100, { department: "", useCenter: "中心甲" }),
    row(100, { department: "部门甲", useCenter: "中心甲" }),
  ])];
  const plan = planAllocation(sources, 100, 2);
  assert.equal(plan.groups.length, 2);
  assert.ok(plan.groups.every(group => group.availableCents === 100 && group.remainderCents === 0));
});

test("a blank use center cannot merge with a nonblank row", () => {
  const sources = [source("s1", 1, [
    row(100, { department: "部门甲", useCenter: "" }),
    row(100, { department: "部门甲", useCenter: "中心甲" }),
  ])];
  const plan = planAllocation(sources, 100, 2);
  assert.equal(plan.groups.length, 2);
  assert.deepEqual(plan.groups.map(group => group.useCenter), ["", "中心甲"]);
});

test("two blank department rows remain separate even when all other fields match", () => {
  const sources = [source("s1", 1, [
    row(100, { department: "", useCenter: "" }),
    row(100, { department: "", useCenter: "" }),
  ])];
  const plan = planAllocation(sources, 100, 2);
  assert.equal(plan.groups.length, 2);
  assert.notEqual(plan.groups[0].key, plan.groups[1].key);
  assert.ok(plan.groups.every(group => group.availableCents === 100 && group.quantity === 1));
});

test("a blank row must independently satisfy divisibility and remainder rules", () => {
  const price = 3_300;
  const amount = 3_000_000;
  const shared = [row(amount, { department: "部门甲", useCenter: "中心甲" }), row(amount, { department: "部门甲", useCenter: "中心甲" })];
  assert.doesNotThrow(() => planAllocation([source("s1", 1, shared)], price, 1_000));

  const blank = source("s1", 1, [
    row(39_899, { department: "", useCenter: "中心甲" }),
    row(39_899, { department: "部门甲", useCenter: "中心甲" }),
  ]);
  assert.throws(() => planAllocation([blank], price, 3), /不足以精确完成/);
});

test("nonblank mismatches never merge and blank rows preserve original blank fields", () => {
  const sources = [source("s1", 1, [
    row(100, { department: "部门甲", useCenter: "中心甲" }),
    row(100, { department: "部门乙", useCenter: "中心甲" }),
    row(100, { department: "", useCenter: "" }),
  ])];
  const plan = planAllocation(sources, 100, 3);
  assert.equal(plan.groups.length, 3);
  const blankGroup = plan.groups.find(group => group.department === "" && group.useCenter === "");
  assert.ok(blankGroup);
  assert.equal(validateAllocationPlan(sources, 100, 3, plan).valid, true);
});

test("manual assignment and tampered blank-group membership are rejected", () => {
  const blank = row(100, { department: "", useCenter: "中心甲" });
  const sources = [source("s1", 1, [blank])];
  assert.throws(
    () => planAllocation(sources, 100, 1, {}, [{ sourceId: "s1", rowId: blank.id, department: "部门甲", useCenter: "中心甲" }]),
    /禁止补填部门/,
  );
  const plan = planAllocation(sources, 100, 1);
  const tampered = structuredClone(plan);
  tampered.groupMembership[0].rows.push({ sourceId: "s1", rowId: "forged", amountCents: 100 });
  assert.equal(validateAllocationPlan(sources, 100, 1, tampered).valid, false);
});

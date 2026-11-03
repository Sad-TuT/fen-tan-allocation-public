import assert from "node:assert/strict";
import test from "node:test";
const policy = await import(new URL("../app/lib/review-policy.ts", import.meta.url).href);

const expectation = {
  reviewDigest: "a".repeat(64),
  expectedFinancials: { totalCents: 10000000, quantity: 4000, sourceUsed: { source1: 2500000, source2: 7500000 }, sourceRemaining: { source1: 15000000, source2: 9500000 } },
};
function review(id = "agent-a", run = "run-a"): any {
  return { reviewerId: id, reviewerRunId: run, origin: "codex_subagent", status: "passed", reviewDigest: expectation.reviewDigest, financials: structuredClone(expectation.expectedFinancials), checks: [...policy.CORE_REVIEW_CHECKS], issues: [], unverified: [] };
}
const rejected = (fn: () => unknown, code: string) => assert.throws(fn, (error: any) => error.code === code);

test("two distinct complete independent reports authorize the exact frozen financial version", () => {
  assert.equal(policy.assertTwoIndependentReviews(expectation, [review(), review("agent-b", "run-b")]).length, 2);
});
test("one review cannot authorize posting", () => {
  rejected(() => policy.assertTwoIndependentReviews(expectation, [review()]), "TWO_REVIEWS_REQUIRED");
});
test("same agent or same execution cannot count twice", () => {
  rejected(() => policy.assertTwoIndependentReviews(expectation, [review(), review("agent-a", "run-b")]), "REVIEWERS_NOT_INDEPENDENT");
  rejected(() => policy.assertTwoIndependentReviews(expectation, [review(), review("agent-b", "run-a")]), "REVIEWERS_NOT_INDEPENDENT");
});
test("changed final file digest invalidates an old passed report", () => {
  const report = review(); report.reviewDigest = "b".repeat(64);
  rejected(() => policy.validateReviewReport(expectation, report), "STALE_REVIEW");
});
test("a failed report records its discrepant actual amount but blocks posting", () => {
  const report = review("agent-b", "run-b"); report.status = "failed"; report.issues = ["来源使用金额不一致"];
  report.financials.sourceUsed.source1 += 100; report.financials.sourceUsed.source2 -= 100;
  assert.equal(policy.validateReviewReport(expectation, report).status, "failed");
  rejected(() => policy.assertTwoIndependentReviews(expectation, [review(), report]), "REVIEW_FAILED");
});
test("a passed label cannot hide unresolved or unverified work", () => {
  const report = review(); report.unverified = ["未读取最终Excel"];
  rejected(() => policy.validateReviewReport(expectation, report), "UNRESOLVED_REVIEW");
});
test("checking only totals and format is insufficient coverage", () => {
  const report = review(); report.checks = ["EXACT_TOTAL", "FINAL_FILES"];
  rejected(() => policy.validateReviewReport(expectation, report), "INCOMPLETE_REVIEW");
});
test("same invoice total cannot mask a different split between sources", () => {
  const report = review(); report.financials.sourceUsed.source1 += 100; report.financials.sourceUsed.source2 -= 100;
  rejected(() => policy.validateReviewReport(expectation, report), "FINANCIAL_MISMATCH");
});
test("source maps compare by exact keys and amounts rather than insertion order", () => {
  const report = review(); report.financials.sourceUsed = { source2: 7500000, source1: 2500000 };
  assert.equal(policy.validateReviewReport(expectation, report).status, "passed");
});
test("fractional cents and unsafe integers cannot appear in financial reports", () => {
  const report = review(); report.financials.sourceRemaining.source1 += 0.5;
  rejected(() => policy.validateReviewReport(expectation, report), "INVALID_FINANCIALS");
  const unsafe = review(); unsafe.financials.quantity = Number.MAX_SAFE_INTEGER + 1;
  rejected(() => policy.validateReviewReport(expectation, unsafe), "INVALID_FINANCIALS");
});
test("a browser self-approval does not impersonate a Codex agent report", () => {
  const report = review(); report.origin = "browser";
  rejected(() => policy.validateReviewReport(expectation, report), "INVALID_ORIGIN");
});

// Execute persistence's real SQL against SQLite in memory. This validates the
// posting transaction and failure preservation without touching live D1/R2.
const { DatabaseSync } = await import("node:sqlite");
const { registerHooks } = await import("node:module");
const mockEnv: any = {};
(globalThis as any).__allocationPersistenceTestEnv = mockEnv;
registerHooks({
  resolve(specifier: string, context: any, nextResolve: any) {
    if (specifier === "./node-runtime" && context.parentURL?.endsWith("/persistence.ts")) {
      return { url: "data:text/javascript,export const env=globalThis.__allocationPersistenceTestEnv", shortCircuit: true };
    }
    if (specifier === "./review-policy" && context.parentURL?.endsWith("/persistence.ts")) {
      return nextResolve(new URL("./review-policy.ts", context.parentURL).href, context);
    }
    return nextResolve(specifier, context);
  },
});
const persistence = await import(new URL("../app/lib/persistence.ts", import.meta.url).href);

function fixture() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(`
    CREATE TABLE allocation_workspace (id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, data_key TEXT, last_batch_id TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE allocation_batches (id TEXT PRIMARY KEY, product TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, version_at_creation INTEGER NOT NULL, status TEXT NOT NULL, data_key TEXT NOT NULL, total_cents INTEGER NOT NULL, quantity INTEGER NOT NULL, review_digest TEXT NOT NULL, completed_at TEXT);
    CREATE TABLE allocation_reviews (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, reviewer_id TEXT NOT NULL, reviewer_run_id TEXT NOT NULL, status TEXT NOT NULL, review_digest TEXT NOT NULL, data_key TEXT NOT NULL, submitted_at TEXT NOT NULL, submitted_by TEXT NOT NULL, UNIQUE(batch_id,reviewer_id), UNIQUE(batch_id,reviewer_run_id));
    CREATE TABLE allocation_events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, batch_id TEXT, actor TEXT NOT NULL, created_at TEXT NOT NULL, detail_json TEXT NOT NULL);
  `);
  const statement = (query: string, bindings: any[] = []): any => ({
    bind: (...values: any[]) => statement(query, values),
    first: async () => sql.prepare(query).get(...bindings) ?? null,
    all: async () => ({ results: sql.prepare(query).all(...bindings) }),
    run: async () => {
      const result = sql.prepare(query).run(...bindings);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  });
  mockEnv.DB = {
    prepare: statement,
    batch: async (statements: any[]) => {
      sql.exec("BEGIN");
      try {
        const results = [];
        for (const entry of statements) results.push(await entry.run());
        sql.exec("COMMIT");
        return results;
      } catch (error) { sql.exec("ROLLBACK"); throw error; }
    },
  };
  const objects = new Map<string, { bytes: Uint8Array; options: any }>();
  mockEnv.BUCKET = {
    put: async (key: string, bytes: Uint8Array, options: any) => {
      if (objects.has(key) && options.onlyIf?.etagDoesNotMatch === "*") return null;
      objects.set(key, { bytes: new Uint8Array(bytes), options });
      return { key };
    },
    get: async (key: string) => {
      const item = objects.get(key);
      return item ? { size: item.bytes.length, arrayBuffer: async () => item.bytes.slice().buffer, httpMetadata: item.options.httpMetadata } : null;
    },
  };
  return { sql, objects };
}

async function staged(id = "batch-001") {
  await persistence.saveWorkspace(0, { sources: ["before"], taxes: [], productHistory: [] }, "operator");
  const manifest = [];
  for (let n = 0; n < 4; n++) {
    const bytes = new TextEncoder().encode(`immutable test artifact ${n}`);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const key = `outputs/${id}/file-${n}.xlsx`;
    await persistence.storeFile(key, bytes, "application/octet-stream");
    manifest.push({ key, name: `file-${n}.xlsx`, sha256: digest, role: `role-${n}` });
  }
  const nextState = { sources: ["after"], taxes: [], productHistory: [{ batchId: id, product: "测试商品" }] };
  const batch = { id, product: "测试商品", createdAt: "2026-11-02T01:00:00.000Z", createdBy: "operator", versionAtCreation: 1, status: "awaiting_review", data: { ...expectation, manifest, nextState } };
  await persistence.createBatch(batch);
  return batch;
}

test("missing or failed second review leaves actual workspace version and state intact", async () => {
  const { sql } = fixture();
  try {
    const batch = await staged();
    await persistence.submitReview(batch.id, review(), "codex-owner");
    await assert.rejects(persistence.commitBatch(batch.id, batch.data.nextState, "operator"), /两名/);
    assert.deepEqual(await persistence.loadWorkspace(), { version: 1, state: { sources: ["before"], taxes: [], productHistory: [] } });
    const failure = review("agent-b", "run-b"); failure.status = "failed"; failure.issues = ["核验发现差额"];
    await persistence.submitReview(batch.id, failure, "codex-owner");
    await assert.rejects(persistence.commitBatch(batch.id, batch.data.nextState, "operator"), /未通过/);
    assert.equal((await persistence.loadWorkspace()).version, 1);
    assert.equal((await persistence.getBatch(batch.id)).status, "awaiting_review");
  } finally { sql.close(); }
});

test("same batch retry posts balance once and preserves one commit event", async () => {
  const { sql } = fixture();
  try {
    const batch = await staged();
    await persistence.submitReview(batch.id, review(), "codex-owner");
    await persistence.submitReview(batch.id, review("agent-b", "run-b"), "codex-owner");
    assert.equal((await persistence.commitBatch(batch.id, batch.data.nextState, "operator")).status, "completed");
    assert.equal((await persistence.commitBatch(batch.id, batch.data.nextState, "operator")).status, "completed");
    assert.deepEqual(await persistence.loadWorkspace(), { version: 2, state: batch.data.nextState });
    assert.equal((sql.prepare("SELECT COUNT(*) AS n FROM allocation_events WHERE kind='batch_committed'").get() as any).n, 1);
  } finally { sql.close(); }
});

test("reviewed batch cannot overwrite an intervening source import", async () => {
  const { sql } = fixture();
  try {
    const batch = await staged();
    await persistence.submitReview(batch.id, review(), "codex-owner");
    await persistence.submitReview(batch.id, review("agent-b", "run-b"), "codex-owner");
    const imported = { sources: ["newly imported"], taxes: [], productHistory: [] };
    await persistence.saveWorkspace(1, imported, "operator-b");
    await assert.rejects(persistence.commitBatch(batch.id, batch.data.nextState, "operator"), /余额.*更新/);
    assert.deepEqual(await persistence.loadWorkspace(), { version: 2, state: imported });
    assert.equal((await persistence.listBatches())[0].isStale, true);
  } finally { sql.close(); }
});

test("final file mutation invalidates review and cannot change live balance", async () => {
  const { sql, objects } = fixture();
  try {
    const batch = await staged();
    await persistence.submitReview(batch.id, review(), "codex-owner");
    await persistence.submitReview(batch.id, review("agent-b", "run-b"), "codex-owner");
    const key = batch.data.manifest[0].key;
    await assert.rejects(persistence.storeFile(key, new TextEncoder().encode("different"), "application/octet-stream"), /阻止覆盖/);
    const original = objects.get(key)!;
    objects.set(key, { ...original, bytes: new TextEncoder().encode("simulated external tampering") });
    await assert.rejects(persistence.commitBatch(batch.id, batch.data.nextState, "operator"), /文件缺失或已改变/);
    assert.equal((await persistence.loadWorkspace()).version, 1);
  } finally { sql.close(); }
});

test("a caller cannot swap next balance after two passing reviews", async () => {
  const { sql } = fixture();
  try {
    const batch = await staged();
    await persistence.submitReview(batch.id, review(), "codex-owner");
    await persistence.submitReview(batch.id, review("agent-b", "run-b"), "codex-owner");
    await assert.rejects(persistence.commitBatch(batch.id, { ...batch.data.nextState, sources: ["unreviewed balance"] }, "operator"), /下一批余额.*不一致/);
    assert.equal((await persistence.loadWorkspace()).version, 1);
  } finally { sql.close(); }
});

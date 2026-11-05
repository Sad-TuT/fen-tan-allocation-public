import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveDraftProgress,
  deriveNextAction,
  type GuidanceBatch,
} from "../app/lib/workflow-ux.ts";

const completeBatch = (overrides: Partial<GuidanceBatch> = {}): GuidanceBatch => ({
  id: "batch-1",
  product: "测试商品",
  passedReviews: 0,
  ...overrides,
});

test("overview recommends prerequisites before starting an allocation", () => {
  assert.equal(
    deriveNextAction({ sourceCount: 0, taxCount: 0, batches: [] }).kind,
    "import-source",
  );
  assert.equal(
    deriveNextAction({ sourceCount: 2, taxCount: 0, batches: [] }).kind,
    "import-tax",
  );
});

test("overview recommends the exact action for each pending review state", () => {
  assert.equal(
    deriveNextAction({
      sourceCount: 2,
      taxCount: 10,
      batches: [completeBatch()],
    }).kind,
    "continue-review",
  );
  assert.equal(
    deriveNextAction({
      sourceCount: 2,
      taxCount: 10,
      batches: [completeBatch({ passedReviews: 2 })],
    }).kind,
    "confirm-commit",
  );
});

test("stale batches and stale-only history do not block a new allocation", () => {
  assert.equal(
    deriveNextAction({
      sourceCount: 2,
      taxCount: 10,
      batches: [completeBatch({ isStale: true })],
    }).kind,
    "start-allocation",
  );
  assert.equal(
    deriveNextAction({
      sourceCount: 2,
      taxCount: 10,
      batches: [completeBatch({ id: "fresh" }), completeBatch({ id: "stale", isStale: true })],
    }).batchId,
    "fresh",
  );
});

test("draft wizard advances only after each user-visible prerequisite", () => {
  assert.deepEqual(
    deriveDraftProgress({
      hasSources: false,
      parametersReady: false,
      hasSimulation: false,
      hasTemplate: false,
    }),
    { stage: 1, nextLabel: "先导入金额来源", canGenerate: false },
  );
  assert.equal(
    deriveDraftProgress({
      hasSources: true,
      parametersReady: false,
      hasSimulation: false,
      hasTemplate: false,
    }).stage,
    1,
  );
  assert.equal(
    deriveDraftProgress({
      hasSources: true,
      parametersReady: true,
      hasSimulation: false,
      hasTemplate: false,
    }).stage,
    2,
  );
  assert.deepEqual(
    deriveDraftProgress({
      hasSources: true,
      parametersReady: true,
      hasSimulation: true,
      hasTemplate: true,
    }),
    { stage: 3, nextLabel: "生成待核验文件", canGenerate: true },
  );
});

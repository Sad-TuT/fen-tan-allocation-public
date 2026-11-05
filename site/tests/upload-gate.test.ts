import assert from "node:assert/strict";
import test from "node:test";
import { activeUploadCountForTest, tryAcquireUploadSlot } from "../app/lib/upload-gate.ts";

test("upload parsing has a bounded concurrency gate and releases once", () => {
  assert.equal(activeUploadCountForTest(), 0);
  const first = tryAcquireUploadSlot();
  const second = tryAcquireUploadSlot();
  assert.ok(first);
  assert.ok(second);
  assert.equal(tryAcquireUploadSlot(), null);
  assert.equal(activeUploadCountForTest(), 2);

  first();
  first();
  assert.equal(activeUploadCountForTest(), 1);
  const replacement = tryAcquireUploadSlot();
  assert.ok(replacement);
  second();
  replacement();
  assert.equal(activeUploadCountForTest(), 0);
});

import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's native TypeScript test runner requires the explicit .ts extension.
import nextConfig from "../next.config.ts";

test("all responses receive the application security headers", async () => {
  assert.equal(nextConfig.poweredByHeader, false);
  const rules = await nextConfig.headers?.();
  assert.ok(rules?.length);
  const globalRule = rules.find((rule) => rule.source === "/(.*)");
  assert.ok(globalRule);
  const headers = new Map(globalRule.headers.map(({ key, value }) => [key, value]));

  assert.match(headers.get("Content-Security-Policy") ?? "", /default-src 'self'/);
  assert.match(headers.get("Content-Security-Policy") ?? "", /frame-ancestors 'none'/);
  assert.match(headers.get("Content-Security-Policy") ?? "", /object-src 'none'/);
  assert.equal(headers.get("Strict-Transport-Security"), "max-age=31536000");
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("X-Frame-Options"), "DENY");
  assert.equal(headers.get("Referrer-Policy"), "no-referrer");
  assert.match(headers.get("Permissions-Policy") ?? "", /camera=\(\)/);
  assert.equal(headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  assert.equal(headers.get("Cross-Origin-Resource-Policy"), "same-origin");
});

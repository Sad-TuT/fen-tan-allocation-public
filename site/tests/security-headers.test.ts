import assert from "node:assert/strict";
import test from "node:test";

import nextConfig from "../next.config.ts";
import {
  APPLICATION_SECURITY_HEADERS,
  CONTENT_SECURITY_POLICY,
  edgeSecurityHeadersEnabled,
  securityHeadersForDeployment,
} from "../app/lib/security-policy.ts";

test("standalone responses receive the complete application security headers", () => {
  const headers = new Map(
    APPLICATION_SECURITY_HEADERS.map(({ key, value }) => [key, value]),
  );

  assert.equal(headers.get("Content-Security-Policy"), CONTENT_SECURITY_POLICY);
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

test("edge-managed deployments omit only duplicated common headers", () => {
  const headers = new Map(
    securityHeadersForDeployment(true).map(({ key, value }) => [key, value]),
  );

  assert.equal(headers.has("Content-Security-Policy"), false);
  assert.equal(headers.has("Strict-Transport-Security"), false);
  assert.equal(headers.has("X-Content-Type-Options"), false);
  assert.equal(headers.has("Referrer-Policy"), false);
  assert.equal(headers.has("Permissions-Policy"), false);
  assert.equal(headers.get("X-Frame-Options"), "DENY");
  assert.equal(headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  assert.equal(headers.get("Cross-Origin-Resource-Policy"), "same-origin");
});

test("the edge-managed mode requires the exact opt-in value", () => {
  assert.equal(edgeSecurityHeadersEnabled("true"), true);
  assert.equal(edgeSecurityHeadersEnabled("false"), false);
  assert.equal(edgeSecurityHeadersEnabled("TRUE"), false);
  assert.equal(edgeSecurityHeadersEnabled(""), false);
  assert.equal(edgeSecurityHeadersEnabled("1"), false);
});

test("Next.js applies the header set selected for the deployment", async () => {
  assert.equal(nextConfig.poweredByHeader, false);
  const rules = await nextConfig.headers?.();
  assert.ok(rules?.length);
  const globalRule = rules.find((rule) => rule.source === "/(.*)");
  assert.ok(globalRule);
  assert.deepEqual(
    globalRule.headers,
    securityHeadersForDeployment(edgeSecurityHeadersEnabled()),
  );
});

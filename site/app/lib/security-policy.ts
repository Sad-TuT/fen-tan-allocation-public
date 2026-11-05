const CONTENT_SECURITY_POLICY_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
];

export const CONTENT_SECURITY_POLICY =
  CONTENT_SECURITY_POLICY_DIRECTIVES.join("; ");

// frame-ancestors is not supported in a meta-delivered policy. The trusted
// edge keeps that directive in the HTTP response header.
export const HTML_CONTENT_SECURITY_POLICY = CONTENT_SECURITY_POLICY_DIRECTIVES
  .filter((directive) => !directive.startsWith("frame-ancestors "))
  .join("; ");

export const APPLICATION_SECURITY_HEADERS: Array<{
  key: string;
  value: string;
}> = [
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  {
    key: "Permissions-Policy",
    value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

const EDGE_MANAGED_HEADER_KEYS = new Set([
  "Content-Security-Policy",
  "Strict-Transport-Security",
  "X-Content-Type-Options",
  "Referrer-Policy",
  "Permissions-Policy",
]);

export function edgeSecurityHeadersEnabled(
  value = process.env.ALLOCATION_EDGE_SECURITY_HEADERS,
) {
  return value === "true";
}

export function securityHeadersForDeployment(edgeManaged: boolean) {
  if (!edgeManaged) {
    return APPLICATION_SECURITY_HEADERS;
  }

  return APPLICATION_SECURITY_HEADERS.filter(
    ({ key }) => !EDGE_MANAGED_HEADER_KEYS.has(key),
  );
}

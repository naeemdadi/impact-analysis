import type { NextFunction, Request, Response } from "express";

// The landing page is fully self-hosted: inline styles, same-origin images, no
// scripts, no forms. That lets the policy stay at deny-by-default throughout.
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "img-src 'self'",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const STRICT_TRANSPORT_SECURITY = "max-age=31536000; includeSubDomains";

export function securityHeaders(request: Request, response: Response, next: NextFunction): void {
  response.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  // Browsers ignore HSTS over plain HTTP; only send it on TLS requests.
  if (isSecureRequest(request)) {
    response.setHeader("Strict-Transport-Security", STRICT_TRANSPORT_SECURITY);
  }
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  next();
}

function isSecureRequest(request: Request): boolean {
  return request.secure || request.headers["x-forwarded-proto"] === "https";
}

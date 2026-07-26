import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

// createApp transitively loads modules that require these at import time.
process.env.GITHUB_WEBHOOK_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/test";

test("every response carries baseline security headers and the landing page renders under CSP", async () => {
  const { createApp } = await import("../src/server/app.js");
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    assert.equal(health.headers.get("x-frame-options"), "DENY");
    assert.equal(health.headers.get("referrer-policy"), "no-referrer");
    assert.ok(health.headers.get("strict-transport-security"));
    const csp = health.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /img-src 'self'/);
    assert.match(csp, /style-src 'unsafe-inline'/);
    assert.match(csp, /frame-ancestors 'none'/);

    const landing = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(landing.status, 200);
    assert.equal(landing.headers.get("x-frame-options"), "DENY");
    assert.match(await landing.text(), /PR Impact Analysis/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

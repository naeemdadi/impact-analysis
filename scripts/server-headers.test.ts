import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

// createApp transitively loads modules that require these at import time.
process.env.GITHUB_WEBHOOK_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/test";

test("serves baseline security headers and still serves the landing page", async () => {
  const { createApp } = await import("../src/server/app.js");
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    assert.equal(health.headers.get("x-frame-options"), "DENY");
    assert.equal(health.headers.get("referrer-policy"), "no-referrer");
    const csp = health.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /img-src 'self'/);
    assert.match(csp, /style-src 'unsafe-inline'/);
    assert.match(csp, /form-action 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);

    // HSTS only over HTTPS: absent on plain HTTP, present when proxied as https.
    assert.equal(health.headers.get("strict-transport-security"), null);
    const secure = await fetch(`${base}/health`, { headers: { "x-forwarded-proto": "https" } });
    assert.ok(secure.headers.get("strict-transport-security"));

    const landing = await fetch(`${base}/`);
    assert.equal(landing.status, 200);
    assert.equal(landing.headers.get("x-frame-options"), "DENY");
    assert.match(await landing.text(), /PR Impact Analysis/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

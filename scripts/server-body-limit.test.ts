import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

// createApp transitively loads modules that require these at import time.
process.env.GITHUB_WEBHOOK_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/test";

test("rejects oversized request bodies but still parses normal ones", async () => {
  const { createApp } = await import("../src/server/app.js");
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const webhook = `http://127.0.0.1:${port}/webhooks/github`;
  const jsonHeaders = { "content-type": "application/json" };

  try {
    const oversized = await fetch(webhook, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ padding: "a".repeat(3 * 1024 * 1024) }),
    });
    assert.equal(oversized.status, 413);
    assert.match(oversized.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await oversized.json(), { error: "request body too large" });

    // A normal body parses, so it reaches the handler and is rejected there for
    // missing webhook headers (400), not blocked by the body limit (413).
    const normal = await fetch(webhook, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ hello: "world" }),
    });
    assert.equal(normal.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

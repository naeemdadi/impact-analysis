import assert from "node:assert/strict";
import test from "node:test";

import { classifyJobError, JobTimeoutError, maxJobAttempts, retryDelayMs, runWithDeadline } from "../src/queue/reliability.js";

test("retry policy is bounded and uses the documented backoff", () => {
  assert.equal(maxJobAttempts, 3);
  assert.equal(retryDelayMs(1), 30_000);
  assert.equal(retryDelayMs(2), 120_000);
  assert.equal(classifyJobError({ status: 429 }), "transient");
  assert.equal(classifyJobError({ status: 503 }), "transient");
  assert.equal(classifyJobError({ status: 403 }), "permanent");
});

test("deadline aborts an operation with a typed timeout", async () => {
  await assert.rejects(
    runWithDeadline(5, async () => new Promise<void>(() => undefined)),
    JobTimeoutError,
  );
});

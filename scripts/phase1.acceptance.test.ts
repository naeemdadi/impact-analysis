import test from "node:test";
import assert from "node:assert/strict";

import { createIdempotencyKey, createPayloadHash } from "../src/queue/idempotency.js";

test("idempotency key is stable for repeated delivery metadata", () => {
  const input = {
    deliveryId: "delivery-123",
    eventName: "pull_request",
    eventAction: "opened",
    repoId: 42,
    commitSha: "abc123",
    pullRequestNumber: 7,
  };

  const first = createIdempotencyKey(input);
  const second = createIdempotencyKey(input);

  assert.equal(first, second);
});

test("idempotency key changes when event identity changes", () => {
  const first = createIdempotencyKey({
    deliveryId: "delivery-123",
    eventName: "pull_request",
    eventAction: "opened",
    repoId: 42,
    commitSha: "abc123",
    pullRequestNumber: 7,
  });
  const second = createIdempotencyKey({
    deliveryId: "delivery-123",
    eventName: "pull_request",
    eventAction: "synchronize",
    repoId: 42,
    commitSha: "def456",
    pullRequestNumber: 7,
  });

  assert.notEqual(first, second);
});

test("payload hash is deterministic", () => {
  const payload = JSON.stringify({ action: "opened", repository: { id: 42 } });
  const first = createPayloadHash(payload);
  const second = createPayloadHash(payload);

  assert.equal(first, second);
});

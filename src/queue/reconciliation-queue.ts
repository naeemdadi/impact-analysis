import crypto from "node:crypto";

import { enqueueJobWithIdempotency } from "./enqueue.js";

export async function enqueueBranchReconciliation(input: { repoId: number; branch: string; sha: string; reason: string }): Promise<void> {
  const payload = { repoId: input.repoId, branch: input.branch, sha: input.sha, reason: input.reason };
  const window = Math.floor(Date.now() / (5 * 60_000));
  const digest = crypto.createHash("sha256").update(JSON.stringify({ ...payload, window })).digest("hex");
  const deliveryId = `system:branch-reconcile:${digest}`;
  await enqueueJobWithIdempotency({
    idempotencyKey: digest, deliveryId, eventName: "system", eventAction: "branch_reconcile", repoId: input.repoId,
    payloadSha256: crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    jobType: "branch.reconcile", jobPayload: payload,
  });
}

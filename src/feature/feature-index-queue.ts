import { enqueueJobWithIdempotency } from "../queue/enqueue.js";
import { createIdempotencyKey, createPayloadHash } from "../queue/idempotency.js";

export async function enqueueFeatureIndex(input: { deliveryId: string; repoId: number; branch: string; sha: string; mode: "full" | "incremental"; changedPaths?: string[] }): Promise<void> {
  const payload = { repoId: input.repoId, branch: input.branch, sha: input.sha, mode: input.mode, changedPaths: input.changedPaths ?? [] };
  await enqueueJobWithIdempotency({
    idempotencyKey: createIdempotencyKey({ deliveryId: input.deliveryId, eventName: "feature", eventAction: "index", repoId: input.repoId, commitSha: input.sha }),
    deliveryId: input.deliveryId, eventName: "feature", eventAction: "index", repoId: input.repoId,
    payloadSha256: createPayloadHash(JSON.stringify(payload)), jobType: "feature.index", jobPayload: payload,
  });
}

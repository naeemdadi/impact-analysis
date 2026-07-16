import { z } from "zod";

import { enqueueJobWithIdempotency } from "../../queue/enqueue.js";
import { createIdempotencyKey, createPayloadHash } from "../../queue/idempotency.js";
import { getRepoConfig } from "../../storage/repo-config-repo.js";
import { log } from "../../server/logger.js";

const pushPayloadSchema = z.object({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  deleted: z.boolean().optional(),
  repository: z.object({
    id: z.number(),
    default_branch: z.string(),
  }),
});

interface PushEventContext {
  deliveryId: string;
  rawBody: string;
}

function getBranchFromRef(ref: string): string {
  const prefix = "refs/heads/";
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

export async function handlePushEvent(payload: unknown, context: PushEventContext): Promise<void> {
  const parsed = pushPayloadSchema.parse(payload);
  const pushedBranch = getBranchFromRef(parsed.ref);
  const config = await getRepoConfig(parsed.repository.id);
  if (config && !config.isActive) {
    log("info", "push event ignored for inactive repository", {
      deliveryId: context.deliveryId,
      repoId: parsed.repository.id,
    });
    return;
  }
  const trackedBranch = config?.trackedBranch ?? parsed.repository.default_branch;

  if (pushedBranch !== trackedBranch) {
    log("info", "push event ignored for untracked branch", {
      deliveryId: context.deliveryId,
      pushedBranch,
      trackedBranch,
      repoId: parsed.repository.id,
    });
    return;
  }

  const idempotencyKey = createIdempotencyKey({
    deliveryId: context.deliveryId,
    eventName: "push",
    eventAction: "updated",
    repoId: parsed.repository.id,
    commitSha: parsed.after,
  });

  await enqueueJobWithIdempotency({
    idempotencyKey,
    deliveryId: context.deliveryId,
    eventName: "push",
    eventAction: "updated",
    repoId: parsed.repository.id,
    payloadSha256: createPayloadHash(context.rawBody),
    jobType: "branch.push",
    jobPayload: {
      repoId: parsed.repository.id,
      branch: pushedBranch,
      beforeSha: parsed.before,
      afterSha: parsed.after,
      deleted: parsed.deleted ?? false,
    },
  });

  log("info", "push event enqueued", {
    deliveryId: context.deliveryId,
    repoId: parsed.repository.id,
    branch: pushedBranch,
    afterSha: parsed.after,
  });
}

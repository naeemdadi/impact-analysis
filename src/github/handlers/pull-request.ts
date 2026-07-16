import { z } from "zod";

import { enqueueJobWithIdempotency } from "../../queue/enqueue.js";
import { createIdempotencyKey, createPayloadHash } from "../../queue/idempotency.js";
import { getRepoConfig } from "../../storage/repo-config-repo.js";
import { log } from "../../server/logger.js";

const pullRequestPayloadSchema = z.object({
  action: z.string(),
  number: z.number(),
  repository: z.object({
    id: z.number(),
    default_branch: z.string(),
  }),
  pull_request: z.object({
    number: z.number(),
    base: z.object({
      ref: z.string(),
      sha: z.string(),
    }),
    head: z.object({
      sha: z.string(),
    }),
  }),
});

interface PullRequestEventContext {
  deliveryId: string;
  rawBody: string;
}

const allowedActions = new Set(["opened", "synchronize", "reopened"]);

export async function handlePullRequestEvent(
  payload: unknown,
  context: PullRequestEventContext,
): Promise<void> {
  const parsed = pullRequestPayloadSchema.parse(payload);

  if (!allowedActions.has(parsed.action)) {
    log("info", "pull_request action ignored", {
      deliveryId: context.deliveryId,
      action: parsed.action,
      repoId: parsed.repository.id,
    });
    return;
  }

  const config = await getRepoConfig(parsed.repository.id);
  if (config && !config.isActive) {
    log("info", "pull_request ignored for inactive repository", {
      deliveryId: context.deliveryId,
      repoId: parsed.repository.id,
    });
    return;
  }
  const trackedBranch = config?.trackedBranch ?? parsed.repository.default_branch;
  if (parsed.pull_request.base.ref !== trackedBranch) {
    log("info", "pull_request ignored for untracked base branch", {
      deliveryId: context.deliveryId,
      action: parsed.action,
      baseRef: parsed.pull_request.base.ref,
      trackedBranch,
      repoId: parsed.repository.id,
    });
    return;
  }

  const idempotencyKey = createIdempotencyKey({
    deliveryId: context.deliveryId,
    eventName: "pull_request",
    eventAction: parsed.action,
    repoId: parsed.repository.id,
    commitSha: parsed.pull_request.head.sha,
    pullRequestNumber: parsed.pull_request.number,
  });

  await enqueueJobWithIdempotency({
    idempotencyKey,
    deliveryId: context.deliveryId,
    eventName: "pull_request",
    eventAction: parsed.action,
    repoId: parsed.repository.id,
    payloadSha256: createPayloadHash(context.rawBody),
    jobType: "pull_request.analyze",
    jobPayload: {
      repoId: parsed.repository.id,
      pullRequestNumber: parsed.pull_request.number,
      action: parsed.action,
      baseRef: parsed.pull_request.base.ref,
      baseSha: parsed.pull_request.base.sha,
      headSha: parsed.pull_request.head.sha,
    },
  });

  log("info", "pull_request event enqueued", {
    deliveryId: context.deliveryId,
    repoId: parsed.repository.id,
    action: parsed.action,
    pullRequestNumber: parsed.pull_request.number,
  });
}

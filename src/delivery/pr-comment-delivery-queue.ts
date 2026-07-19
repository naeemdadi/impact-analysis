import { createHash } from "node:crypto";

import { enqueueJobWithIdempotency } from "../queue/enqueue.js";

export interface PullRequestDeliveryRequest {
  repoId: number;
  pullRequestNumber: number;
  prAnalysisId: string;
  headSha: string;
  deliveryState: "running" | "ready" | "failed";
}

export async function enqueuePullRequestDelivery(input: PullRequestDeliveryRequest & { deliveryId: string }): Promise<void> {
  const payload: PullRequestDeliveryRequest = {
    repoId: input.repoId,
    pullRequestNumber: input.pullRequestNumber,
    prAnalysisId: input.prAnalysisId,
    headSha: input.headSha,
    deliveryState: input.deliveryState,
  };
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  await enqueueJobWithIdempotency({
    idempotencyKey: `pull_request:deliver:${input.deliveryId}:${digest}`,
    deliveryId: input.deliveryId,
    eventName: "pull_request",
    eventAction: "deliver",
    repoId: input.repoId,
    payloadSha256: digest,
    jobType: "pull_request.deliver",
    jobPayload: { ...payload },
  });
}

/** Queues one idempotent repair for a comment pointer discovered by reconciliation. */
export async function enqueueUndeliveredPullRequestComment(input: PullRequestDeliveryRequest): Promise<void> {
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  await enqueuePullRequestDelivery({
    ...input,
    deliveryId: `system:pull-request-delivery:${digest}`,
  });
}

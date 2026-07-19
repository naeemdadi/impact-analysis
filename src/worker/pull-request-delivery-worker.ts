import { z } from "zod";

import { GitHubPullRequestCommentWriter } from "../github/pull-request-comment-writer.js";
import { claimNextJob, completeJob, retryOrFailJob } from "../queue/worker-repository.js";
import { log } from "../server/logger.js";
import { markPrCommentDeliveryFailed } from "../delivery/pr-comment-delivery-repository.js";
import { deliverPullRequestComment } from "../delivery/pr-comment-delivery-service.js";
import { runWithDeadline, timeoutForJob } from "../queue/reliability.js";

const deliveryPayloadSchema = z.object({
  repoId: z.number(),
  pullRequestNumber: z.number(),
  prAnalysisId: z.string().uuid(),
  headSha: z.string(),
  deliveryState: z.enum(["running", "ready", "failed"]),
});

export async function processNextPullRequestDeliveryJob(): Promise<boolean> {
  const job = await claimNextJob("pull_request.deliver");
  if (!job) return false;
  let payload: z.infer<typeof deliveryPayloadSchema> | null = null;
  const startedAt = Date.now();
  try {
    payload = deliveryPayloadSchema.parse(job.jobPayload);
    const parsed = payload;
    const result = await runWithDeadline(timeoutForJob(job.jobType), async () => deliverPullRequestComment(parsed, new GitHubPullRequestCommentWriter()));
    await completeJob(job);
    log("info", "pull request comment delivered", {
      jobId: job.id, repoId: payload.repoId, pullRequestNumber: payload.pullRequestNumber,
      headSha: payload.headSha, commentId: result.commentId, action: result.action, durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "pull request comment delivery failed";
    const outcome = await retryOrFailJob(job, error);
    // A retried delivery is still pending. Recording it as failed made the
    // mutable pointer lie even though a later attempt could update GitHub.
    if (payload && !outcome.retried) await markPrCommentDeliveryFailed({ ...payload, analysisId: payload.prAnalysisId, error: message });
    log("error", "pull request comment delivery failed", {
      jobId: job.id, repoId: payload?.repoId ?? null, pullRequestNumber: payload?.pullRequestNumber ?? null,
      headSha: payload?.headSha ?? null, error: message, errorKind: outcome.errorKind, retryScheduled: outcome.retried, durationMs: Date.now() - startedAt,
    });
  }
  return true;
}

export async function runPullRequestDeliveryWorker(): Promise<void> {
  log("info", "pull request delivery worker started");
  while (true) if (!await processNextPullRequestDeliveryJob()) await new Promise((resolve) => setTimeout(resolve, 1_000));
}

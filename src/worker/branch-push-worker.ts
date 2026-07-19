import { z } from "zod";

import { updateGraphIncrementally } from "../graph/update-incremental.js";
import { GitHubRepositoryReader } from "../graph/github-repository-reader.js";
import { claimNextJob, completeJob, retryOrFailJob } from "../queue/worker-repository.js";
import { log } from "../server/logger.js";
import { enqueueFeatureIndex } from "../feature/feature-index-queue.js";
import { enqueueBranchReconciliation } from "../queue/reconciliation-queue.js";
import { runWithDeadline, timeoutForJob } from "../queue/reliability.js";

const pushPayloadSchema = z.object({
  repoId: z.number(),
  branch: z.string(),
  beforeSha: z.string(),
  afterSha: z.string(),
});

export async function processNextBranchPushJob(): Promise<boolean> {
  const job = await claimNextJob("branch.push");
  if (!job) return false;
  let payload: z.infer<typeof pushPayloadSchema> | null = null;
  try {
    payload = pushPayloadSchema.parse(job.jobPayload);
    const parsed = payload;
    const result = await runWithDeadline(timeoutForJob(job.jobType), async () => updateGraphIncrementally(parsed, new GitHubRepositoryReader()));
    if (result?.status === "superseded") {
      await completeJob(job);
      log("info", "push graph update superseded by newer branch head", { jobId: job.id, repoId: payload.repoId, branch: payload.branch, afterSha: payload.afterSha, liveSha: result.liveSha });
      return true;
    }
    if (result) await enqueueFeatureIndex({
      deliveryId: job.deliveryId, repoId: payload.repoId, branch: payload.branch, sha: result.sha,
      // A full graph fallback intentionally refreshes all feature cards because
      // comparison/configuration evidence was not safe to scope further.
      mode: result.buildMode === "incremental" ? "incremental" : "full",
      changedPaths: result.featureIndexPaths,
    });
    await completeJob(job);
    log("info", result ? "push graph snapshot ready" : "push graph build skipped for deleted branch", {
      jobId: job.id, repoId: payload.repoId, branch: payload.branch, afterSha: payload.afterSha,
      snapshotId: result?.snapshotId, buildMode: result?.buildMode, buildDurationMs: result?.buildDurationMs,
      changedFileCount: result?.changedFileCount, reanalyzedFileCount: result?.reanalyzedFileCount,
      fallbackReason: result?.fallbackReason,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "branch push worker error";
    const outcome = await retryOrFailJob(job, error);
    if (!outcome.retried && payload) {
      await enqueueBranchReconciliation({ repoId: payload.repoId, branch: payload.branch, sha: payload.afterSha, reason: `terminal branch.push failure: ${outcome.errorKind}` });
    }
    log("error", "push graph update failed", { jobId: job.id, error: message });
  }
  return true;
}

export async function runBranchPushWorker(): Promise<void> {
  log("info", "branch push worker started");
  while (true) {
    if (!await processNextBranchPushJob()) await wait(1_000);
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

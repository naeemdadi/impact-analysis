import { z } from "zod";

import { buildAndPersistBaselineGraph } from "../graph/build-baseline.js";
import { GitHubRepositoryReader } from "../graph/github-repository-reader.js";
import { enqueueFeatureIndex } from "../feature/feature-index-queue.js";
import { claimNextJob, completeJob, retryOrFailJob } from "../queue/worker-repository.js";
import { log } from "../server/logger.js";
import { runWithDeadline, timeoutForJob } from "../queue/reliability.js";

const payloadSchema = z.object({ repoId: z.number(), branch: z.string(), sha: z.string(), reason: z.string() });

export async function processNextBranchReconcileJob(): Promise<boolean> {
  const job = await claimNextJob("branch.reconcile");
  if (!job) return false;
  try {
    const payload = payloadSchema.parse(job.jobPayload);
    const result = await runWithDeadline(timeoutForJob(job.jobType), async () => buildAndPersistBaselineGraph({ repoId: payload.repoId, sha: payload.sha, reuseReadySnapshot: true, buildMetadata: { buildMode: "full_fallback", fallbackReason: `reconciliation: ${payload.reason}` } }, new GitHubRepositoryReader()));
    await enqueueFeatureIndex({ deliveryId: job.deliveryId, repoId: result.repoId, branch: result.branch, sha: result.sha, mode: "full" });
    await completeJob(job);
    log("info", "branch reconciliation completed", { jobId: job.id, repoId: payload.repoId, branch: payload.branch, sha: payload.sha, reason: payload.reason, snapshotId: result.snapshotId });
  } catch (error) {
    await retryOrFailJob(job, error);
    log("error", "branch reconciliation failed", { jobId: job.id, error: error instanceof Error ? error.message : "unknown error" });
  }
  return true;
}

export async function runBranchReconcileWorker(): Promise<void> {
  log("info", "branch reconciliation worker started");
  while (true) if (!await processNextBranchReconcileJob()) await new Promise((resolve) => setTimeout(resolve, 1_000));
}

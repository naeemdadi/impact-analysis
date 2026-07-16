import { z } from "zod";

import { updateGraphIncrementally } from "../graph/update-incremental.js";
import { GitHubRepositoryReader } from "../graph/github-repository-reader.js";
import { claimNextJob, completeJob, failJob } from "../queue/worker-repository.js";
import { log } from "../server/logger.js";

const pushPayloadSchema = z.object({
  repoId: z.number(),
  branch: z.string(),
  beforeSha: z.string(),
  afterSha: z.string(),
});

export async function processNextBranchPushJob(): Promise<boolean> {
  const job = await claimNextJob("branch.push");
  if (!job) return false;
  try {
    const payload = pushPayloadSchema.parse(job.jobPayload);
    const result = await updateGraphIncrementally(payload, new GitHubRepositoryReader());
    await completeJob(job.id);
    log("info", result ? "push graph snapshot ready" : "push graph build skipped for deleted branch", {
      jobId: job.id, repoId: payload.repoId, branch: payload.branch, afterSha: payload.afterSha,
      snapshotId: result?.snapshotId, buildMode: result?.buildMode, buildDurationMs: result?.buildDurationMs,
      changedFileCount: result?.changedFileCount, reanalyzedFileCount: result?.reanalyzedFileCount,
      fallbackReason: result?.fallbackReason,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "branch push worker error";
    await failJob(job.id, message);
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

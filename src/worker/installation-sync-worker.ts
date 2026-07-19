import { z } from "zod";

import { buildAndPersistBaselineGraph } from "../graph/build-baseline.js";
import { GitHubRepositoryReader } from "../graph/github-repository-reader.js";
import { claimNextJob, completeJob, failJob } from "../queue/worker-repository.js";
import { log } from "../server/logger.js";
import { enqueueFeatureIndex } from "../feature/feature-index-queue.js";

const installationSyncPayloadSchema = z.object({
  installationId: z.number(),
  repositoryIds: z.array(z.number()),
  action: z.string(),
});

const buildActions = new Set(["created", "added", "unsuspend", "new_permissions_accepted"]);

export async function processNextInstallationSyncJob(): Promise<boolean> {
  const job = await claimNextJob("installation.sync");
  if (!job) return false;

  try {
    const payload = installationSyncPayloadSchema.parse(job.jobPayload);
    if (!buildActions.has(payload.action)) {
      log("info", "installation sync job completed without graph build", {
        jobId: job.id,
        action: payload.action,
      });
      await completeJob(job.id);
      return true;
    }

    const repositoryReader = new GitHubRepositoryReader();
    for (const repoId of payload.repositoryIds) {
      const result = await buildAndPersistBaselineGraph(
        { repoId, reuseReadySnapshot: true },
        repositoryReader,
      );
      await enqueueFeatureIndex({ deliveryId: job.deliveryId, repoId, branch: result.branch, sha: result.sha, mode: "full" });
      log("info", "baseline snapshot ready", {
        jobId: job.id,
        repoId,
        branch: result.branch,
        sha: result.sha,
        fileCount: result.fileCount,
        importCount: result.importCount,
        buildDurationMs: result.buildDurationMs,
      });
    }

    await completeJob(job.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown installation sync worker error";
    await failJob(job.id, message);
    log("error", "installation sync job failed", { jobId: job.id, error: message });
  }
  return true;
}

export async function runInstallationSyncWorker(): Promise<void> {
  log("info", "installation sync worker started");
  while (true) {
    const processed = await processNextInstallationSyncJob();
    if (!processed) await wait(1_000);
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

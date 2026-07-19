import { z } from "zod";

import { indexRepositoryFeatures } from "../feature/feature-service.js";
import { GitHubRepositoryReader } from "../graph/github-repository-reader.js";
import { claimNextJob, completeJob, retryOrFailJob } from "../queue/worker-repository.js";
import { log } from "../server/logger.js";
import { runWithDeadline, timeoutForJob } from "../queue/reliability.js";

const payloadSchema = z.object({ repoId: z.number(), branch: z.string(), sha: z.string(), mode: z.enum(["full", "incremental"]), changedPaths: z.array(z.string()).default([]) });

export async function processNextFeatureIndexJob(): Promise<boolean> {
  const job = await claimNextJob("feature.index");
  if (!job) return false;
  try {
    const result = await runWithDeadline(timeoutForJob(job.jobType), async () => indexRepositoryFeatures(payloadSchema.parse(job.jobPayload), new GitHubRepositoryReader()));
    await completeJob(job);
    log("info", "feature index completed", { jobId: job.id, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "feature index worker error";
    await retryOrFailJob(job, error);
    log("error", "feature index failed", { jobId: job.id, error: message });
  }
  return true;
}

export async function runFeatureIndexWorker(): Promise<void> {
  log("info", "feature index worker started");
  while (true) if (!await processNextFeatureIndexJob()) await new Promise((resolve) => setTimeout(resolve, 1_000));
}

import { z } from "zod";

import { GitHubRepositoryReader } from "../graph/github-repository-reader.js";
import { findCompletedPrAnalysis, createBuildingPrAnalysis, failPrAnalysis, persistPrAnalysis } from "../impact/pr-analysis-repository.js";
import { buildPullRequestImpactAnalysis } from "../impact/pr-impact-service.js";
import { ensurePrReport } from "../report/report-service.js";
import { claimNextJob, completeJob, failJob } from "../queue/worker-repository.js";
import { log } from "../server/logger.js";

const pullRequestPayloadSchema = z.object({
  repoId: z.number(),
  pullRequestNumber: z.number(),
  action: z.string(),
  baseRef: z.string(),
  baseSha: z.string(),
  headSha: z.string(),
});

export async function processNextPullRequestAnalysisJob(): Promise<boolean> {
  const job = await claimNextJob("pull_request.analyze");
  if (!job) return false;

  let payload: z.infer<typeof pullRequestPayloadSchema> | null = null;
  try {
    payload = pullRequestPayloadSchema.parse(job.jobPayload);
    const existing = await findCompletedPrAnalysis(payload);
    if (existing) {
      const report = await ensurePrReport(existing);
      await completeJob(job.id);
      log("info", "pull request analysis reused", { jobId: job.id, repoId: payload.repoId, pullRequestNumber: payload.pullRequestNumber, headSha: payload.headSha, reportReused: report.reused, llmStatus: report.llmStatus });
      return true;
    }

    await createBuildingPrAnalysis(payload);
    const result = await buildPullRequestImpactAnalysis(payload, new GitHubRepositoryReader());
    await persistPrAnalysis(result);
    const report = await ensurePrReport(result);
    await completeJob(job.id);
    log("info", "pull request analysis ready", {
      jobId: job.id,
      repoId: payload.repoId,
      pullRequestNumber: payload.pullRequestNumber,
      headSha: payload.headSha,
      status: result.status,
      impactLevel: result.impactLevel,
      affectedItemCount: result.affectedItems.length,
      reportReused: report.reused,
      llmStatus: report.llmStatus,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "pull request analysis worker error";
    if (payload) await failPrAnalysis(payload, message);
    await failJob(job.id, message);
    log("error", "pull request analysis failed", { jobId: job.id, error: message });
  }
  return true;
}

export async function runPullRequestAnalysisWorker(): Promise<void> {
  log("info", "pull request analysis worker started");
  while (true) {
    if (!await processNextPullRequestAnalysisJob()) await wait(1_000);
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

import { z } from "zod";

import { GitHubRepositoryReader } from "../graph/github-repository-reader.js";
import { findCompletedPrAnalysis, createBuildingPrAnalysis, failPrAnalysis, getPrAnalysisId, persistPrAnalysis } from "../impact/pr-analysis-repository.js";
import { buildPullRequestImpactAnalysis } from "../impact/pr-impact-service.js";
import { ensurePrReport } from "../report/report-service.js";
import { enqueuePullRequestDelivery } from "../delivery/pr-comment-delivery-queue.js";
import { requestPrCommentDelivery } from "../delivery/pr-comment-delivery-repository.js";
import { claimNextJob, completeJob, retryOrFailJob } from "../queue/worker-repository.js";
import { log } from "../server/logger.js";
import { runWithDeadline, timeoutForJob } from "../queue/reliability.js";

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
    const parsed = payload;
    const existing = await findCompletedPrAnalysis(parsed);
    if (existing) {
      const report = await runWithDeadline(timeoutForJob(job.jobType), async () => ensurePrReport(existing, undefined, new GitHubRepositoryReader()));
      await enqueueDeliverySafely({
        deliveryId: job.deliveryId,
        repoId: payload.repoId,
        pullRequestNumber: payload.pullRequestNumber,
        analysisId: await getPrAnalysisId(payload),
        headSha: payload.headSha,
        deliveryState: "ready",
      });
      await completeJob(job);
      log("info", "pull request analysis reused", { jobId: job.id, repoId: payload.repoId, pullRequestNumber: payload.pullRequestNumber, headSha: payload.headSha, reportReused: report.reused, llmStatus: report.llmStatus });
      return true;
    }

    await createBuildingPrAnalysis(payload);
    const analysisId = await getPrAnalysisId(payload);
    await enqueueDeliverySafely({
      deliveryId: job.deliveryId,
      repoId: payload.repoId,
      pullRequestNumber: payload.pullRequestNumber,
      analysisId,
      headSha: payload.headSha,
      deliveryState: "running",
    });
    const result = await runWithDeadline(timeoutForJob(job.jobType), async () => buildPullRequestImpactAnalysis(parsed, new GitHubRepositoryReader()));
    await persistPrAnalysis(result);
    const report = await runWithDeadline(timeoutForJob(job.jobType), async () => ensurePrReport(result, undefined, new GitHubRepositoryReader()));
    await enqueueDeliverySafely({
      deliveryId: job.deliveryId,
      repoId: payload.repoId,
      pullRequestNumber: payload.pullRequestNumber,
      analysisId,
      headSha: payload.headSha,
      deliveryState: "ready",
    });
    await completeJob(job);
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
    if (payload) {
      await failPrAnalysis(payload, message);
      await enqueueDeliverySafely({
        deliveryId: job.deliveryId,
        repoId: payload.repoId,
        pullRequestNumber: payload.pullRequestNumber,
        analysisId: await getPrAnalysisId(payload),
        headSha: payload.headSha,
        deliveryState: "failed",
      });
    }
    await retryOrFailJob(job, error);
    log("error", "pull request analysis failed", { jobId: job.id, error: message });
  }
  return true;
}

async function enqueueDeliverySafely(input: {
  deliveryId: string;
  repoId: number;
  pullRequestNumber: number;
  analysisId: string;
  headSha: string;
  deliveryState: "running" | "ready" | "failed";
}): Promise<void> {
  try {
    await requestPrCommentDelivery({
      repoId: input.repoId,
      pullRequestNumber: input.pullRequestNumber,
      analysisId: input.analysisId,
      headSha: input.headSha,
    });
    await enqueuePullRequestDelivery({ ...input, prAnalysisId: input.analysisId });
  } catch (error) {
    log("error", "failed to enqueue pull request comment delivery", {
      repoId: input.repoId,
      pullRequestNumber: input.pullRequestNumber,
      headSha: input.headSha,
      deliveryState: input.deliveryState,
      error: error instanceof Error ? error.message : "unknown delivery enqueue error",
    });
  }
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

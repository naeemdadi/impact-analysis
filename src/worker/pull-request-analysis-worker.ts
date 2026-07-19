import { z } from "zod";

import { GitHubRepositoryReader } from "../graph/github-repository-reader.js";
import { findCompletedPrAnalysis, createBuildingPrAnalysis, failPrAnalysis, getPrAnalysisId, persistPrAnalysis } from "../impact/pr-analysis-repository.js";
import { buildPullRequestImpactArtifacts } from "../impact/pr-impact-service.js";
import { assessImpact } from "../impact/impact-assessment.js";
import { ensureImpactAssessment, findImpactAssessment } from "../impact/pr-impact-assessment-repository.js";
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
  // Once raw analysis is durable, a later report or delivery-scheduling error
  // must retry the job without rewriting the trustworthy analysis as failed.
  let analysisPersisted = false;
  try {
    payload = pullRequestPayloadSchema.parse(job.jobPayload);
    const parsed = payload;
    const existing = await findCompletedPrAnalysis(parsed);
    if (existing) {
      analysisPersisted = true;
      // A worker can crash after persisting raw graph facts but before storing
      // the policy. Repair that deterministic gap before reusing the report.
      if (!await findImpactAssessment(await getPrAnalysisId(parsed))) {
        const artifacts = await runWithDeadline(timeoutForJob(job.jobType), async () => buildPullRequestImpactArtifacts(parsed, new GitHubRepositoryReader()));
        await ensureImpactAssessment(await getPrAnalysisId(parsed), assessImpact(existing, artifacts.baseGraph && artifacts.headGraph ? { baseGraph: artifacts.baseGraph, headGraph: artifacts.headGraph } : null));
      }
      const report = await runWithDeadline(timeoutForJob(job.jobType), async () => ensurePrReport(existing, undefined, new GitHubRepositoryReader()));
      await schedulePullRequestCommentDelivery({
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
    // A running status is helpful but non-essential. A temporary failure here
    // must not prevent deterministic analysis from progressing to its ready
    // report, which is scheduled durably below.
    await schedulePullRequestCommentDelivery({
      deliveryId: job.deliveryId,
      repoId: payload.repoId,
      pullRequestNumber: payload.pullRequestNumber,
      analysisId,
      headSha: payload.headSha,
      deliveryState: "running",
    }).catch(() => undefined);
    const artifacts = await runWithDeadline(timeoutForJob(job.jobType), async () => buildPullRequestImpactArtifacts(parsed, new GitHubRepositoryReader()));
    const result = artifacts.analysis;
    await persistPrAnalysis(result);
    analysisPersisted = true;
    await ensureImpactAssessment(analysisId, assessImpact(result, artifacts.baseGraph && artifacts.headGraph ? { baseGraph: artifacts.baseGraph, headGraph: artifacts.headGraph } : null));
    const report = await runWithDeadline(timeoutForJob(job.jobType), async () => ensurePrReport(result, undefined, new GitHubRepositoryReader()));
    // A ready report is not complete until its sticky-comment delivery has
    // been durably queued. Let queue errors retry this job rather than silently
    // leaving a running comment behind.
    await schedulePullRequestCommentDelivery({
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
    if (payload && !analysisPersisted) {
      await failPrAnalysis(payload, message);
      await schedulePullRequestCommentDelivery({
        deliveryId: job.deliveryId,
        repoId: payload.repoId,
        pullRequestNumber: payload.pullRequestNumber,
        analysisId: await getPrAnalysisId(payload),
        headSha: payload.headSha,
        deliveryState: "failed",
      }).catch(() => undefined);
    }
    await retryOrFailJob(job, error);
    log("error", "pull request analysis failed", { jobId: job.id, error: message });
  }
  return true;
}

async function schedulePullRequestCommentDelivery(input: {
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
      deliveryState: input.deliveryState,
    });
    await enqueuePullRequestDelivery({ ...input, prAnalysisId: input.analysisId });
    log("info", "pull request comment delivery scheduled", {
      repoId: input.repoId,
      pullRequestNumber: input.pullRequestNumber,
      headSha: input.headSha,
      deliveryState: input.deliveryState,
    });
  } catch (error) {
    log("error", "failed to enqueue pull request comment delivery", {
      repoId: input.repoId,
      pullRequestNumber: input.pullRequestNumber,
      headSha: input.headSha,
      deliveryState: input.deliveryState,
      error: error instanceof Error ? error.message : "unknown delivery enqueue error",
    });
    throw error;
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

import "dotenv/config";
import { randomUUID } from "node:crypto";

import { enqueuePullRequestDelivery } from "../src/delivery/pr-comment-delivery-queue.js";
import { requestPrCommentDelivery } from "../src/delivery/pr-comment-delivery-repository.js";
import { GitHubRepositoryReader } from "../src/graph/github-repository-reader.js";
import { findCompletedPrAnalysis, getPrAnalysisId } from "../src/impact/pr-analysis-repository.js";
import { ensurePrReport } from "../src/report/report-service.js";
import { positionalArgs, positiveIntegerArg } from "./cli-args.js";

async function main(): Promise<void> {
  const [repoIdValue, prNumberValue, headSha] = positionalArgs();
  if (!repoIdValue || !prNumberValue || !headSha) throw new Error("usage: pnpm pr-report:rebuild -- <repoId> <prNumber> <headSha>");
  const repoId = positiveIntegerArg(repoIdValue, "repoId");
  const pullRequestNumber = positiveIntegerArg(prNumberValue, "pullRequestNumber");
  const analysis = await findCompletedPrAnalysis({ repoId, pullRequestNumber, headSha });
  if (!analysis) throw new Error("no completed PR analysis exists for this repository, PR, and head SHA");
  const report = await ensurePrReport(analysis, undefined, new GitHubRepositoryReader(), { force: true });
  const analysisId = await getPrAnalysisId(analysis);
  // A manual rebuild intentionally creates a fresh delivery request, even for
  // the same SHA, so the sticky comment reflects the regenerated report.
  const deliveryId = `manual:pr-report-rebuild:${analysis.repoId}:${analysis.pullRequestNumber}:${analysis.headSha}:${randomUUID()}`;
  await requestPrCommentDelivery({
    repoId: analysis.repoId,
    pullRequestNumber: analysis.pullRequestNumber,
    analysisId,
    headSha: analysis.headSha,
  });
  await enqueuePullRequestDelivery({
    deliveryId,
    repoId: analysis.repoId,
    pullRequestNumber: analysis.pullRequestNumber,
    prAnalysisId: analysisId,
    headSha: analysis.headSha,
    deliveryState: "ready",
  });
  console.log({ ...report, deliveryEnqueued: true });
}

main().catch((error) => { console.error(error); process.exit(1); });

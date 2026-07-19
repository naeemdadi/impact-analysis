import "dotenv/config";

import { GitHubRepositoryReader } from "../src/graph/github-repository-reader.js";
import { findCompletedPrAnalysis } from "../src/impact/pr-analysis-repository.js";
import { ensurePrReport } from "../src/report/report-service.js";

async function main(): Promise<void> {
  const [repoIdValue, prNumberValue, headSha] = process.argv.slice(2);
  if (!repoIdValue || !prNumberValue || !headSha) throw new Error("usage: pnpm pr-report:rebuild -- <repoId> <prNumber> <headSha>");
  const analysis = await findCompletedPrAnalysis({ repoId: Number(repoIdValue), pullRequestNumber: Number(prNumberValue), headSha });
  if (!analysis) throw new Error("no completed PR analysis exists for this repository, PR, and head SHA");
  console.log(await ensurePrReport(analysis, undefined, new GitHubRepositoryReader(), { force: true }));
}

main().catch((error) => { console.error(error); process.exit(1); });

import "dotenv/config";

import { indexRepositoryFeatures } from "../src/feature/feature-service.js";
import { GitHubRepositoryReader } from "../src/graph/github-repository-reader.js";
import { getRepoConfig } from "../src/storage/repo-config-repo.js";

async function main(): Promise<void> {
  const repoId = Number(process.argv[2]);
  if (!Number.isSafeInteger(repoId)) throw new Error("usage: pnpm feature:index -- <repoId>");
  const config = await getRepoConfig(repoId);
  if (!config?.owner || !config.name) throw new Error("repository owner/name is unavailable; wait for the installation sync first");
  const reader = new GitHubRepositoryReader();
  const sha = await reader.resolveBranchSha({ installationId: config.installationId, owner: config.owner, name: config.name, branch: config.trackedBranch });
  console.log(await indexRepositoryFeatures({ repoId, branch: config.trackedBranch, sha, mode: "full" }, reader));
}

main().catch((error) => { console.error(error); process.exit(1); });

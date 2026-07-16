import "dotenv/config";

import { upsertRepoConfig } from "../src/storage/repo-config-repo.js";

async function main(): Promise<void> {
  const [repoIdValue, installationIdValue, trackedBranch] = process.argv.slice(2);

  if (!repoIdValue || !installationIdValue || !trackedBranch) {
    throw new Error("usage: npm run set-tracked-branch -- <repoId> <installationId> <trackedBranch>");
  }

  await upsertRepoConfig({
    repoId: Number(repoIdValue),
    installationId: Number(installationIdValue),
    owner: null,
    name: null,
    trackedBranch,
    isActive: true,
    accessState: "active",
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import "dotenv/config";

import { upsertRepoConfig } from "../src/storage/repo-config-repo.js";
import { positionalArgs, positiveIntegerArg } from "./cli-args.js";

async function main(): Promise<void> {
  const [repoIdValue, installationIdValue, trackedBranch] = positionalArgs();

  if (!repoIdValue || !installationIdValue || !trackedBranch) {
    throw new Error("usage: npm run set-tracked-branch -- <repoId> <installationId> <trackedBranch>");
  }

  await upsertRepoConfig({
    repoId: positiveIntegerArg(repoIdValue, "repoId"),
    installationId: positiveIntegerArg(installationIdValue, "installationId"),
    owner: null,
    name: null,
    trackedBranch,
    isActive: true,
    accessState: "active",
    aiAssistanceEnabled: true,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

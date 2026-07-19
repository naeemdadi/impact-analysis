import "dotenv/config";

import { setSemanticAiEnabled } from "../src/storage/repo-config-repo.js";

async function main(): Promise<void> {
  const [repoIdValue, enabledValue] = process.argv.slice(2);
  if (!repoIdValue || !["true", "false"].includes(enabledValue)) throw new Error("usage: pnpm set-semantic-ai -- <repoId> <true|false>");
  await setSemanticAiEnabled(Number(repoIdValue), enabledValue === "true");
  console.log(`semantic AI ${enabledValue === "true" ? "enabled" : "disabled"} for repository ${repoIdValue}`);
}

main().catch((error) => { console.error(error); process.exit(1); });

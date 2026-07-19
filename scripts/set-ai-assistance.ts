import "dotenv/config";

import { setAiAssistanceEnabled } from "../src/storage/repo-config-repo.js";
import { positionalArgs, positiveIntegerArg } from "./cli-args.js";

async function main(): Promise<void> {
  const [repoIdValue, enabledValue] = positionalArgs();
  if (!repoIdValue || !["true", "false"].includes(enabledValue)) throw new Error("usage: pnpm set-ai-assistance -- <repoId> <true|false>");
  const repoId = positiveIntegerArg(repoIdValue, "repoId");
  await setAiAssistanceEnabled(repoId, enabledValue === "true");
  console.log(`AI-assisted PR guidance ${enabledValue === "true" ? "enabled" : "disabled"} for repository ${repoId}`);
}

main().catch((error) => { console.error(error); process.exit(1); });

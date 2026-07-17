import "dotenv/config";

import { runInstallationSyncWorker } from "./installation-sync-worker.js";
import { runBranchPushWorker } from "./branch-push-worker.js";
import { runPullRequestAnalysisWorker } from "./pull-request-analysis-worker.js";

Promise.all([runInstallationSyncWorker(), runBranchPushWorker(), runPullRequestAnalysisWorker()]).catch((error) => {
  console.error(error);
  process.exit(1);
});

import "dotenv/config";

import { runInstallationSyncWorker } from "./installation-sync-worker.js";
import { runBranchPushWorker } from "./branch-push-worker.js";
import { runPullRequestAnalysisWorker } from "./pull-request-analysis-worker.js";
import { runFeatureIndexWorker } from "./feature-index-worker.js";
import { runPullRequestDeliveryWorker } from "./pull-request-delivery-worker.js";

Promise.all([runInstallationSyncWorker(), runBranchPushWorker(), runPullRequestAnalysisWorker(), runPullRequestDeliveryWorker(), runFeatureIndexWorker()]).catch((error) => {
  console.error(error);
  process.exit(1);
});

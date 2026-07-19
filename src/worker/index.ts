import "dotenv/config";

import { runInstallationSyncWorker } from "./installation-sync-worker.js";
import { runBranchPushWorker } from "./branch-push-worker.js";
import { runPullRequestAnalysisWorker } from "./pull-request-analysis-worker.js";
import { runFeatureIndexWorker } from "./feature-index-worker.js";
import { runPullRequestDeliveryWorker } from "./pull-request-delivery-worker.js";
import { runBranchReconcileWorker } from "./branch-reconcile-worker.js";
import { runTrackedBranchReconciler } from "./tracked-branch-reconciler.js";

Promise.all([runInstallationSyncWorker(), runBranchPushWorker(), runBranchReconcileWorker(), runPullRequestAnalysisWorker(), runPullRequestDeliveryWorker(), runFeatureIndexWorker(), runTrackedBranchReconciler()]).catch((error) => {
  console.error(error);
  process.exit(1);
});

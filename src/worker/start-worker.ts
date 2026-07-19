import { log } from "../server/logger.js";
import { runInstallationSyncWorker } from "./installation-sync-worker.js";
import { runBranchPushWorker } from "./branch-push-worker.js";
import { runPullRequestAnalysisWorker } from "./pull-request-analysis-worker.js";
import { runPullRequestDeliveryWorker } from "./pull-request-delivery-worker.js";
import { runBranchReconcileWorker } from "./branch-reconcile-worker.js";
import { runTrackedBranchReconciler } from "./tracked-branch-reconciler.js";

let workerPromise: Promise<void> | null = null;

/**
 * Starts every durable-job consumer and the tracked-branch reconciler once per
 * Node process. It intentionally never resolves while the process is healthy.
 */
export function startWorker(): Promise<void> {
  if (workerPromise) return workerPromise;

  log("info", "worker starting");
  workerPromise = Promise.all([
    runInstallationSyncWorker(),
    runBranchPushWorker(),
    runBranchReconcileWorker(),
    runPullRequestAnalysisWorker(),
    runPullRequestDeliveryWorker(),
    runTrackedBranchReconciler(),
  ]).then(() => undefined);

  return workerPromise;
}

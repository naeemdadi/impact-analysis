import "dotenv/config";

import { runInstallationSyncWorker } from "./installation-sync-worker.js";
import { runBranchPushWorker } from "./branch-push-worker.js";

Promise.all([runInstallationSyncWorker(), runBranchPushWorker()]).catch((error) => {
  console.error(error);
  process.exit(1);
});

import "dotenv/config";

import { runInstallationSyncWorker } from "./installation-sync-worker.js";

runInstallationSyncWorker().catch((error) => {
  console.error(error);
  process.exit(1);
});

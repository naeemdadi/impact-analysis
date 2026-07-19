import "dotenv/config";

import { startWorker } from "./start-worker.js";

void startWorker().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

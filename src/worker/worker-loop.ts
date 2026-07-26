import { log } from "../server/logger.js";

// Keeps a claim/process loop alive across unexpected throws (e.g. a DB blip
// during claim) so one failure cannot crash the process and its web server.
export async function runWorkerLoop(name: string, tick: () => Promise<boolean>): Promise<void> {
  while (true) {
    try {
      if (!(await tick())) await wait(1_000);
    } catch (error) {
      log("error", "worker loop error", { worker: name, error: error instanceof Error ? (error.stack ?? error.message) : "unknown error" });
      await wait(1_000);
    }
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

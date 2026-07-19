import "dotenv/config";
import express from "express";

import { handleGithubWebhook } from "../github/webhook-handler.js";
import { startWorker } from "../worker/start-worker.js";
import { log } from "./logger.js";

const app = express();
const port = Number(process.env.PORT ?? "3000");

app.use(
  express.json({
    verify: (request, _response, buffer) => {
      (request as { rawBody?: string }).rawBody = buffer.toString("utf8");
    },
  }),
);

app.get("/health", (_request, response) => {
  response.status(200).json({ status: "ok" });
});

app.post("/webhooks/github", async (request, response) => {
  await handleGithubWebhook(request, response);
});

const server = app.listen(port, () => {
  log("info", "server started", {
    port,
  });

  void startWorker().catch((error: unknown) => {
    log("error", "embedded worker stopped unexpectedly", {
      error: error instanceof Error ? error.message : "unknown worker error",
    });
    process.exit(1);
  });
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => shutdown(signal));
}

function shutdown(signal: "SIGINT" | "SIGTERM"): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "server shutdown requested", { signal });

  const forceExit = setTimeout(() => {
    log("warn", "server shutdown timed out; forcing exit", { signal });
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(() => {
    log("info", "server stopped", { signal });
    process.exit(0);
  });
}

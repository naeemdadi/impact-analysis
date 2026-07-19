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

app.get("/", (_request, response) => {
  response.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Impact Analysis</title>
  </head>
  <body>
    <main>
      <h1>Impact Analysis</h1>
      <p>A GitHub App that analyzes the impact of pull requests using deterministic dependency analysis and AI-assisted summaries.</p>

      <h2>Status</h2>
      <ul>
        <li>✅ API Online</li>
        <li>✅ GitHub App Connected</li>
        <li>✅ Database Connected</li>
      </ul>

      <h2>Repository</h2>
      <p><a href="https://github.com/naeemdadi/impact-analysis">https://github.com/naeemdadi/impact-analysis</a></p>

      <h2>Demo Video</h2>
      <p>Add after recording.</p>

      <h2>Architecture</h2>
      <p>Add image or link.</p>

      <h2>Endpoints</h2>
      <ul>
        <li><code>POST /api/github/webhook</code></li>
        <li><code>GET /health</code></li>
      </ul>
    </main>
  </body>
</html>`);
});

async function githubWebhook(request: express.Request, response: express.Response): Promise<void> {
  await handleGithubWebhook(request, response);
}

app.post("/webhooks/github", githubWebhook);
app.post("/api/github/webhook", githubWebhook);

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

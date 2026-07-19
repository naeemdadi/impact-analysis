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
app.use("/images", express.static("images"));

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
    <style>
      :root { color: #e9edf5; background: #0a1020; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; background: radial-gradient(circle at top, #17264d 0, #0a1020 45rem); }
      main { width: min(1120px, calc(100% - 2rem)); margin: 0 auto; padding: 4rem 0 5rem; }
      h1 { font-size: clamp(2.25rem, 5vw, 4rem); letter-spacing: -0.055em; margin: 0; }
      h2 { font-size: 1.2rem; margin: 0; }
      p { color: #b8c2d9; line-height: 1.65; }
      a { color: #9dc0ff; }
      .eyebrow { color: #8aabff; font-size: .78rem; font-weight: 700; letter-spacing: .13em; text-transform: uppercase; }
      .intro { max-width: 44rem; font-size: 1.15rem; }
      .status { display: flex; flex-wrap: wrap; gap: .65rem; margin: 1.75rem 0 3.5rem; padding: 0; list-style: none; }
      .status li { padding: .55rem .8rem; border: 1px solid #294471; border-radius: 999px; background: rgba(20, 38, 76, .7); font-size: .93rem; }
      section { margin-top: 3.5rem; }
      .examples { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.25rem; margin-top: 1.25rem; }
      figure { margin: 0; overflow: hidden; border: 1px solid #30456d; border-radius: 1rem; background: #101a31; box-shadow: 0 18px 45px rgba(0, 0, 0, .25); }
      figure a { display: block; background: #fff; }
      img { display: block; width: 100%; height: auto; transition: transform .25s ease; }
      figure:hover img { transform: scale(1.015); }
      figcaption { padding: 1rem 1.1rem 1.1rem; color: #c8d4ec; font-weight: 650; }
      .details { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.25rem; }
      .panel { padding: 1.25rem; border: 1px solid #263b62; border-radius: .85rem; background: rgba(16, 26, 49, .72); }
      .panel p { margin-bottom: 0; }
      code { color: #dce8ff; }
      @media (max-width: 700px) { main { padding-top: 2.75rem; } .examples, .details { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">GitHub App · Pull request intelligence</p>
      <h1>Impact Analysis</h1>
      <p class="intro">A GitHub App that analyzes the impact of pull requests using deterministic dependency analysis and AI-assisted summaries.</p>

      <ul class="status" aria-label="Service status">
        <li>✅ API Online</li>
        <li>✅ GitHub App Connected</li>
        <li>✅ Database Connected</li>
      </ul>

      <section aria-labelledby="examples-heading">
        <h2 id="examples-heading">Example impact reports</h2>
        <p>Reports posted by the GitHub App show what changed, what to verify, and the dependency evidence behind each finding.</p>
        <div class="examples">
          <figure>
            <a href="/images/PR-1.png" target="_blank" rel="noopener noreferrer"><img src="/images/PR-1.png" alt="Impact report for staged Reddit review submissions and zero-review seller-profile actions" /></a>
            <figcaption>PR-1 — Seller review requests and management flows</figcaption>
          </figure>
          <figure>
            <a href="/images/PR-2.png" target="_blank" rel="noopener noreferrer"><img src="/images/PR-2.png" alt="Impact report for seller review-request channels, seller management, Reddit workspace, and empty-review owner actions" /></a>
            <figcaption>PR-2 — Reddit review submission and seller-profile actions</figcaption>
          </figure>
        </div>
      </section>

      <section class="details" aria-label="Project links and endpoints">
        <div class="panel">
          <h2>Repository</h2>
          <p><a href="https://github.com/naeemdadi/impact-analysis">github.com/naeemdadi/impact-analysis</a></p>
        </div>
        <div class="panel">
          <h2>Endpoints</h2>
          <p><code>POST /api/github/webhook</code><br /><code>GET /health</code></p>
        </div>
      </section>
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

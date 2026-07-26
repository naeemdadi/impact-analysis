import express from "express";
import type { NextFunction, Request, Response } from "express";

import { handleGithubWebhook } from "../github/webhook-handler.js";
import { renderLandingPage } from "./landing-page.js";
import { securityHeaders } from "./security-headers.js";

export function createApp(): express.Express {
  const app = express();

  app.use(securityHeaders);
  // 2mb clears real GitHub payloads while bounding unauthenticated buffering.
  app.use(
    express.json({
      limit: "2mb",
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
    response.type("html").send(renderLandingPage());
  });

  app.post("/webhooks/github", handleGithubWebhook);
  app.post("/api/github/webhook", handleGithubWebhook);

  app.use(bodyParserErrorHandler);

  return app;
}

// Client body-parser failures return clean JSON instead of Express's HTML page.
function bodyParserErrorHandler(error: unknown, _request: Request, response: Response, next: NextFunction): void {
  const status = bodyParserStatus(error);
  if (status === null || status >= 500 || response.headersSent) {
    next(error);
    return;
  }
  response.status(status).json({ error: status === 413 ? "request body too large" : "invalid request body" });
}

function bodyParserStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { type?: unknown; status?: unknown };
  return typeof candidate.type === "string" && typeof candidate.status === "number" ? candidate.status : null;
}

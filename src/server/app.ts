import express from "express";

import { handleGithubWebhook } from "../github/webhook-handler.js";
import { renderLandingPage } from "./landing-page.js";
import { securityHeaders } from "./security-headers.js";

export function createApp(): express.Express {
  const app = express();

  app.use(securityHeaders);
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
    response.type("html").send(renderLandingPage());
  });

  app.post("/webhooks/github", handleGithubWebhook);
  app.post("/api/github/webhook", handleGithubWebhook);

  return app;
}

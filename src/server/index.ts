import "dotenv/config";
import express from "express";

import { handleGithubWebhook } from "../github/webhook-handler.js";
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

app.listen(port, () => {
  log("info", "server started", {
    port,
  });
});

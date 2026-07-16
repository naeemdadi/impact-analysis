import { Webhooks } from "@octokit/webhooks";
import type { Request, Response } from "express";

import { handleInstallationEvent } from "./handlers/installation.js";
import { handleInstallationRepositoriesEvent } from "./handlers/installation-repositories.js";
import { handlePushEvent } from "./handlers/push.js";
import { handlePullRequestEvent } from "./handlers/pull-request.js";
import { log } from "../server/logger.js";

export interface WebhookRequest extends Request {
  rawBody?: string;
}

const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

if (!webhookSecret) {
  throw new Error("GITHUB_WEBHOOK_SECRET is required");
}

const webhooks = new Webhooks({
  secret: webhookSecret,
});

function readGithubHeader(request: Request, name: string): string | null {
  const headerValue = request.header(name);
  return typeof headerValue === "string" ? headerValue : null;
}

export async function handleGithubWebhook(request: WebhookRequest, response: Response): Promise<void> {
  const deliveryId = readGithubHeader(request, "x-github-delivery");
  const eventName = readGithubHeader(request, "x-github-event");
  const signature = readGithubHeader(request, "x-hub-signature-256");
  const rawBody = request.rawBody;

  if (!deliveryId || !eventName || !signature || !rawBody) {
    response.status(400).json({ error: "missing required webhook headers or raw body" });
    return;
  }

  const validSignature = await webhooks.verify(rawBody, signature);
  if (!validSignature) {
    log("warn", "webhook signature verification failed", {
      deliveryId,
      eventName,
    });
    response.status(401).json({ error: "invalid webhook signature" });
    return;
  }

  try {
    const payload = JSON.parse(rawBody) as unknown;
    switch (eventName) {
      case "installation":
        await handleInstallationEvent(payload, { deliveryId, rawBody });
        break;
      case "installation_repositories":
        await handleInstallationRepositoriesEvent(payload, { deliveryId, rawBody });
        break;
      case "push":
        await handlePushEvent(payload, { deliveryId, rawBody });
        break;
      case "pull_request":
        await handlePullRequestEvent(payload, { deliveryId, rawBody });
        break;
      default:
        log("info", "ignored unsupported github event", { deliveryId, eventName });
        break;
    }

    response.status(202).json({ accepted: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    log("error", "webhook processing failed", {
      deliveryId,
      eventName,
      error: message,
    });
    response.status(500).json({ error: "webhook processing failed" });
  }
}

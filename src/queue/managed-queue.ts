import { log } from "../server/logger.js";

interface QueueMessage {
  jobType: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

const queueKind = process.env.MANAGED_QUEUE_KIND ?? "inline";
const queueTopicPrefix = process.env.QUEUE_TOPIC_PREFIX ?? "impact-analysis";

export async function publishManagedQueue(message: QueueMessage): Promise<void> {
  if (queueKind === "inline") {
    log("info", "queue publish simulated in inline mode", {
      topic: `${queueTopicPrefix}.${message.jobType}`,
      idempotencyKey: message.idempotencyKey,
    });
    return;
  }

  // Managed provider integration lands here in deployment-specific wiring.
  log("info", "queue publish placeholder for managed provider", {
    queueKind,
    topic: `${queueTopicPrefix}.${message.jobType}`,
    idempotencyKey: message.idempotencyKey,
  });
}

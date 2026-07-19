import type { EnqueueRequest, EnqueueResult } from "../types/events.js";
import { db } from "../storage/db.js";
import { eventIngestTable, jobQueueEnqueuedTable } from "../storage/schema.js";
import { log } from "../server/logger.js";

export async function enqueueJobWithIdempotency(request: EnqueueRequest): Promise<EnqueueResult> {
  const result = await db.transaction(async (transaction) => {
    await transaction
      .insert(eventIngestTable)
      .values({
        deliveryId: request.deliveryId,
        eventName: request.eventName,
        eventAction: request.eventAction ?? null,
        repoId: request.repoId ?? null,
        payloadSha256: request.payloadSha256,
      })
      .onConflictDoNothing({
        target: eventIngestTable.deliveryId,
      });

    const insertJob = await transaction
      .insert(jobQueueEnqueuedTable)
      .values({
        idempotencyKey: request.idempotencyKey,
        deliveryId: request.deliveryId,
        jobType: request.jobType,
        jobPayload: request.jobPayload,
      })
      .onConflictDoNothing({
        target: jobQueueEnqueuedTable.idempotencyKey,
      })
      .returning({
        idempotencyKey: jobQueueEnqueuedTable.idempotencyKey,
      });

    return {
      inserted: insertJob.length > 0,
      idempotencyKey: request.idempotencyKey,
    };
  });

  log("info", result.inserted ? "queue job enqueued" : "queue job deduplicated", {
    jobType: request.jobType,
    deliveryId: request.deliveryId,
    repoId: request.repoId ?? null,
    idempotencyKey: result.idempotencyKey,
  });

  return result;
}

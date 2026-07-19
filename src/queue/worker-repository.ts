import { and, asc, eq, lte, sql } from "drizzle-orm";

import { db } from "../storage/db.js";
import { jobQueueEnqueuedTable } from "../storage/schema.js";
import { log } from "../server/logger.js";

export interface ClaimedJob {
  id: number;
  deliveryId: string;
  jobType: string;
  jobPayload: Record<string, unknown>;
  attempts: number;
}

export async function claimNextJob(jobType: string): Promise<ClaimedJob | null> {
  const claimed = await db.transaction(async (transaction) => {
    const jobs = await transaction
      .select({ id: jobQueueEnqueuedTable.id })
      .from(jobQueueEnqueuedTable)
      .where(
        and(
          eq(jobQueueEnqueuedTable.jobType, jobType),
          eq(jobQueueEnqueuedTable.status, "pending"),
          lte(jobQueueEnqueuedTable.availableAt, new Date()),
        ),
      )
      .orderBy(asc(jobQueueEnqueuedTable.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (jobs.length === 0) return null;

    const rows = await transaction
      .update(jobQueueEnqueuedTable)
      .set({
        status: "running",
        attempts: sql`${jobQueueEnqueuedTable.attempts} + 1`,
        lockedAt: new Date(),
        lastError: null,
      })
      .where(eq(jobQueueEnqueuedTable.id, jobs[0].id))
      .returning({
        id: jobQueueEnqueuedTable.id,
        deliveryId: jobQueueEnqueuedTable.deliveryId,
        jobType: jobQueueEnqueuedTable.jobType,
        jobPayload: jobQueueEnqueuedTable.jobPayload,
        attempts: jobQueueEnqueuedTable.attempts,
      });
    return rows[0] ?? null;
  });
  if (claimed) log("info", "queue job claimed", { jobId: claimed.id, deliveryId: claimed.deliveryId, jobType: claimed.jobType, attempt: claimed.attempts });
  return claimed;
}

export async function completeJob(id: number): Promise<void> {
  await db
    .update(jobQueueEnqueuedTable)
    .set({ status: "completed", completedAt: new Date() })
    .where(and(eq(jobQueueEnqueuedTable.id, id), eq(jobQueueEnqueuedTable.status, "running")));
  log("info", "queue job completed", { jobId: id });
}

export async function failJob(id: number, error: string): Promise<void> {
  await db
    .update(jobQueueEnqueuedTable)
    .set({ status: "failed", lastError: error, completedAt: new Date() })
    .where(and(eq(jobQueueEnqueuedTable.id, id), eq(jobQueueEnqueuedTable.status, "running")));
  log("error", "queue job failed", { jobId: id, error });
}

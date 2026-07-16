import { and, asc, eq, lte, sql } from "drizzle-orm";

import { db } from "../storage/db.js";
import { jobQueueEnqueuedTable } from "../storage/schema.js";

export interface ClaimedJob {
  id: number;
  jobType: string;
  jobPayload: Record<string, unknown>;
  attempts: number;
}

export async function claimNextJob(jobType: string): Promise<ClaimedJob | null> {
  return db.transaction(async (transaction) => {
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
        jobType: jobQueueEnqueuedTable.jobType,
        jobPayload: jobQueueEnqueuedTable.jobPayload,
        attempts: jobQueueEnqueuedTable.attempts,
      });
    return rows[0] ?? null;
  });
}

export async function completeJob(id: number): Promise<void> {
  await db
    .update(jobQueueEnqueuedTable)
    .set({ status: "completed", completedAt: new Date() })
    .where(and(eq(jobQueueEnqueuedTable.id, id), eq(jobQueueEnqueuedTable.status, "running")));
}

export async function failJob(id: number, error: string): Promise<void> {
  await db
    .update(jobQueueEnqueuedTable)
    .set({ status: "failed", lastError: error, completedAt: new Date() })
    .where(and(eq(jobQueueEnqueuedTable.id, id), eq(jobQueueEnqueuedTable.status, "running")));
}

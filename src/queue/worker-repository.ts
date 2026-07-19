import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import crypto from "node:crypto";

import { db } from "../storage/db.js";
import { jobQueueEnqueuedTable } from "../storage/schema.js";
import { classifyJobError, maxJobAttempts, retryDelayMs, type JobErrorKind } from "./reliability.js";
import { log } from "../server/logger.js";

export interface ClaimedJob { id: number; deliveryId: string; jobType: string; jobPayload: Record<string, unknown>; attempts: number; leaseToken: string; }

const leaseMs = 10 * 60_000;

export async function claimNextJob(jobType: string): Promise<ClaimedJob | null> {
  const claimed = await db.transaction(async (transaction) => {
    const jobs = await transaction.select({ id: jobQueueEnqueuedTable.id }).from(jobQueueEnqueuedTable).where(and(eq(jobQueueEnqueuedTable.jobType, jobType), eq(jobQueueEnqueuedTable.status, "pending"), lte(jobQueueEnqueuedTable.availableAt, new Date()))).orderBy(asc(jobQueueEnqueuedTable.id)).limit(1).for("update", { skipLocked: true });
    if (!jobs[0]) return null;
    const now = new Date(); const token = crypto.randomUUID();
    const rows = await transaction.update(jobQueueEnqueuedTable).set({ status: "running", attempts: sql`${jobQueueEnqueuedTable.attempts} + 1`, firstStartedAt: sql`COALESCE(${jobQueueEnqueuedTable.firstStartedAt}, ${now})`, lockedAt: now, leaseToken: token, leaseExpiresAt: new Date(now.getTime() + leaseMs), lastError: null, lastErrorKind: null }).where(eq(jobQueueEnqueuedTable.id, jobs[0].id)).returning({ id: jobQueueEnqueuedTable.id, deliveryId: jobQueueEnqueuedTable.deliveryId, jobType: jobQueueEnqueuedTable.jobType, jobPayload: jobQueueEnqueuedTable.jobPayload, attempts: jobQueueEnqueuedTable.attempts, leaseToken: jobQueueEnqueuedTable.leaseToken });
    const row = rows[0]; return row?.leaseToken ? { ...row, leaseToken: row.leaseToken } : null;
  });
  if (claimed) log("info", "queue job claimed", { jobId: claimed.id, deliveryId: claimed.deliveryId, jobType: claimed.jobType, attempt: claimed.attempts });
  return claimed;
}

export async function completeJob(job: ClaimedJob): Promise<void> {
  const rows = await db.update(jobQueueEnqueuedTable).set({ status: "completed", completedAt: new Date(), terminalAt: new Date(), leaseToken: null, leaseExpiresAt: null }).where(and(eq(jobQueueEnqueuedTable.id, job.id), eq(jobQueueEnqueuedTable.status, "running"), eq(jobQueueEnqueuedTable.leaseToken, job.leaseToken))).returning({ id: jobQueueEnqueuedTable.id });
  if (!rows[0]) throw new Error(`job ${job.id} lease is no longer owned`);
  log("info", "queue job completed", { jobId: job.id });
}

export async function retryOrFailJob(job: ClaimedJob, error: unknown): Promise<{ retried: boolean; errorKind: JobErrorKind }> {
  const message = error instanceof Error ? error.message : "worker error";
  const errorKind = classifyJobError(error);
  const retry = errorKind === "transient" || errorKind === "timeout";
  if (retry && job.attempts < maxJobAttempts) {
    const availableAt = new Date(Date.now() + retryDelayMs(job.attempts));
    const rows = await db.update(jobQueueEnqueuedTable).set({ status: "pending", availableAt, lockedAt: null, leaseToken: null, leaseExpiresAt: null, lastError: message, lastErrorKind: errorKind }).where(and(eq(jobQueueEnqueuedTable.id, job.id), eq(jobQueueEnqueuedTable.status, "running"), eq(jobQueueEnqueuedTable.leaseToken, job.leaseToken))).returning({ id: jobQueueEnqueuedTable.id });
    if (rows[0]) { log("warn", "queue job scheduled for retry", { jobId: job.id, attempt: job.attempts, errorKind, availableAt: availableAt.toISOString() }); return { retried: true, errorKind }; }
  }
  const rows = await db.update(jobQueueEnqueuedTable).set({ status: "failed", lastError: message, lastErrorKind: errorKind, completedAt: new Date(), terminalAt: new Date(), leaseToken: null, leaseExpiresAt: null }).where(and(eq(jobQueueEnqueuedTable.id, job.id), eq(jobQueueEnqueuedTable.status, "running"), eq(jobQueueEnqueuedTable.leaseToken, job.leaseToken))).returning({ id: jobQueueEnqueuedTable.id });
  if (rows[0]) log("error", "queue job terminal failure", { jobId: job.id, attempt: job.attempts, errorKind, error: message });
  return { retried: false, errorKind };
}

export async function reapExpiredJobLeases(): Promise<{ retried: number; failed: number }> {
  const expired = await db.select({ id: jobQueueEnqueuedTable.id, attempts: jobQueueEnqueuedTable.attempts }).from(jobQueueEnqueuedTable).where(and(eq(jobQueueEnqueuedTable.status, "running"), lte(jobQueueEnqueuedTable.leaseExpiresAt, new Date())));
  let retried = 0; let failed = 0;
  for (const job of expired) {
    if (job.attempts < maxJobAttempts) {
      const rows = await db.update(jobQueueEnqueuedTable).set({ status: "pending", availableAt: new Date(Date.now() + retryDelayMs(job.attempts)), lockedAt: null, leaseToken: null, leaseExpiresAt: null, lastError: "worker lease expired", lastErrorKind: "worker_lost" }).where(and(eq(jobQueueEnqueuedTable.id, job.id), eq(jobQueueEnqueuedTable.status, "running"), lte(jobQueueEnqueuedTable.leaseExpiresAt, new Date()))).returning({ id: jobQueueEnqueuedTable.id });
      if (rows[0]) retried++;
    } else {
      const rows = await db.update(jobQueueEnqueuedTable).set({ status: "failed", completedAt: new Date(), terminalAt: new Date(), leaseToken: null, leaseExpiresAt: null, lastError: "worker lease expired", lastErrorKind: "worker_lost" }).where(and(eq(jobQueueEnqueuedTable.id, job.id), eq(jobQueueEnqueuedTable.status, "running"), lte(jobQueueEnqueuedTable.leaseExpiresAt, new Date()))).returning({ id: jobQueueEnqueuedTable.id });
      if (rows[0]) failed++;
    }
  }
  if (retried || failed) log("warn", "expired job leases reaped", { retried, failed });
  return { retried, failed };
}

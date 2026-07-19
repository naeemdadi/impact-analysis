import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";

import { db, pool } from "../storage/db.js";
import { prCommentDeliveryTable } from "../storage/schema.js";

export interface PrCommentDelivery {
  id: string;
  commentId: number | null;
  desiredAnalysisId: string | null;
  desiredHeadSha: string;
  desiredState: "running" | "ready" | "failed";
  lastDeliveredAnalysisId: string | null;
  lastDeliveredHeadSha: string | null;
  lastDeliveredState: "running" | "ready" | "failed" | null;
  status: string;
  lastError: string | null;
}

export interface UndeliveredPrCommentDelivery {
  repoId: number;
  pullRequestNumber: number;
  analysisId: string;
  headSha: string;
  deliveryState: "running" | "ready" | "failed";
}

function toDelivery(row: typeof prCommentDeliveryTable.$inferSelect): PrCommentDelivery {
  return {
    id: row.id,
    commentId: row.commentId,
    desiredAnalysisId: row.desiredAnalysisId,
    desiredHeadSha: row.desiredHeadSha,
    desiredState: deliveryState(row.desiredState),
    lastDeliveredAnalysisId: row.lastDeliveredAnalysisId,
    lastDeliveredHeadSha: row.lastDeliveredHeadSha,
    lastDeliveredState: row.lastDeliveredState ? deliveryState(row.lastDeliveredState) : null,
    status: row.status,
    lastError: row.lastError,
  };
}

function deliveryState(value: string): "running" | "ready" | "failed" {
  if (value === "running" || value === "ready" || value === "failed") return value;
  throw new Error(`invalid persisted pull request comment delivery state: ${value}`);
}

export async function requestPrCommentDelivery(input: {
  repoId: number;
  pullRequestNumber: number;
  analysisId: string;
  headSha: string;
  deliveryState: "running" | "ready" | "failed";
}): Promise<void> {
  // This is one atomic row update. It must never wait on the session lock used
  // for an external GitHub write; otherwise a ready report can be stranded
  // behind an older running-comment delivery.
  await db.insert(prCommentDeliveryTable).values({
    repoId: input.repoId,
    pullRequestNumber: input.pullRequestNumber,
    desiredAnalysisId: input.analysisId,
    desiredHeadSha: input.headSha,
    desiredState: input.deliveryState,
    status: "pending",
    lastError: null,
  }).onConflictDoUpdate({
    target: [prCommentDeliveryTable.repoId, prCommentDeliveryTable.pullRequestNumber],
    set: {
      desiredAnalysisId: input.analysisId,
      desiredHeadSha: input.headSha,
      desiredState: input.deliveryState,
      status: "pending",
      lastError: null,
      updatedAt: new Date(),
    },
  });
}

export async function getPrCommentDelivery(repoId: number, pullRequestNumber: number): Promise<PrCommentDelivery | null> {
  const rows = await db.select().from(prCommentDeliveryTable).where(and(
    eq(prCommentDeliveryTable.repoId, repoId),
    eq(prCommentDeliveryTable.pullRequestNumber, pullRequestNumber),
  )).limit(1);
  return rows[0] ? toDelivery(rows[0]) : null;
}

/**
 * Finds the mutable comment pointers whose visible GitHub state is not the
 * requested state. This is deliberately small: immutable analyses and reports
 * remain untouched; only their already-selected comment delivery is repaired.
 */
export async function findUndeliveredPrCommentDeliveries(): Promise<UndeliveredPrCommentDelivery[]> {
  const rows = await db.select({
    repoId: prCommentDeliveryTable.repoId,
    pullRequestNumber: prCommentDeliveryTable.pullRequestNumber,
    analysisId: prCommentDeliveryTable.desiredAnalysisId,
    headSha: prCommentDeliveryTable.desiredHeadSha,
    deliveryState: prCommentDeliveryTable.desiredState,
  }).from(prCommentDeliveryTable).where(and(
    isNotNull(prCommentDeliveryTable.desiredAnalysisId),
    or(
      ne(prCommentDeliveryTable.status, "delivered"),
      isNull(prCommentDeliveryTable.lastDeliveredState),
      ne(prCommentDeliveryTable.desiredState, prCommentDeliveryTable.lastDeliveredState),
    ),
  ));

  return rows.flatMap((row) => row.analysisId ? [{
    repoId: row.repoId,
    pullRequestNumber: row.pullRequestNumber,
    analysisId: row.analysisId,
    headSha: row.headSha,
    deliveryState: deliveryState(row.deliveryState),
  }] : []);
}

export async function markPrCommentDelivered(input: {
  repoId: number;
  pullRequestNumber: number;
  analysisId: string;
  headSha: string;
  deliveryState: "running" | "ready" | "failed";
  commentId: number;
}): Promise<void> {
  await db.update(prCommentDeliveryTable).set({
    commentId: input.commentId,
    lastDeliveredAnalysisId: input.analysisId,
    lastDeliveredHeadSha: input.headSha,
    lastDeliveredState: input.deliveryState,
    status: "delivered",
    lastError: null,
    updatedAt: new Date(),
  }).where(and(
    eq(prCommentDeliveryTable.repoId, input.repoId),
    eq(prCommentDeliveryTable.pullRequestNumber, input.pullRequestNumber),
    eq(prCommentDeliveryTable.desiredAnalysisId, input.analysisId),
    eq(prCommentDeliveryTable.desiredHeadSha, input.headSha),
    eq(prCommentDeliveryTable.desiredState, input.deliveryState),
  ));
}

export async function markPrCommentDeliveryFailed(input: {
  repoId: number;
  pullRequestNumber: number;
  analysisId: string;
  headSha: string;
  deliveryState: "running" | "ready" | "failed";
  error: string;
}): Promise<void> {
  await db.update(prCommentDeliveryTable).set({
    status: "failed",
    lastError: input.error,
    updatedAt: new Date(),
  }).where(and(
    eq(prCommentDeliveryTable.repoId, input.repoId),
    eq(prCommentDeliveryTable.pullRequestNumber, input.pullRequestNumber),
    eq(prCommentDeliveryTable.desiredAnalysisId, input.analysisId),
    eq(prCommentDeliveryTable.desiredHeadSha, input.headSha),
    eq(prCommentDeliveryTable.desiredState, input.deliveryState),
  ));
}

export class PrCommentDeliveryBusyError extends Error {
  override readonly name = "PrCommentDeliveryBusyError";
  readonly code = "PR_COMMENT_DELIVERY_BUSY";
}

// PostgreSQL advisory locks serialize a single PR's external GitHub writes.
// Use a non-blocking attempt: a queue worker must retry rather than consume a
// database statement timeout waiting for a prior delivery to finish.
export async function withPrCommentDeliveryLock<T>(repoId: number, pullRequestNumber: number, action: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const key = `${repoId}:${pullRequestNumber}`;
  let lockAcquired = false;
  try {
    const result = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [key]);
    lockAcquired = result.rows[0]?.acquired === true;
    if (!lockAcquired) throw new PrCommentDeliveryBusyError(`pull request comment delivery is already in progress for ${key}`);
    return await action();
  } finally {
    if (lockAcquired) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]).catch(() => undefined);
    client.release();
  }
}

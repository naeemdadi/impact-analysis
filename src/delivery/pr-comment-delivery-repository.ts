import { and, eq } from "drizzle-orm";

import { db, pool } from "../storage/db.js";
import { prCommentDeliveryTable } from "../storage/schema.js";

export interface PrCommentDelivery {
  id: string;
  commentId: number | null;
  desiredAnalysisId: string | null;
  desiredHeadSha: string;
  lastDeliveredAnalysisId: string | null;
  lastDeliveredHeadSha: string | null;
  status: string;
  lastError: string | null;
}

function toDelivery(row: typeof prCommentDeliveryTable.$inferSelect): PrCommentDelivery {
  return {
    id: row.id,
    commentId: row.commentId,
    desiredAnalysisId: row.desiredAnalysisId,
    desiredHeadSha: row.desiredHeadSha,
    lastDeliveredAnalysisId: row.lastDeliveredAnalysisId,
    lastDeliveredHeadSha: row.lastDeliveredHeadSha,
    status: row.status,
    lastError: row.lastError,
  };
}

export async function requestPrCommentDelivery(input: {
  repoId: number;
  pullRequestNumber: number;
  analysisId: string;
  headSha: string;
}): Promise<void> {
  await withPrCommentDeliveryLock(input.repoId, input.pullRequestNumber, async () => db.insert(prCommentDeliveryTable).values({
    repoId: input.repoId,
    pullRequestNumber: input.pullRequestNumber,
    desiredAnalysisId: input.analysisId,
    desiredHeadSha: input.headSha,
    status: "pending",
    lastError: null,
  }).onConflictDoUpdate({
    target: [prCommentDeliveryTable.repoId, prCommentDeliveryTable.pullRequestNumber],
    set: {
      desiredAnalysisId: input.analysisId,
      desiredHeadSha: input.headSha,
      status: "pending",
      lastError: null,
      updatedAt: new Date(),
    },
  }));
}

export async function getPrCommentDelivery(repoId: number, pullRequestNumber: number): Promise<PrCommentDelivery | null> {
  const rows = await db.select().from(prCommentDeliveryTable).where(and(
    eq(prCommentDeliveryTable.repoId, repoId),
    eq(prCommentDeliveryTable.pullRequestNumber, pullRequestNumber),
  )).limit(1);
  return rows[0] ? toDelivery(rows[0]) : null;
}

export async function markPrCommentDelivered(input: {
  repoId: number;
  pullRequestNumber: number;
  analysisId: string;
  headSha: string;
  commentId: number;
}): Promise<void> {
  await db.update(prCommentDeliveryTable).set({
    commentId: input.commentId,
    lastDeliveredAnalysisId: input.analysisId,
    lastDeliveredHeadSha: input.headSha,
    status: "delivered",
    lastError: null,
    updatedAt: new Date(),
  }).where(and(
    eq(prCommentDeliveryTable.repoId, input.repoId),
    eq(prCommentDeliveryTable.pullRequestNumber, input.pullRequestNumber),
    eq(prCommentDeliveryTable.desiredAnalysisId, input.analysisId),
    eq(prCommentDeliveryTable.desiredHeadSha, input.headSha),
  ));
}

export async function markPrCommentDeliveryFailed(input: {
  repoId: number;
  pullRequestNumber: number;
  analysisId: string;
  headSha: string;
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
  ));
}

// PostgreSQL advisory locks serialize a single PR's external GitHub writes.
export async function withPrCommentDeliveryLock<T>(repoId: number, pullRequestNumber: number, action: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const key = `${repoId}:${pullRequestNumber}`;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
    return await action();
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]).catch(() => undefined);
    client.release();
  }
}

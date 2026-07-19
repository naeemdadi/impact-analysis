import { and, eq } from "drizzle-orm";

import { db } from "../storage/db.js";
import { featureCardTable } from "../storage/schema.js";
import { featureCardSchema, type FeatureCard, type FeatureCardRecord, type FeatureContext } from "./feature-types.js";

export async function findReadyFeatureCard(input: { repoId: number; branch: string; entryPath: string; sourceFingerprint: string }): Promise<FeatureCardRecord | null> {
  const rows = await db.select().from(featureCardTable).where(and(
    eq(featureCardTable.repoId, input.repoId), eq(featureCardTable.branch, input.branch), eq(featureCardTable.entryPath, input.entryPath),
    eq(featureCardTable.sourceFingerprint, input.sourceFingerprint), eq(featureCardTable.status, "ready"),
  )).limit(1);
  const row = rows[0];
  if (!row?.cardJson) return null;
  return {
    entryPath: row.entryPath,
    entryKind: row.entryKind as FeatureCardRecord["entryKind"],
    sourceFingerprint: row.sourceFingerprint,
    sourceCommitSha: row.sourceCommitSha,
    status: "ready",
    card: featureCardSchema.parse(row.cardJson),
  };
}

export async function upsertFeatureCard(input: {
  repoId: number; branch: string; context: FeatureContext; status: "ready" | "unavailable"; card: FeatureCard | null;
  model?: string | null; providerResponseId?: string | null; failureReason?: string | null;
}): Promise<void> {
  const provenance = {
    entryPath: input.context.entryPath,
    commitSha: input.context.commitSha,
    context: input.context.items.map(({ id, path, blobSha, role }) => ({ id, path, blobSha, role })),
    reachablePaths: input.context.reachablePaths,
  };
  await db.insert(featureCardTable).values({
    repoId: input.repoId, branch: input.branch, entryPath: input.context.entryPath, entryKind: input.context.entryKind,
    sourceFingerprint: input.context.sourceFingerprint, sourceCommitSha: input.context.commitSha, status: input.status,
    cardJson: input.card ? json(input.card) : null, provenanceJson: json(provenance), model: input.model ?? null,
    providerResponseId: input.providerResponseId ?? null, failureReason: input.failureReason ?? null,
  }).onConflictDoUpdate({
    target: [featureCardTable.repoId, featureCardTable.branch, featureCardTable.entryPath],
    set: {
      entryKind: input.context.entryKind, sourceFingerprint: input.context.sourceFingerprint, sourceCommitSha: input.context.commitSha,
      status: input.status, cardJson: input.card ? json(input.card) : null, provenanceJson: json(provenance), model: input.model ?? null,
      providerResponseId: input.providerResponseId ?? null, failureReason: input.failureReason ?? null, updatedAt: new Date(),
    },
  });
}

export async function deleteMissingFeatureCards(repoId: number, branch: string, entryPaths: string[]): Promise<void> {
  const rows = await db.select({ entryPath: featureCardTable.entryPath }).from(featureCardTable)
    .where(and(eq(featureCardTable.repoId, repoId), eq(featureCardTable.branch, branch)));
  await Promise.all(rows.filter((row) => !entryPaths.includes(row.entryPath)).map((row) => db.delete(featureCardTable).where(and(
    eq(featureCardTable.repoId, repoId), eq(featureCardTable.branch, branch), eq(featureCardTable.entryPath, row.entryPath),
  ))));
}

/** Removes cards for routes deleted or renamed by an incremental push. */
export async function deleteFeatureCardsAtPaths(repoId: number, branch: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const uniquePaths = [...new Set(paths)];
  const rows = await db.select({ entryPath: featureCardTable.entryPath }).from(featureCardTable)
    .where(and(eq(featureCardTable.repoId, repoId), eq(featureCardTable.branch, branch)));
  await Promise.all(rows.filter((row) => uniquePaths.includes(row.entryPath)).map((row) => db.delete(featureCardTable).where(and(
    eq(featureCardTable.repoId, repoId), eq(featureCardTable.branch, branch), eq(featureCardTable.entryPath, row.entryPath),
  ))));
}

function json(value: object): Record<string, unknown> { return JSON.parse(JSON.stringify(value)) as Record<string, unknown>; }

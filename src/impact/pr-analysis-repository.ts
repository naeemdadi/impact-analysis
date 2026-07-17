import { and, eq } from "drizzle-orm";

import { db } from "../storage/db.js";
import { prAnalysisTable } from "../storage/schema.js";
import { deterministicPrAnalysisSchema, type DeterministicPrAnalysis, type PullRequestAnalysisRequest } from "./pr-impact-types.js";

export async function findCompletedPrAnalysis(input: Pick<PullRequestAnalysisRequest, "repoId" | "pullRequestNumber" | "headSha">): Promise<DeterministicPrAnalysis | null> {
  const rows = await db.select({ status: prAnalysisTable.status, resultJson: prAnalysisTable.resultJson }).from(prAnalysisTable).where(and(
    eq(prAnalysisTable.repoId, input.repoId),
    eq(prAnalysisTable.pullRequestNumber, input.pullRequestNumber),
    eq(prAnalysisTable.headSha, input.headSha),
  )).limit(1);
  const row = rows[0];
  if (!row || (row.status !== "ready" && row.status !== "insufficient_evidence") || !row.resultJson) return null;
  return deterministicPrAnalysisSchema.parse(row.resultJson);
}

export async function getPrAnalysisId(input: Pick<PullRequestAnalysisRequest, "repoId" | "pullRequestNumber" | "headSha">): Promise<string> {
  const rows = await db.select({ id: prAnalysisTable.id }).from(prAnalysisTable).where(and(
    eq(prAnalysisTable.repoId, input.repoId),
    eq(prAnalysisTable.pullRequestNumber, input.pullRequestNumber),
    eq(prAnalysisTable.headSha, input.headSha),
  )).limit(1);
  if (!rows[0]) throw new Error("PR analysis record was not found");
  return rows[0].id;
}

export async function createBuildingPrAnalysis(request: PullRequestAnalysisRequest): Promise<void> {
  await db.insert(prAnalysisTable).values({
    repoId: request.repoId,
    pullRequestNumber: request.pullRequestNumber,
    baseSha: request.baseSha,
    headSha: request.headSha,
    status: "building",
  }).onConflictDoUpdate({
    target: [prAnalysisTable.repoId, prAnalysisTable.pullRequestNumber, prAnalysisTable.headSha],
    set: { baseSha: request.baseSha, status: "building", impactLevel: null, resultJson: null, reason: null, completedAt: null },
  });
}

export async function persistPrAnalysis(result: DeterministicPrAnalysis): Promise<void> {
  const validated = deterministicPrAnalysisSchema.parse(result);
  await db.update(prAnalysisTable).set({
    status: validated.status,
    impactLevel: validated.impactLevel,
    resultJson: validated,
    reason: validated.insufficientReason,
    completedAt: new Date(),
  }).where(and(
    eq(prAnalysisTable.repoId, validated.repoId),
    eq(prAnalysisTable.pullRequestNumber, validated.pullRequestNumber),
    eq(prAnalysisTable.headSha, validated.headSha),
  ));
}

export async function failPrAnalysis(request: PullRequestAnalysisRequest, reason: string): Promise<void> {
  await db.update(prAnalysisTable).set({ status: "failed", reason, completedAt: new Date() }).where(and(
    eq(prAnalysisTable.repoId, request.repoId),
    eq(prAnalysisTable.pullRequestNumber, request.pullRequestNumber),
    eq(prAnalysisTable.headSha, request.headSha),
  ));
}

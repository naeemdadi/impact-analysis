import { and, eq } from "drizzle-orm";

import { db } from "../storage/db.js";
import { prReportTable } from "../storage/schema.js";
import type { PrSemanticInput, PrSemanticResult, ReportEvidence } from "./report-types.js";

export async function findReadyReport(analysisId: string): Promise<{ markdown: string; llmStatus: "not_requested" | "completed" | "fallback" } | null> {
  const rows = await db.select({ markdown: prReportTable.markdown, llmStatus: prReportTable.llmStatus }).from(prReportTable).where(and(eq(prReportTable.prAnalysisId, analysisId), eq(prReportTable.status, "ready"))).limit(1);
  return rows[0] ? { markdown: rows[0].markdown, llmStatus: rows[0].llmStatus as "not_requested" | "completed" | "fallback" } : null;
}

export async function createBuildingReport(analysisId: string, evidence: ReportEvidence, semanticInput: PrSemanticInput): Promise<void> {
  await db.insert(prReportTable).values({
    prAnalysisId: analysisId, status: "building", evidenceJson: toJson(evidence), semanticInputJson: toJson(semanticInput), semanticResultJson: null,
    markdown: "", llmStatus: "not_requested",
  }).onConflictDoUpdate({
    target: prReportTable.prAnalysisId,
    set: { status: "building", evidenceJson: toJson(evidence), semanticInputJson: toJson(semanticInput), semanticResultJson: null, markdown: "", model: null, providerResponseId: null, inputTokens: null, outputTokens: null, llmStatus: "not_requested", llmError: null, completedAt: null },
  });
}

export async function persistReadyReport(input: {
  analysisId: string; evidence: ReportEvidence; semanticInput: PrSemanticInput; semanticResult: PrSemanticResult | null; markdown: string;
  model: string | null; providerResponseId: string | null; inputTokens: number | null; outputTokens: number | null;
  llmStatus: "not_requested" | "completed" | "fallback"; llmError: string | null;
}): Promise<void> {
  await db.update(prReportTable).set({
    status: "ready", evidenceJson: toJson(input.evidence), semanticInputJson: toJson(input.semanticInput), semanticResultJson: input.semanticResult ? toJson(input.semanticResult) : null,
    markdown: input.markdown, model: input.model, providerResponseId: input.providerResponseId, inputTokens: input.inputTokens, outputTokens: input.outputTokens,
    llmStatus: input.llmStatus, llmError: input.llmError, completedAt: new Date(),
  }).where(eq(prReportTable.prAnalysisId, input.analysisId));
}

function toJson(value: object): Record<string, unknown> { return JSON.parse(JSON.stringify(value)) as Record<string, unknown>; }

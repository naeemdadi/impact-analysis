import { z } from "zod";

import type { DeterministicPrAnalysis, ProductImpactKind } from "../impact/pr-impact-types.js";

export type ReportConfidence = "high" | "medium" | "low" | "insufficient";
export type SummaryTemplate = "broad_shared_change" | "route_change" | "localized_change" | "no_graph_impact" | "insufficient_evidence";
export type VerificationAction = "render_page" | "exercise_api_route" | "exercise_component_state" | "exercise_consumers";

export interface ReportEvidence {
  version: 1;
  repoId: number;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  analysisStatus: DeterministicPrAnalysis["status"];
  impactLevel: DeterministicPrAnalysis["impactLevel"];
  confidence: ReportConfidence;
  insufficientReason: string | null;
  unresolvedImportCount: number;
  changedSymbols: Array<{ id: string; name: string; changeKind: string; filePath: string }>;
  affectedItems: Array<{
    id: string;
    path: string;
    kind: ProductImpactKind;
    impact: "direct" | "indirect";
    dependencyPath: string[];
  }>;
}

export interface ReportSelection {
  summaryTemplate: SummaryTemplate;
  verifications: Array<{ affectedItemId: string; action: VerificationAction }>;
}

export interface ReportSelectionCatalog {
  summaryTemplates: SummaryTemplate[];
  verificationTargets: Array<{ id: string; kind: ProductImpactKind; allowedActions: VerificationAction[] }>;
}

export interface ReportSelectionResult {
  selection: ReportSelection;
  providerResponseId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ReportSelector {
  select(evidence: ReportEvidence, catalog: ReportSelectionCatalog): Promise<ReportSelectionResult>;
}

export const reportSelectionSchema = z.object({
  summaryTemplate: z.enum(["broad_shared_change", "route_change", "localized_change", "no_graph_impact", "insufficient_evidence"]),
  verifications: z.array(z.object({
    affectedItemId: z.string(),
    action: z.enum(["render_page", "exercise_api_route", "exercise_component_state", "exercise_consumers"]),
  })).max(5),
});

import { z } from "zod";

import type { DeterministicPrAnalysis, ProductImpactKind } from "../impact/pr-impact-types.js";
import type { ImpactAssessment } from "../impact/impact-assessment.js";

export type SummaryTemplate = "broad_shared_change" | "route_change" | "localized_change" | "no_graph_impact" | "insufficient_evidence";

export interface ChangedHunk {
  id: string;
  path: string;
  beforeStartLine: number;
  afterStartLine: number;
  beforeExcerpt: string;
  afterExcerpt: string;
}

export interface FeatureVerificationTarget {
  id: string;
  path: string;
  kind: Extract<ProductImpactKind, "page" | "api_route">;
  impact: "direct" | "indirect";
  dependencyPath: string[];
  title: string;
  description: string;
  scenarios: Array<{ id: string; title: string; steps: string[]; contextIds: string[] }>;
}

export interface ReportEvidence {
  version: 3;
  repoId: number;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  analysisStatus: DeterministicPrAnalysis["status"];
  impactLevel: DeterministicPrAnalysis["impactLevel"];
  insufficientReason: string | null;
  unresolvedImportCount: number;
  changedSymbols: Array<{ id: string; name: string; changeKind: string; filePath: string }>;
  affectedItems: Array<{ id: string; path: string; kind: ProductImpactKind; impact: "direct" | "indirect"; dependencyPath: string[] }>;
  // Bounded, source-backed inputs for suggestions. They are not reachability evidence.
  featureTargets: FeatureVerificationTarget[];
  changedHunks: ChangedHunk[];
  impactAssessment: ImpactAssessment;
}

export interface ReportSelection {
  summaryTemplate: SummaryTemplate;
  verifications: Array<{ entrypointId: string; scenarioId: string; hunkIds: string[] }>;
}

export interface ReportSelectionCatalog {
  summaryTemplates: SummaryTemplate[];
  verificationTargets: Array<{ id: string; scenarioIds: string[]; allowedHunkIds: string[] }>;
}

export interface ReportSelectionResult {
  selection: ReportSelection;
  providerResponseId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ReportSelector { select(evidence: ReportEvidence, catalog: ReportSelectionCatalog): Promise<ReportSelectionResult>; }

export const reportSelectionSchema = z.object({
  summaryTemplate: z.enum(["broad_shared_change", "route_change", "localized_change", "no_graph_impact", "insufficient_evidence"]),
  verifications: z.array(z.object({ entrypointId: z.string(), scenarioId: z.string(), hunkIds: z.array(z.string()).max(4) })).max(5),
});

import { z } from "zod";

import type { DeterministicPrAnalysis, ProductImpactKind } from "../impact/pr-impact-types.js";
import type { ImpactAssessment, ImpactAssessmentItem } from "../impact/impact-assessment.js";

// PR semantic context includes at most twelve changed hunks. A model may
// truthfully cite every supplied hunk in one summary or verification check.
const maxChangedHunkReferences = 12;

export interface ChangedHunk {
  id: string;
  path: string;
  beforeStartLine: number;
  afterStartLine: number;
  beforeExcerpt: string;
  afterExcerpt: string;
}

export interface SourceContextItem {
  id: string;
  path: string;
  blobSha: string;
  startLine: number;
  endLine: number;
  excerpt: string;
}

export interface SemanticEntrypointTarget {
  id: string;
  path: string;
  kind: Extract<ProductImpactKind, "page" | "api_route">;
  tier: "primary" | "secondary";
  changedSeedPath: string;
  dependencyPath: string[];
  context: SourceContextItem[];
}

/** Exact, bounded source context that is permitted to leave the repository. */
export interface PrSemanticInput {
  version: 1;
  enabled: boolean;
  changedHunks: ChangedHunk[];
  targets: SemanticEntrypointTarget[];
}

export interface SemanticChangeSummary {
  hunkIds: string[];
  summary: string;
}

export interface SemanticVerification {
  entrypointId: string;
  checks: Array<{ text: string; hunkIds: string[]; contextIds: string[] }>;
}

export interface PrSemanticResult {
  changeSummaries: SemanticChangeSummary[];
  verifications: SemanticVerification[];
}

export interface SemanticAnalysisResult {
  result: PrSemanticResult;
  providerResponseId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** Safe, user-visible state for optional AI guidance. Never contains provider raw errors. */
export interface SemanticGuidanceState {
  status: "not_requested" | "completed" | "fallback";
  notice: string | null;
}

export interface PrSemanticAnalyzer {
  analyze(input: PrSemanticInput, evidence: Pick<ReportEvidence, "repoId" | "pullRequestNumber" | "headSha">): Promise<SemanticAnalysisResult>;
}

export interface ReportEvidence {
  version: 4;
  repoId: number;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  analysisStatus: DeterministicPrAnalysis["status"];
  insufficientReason: string | null;
  unresolvedImportCount: number;
  changedFiles: DeterministicPrAnalysis["changedFiles"];
  changedSymbols: Array<{ id: string; name: string; changeKind: string; filePath: string }>;
  affectedItems: Array<{ id: string; path: string; kind: ProductImpactKind; impact: "direct" | "indirect"; dependencyPath: string[] }>;
  impactAssessment: ImpactAssessment;
}

export const prSemanticResultSchema = z.object({
  changeSummaries: z.array(z.object({ hunkIds: z.array(z.string()).min(1).max(maxChangedHunkReferences), summary: z.string().min(1).max(400) })).max(12),
  verifications: z.array(z.object({
    entrypointId: z.string(),
    checks: z.array(z.object({ text: z.string().min(1).max(400), hunkIds: z.array(z.string()).min(1).max(maxChangedHunkReferences), contextIds: z.array(z.string()).min(1).max(6) })).max(3),
  })).max(5),
});

export function isPrioritized(item: ImpactAssessmentItem): item is ImpactAssessmentItem & { tier: "primary" | "secondary" } {
  return item.tier === "primary" || item.tier === "secondary";
}

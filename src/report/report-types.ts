import { z } from "zod";

import type { DeterministicPrAnalysis, ProductImpactKind } from "../impact/pr-impact-types.js";
import type { ImpactAssessment, ImpactAssessmentItem } from "../impact/impact-assessment.js";

const maxChangedHunkReferences = 12;

export type SourceRevision = "base" | "head";
export type SemanticAnchorKind = "changed_declaration" | "entrypoint" | "dependency_use" | "interaction" | "state" | "api_contract" | "test";

/** A separate, line-addressable change. It is never a whole-file substitute. */
export interface ChangedHunk {
  id: string;
  path: string;
  revision: SourceRevision;
  beforeStartLine: number;
  beforeEndLine: number;
  afterStartLine: number;
  afterEndLine: number;
  beforeExcerpt: string;
  afterExcerpt: string;
  symbolName: string | null;
  symbolKind: "function" | "class" | "component" | "variable" | null;
}

/** Exact, bounded source evidence permitted to leave the repository. */
export interface SourceContextItem {
  id: string;
  kind: SemanticAnchorKind;
  path: string;
  revision: SourceRevision;
  blobSha: string;
  startLine: number;
  endLine: number;
  label: string;
  excerpt: string;
}

/** A line-addressable audit reference. It contains no source excerpt. */
export interface SourceReference {
  path: string;
  revision: SourceRevision;
  startLine: number;
  endLine: number;
  symbolName: string | null;
}

export interface SemanticEntrypointTarget {
  id: string;
  path: string;
  kind: Extract<ProductImpactKind, "page" | "api_route">;
  tier: "primary" | "secondary";
  changedSeedPath: string;
  dependencyPath: string[];
  /** API targets need an observable contract before a user-facing scenario is allowed. */
  apiVerificationAllowed: boolean;
  anchors: SourceContextItem[];
}

/** Exact, bounded source packet allowed to leave the repository for one PR. */
export interface PrSemanticInput {
  version: 2;
  enabled: boolean;
  repository: { owner: string; name: string } | null;
  sourceReferences: SourceReference[];
  changedHunks: ChangedHunk[];
  targets: SemanticEntrypointTarget[];
}

export interface SemanticChangeSummary {
  hunkIds: string[];
  summary: string;
}

export interface SemanticScenario {
  title: string;
  setup: string | null;
  actions: string[];
  expected: string[];
  hunkIds: string[];
  anchorIds: string[];
}

export interface SemanticVerification {
  entrypointId: string;
  scenarios: SemanticScenario[];
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
  version: 5;
  repoId: number;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  analysisStatus: DeterministicPrAnalysis["status"];
  insufficientReason: string | null;
  unresolvedImportCount: number;
  changedFiles: DeterministicPrAnalysis["changedFiles"];
  changedSymbols: Array<{ id: string; name: string; changeKind: string; filePath: string }>;
  affectedItems: Array<{ id: string; path: string; kind: ProductImpactKind; projectRoot?: string; routePath?: string; httpMethod?: string | null; impact: "direct" | "indirect"; dependencyPath: string[] }>;
  impactAssessment: ImpactAssessment;
}

const scenarioSchema = z.object({
  title: z.string().min(1).max(160),
  setup: z.string().max(280).nullable(),
  actions: z.array(z.string().min(1).max(280)).min(1).max(5),
  expected: z.array(z.string().min(1).max(280)).min(1).max(5),
  hunkIds: z.array(z.string()).min(1).max(maxChangedHunkReferences),
  anchorIds: z.array(z.string()).min(2).max(8),
});

export const prSemanticResultSchema = z.object({
  changeSummaries: z.array(z.object({ hunkIds: z.array(z.string()).min(1).max(maxChangedHunkReferences), summary: z.string().min(1).max(400) })).max(12),
  verifications: z.array(z.object({
    entrypointId: z.string(),
    // Provider schemas cannot reliably enforce cardinality. Accept a small
    // surplus, then deterministically retain at most two validated scenarios.
    scenarios: z.array(scenarioSchema).max(5),
  })).max(5),
});

export function isPrioritized(item: ImpactAssessmentItem): item is ImpactAssessmentItem & { tier: "primary" | "secondary" } {
  return item.tier === "primary" || item.tier === "secondary";
}

import { z } from "zod";

import type { CommitFileChange, GraphFileKind, GraphSymbol } from "../graph/types.js";

export interface PullRequestAnalysisRequest {
  repoId: number;
  pullRequestNumber: number;
  baseRef: string;
  baseSha: string;
  headSha: string;
}

export type ImpactLevel = "high" | "medium" | "low";
export type AnalysisStatus = "ready" | "insufficient_evidence";
export type ChangedSymbolKind = "added" | "modified" | "deleted";
export type ProductImpactKind = "page" | "api_route" | "component" | "shared_module";

export interface ChangedFile extends CommitFileChange {
  graphRelevant: boolean;
}

export interface ChangedSymbol {
  changeKind: ChangedSymbolKind;
  filePath: string;
  symbolKey: string;
  name: string;
  kind: GraphSymbol["kind"];
}

export interface AffectedItem {
  path: string;
  kind: ProductImpactKind;
  /** Framework-proven identity; absent only for legacy technical items. */
  projectRoot?: string;
  routePath?: string;
  httpMethod?: string | null;
  entrypointReason?: string;
  impact: "direct" | "indirect";
  // Ordered from the changed source file to this affected file.
  dependencyPath: string[];
  /**
   * Every verified changed-source path to this same affected item. `impact`
   * and `dependencyPath` above remain the preferred display path; this keeps
   * alternative evidence available when it carries richer user-visible
   * context than the preferred path.
   */
  supportingPaths?: AffectedItemSupportingPath[];
}

export interface AffectedItemSupportingPath {
  impact: "direct" | "indirect";
  dependencyPath: string[];
}

export interface DeterministicPrAnalysis {
  status: AnalysisStatus;
  repoId: number;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  impactLevel: ImpactLevel | null;
  changedFiles: ChangedFile[];
  changedSymbols: ChangedSymbol[];
  affectedItems: AffectedItem[];
  unresolvedImportCount: number;
  insufficientReason: string | null;
}

// Phase 4 validates its persisted deterministic payload. Phase 5 owns the
// public evidence/report schema, so this remains an internal storage contract.
export const deterministicPrAnalysisSchema = z.object({
  status: z.enum(["ready", "insufficient_evidence"]),
  repoId: z.number(),
  pullRequestNumber: z.number(),
  baseSha: z.string(),
  headSha: z.string(),
  impactLevel: z.enum(["high", "medium", "low"]).nullable(),
  changedFiles: z.array(z.object({
    path: z.string(),
    status: z.enum(["added", "modified", "removed", "renamed"]),
    previousPath: z.string().optional(),
    graphRelevant: z.boolean(),
  })),
  changedSymbols: z.array(z.object({
    changeKind: z.enum(["added", "modified", "deleted"]),
    filePath: z.string(),
    symbolKey: z.string(),
    name: z.string(),
    kind: z.enum(["function", "class", "component", "variable"]),
  })),
  affectedItems: z.array(z.object({
    path: z.string(),
    kind: z.enum(["page", "api_route", "component", "shared_module"]),
    projectRoot: z.string().optional(),
    routePath: z.string().optional(),
    httpMethod: z.string().nullable().optional(),
    entrypointReason: z.string().optional(),
    impact: z.enum(["direct", "indirect"]),
    dependencyPath: z.array(z.string()).min(1),
    supportingPaths: z.array(z.object({
      impact: z.enum(["direct", "indirect"]),
      dependencyPath: z.array(z.string()).min(1),
    })).min(1).optional(),
  })),
  unresolvedImportCount: z.number().int().nonnegative(),
  insufficientReason: z.string().nullable(),
});

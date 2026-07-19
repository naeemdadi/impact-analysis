import type { BaselineGraph, TechnicalRole } from "../graph/types.js";
import type { DeterministicPrAnalysis, ProductImpactKind } from "./pr-impact-types.js";

export type ImpactTier = "primary" | "secondary" | "technical_only" | "evidence_only";

export interface ImpactAssessmentItem {
  /** A user-facing graph entrypoint. Only pages and API routes are candidates. */
  path: string;
  kind: Extract<ProductImpactKind, "page" | "api_route">;
  tier: ImpactTier;
  changedSeedPath: string;
  technicalRole: TechnicalRole;
  technicalRoleReason: string;
  impact: "direct" | "indirect";
  dependencyPath: string[];
  reason: string;
}

export interface ImpactAssessment {
  version: 2;
  status: "ready" | "insufficient_evidence";
  items: ImpactAssessmentItem[];
}

const tierRank: Record<ImpactTier, number> = {
  primary: 0,
  secondary: 1,
  technical_only: 2,
  evidence_only: 3,
};

/**
 * Deterministic relevance policy. The graph establishes reachability; this
 * function only decides how prominently that verified reachability appears.
 */
export function assessImpact(
  analysis: DeterministicPrAnalysis,
  graphs: { headGraph: BaselineGraph; baseGraph: BaselineGraph } | null,
): ImpactAssessment {
  if (analysis.status !== "ready") return { version: 2, status: "insufficient_evidence", items: [] };

  const files = new Map<string, BaselineGraph["files"][number]>();
  for (const file of graphs?.baseGraph.files ?? []) files.set(file.path, file);
  for (const file of graphs?.headGraph.files ?? []) files.set(file.path, file);
  const candidates = new Map<string, ImpactAssessmentItem>();

  for (const item of analysis.affectedItems) {
    if (item.kind !== "page" && item.kind !== "api_route") continue;
    const changedSeedPath = item.dependencyPath[0] ?? item.path;
    const seed = files.get(changedSeedPath);
    const technicalRole = seed?.technicalRole ?? "unknown";
    const technicalRoleReason = seed?.technicalRoleReason ?? "the exact PR-head graph has no classified source file";
    const directEntrypoint = item.impact === "direct" && (item.kind === "page" || item.kind === "api_route");
    const tier = classifyTier(technicalRole, directEntrypoint);
    const candidate: ImpactAssessmentItem = {
      path: item.path,
      kind: item.kind,
      tier,
      changedSeedPath,
      technicalRole,
      technicalRoleReason,
      impact: item.impact,
      dependencyPath: item.dependencyPath,
      reason: policyReason(tier, technicalRole, changedSeedPath, item.path, item.dependencyPath),
    };
    const current = candidates.get(item.path);
    if (!current || compareCandidates(candidate, current) < 0) candidates.set(item.path, candidate);
  }

  return {
    version: 2,
    status: "ready",
    items: [...candidates.values()].sort(compareCandidates),
  };
}

function classifyTier(role: TechnicalRole, directEntrypoint: boolean): ImpactTier {
  if (directEntrypoint || role === "application") return "primary";
  if (role === "presentation" || role === "utility") return "secondary";
  if (["analytics", "infrastructure", "styling", "configuration", "testing", "ui_primitive"].includes(role)) return "technical_only";
  return "evidence_only";
}

function policyReason(tier: ImpactTier, role: TechnicalRole, seed: string, entrypoint: string, path: string[]): string {
  const route = `\`${entrypoint}\``;
  if (tier === "primary" && path.length === 1) return `Primary because ${route} is changed directly.`;
  if (tier === "primary") return `Primary because changed ${role} code \`${seed}\` reaches ${route} through a resolved import path.`;
  if (tier === "secondary") return `Secondary because changed ${role} code \`${seed}\` reaches ${route} indirectly.`;
  if (tier === "technical_only") return `Technical-only because changed \`${seed}\` is classified as ${role}; its reachability to ${route} is retained as evidence.`;
  return `Evidence-only because changed \`${seed}\` has no reliable technical-role classification.`;
}

function compareCandidates(left: ImpactAssessmentItem, right: ImpactAssessmentItem): number {
  return tierRank[left.tier] - tierRank[right.tier]
    || Number(right.impact === "direct") - Number(left.impact === "direct")
    || left.dependencyPath.length - right.dependencyPath.length
    || left.path.localeCompare(right.path)
    || left.dependencyPath.join("\u0000").localeCompare(right.dependencyPath.join("\u0000"));
}

import type { BaselineGraph, TechnicalRole } from "../graph/types.js";
import type { DeterministicPrAnalysis, ProductImpactKind } from "./pr-impact-types.js";

export type ImpactTier = "primary" | "secondary" | "technical_only" | "evidence_only";

export interface ImpactAssessmentItem {
  /** A user-facing graph entrypoint. Only pages and API routes are candidates. */
  path: string;
  kind: Extract<ProductImpactKind, "page" | "api_route">;
  projectRoot?: string;
  routePath?: string;
  httpMethod?: string | null;
  entrypointReason?: string;
  tier: ImpactTier;
  changedSeedPath: string;
  technicalRole: TechnicalRole;
  technicalRoleReason: string;
  impact: "direct" | "indirect";
  dependencyPath: string[];
  reason: string;
  /**
   * All resolved changed-source paths to this entrypoint. The visible report
   * still renders the entrypoint once at its highest tier, while semantic
   * scenario generation can use a lower-tier path when it contains the
   * actual interaction or state evidence (for example, a changed component
   * rendered by a directly changed page).
   */
  supportingPaths?: ImpactAssessmentSupportingPath[];
}

export interface ImpactAssessmentSupportingPath {
  changedSeedPath: string;
  technicalRole: TechnicalRole;
  technicalRoleReason: string;
  tier: ImpactTier;
  impact: "direct" | "indirect";
  dependencyPath: string[];
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
  const candidates = new Map<string, { selected: ImpactAssessmentItem; supportingPaths: ImpactAssessmentSupportingPath[] }>();

  for (const item of analysis.affectedItems) {
    if (item.kind !== "page" && item.kind !== "api_route") continue;
    const rawPaths = item.supportingPaths?.length ? item.supportingPaths : [{ impact: item.impact, dependencyPath: item.dependencyPath }];
    for (const rawPath of rawPaths) {
      const changedSeedPath = rawPath.dependencyPath[0] ?? item.path;
      const seed = files.get(changedSeedPath);
      const technicalRole = seed?.technicalRole ?? "unknown";
      const technicalRoleReason = seed?.technicalRoleReason ?? "the exact PR-head graph has no classified source file";
      const directEntrypoint = rawPath.impact === "direct" && (item.kind === "page" || item.kind === "api_route");
      const tier = classifyTier(technicalRole, directEntrypoint);
      const candidate: ImpactAssessmentItem = {
        path: item.path,
        kind: item.kind,
        projectRoot: item.projectRoot,
        routePath: item.routePath,
        httpMethod: item.httpMethod,
        entrypointReason: item.entrypointReason,
        tier,
        changedSeedPath,
        technicalRole,
        technicalRoleReason,
        impact: rawPath.impact,
        dependencyPath: rawPath.dependencyPath,
        reason: policyReason(tier, technicalRole, changedSeedPath, item.routePath ?? item.path, rawPath.dependencyPath),
      };
      const supportingPath: ImpactAssessmentSupportingPath = {
        changedSeedPath,
        technicalRole,
        technicalRoleReason,
        tier,
        impact: rawPath.impact,
        dependencyPath: rawPath.dependencyPath,
      };
      const key = [item.projectRoot ?? "", item.kind, item.httpMethod ?? "", item.routePath ?? item.path].join("\u0000");
      const current = candidates.get(key);
      if (!current) {
        candidates.set(key, { selected: candidate, supportingPaths: [supportingPath] });
        continue;
      }
      if (!current.supportingPaths.some((path) => sameSupportingPath(path, supportingPath))) current.supportingPaths.push(supportingPath);
      if (compareCandidates(candidate, current.selected) < 0) current.selected = candidate;
    }
  }

  return {
    version: 2,
    status: "ready",
    items: [...candidates.values()]
      .map(({ selected, supportingPaths }) => ({ ...selected, supportingPaths: supportingPaths.sort(compareSupportingPaths) }))
      .sort(compareCandidates),
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
    || (left.projectRoot ?? "").localeCompare(right.projectRoot ?? "")
    || (left.routePath ?? left.path).localeCompare(right.routePath ?? right.path)
    || left.path.localeCompare(right.path)
    || left.dependencyPath.join("\u0000").localeCompare(right.dependencyPath.join("\u0000"));
}

function compareSupportingPaths(left: ImpactAssessmentSupportingPath, right: ImpactAssessmentSupportingPath): number {
  return tierRank[left.tier] - tierRank[right.tier]
    || Number(right.impact === "direct") - Number(left.impact === "direct")
    || left.dependencyPath.length - right.dependencyPath.length
    || left.changedSeedPath.localeCompare(right.changedSeedPath)
    || left.dependencyPath.join("\u0000").localeCompare(right.dependencyPath.join("\u0000"));
}

function sameSupportingPath(left: ImpactAssessmentSupportingPath, right: ImpactAssessmentSupportingPath): boolean {
  return left.changedSeedPath === right.changedSeedPath
    && left.technicalRole === right.technicalRole
    && left.tier === right.tier
    && left.impact === right.impact
    && left.dependencyPath.join("\u0000") === right.dependencyPath.join("\u0000");
}

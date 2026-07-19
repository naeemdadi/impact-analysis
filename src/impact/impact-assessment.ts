import { classifyTechnicalRole } from "../graph/baseline-graph-builder.js";
import type { DeterministicPrAnalysis } from "./pr-impact-types.js";

export type ImpactTier = "primary" | "secondary" | "technical_only" | "evidence_only";
export interface ImpactAssessmentItem { path: string; tier: ImpactTier; technicalRole: string; reason: string; dependencyPath: string[]; }
export interface ImpactAssessment { version: 1; items: ImpactAssessmentItem[]; }

/** Deterministic prioritization. Domains enrich this later but never establish reachability. */
export function assessImpact(analysis: DeterministicPrAnalysis): ImpactAssessment {
  const items = analysis.affectedItems.map((item) => {
    const seed = item.dependencyPath[0] ?? item.path;
    const role = classifyTechnicalRole(seed, seed === item.path ? item.kind : "shared_module", "");
    const directRoute = item.impact === "direct" && (item.kind === "page" || item.kind === "api_route");
    let tier: ImpactTier;
    const technicalRole = role.technicalRole ?? "unknown";
    if (directRoute || technicalRole === "business_logic" || technicalRole === "application_module") tier = "primary";
    else if (technicalRole === "presentation" || technicalRole === "utility") tier = "secondary";
    else if (["analytics", "infrastructure", "configuration", "styling", "testing", "ui_primitive"].includes(technicalRole)) tier = "technical_only";
    else tier = "evidence_only";
    return { path: item.path, tier, technicalRole, dependencyPath: item.dependencyPath, reason: `${tier} because changed seed ${seed} is classified as ${technicalRole}: ${role.technicalRoleReason ?? "no stronger role signal"}` };
  }).sort((a, b) => a.tier.localeCompare(b.tier) || a.path.localeCompare(b.path));
  return { version: 1, items };
}

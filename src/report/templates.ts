import type { ImpactAssessmentItem } from "../impact/impact-assessment.js";
import type { PrSemanticResult, ReportEvidence, SemanticGuidanceState } from "./report-types.js";

export function renderReport(evidence: ReportEvidence, semantic: PrSemanticResult | null, guidance: SemanticGuidanceState = { status: "not_requested", notice: null }): string {
  if (evidence.analysisStatus === "insufficient_evidence") {
    return ["## Change Impact Report", "", "**Analysis status:** Insufficient evidence", "", `This report makes no impact claims because ${evidence.insufficientReason ?? "the required deterministic evidence is unavailable"}.`, "", footer(evidence)].join("\n");
  }

  const lines = ["## Change Impact Report", ""];
  if (guidance.status === "fallback" && guidance.notice) {
    lines.push(`> **AI-assisted guidance unavailable:** ${guidance.notice} This report still contains deterministic dependency evidence.`, "");
  }
  lines.push("### What changed", "");
  const summaries = semantic?.changeSummaries ?? [];
  if (summaries.length) lines.push(...summaries.map((item) => `- ${item.summary}`), "");
  else lines.push(...deterministicChangeSummary(evidence), "");

  const verificationByTarget = new Map((semantic?.verifications ?? []).map((item) => [item.entrypointId, item]));
  for (const [tier, heading] of [["primary", "### Primary verification"], ["secondary", "### Secondary verification"]] as const) {
    const items = evidence.impactAssessment.items.filter((item) => item.tier === tier);
    if (!items.length) continue;
    lines.push(heading, "");
    for (const [index, item] of items.entries()) {
      const targetId = targetIdFor(item);
      const checks = verificationByTarget.get(targetId)?.checks ?? [];
      lines.push(`${index + 1}. **${displayEntrypoint(item)}**`);
      if (checks.length) lines.push(...checks.map((check) => `   - ${check.text}`));
      else lines.push(`   - Verify this ${item.kind === "page" ? "route" : "API endpoint"} because changed ${item.technicalRole} code reaches it.`);
      lines.push(`   - Why: ${item.dependencyPath.map((path) => `\`${path}\``).join(" → ")}`, "");
    }
  }

  const technical = evidence.impactAssessment.items.filter((item) => item.tier === "technical_only");
  if (technical.length) {
    lines.push("### Technical impact", "", ...technical.map((item) => `- ${item.reason}`), "");
  }
  const evidenceOnly = evidence.impactAssessment.items.filter((item) => item.tier === "evidence_only");
  if (evidenceOnly.length) lines.push("### Evidence requiring manual review", "", ...evidenceOnly.map((item) => `- ${item.reason}`), "");

  lines.push("### Technical evidence", "");
  lines.push(...evidence.affectedItems.map((item) => `- **${item.path}** (${item.impact}): ${item.dependencyPath.map((path) => `\`${path}\``).join(" → ")}`));
  if (evidence.changedSymbols.length) lines.push("", "**Changed symbols**", ...evidence.changedSymbols.map((symbol) => `- ${symbol.changeKind}: \`${symbol.name}\` in \`${symbol.filePath}\``));
  lines.push("", `- ${evidence.unresolvedImportCount} unresolved import(s)`, "", footer(evidence));
  return lines.join("\n");
}

export function targetIdFor(item: Pick<ImpactAssessmentItem, "path">): string { return `entry:${item.path}`; }

function deterministicChangeSummary(evidence: ReportEvidence): string[] {
  if (evidence.changedSymbols.length) return evidence.changedSymbols.slice(0, 8).map((symbol) => `Changed ${symbol.changeKind} symbol \`${symbol.name}\` in \`${symbol.filePath}\`.`);
  if (evidence.changedFiles.length) return evidence.changedFiles.slice(0, 8).map((file) => `Changed ${file.status} file \`${file.path}\`.`);
  return ["No graph-relevant source change was identified."];
}

function displayEntrypoint(item: ImpactAssessmentItem): string {
  if (item.kind === "api_route") return `API ${routePath(item.path)}`;
  return routePath(item.path);
}

function routePath(path: string): string {
  const normalized = path.replace(/^src\//, "").replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
  if (normalized.startsWith("app/")) {
    const route = normalized.slice(4).replace(/\/(?:page|route)$/, "");
    return route ? `/${route}` : "/";
  }
  if (normalized.startsWith("pages/")) return `/${normalized.slice(6).replace(/^index$/, "")}`.replace(/\/$/, "") || "/";
  return path;
}

function footer(evidence: ReportEvidence): string { return `Analyzed base \`${evidence.baseSha}\` → head \`${evidence.headSha}\``; }

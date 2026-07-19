import type { ReportEvidence, ReportSelection, ReportSelectionCatalog, SummaryTemplate } from "./report-types.js";

export function buildSelectionCatalog(evidence: ReportEvidence): ReportSelectionCatalog {
  if (evidence.analysisStatus === "insufficient_evidence") return { summaryTemplates: ["insufficient_evidence"], verificationTargets: [] };
  const summaryTemplates: SummaryTemplate[] = evidence.impactLevel === "high" ? ["broad_shared_change"] : evidence.impactLevel === "medium" ? ["route_change"] : evidence.affectedItems.length ? ["localized_change"] : ["no_graph_impact"];
  return {
    summaryTemplates,
    verificationTargets: evidence.featureTargets.map((target) => ({ id: target.id, scenarioIds: target.scenarios.map((scenario) => scenario.id), allowedHunkIds: evidence.changedHunks.map((hunk) => hunk.id) })),
  };
}

export function defaultSelection(catalog: ReportSelectionCatalog): ReportSelection {
  return { summaryTemplate: catalog.summaryTemplates[0], verifications: catalog.verificationTargets.slice(0, 5).flatMap((target) => target.scenarioIds[0] ? [{ entrypointId: target.id, scenarioId: target.scenarioIds[0], hunkIds: [] }] : []) };
}

export function validateSelection(selection: ReportSelection, catalog: ReportSelectionCatalog): ReportSelection {
  if (!catalog.summaryTemplates.includes(selection.summaryTemplate)) throw new Error(`summary template ${selection.summaryTemplate} is not supported by evidence`);
  if (selection.verifications.length > 5) throw new Error("report selection exceeds five verification targets");
  const targets = new Map(catalog.verificationTargets.map((target) => [target.id, target]));
  const seen = new Set<string>();
  for (const verification of selection.verifications) {
    if (seen.has(verification.entrypointId)) throw new Error(`duplicate verification target ${verification.entrypointId}`);
    seen.add(verification.entrypointId);
    const target = targets.get(verification.entrypointId);
    if (!target) throw new Error(`unknown verification target ${verification.entrypointId}`);
    if (!target.scenarioIds.includes(verification.scenarioId)) throw new Error(`scenario ${verification.scenarioId} does not belong to ${verification.entrypointId}`);
    for (const hunkId of verification.hunkIds) if (!target.allowedHunkIds.includes(hunkId)) throw new Error(`unknown changed hunk ${hunkId}`);
  }
  return selection;
}

export function renderReport(evidence: ReportEvidence, selection: ReportSelection): string {
  if (evidence.analysisStatus === "insufficient_evidence") return ["## Change Impact Report", "", "**Analysis status:** Insufficient evidence", "", `This report makes no impact claims because ${evidence.insufficientReason ?? "the required deterministic evidence is unavailable"}.`, "", footer(evidence)].join("\n");
  const targetById = new Map(evidence.featureTargets.map((target) => [target.id, target]));
  const lines = ["## Change Impact Report", "", `**Impact level:** ${capitalize(evidence.impactLevel ?? "low")}`, ""];
  for (const [tier, heading] of [["primary", "### Primary verification"], ["secondary", "### Secondary verification"], ["technical_only", "### Technical impact"]] as const) {
    const items = evidence.impactAssessment.items.filter((item) => item.tier === tier);
    if (items.length) lines.push(heading, ...items.map((item) => `- **${item.path}** — ${item.reason}`), "");
  }
  lines.push("### Before merging, verify", "");
  if (selection.verifications.length > 0) {
    for (const [index, chosen] of selection.verifications.entries()) {
      const target = targetById.get(chosen.entrypointId)!;
      const scenario = target.scenarios.find((item) => item.id === chosen.scenarioId)!;
      lines.push(`${index + 1}. **${target.title}** — \`${target.path}\``, ...scenario.steps.map((step) => `   - ${step}`), `   - Why: ${target.dependencyPath.join(" → ")}`, "");
    }
  } else {
    lines.push("- No source-backed verification scenario is available. Review the changed code and verified dependency paths below.", "");
  }
  lines.push("### Technical evidence", ...evidence.affectedItems.map((item) => `- **${item.path}** (${item.impact}): ${item.dependencyPath.join(" → ")}`));
  if (evidence.changedSymbols.length) lines.push("", "**Changed symbols**", ...evidence.changedSymbols.map((symbol) => `- ${symbol.changeKind}: \`${symbol.name}\` in ${symbol.filePath}`));
  lines.push("", `- ${evidence.unresolvedImportCount} unresolved import(s)`, "", footer(evidence));
  return lines.join("\n");
}

function footer(evidence: ReportEvidence) { return `Analyzed base \`${evidence.baseSha}\` → head \`${evidence.headSha}\``; }
function capitalize(value: string) { return `${value[0].toUpperCase()}${value.slice(1)}`; }

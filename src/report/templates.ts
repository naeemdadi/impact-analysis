import type { ReportEvidence, ReportSelection, ReportSelectionCatalog, SummaryTemplate, VerificationAction } from "./report-types.js";

export function buildSelectionCatalog(evidence: ReportEvidence): ReportSelectionCatalog {
  if (evidence.analysisStatus === "insufficient_evidence") return { summaryTemplates: ["insufficient_evidence"], verificationTargets: [] };
  const summaryTemplates: SummaryTemplate[] = evidence.impactLevel === "high"
    ? ["broad_shared_change"]
    : evidence.impactLevel === "medium"
      ? ["route_change"]
      : evidence.affectedItems.length > 0
        ? ["localized_change"]
        : ["no_graph_impact"];
  return {
    summaryTemplates,
    verificationTargets: evidence.affectedItems.map((item) => ({ id: item.id, kind: item.kind, allowedActions: actionsForKind(item.kind) })),
  };
}

export function defaultSelection(catalog: ReportSelectionCatalog): ReportSelection {
  return {
    summaryTemplate: catalog.summaryTemplates[0],
    verifications: catalog.verificationTargets.slice(0, 5).map((target) => ({ affectedItemId: target.id, action: target.allowedActions[0] })),
  };
}

export function validateSelection(selection: ReportSelection, catalog: ReportSelectionCatalog): ReportSelection {
  if (!catalog.summaryTemplates.includes(selection.summaryTemplate)) throw new Error(`summary template ${selection.summaryTemplate} is not supported by evidence`);
  if (selection.verifications.length > 5) throw new Error("report selection exceeds five verification targets");
  const targets = new Map(catalog.verificationTargets.map((target) => [target.id, target]));
  const seen = new Set<string>();
  for (const verification of selection.verifications) {
    if (seen.has(verification.affectedItemId)) throw new Error(`duplicate verification target ${verification.affectedItemId}`);
    seen.add(verification.affectedItemId);
    const target = targets.get(verification.affectedItemId);
    if (!target) throw new Error(`unknown verification target ${verification.affectedItemId}`);
    if (!target.allowedActions.includes(verification.action)) throw new Error(`verification action ${verification.action} is incompatible with ${target.kind}`);
  }
  return selection;
}

export function renderReport(evidence: ReportEvidence, selection: ReportSelection): string {
  if (evidence.analysisStatus === "insufficient_evidence") {
    return [
      "## Change Impact Report",
      "",
      "**Analysis status:** Insufficient evidence",
      "",
      `This report makes no impact claims because ${evidence.insufficientReason ?? "the required deterministic evidence is unavailable"}.`,
      "",
      footer(evidence),
    ].join("\n");
  }
  const itemsByKind = groupByKind(evidence);
  const direct = evidence.affectedItems.filter((item) => item.impact === "direct");
  const indirect = evidence.affectedItems.filter((item) => item.impact === "indirect");
  const verificationById = new Map(evidence.affectedItems.map((item) => [item.id, item]));
  const lines = [
    "## Change Impact Report",
    "",
    `**Impact level:** ${capitalize(evidence.impactLevel ?? "low")}`,
    `**Confidence:** ${capitalize(evidence.confidence)}`,
    confidenceNotice(evidence),
    "",
    "### Affected",
    ...renderGroups(itemsByKind),
    "",
    "### Why",
    ...evidence.affectedItems.map((item) => `- **${item.path}** (${item.impact}): ${item.dependencyPath.join(" → ")}`),
    "",
    "### Indirect impact",
    ...(indirect.length > 0 ? indirect.map((item) => `- ${item.path}`) : ["- No indirect product areas were reached by resolved import paths."]),
    "",
    "### Suggested verification",
    ...(selection.verifications.length > 0
      ? selection.verifications.map((verification) => verificationLine(verification.action, verificationById.get(verification.affectedItemId)!.path))
      : ["- Review the changed code and its verified dependency paths."]),
    "",
    "### Evidence",
    ...(evidence.changedSymbols.length > 0
      ? evidence.changedSymbols.map((symbol) => `- ${symbol.changeKind}: \`${symbol.name}\` in ${symbol.filePath}`)
      : ["- No top-level symbols changed; file-level import evidence was used."]),
    `- ${evidence.affectedItems.length} affected product item(s), ${direct.length} direct and ${indirect.length} indirect`,
    `- ${evidence.unresolvedImportCount} unresolved import(s)`,
    "",
    "### Summary",
    summaryLine(selection.summaryTemplate),
    "",
    footer(evidence),
  ];
  return lines.join("\n");
}

function actionsForKind(kind: ReportEvidence["affectedItems"][number]["kind"]): VerificationAction[] {
  if (kind === "page") return ["render_page"];
  if (kind === "api_route") return ["exercise_api_route"];
  if (kind === "component") return ["exercise_component_state"];
  return ["exercise_consumers"];
}
function groupByKind(evidence: ReportEvidence) { return new Map(["page", "api_route", "component", "shared_module"].map((kind) => [kind, evidence.affectedItems.filter((item) => item.kind === kind)])); }
function renderGroups(groups: Map<string, ReportEvidence["affectedItems"]>) { const labels: Record<string, string> = { page: "Pages", api_route: "API Routes", component: "Components", shared_module: "Shared Modules" }; return [...groups].flatMap(([kind, items]) => items.length === 0 ? [] : [`**${labels[kind]}**`, ...items.map((item) => `- ${item.path}`)]); }
function confidenceNotice(evidence: ReportEvidence) { return evidence.confidence === "high" ? "" : `**Confidence note:** ${evidence.unresolvedImportCount} unresolved import(s) may limit dependency coverage.`; }
function verificationLine(action: VerificationAction, path: string) { const actions: Record<VerificationAction, string> = { render_page: "Render the affected page", exercise_api_route: "Exercise the affected API route", exercise_component_state: "Exercise the affected component state", exercise_consumers: "Exercise consumers of the affected shared module" }; return `- ${actions[action]}: ${path}`; }
function summaryLine(template: SummaryTemplate) { const lines: Record<SummaryTemplate, string> = { broad_shared_change: "This PR has verified dependency paths to multiple pages or API routes.", route_change: "This PR directly changes a route with verified dependency evidence.", localized_change: "This PR has a localized, evidence-backed dependency impact.", no_graph_impact: "No affected product area was reached through resolved graph imports.", insufficient_evidence: "Deterministic evidence was insufficient, so no impact claim was made." }; return lines[template]; }
function footer(evidence: ReportEvidence) { return `Analyzed base \`${evidence.baseSha}\` → head \`${evidence.headSha}\``; }
function capitalize(value: string) { return `${value[0].toUpperCase()}${value.slice(1)}`; }

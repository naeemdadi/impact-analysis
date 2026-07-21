import type { ImpactAssessmentItem } from "../impact/impact-assessment.js";
import type { PrSemanticInput, PrSemanticResult, ReportEvidence, SemanticGuidanceState } from "./report-types.js";

const maxImpactMapEntrypoints = 8;
const maxImpactMapNodes = 24;

export function renderReport(
  evidence: ReportEvidence,
  semantic: PrSemanticResult | null,
  guidance: SemanticGuidanceState = { status: "not_requested", notice: null },
  semanticInput?: PrSemanticInput,
): string {
  if (evidence.analysisStatus === "insufficient_evidence") {
    return ["## Change Impact Report", "", "**Analysis status:** Insufficient evidence", "", `This report makes no impact claims because ${evidence.insufficientReason ?? "the required deterministic evidence is unavailable"}.`, "", footer(evidence)].join("\n");
  }

  const lines = ["## Change Impact Report", ""];
  if (guidance.status === "fallback" && guidance.notice) {
    lines.push(`> **AI-assisted guidance unavailable:** ${guidance.notice} This report keeps deterministic dependency evidence, but does not invent verification scenarios.`, "");
  }
  lines.push("### What changed", "");
  const summaries = semantic?.changeSummaries ?? [];
  if (summaries.length) lines.push(...summaries.map((item) => `- ${item.summary}`), "");
  else lines.push(...deterministicChangeSummary(evidence), "");

  const verificationByTarget = new Map((semantic?.verifications ?? []).map((item) => [item.entrypointId, item]));
  const prioritized = evidence.impactAssessment.items.filter((item) => item.tier === "primary" || item.tier === "secondary");
  const scenarioTargets = prioritized.filter((item) => (verificationByTarget.get(targetIdFor(item))?.scenarios.length ?? 0) > 0);
  if (scenarioTargets.length) {
    lines.push("### What to verify before merging", "");
    let scenarioNumber = 1;
    for (const item of scenarioTargets) {
      const scenarios = verificationByTarget.get(targetIdFor(item))!.scenarios;
      for (const scenario of scenarios) {
        lines.push(`${scenarioNumber}. **${scenario.title}**`, `   _Route: ${displayEntrypoint(item)}_`, "");
        if (scenario.setup) lines.push(`   **Setup:** ${scenario.setup}`, "");
        lines.push("   **Do:**", ...scenario.actions.map((action) => `   - ${action}`), "", "   **Expected Outcome:**", ...scenario.expected.map((expected) => `   - ${expected}`), "");
        lines.push(`   **Why:** ${humanImpactReason(item, evidence, semanticInput)}`, "");
        scenarioNumber += 1;
      }
    }
  }

  lines.push(...renderImpactMapSection(evidence));
  const selectedSemanticTargetIds = new Set(semanticInput?.targets.map((target) => target.id) ?? []);
  const semanticCompleted = guidance.status === "completed" && semanticInput?.enabled;
  const unavailable = semanticCompleted ? prioritized.filter((item) => selectedSemanticTargetIds.has(targetIdFor(item)) && !scenarioTargets.includes(item)) : [];
  const notExpanded = semanticCompleted ? prioritized.filter((item) => !selectedSemanticTargetIds.has(targetIdFor(item))) : [];
  const analysisDetails = renderAnalysisDetails(evidence, unavailable, notExpanded);
  if (analysisDetails.length) lines.push(...analysisDetails);
  lines.push("", footer(evidence));
  return lines.join("\n");
}

export function targetIdFor(item: Pick<ImpactAssessmentItem, "path" | "projectRoot" | "kind" | "httpMethod" | "routePath">): string {
  if (!item.projectRoot && !item.routePath && !item.httpMethod) return `entry:${item.path}`;
  return `entry:${item.projectRoot ?? ""}:${item.kind}:${item.httpMethod ?? ""}:${item.routePath ?? item.path}`;
}

function deterministicChangeSummary(evidence: ReportEvidence): string[] {
  if (evidence.changedSymbols.length) return evidence.changedSymbols.slice(0, 8).map((symbol) => `${capitalize(symbol.changeKind)} ${formatSymbolName(symbol.name)}.`);
  if (evidence.changedFiles.length) return evidence.changedFiles.slice(0, 8).map((file) => `${capitalize(file.status)} ${friendlyPathLabel(file.path)}.`);
  return ["No graph-relevant source change was identified."];
}

function displayEntrypoint(item: ImpactAssessmentItem): string {
  const route = item.routePath ?? routePath(item.path);
  const project = item.projectRoot ? `${item.projectRoot} · ` : "";
  if (item.kind === "api_route") return `${project}${item.httpMethod ? `${item.httpMethod} ` : ""}API ${route}`;
  return `${project}${route}`;
}

function humanImpactReason(item: ImpactAssessmentItem, evidence: ReportEvidence, input: PrSemanticInput | undefined): string {
  const route = item.kind === "page" ? "page" : "API endpoint";
  const target = input?.targets.find((candidate) => candidate.id === targetIdFor(item));
  const changedSeedPath = target?.changedSeedPath ?? item.changedSeedPath;
  const dependencyPath = target?.dependencyPath ?? item.dependencyPath;
  // A directly changed route may be grounded by a separately changed child
  // module. Explain that richer, verified path rather than hiding it behind a
  // generic direct-change statement.
  if (!target && item.impact === "direct") return `This ${route} changed directly.`;
  const source = changedSourceLabel(changedSeedPath, evidence, input);
  const directBinding = target?.anchors.some((anchor) => anchor.kind === "dependency_use" && anchor.path === item.path) ?? false;
  if (dependencyPath.length === 2 && directBinding) return `This ${route} imports the modified ${source}.`;
  if (dependencyPath.length === 2) return `The modified ${source} has a verified dependency path to this ${route}.`;
  if (item.impact === "direct") return `This ${route} changed directly.`;
  return `A verified dependency chain connects the modified ${source} to this ${route}.`;
}

function changedSourceLabel(changedSeedPath: string, evidence: ReportEvidence, input: PrSemanticInput | undefined): string {
  const hunk = input?.changedHunks.find((candidate) => candidate.path === changedSeedPath && candidate.symbolName);
  if (hunk?.symbolName) return formatSymbolName(hunk.symbolName);
  const symbol = evidence.changedSymbols.find((candidate) => candidate.filePath === changedSeedPath);
  return symbol ? formatSymbolName(symbol.name) : friendlyPathLabel(changedSeedPath);
}

/** The graph is visible because it is the report's compact, auditable proof of reachability. */
function renderImpactMapSection(evidence: ReportEvidence): string[] {
  return [
    "### Impact map",
    "",
    "```mermaid",
    ...renderImpactMap(evidence),
    "```",
    "",
    "Red = changed source · Blue = affected route/API · Dashed gray = technical-only reachability.",
  ];
}

/** Keeps only genuine analysis limitations collapsed, not the report's main evidence visual. */
function renderAnalysisDetails(evidence: ReportEvidence, unavailable: ImpactAssessmentItem[], notExpanded: ImpactAssessmentItem[]): string[] {
  if (!unavailable.length && !notExpanded.length && evidence.unresolvedImportCount === 0) return [];
  const lines = ["", "<details>", "", "<summary>Analysis details</summary>"];
  if (unavailable.length) {
    lines.push("", "### Affected routes without a source-grounded scenario");
    for (const item of unavailable) lines.push(`- ${displayEntrypoint(item)} — the available source did not contain a supported user interaction, state, or contract anchor.`);
  }
  if (notExpanded.length) {
    const noun = notExpanded.length === 1 ? "entrypoint" : "entrypoints";
    const verb = notExpanded.length === 1 ? "was" : "were";
    lines.push("", `- ${notExpanded.length} prioritized ${noun} ${verb} not expanded into scenarios because the available source did not contain enough eligible evidence for a grounded check. Their deterministic reachability remains recorded.`);
  }
  if (evidence.unresolvedImportCount > 0) lines.push("", `- ${evidence.unresolvedImportCount} unresolved import(s)`);
  lines.push("", "</details>");
  return lines;
}

function renderImpactMap(evidence: ReportEvidence): string[] {
  const selected = evidence.impactAssessment.items.slice(0, maxImpactMapEntrypoints);
  const paths: ImpactAssessmentItem[] = [];
  const nodes = new Set<string>();
  for (const item of selected) {
    const candidateNodes = new Set([...nodes, ...item.dependencyPath]);
    if (paths.length > 0 && candidateNodes.size > maxImpactMapNodes) break;
    nodes.clear();
    for (const node of candidateNodes) nodes.add(node);
    paths.push(item);
  }
  if (!paths.length) return ["flowchart LR", '  empty["No route or API impact path is available."]'];

  const nodeIds = new Map([...nodes].sort((left, right) => left.localeCompare(right)).map((node, index) => [node, `n${index + 1}`]));
  const lines = ["flowchart LR"];
  for (const [node, id] of nodeIds) lines.push(`  ${id}["${mermaidNodeLabel(node, evidence, paths)}"]`);
  const edgeKinds = new Map<string, "product" | "technical">();
  for (const item of paths) {
    for (let index = 0; index < item.dependencyPath.length - 1; index += 1) {
      const from = item.dependencyPath[index];
      const to = item.dependencyPath[index + 1];
      if (!from || !to) continue;
      const key = `${from}\u0000${to}`;
      if (edgeKinds.get(key) !== "product") edgeKinds.set(key, item.tier === "technical_only" ? "technical" : "product");
    }
  }
  for (const [edge, kind] of edgeKinds) {
    const [from, to] = edge.split("\u0000");
    const fromId = nodeIds.get(from ?? "");
    const toId = nodeIds.get(to ?? "");
    if (fromId && toId) lines.push(`  ${fromId} ${kind === "technical" ? "-.->" : "-->"} ${toId}`);
  }
  const changed = uniqueNodeIds(paths.map((item) => item.changedSeedPath), nodeIds);
  const entrypoints = uniqueNodeIds(paths.map((item) => item.path), nodeIds);
  const technical = uniqueNodeIds(paths.filter((item) => item.tier === "technical_only").flatMap((item) => item.dependencyPath), nodeIds)
    .filter((id) => !changed.includes(id) && !entrypoints.includes(id));
  lines.push("  classDef changed fill:#fee2e2,stroke:#dc2626,color:#7f1d1d", "  classDef entrypoint fill:#dbeafe,stroke:#2563eb,color:#1e3a8a", "  classDef technical fill:#f3f4f6,stroke:#6b7280,color:#374151");
  if (changed.length) lines.push(`  class ${changed.join(",")} changed`);
  if (entrypoints.length) lines.push(`  class ${entrypoints.join(",")} entrypoint`);
  if (technical.length) lines.push(`  class ${technical.join(",")} technical`);
  return lines;
}

function uniqueNodeIds(paths: string[], nodeIds: Map<string, string>): string[] {
  return [...new Set(paths.map((item) => nodeIds.get(item)).filter((id): id is string => Boolean(id)))];
}

function mermaidNodeLabel(node: string, evidence: ReportEvidence, items: ImpactAssessmentItem[]): string {
  const entrypoint = items.find((item) => item.path === node);
  if (entrypoint) return mermaidLabel(`${displayEntrypoint(entrypoint)} (${entrypoint.kind === "page" ? "page" : "API"})`);
  const symbol = evidence.changedSymbols.find((candidate) => candidate.filePath === node);
  if (symbol) return mermaidLabel(`${humanizeIdentifier(symbol.name)} (changed)`);
  const changed = items.some((item) => item.changedSeedPath === node);
  return mermaidLabel(`${friendlyPathLabel(node)}${changed ? " (changed)" : ""}`);
}

function mermaidLabel(value: string): string { return value.replace(/["\\]/g, "").replace(/[\r\n]/g, " "); }
function formatSymbolName(name: string): string { return `\`${name}\``; }
function friendlyPathLabel(value: string): string {
  const normalized = value.replace(/^src\//, "").replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
  const parts = normalized.split("/").filter(Boolean);
  const leaf = parts.at(-1) === "index" ? parts.at(-2) ?? "module" : parts.at(-1) ?? "module";
  return `${humanizeIdentifier(leaf)} module`;
}
function humanizeIdentifier(value: string): string { return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function capitalize(value: string): string { return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value; }
function routePath(pathValue: string): string {
  const normalized = pathValue.replace(/^src\//, "").replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
  if (normalized.startsWith("app/")) {
    const route = normalized.slice(4).replace(/\/(?:page|route)$/, "");
    return route ? `/${route}` : "/";
  }
  if (normalized.startsWith("pages/")) return `/${normalized.slice(6).replace(/^index$/, "")}`.replace(/\/$/, "") || "/";
  return friendlyPathLabel(pathValue);
}
function footer(evidence: ReportEvidence): string { return `Analyzed base \`${evidence.baseSha}\` → head \`${evidence.headSha}\``; }

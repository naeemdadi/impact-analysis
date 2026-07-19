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
    lines.push(`> **AI-assisted guidance unavailable:** ${guidance.notice} This report still contains deterministic dependency evidence.`, "");
  }
  lines.push("### What changed", "");
  const summaries = semantic?.changeSummaries ?? [];
  if (summaries.length) lines.push(...summaries.map((item) => `- ${item.summary}`), "");
  else lines.push(...deterministicChangeSummary(evidence), "");

  const verificationByTarget = new Map((semantic?.verifications ?? []).map((item) => [item.entrypointId, item]));
  const prioritized = evidence.impactAssessment.items.filter((item) => item.tier === "primary" || item.tier === "secondary");
  if (prioritized.length) {
    lines.push("### What to verify before merging", "");
    for (const [index, item] of prioritized.entries()) {
      const targetId = targetIdFor(item);
      const checks = verificationByTarget.get(targetId)?.checks ?? [];
      lines.push(`${index + 1}. **${displayEntrypoint(item)}**`);
      if (checks.length) lines.push(...checks.map((check) => `   - ${check.text}`));
      else lines.push(`   - ${fallbackVerification(item, semantic, semanticInput)}`);
      lines.push(`   - Why: ${humanImpactReason(item, evidence)}`, "");
    }
  }

  const technical = evidence.impactAssessment.items.filter((item) => item.tier === "technical_only");
  if (technical.length) {
    lines.push("### Technical impact", "", ...technical.map((item) => `- ${item.reason}`), "");
  }
  const evidenceOnly = evidence.impactAssessment.items.filter((item) => item.tier === "evidence_only");
  if (evidenceOnly.length) lines.push("### Evidence requiring manual review", "", ...evidenceOnly.map((item) => `- ${item.reason}`), "");

  lines.push(...renderTechnicalEvidence(evidence), "", footer(evidence));
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

function humanImpactReason(item: ImpactAssessmentItem, evidence: ReportEvidence): string {
  const route = item.kind === "page" ? "page" : "API endpoint";
  if (item.impact === "direct") return `This ${route} changed directly.`;
  const symbol = evidence.changedSymbols.find((candidate) => candidate.filePath === item.changedSeedPath);
  const source = symbol ? `modified \`${symbol.name}\` ${symbolNoun(symbol.name, item.technicalRole)}` : `modified \`${item.changedSeedPath}\``;
  if (item.dependencyPath.length === 2) return `This ${route} imports the ${source}.`;
  const bridge = item.dependencyPath[1];
  return bridge ? `The ${source} is used by this ${route} through \`${bridge}\`.` : `The ${source} is used by this ${route}.`;
}

function symbolNoun(name: string, role: ImpactAssessmentItem["technicalRole"]): string {
  if (role === "presentation") return "component";
  if (role === "utility") return "helper";
  if (role === "application") return "module";
  return name.endsWith("Service") ? "service" : "module";
}

function fallbackVerification(item: ImpactAssessmentItem, semantic: PrSemanticResult | null, input: PrSemanticInput | undefined): string {
  const hunkPath = new Map(input?.changedHunks.map((hunk) => [hunk.id, hunk.path]) ?? []);
  const summary = semantic?.changeSummaries.find((candidate) => candidate.hunkIds.some((id) => hunkPath.get(id) === item.changedSeedPath));
  if (summary) return `Confirm this changed behavior: ${summary.summary}`;
  return `Review the user-visible behavior on this ${item.kind === "page" ? "page" : "API endpoint"}.`;
}

/**
 * Keeps audit data available without making every PR comment a dependency-list
 * scroll. The graph derives solely from deterministic verified paths.
 */
function renderTechnicalEvidence(evidence: ReportEvidence): string[] {
  const affectedCount = evidence.affectedItems.length;
  const noun = affectedCount === 1 ? "affected file" : "affected files";
  const lines = [
    "<details>",
    "",
    `<summary>Technical evidence · ${affectedCount} ${noun} · ${evidence.unresolvedImportCount} unresolved import(s)</summary>`,
    "",
    "### Impact map",
    "",
    "```mermaid",
    ...renderImpactMap(evidence),
    "```",
    "",
    "Red = changed source · Blue = affected route/API · Dashed gray = technical-only reachability.",
  ];
  if (evidence.changedSymbols.length) lines.push("", "**Changed symbols**", ...evidence.changedSymbols.map((symbol) => `- ${symbol.changeKind}: \`${symbol.name}\` in \`${symbol.filePath}\``));
  lines.push("", `- ${evidence.unresolvedImportCount} unresolved import(s)`, "", "</details>");
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
    for (const path of candidateNodes) nodes.add(path);
    paths.push(item);
  }
  if (!paths.length) return ["flowchart LR", '  empty["No route or API impact path is available."]'];

  const nodeIds = new Map([...nodes].sort((left, right) => left.localeCompare(right)).map((path, index) => [path, `n${index + 1}`]));
  const lines = ["flowchart LR"];
  for (const [path, id] of nodeIds) lines.push(`  ${id}["${mermaidNodeLabel(path, evidence, paths)}"]`);

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
  return [...new Set(paths.map((path) => nodeIds.get(path)).filter((id): id is string => Boolean(id)))];
}

function mermaidNodeLabel(path: string, evidence: ReportEvidence, items: ImpactAssessmentItem[]): string {
  const entrypoint = items.find((item) => item.path === path);
  if (entrypoint) return mermaidLabel(`${displayEntrypoint(entrypoint)} (${entrypoint.kind === "page" ? "page" : "API"})`);
  const symbol = evidence.changedSymbols.find((candidate) => candidate.filePath === path);
  if (symbol) return mermaidLabel(`${symbol.name} (changed)`);
  const changed = items.some((item) => item.changedSeedPath === path);
  const compactPath = path.replace(/^src\//, "").replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
  return mermaidLabel(changed ? `${compactPath} (changed)` : compactPath);
}

function mermaidLabel(value: string): string {
  return value.replace(/["\\]/g, "").replace(/[\r\n]/g, " ");
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

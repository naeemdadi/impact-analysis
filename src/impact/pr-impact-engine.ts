import { isGraphFilePath } from "../graph/baseline-graph-builder.js";
import type { BaselineGraph, CommitFileChange, GraphFile, GraphSymbol } from "../graph/types.js";
import type {
  AffectedItem,
  ChangedFile,
  ChangedSymbol,
  DeterministicPrAnalysis,
  ImpactLevel,
  ProductImpactKind,
  PullRequestAnalysisRequest,
} from "./pr-impact-types.js";

const productKinds = new Set<ProductImpactKind>(["page", "api_route", "component", "shared_module"]);

export function createInsufficientAnalysis(
  request: PullRequestAnalysisRequest,
  reason: string,
  changes: CommitFileChange[] = [],
): DeterministicPrAnalysis {
  return {
    status: "insufficient_evidence",
    repoId: request.repoId,
    pullRequestNumber: request.pullRequestNumber,
    baseSha: request.baseSha,
    headSha: request.headSha,
    impactLevel: null,
    changedFiles: toChangedFiles(changes),
    changedSymbols: [],
    affectedItems: [],
    unresolvedImportCount: 0,
    insufficientReason: reason,
  };
}

/**
 * Produces deterministic file-level evidence. Symbols identify what changed,
 * but traversal deliberately follows only persisted file import edges.
 */
export function analyzePrImpact(input: {
  request: PullRequestAnalysisRequest;
  baseGraph: BaselineGraph;
  headGraph: BaselineGraph;
  changes: CommitFileChange[];
}): DeterministicPrAnalysis {
  const changedFiles = toChangedFiles(input.changes);
  const changedSymbols = compareSymbols(input.baseGraph.symbols, input.headGraph.symbols, changedFiles);
  const headFiles = new Map(input.headGraph.files.map((file) => [file.path, file]));
  const baseFiles = new Map(input.baseGraph.files.map((file) => [file.path, file]));
  const headEntrypoints = entrypointsByFile(input.headGraph);
  const baseEntrypoints = entrypointsByFile(input.baseGraph);
  const candidates = new Map<string, AffectedItem>();

  for (const change of changedFiles) {
    if (!change.graphRelevant) continue;
    const headFile = headFiles.get(change.path);
    if (headFile) addTraversal(candidates, headFile.path, input.headGraph, headEntrypoints, "direct");
    // A removed source file has no node in the PR-head graph. Its old reverse
    // edges are still valid evidence of what the removal can affect.
    if (change.status === "removed" && baseFiles.has(change.path)) {
      addTraversal(candidates, change.path, input.baseGraph, baseEntrypoints, "direct");
    }
  }

  const affectedItems = [...candidates.values()].sort(compareAffectedItems);
  const entrypointCount = affectedItems.filter((item) => item.kind === "page" || item.kind === "api_route").length;
  const changedRoute = changedFiles.some((change) => {
    const file = headFiles.get(change.path) ?? (change.status === "removed" ? baseFiles.get(change.path) : undefined);
    return Boolean((headEntrypoints.get(change.path) ?? baseEntrypoints.get(change.path))?.length) || file?.kind === "page" || file?.kind === "api_route";
  });

  return {
    status: "ready",
    repoId: input.request.repoId,
    pullRequestNumber: input.request.pullRequestNumber,
    baseSha: input.request.baseSha,
    headSha: input.request.headSha,
    impactLevel: classifyImpactLevel(entrypointCount, changedRoute),
    changedFiles,
    changedSymbols,
    affectedItems,
    unresolvedImportCount: input.headGraph.imports.filter((entry) => entry.resolutionStatus === "unresolved").length,
    insufficientReason: null,
  };
}

function toChangedFiles(changes: CommitFileChange[]): ChangedFile[] {
  return [...changes]
    .map((change) => ({ ...change, graphRelevant: isGraphFilePath(change.path) || isGraphFilePath(change.previousPath ?? "") }))
    .sort((left, right) => left.path.localeCompare(right.path) || left.status.localeCompare(right.status));
}

function compareSymbols(baseSymbols: GraphSymbol[], headSymbols: GraphSymbol[], changedFiles: ChangedFile[]): ChangedSymbol[] {
  const relevantPaths = new Set<string>();
  for (const file of changedFiles) {
    if (!file.graphRelevant) continue;
    relevantPaths.add(file.path);
    if (file.previousPath) relevantPaths.add(file.previousPath);
  }
  const baseByKey = new Map(baseSymbols.filter((symbol) => relevantPaths.has(symbol.filePath)).map((symbol) => [symbol.symbolKey, symbol]));
  const headByKey = new Map(headSymbols.filter((symbol) => relevantPaths.has(symbol.filePath)).map((symbol) => [symbol.symbolKey, symbol]));
  const keys = [...new Set([...baseByKey.keys(), ...headByKey.keys()])].sort();
  const results: ChangedSymbol[] = [];
  for (const key of keys) {
    const before = baseByKey.get(key);
    const after = headByKey.get(key);
    if (!before && after) results.push(toChangedSymbol("added", after));
    else if (before && !after) results.push(toChangedSymbol("deleted", before));
    else if (before && after && before.sourceHash !== after.sourceHash) results.push(toChangedSymbol("modified", after));
  }
  return results;
}

function toChangedSymbol(changeKind: ChangedSymbol["changeKind"], symbol: GraphSymbol): ChangedSymbol {
  return { changeKind, filePath: symbol.filePath, symbolKey: symbol.symbolKey, name: symbol.name, kind: symbol.kind };
}

function addTraversal(candidates: Map<string, AffectedItem>, seedPath: string, graph: BaselineGraph, entrypoints: Map<string, NonNullable<BaselineGraph["entrypoints"]>[number][]>, seedImpact: "direct"): void {
  const files = new Map(graph.files.map((file) => [file.path, file]));
  if (!files.has(seedPath)) return;
  const dependents = new Map<string, string[]>();
  for (const edge of graph.imports) {
    if (edge.resolutionStatus !== "resolved" || !edge.toPath) continue;
    dependents.set(edge.toPath, [...(dependents.get(edge.toPath) ?? []), edge.fromPath]);
  }
  for (const binding of graph.protocolBindings ?? []) {
    dependents.set(binding.handlerFilePath, [...(dependents.get(binding.handlerFilePath) ?? []), binding.callerFilePath]);
  }
  for (const paths of dependents.values()) paths.sort();

  const queue: Array<{ path: string; dependencyPath: string[] }> = [{ path: seedPath, dependencyPath: [seedPath] }];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.path)) continue;
    visited.add(current.path);
    const file = files.get(current.path);
    if (!file) continue;
    const impact = current.path === seedPath ? seedImpact : "indirect";
    for (const entrypoint of entrypoints.get(file.path) ?? []) {
      const kind: Extract<ProductImpactKind, "page" | "api_route"> = entrypoint.kind === "web_route" ? "page" : "api_route";
      const candidate: AffectedItem = { path: file.path, kind, projectRoot: entrypoint.projectRoot, routePath: entrypoint.routePath, httpMethod: entrypoint.httpMethod, entrypointReason: entrypoint.reason, impact, dependencyPath: current.dependencyPath };
      const key = entrypointIdentity(candidate);
      const prior = candidates.get(key);
      if (!prior || shouldReplaceAffected(prior, candidate)) candidates.set(key, candidate);
    }
    if ((entrypoints.get(file.path) ?? []).length === 0 && productKinds.has(file.kind as ProductImpactKind)) {
      const candidate: AffectedItem = { path: file.path, kind: file.kind as ProductImpactKind, impact, dependencyPath: current.dependencyPath };
      const prior = candidates.get(file.path);
      if (!prior || shouldReplaceAffected(prior, candidate)) candidates.set(file.path, candidate);
    }
    for (const dependent of dependents.get(current.path) ?? []) {
      if (!visited.has(dependent)) queue.push({ path: dependent, dependencyPath: [...current.dependencyPath, dependent] });
    }
  }
}

function shouldReplaceAffected(previous: AffectedItem, next: AffectedItem): boolean {
  if (previous.impact !== next.impact) return next.impact === "direct";
  if (previous.dependencyPath.length !== next.dependencyPath.length) return next.dependencyPath.length < previous.dependencyPath.length;
  return next.dependencyPath.join("\u0000") < previous.dependencyPath.join("\u0000");
}

function classifyImpactLevel(entrypointCount: number, changedRoute: boolean): ImpactLevel {
  if (entrypointCount >= 2) return "high";
  if (changedRoute) return "medium";
  return "low";
}

function compareAffectedItems(left: AffectedItem, right: AffectedItem): number {
  return left.kind.localeCompare(right.kind) || (left.projectRoot ?? "").localeCompare(right.projectRoot ?? "") || (left.routePath ?? left.path).localeCompare(right.routePath ?? right.path) || left.path.localeCompare(right.path);
}

function entrypointsByFile(graph: BaselineGraph): Map<string, NonNullable<BaselineGraph["entrypoints"]>> {
  const result = new Map<string, NonNullable<BaselineGraph["entrypoints"]>>();
  for (const entrypoint of graph.entrypoints ?? []) result.set(entrypoint.filePath, [...(result.get(entrypoint.filePath) ?? []), entrypoint]);
  return result;
}
function entrypointIdentity(item: AffectedItem): string { return [item.projectRoot ?? "", item.kind, item.httpMethod ?? "", item.routePath ?? item.path].join("\u0000"); }

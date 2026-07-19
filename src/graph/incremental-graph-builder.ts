import { buildGraphForFiles, isGraphFilePath } from "./baseline-graph-builder.js";
import type { BaselineGraph, CommitFileChange, RepositorySource } from "./types.js";

export interface IncrementalGraphBuild {
  graph: BaselineGraph;
  changedFileCount: number;
  reanalyzedPaths: string[];
}

/**
 * Replaces facts only where a changed module can affect the dependency graph.
 * The caller supplies target-SHA blobs for every returned reanalyzed path.
 */
export function buildIncrementalGraph(input: {
  previousGraph: BaselineGraph;
  targetSource: RepositorySource;
  changes: CommitFileChange[];
}): IncrementalGraphBuild {
  const targetPaths = new Set((input.targetSource.allFilePaths ?? input.targetSource.files.map((file) => file.path)).filter(isGraphFilePath));
  const { changedFileCount, reanalyzedPaths } = determineReanalyzedPaths(input.previousGraph, targetPaths, input.changes);
  const reanalyzed = new Set(reanalyzedPaths);
  const fresh = buildGraphForFiles(input.targetSource, reanalyzedPaths);
  const retainedPaths = new Set([...targetPaths].filter((path) => !reanalyzed.has(path)));
  const graph: BaselineGraph = {
    projects: fresh.projects,
    files: [...input.previousGraph.files.filter((file) => retainedPaths.has(file.path)), ...fresh.files].sort(byPath),
    symbols: [...input.previousGraph.symbols.filter((symbol) => retainedPaths.has(symbol.filePath)), ...fresh.symbols],
    imports: [...input.previousGraph.imports.filter((edge) => retainedPaths.has(edge.fromPath)), ...fresh.imports],
    entrypoints: [
      ...(input.previousGraph.entrypoints ?? []).filter((entrypoint) => retainedPaths.has(entrypoint.filePath)),
      ...(fresh.entrypoints ?? []),
    ].sort((left, right) => left.projectRoot.localeCompare(right.projectRoot) || left.routePath.localeCompare(right.routePath)),
    // A changed caller is recomputed. Bindings remain valid when only the
    // server procedure body changes; removing/renaming a procedure forces the
    // surrounding graph update to replace its handler file and later full
    // rebuild safeguards cover topology/configuration changes.
    protocolBindings: [
      ...(input.previousGraph.protocolBindings ?? []).filter((binding) => !reanalyzed.has(binding.callerFilePath) && targetPaths.has(binding.handlerFilePath)),
      ...(fresh.protocolBindings ?? []),
    ].sort((left, right) => left.callerFilePath.localeCompare(right.callerFilePath) || left.operation.localeCompare(right.operation)),
  };
  return { graph, changedFileCount, reanalyzedPaths };
}

export function determineReanalyzedPaths(previousGraph: BaselineGraph, targetPaths: Set<string>, changes: CommitFileChange[]): { changedFileCount: number; reanalyzedPaths: string[] } {
  const changedPaths = new Set<string>();
  const oldPaths = new Set<string>();
  let mayResolvePreviouslyUnresolved = false;

  for (const change of changes) {
    if (!isGraphFilePath(change.path) && !isGraphFilePath(change.previousPath ?? "")) continue;
    changedPaths.add(change.path);
    if (change.previousPath) oldPaths.add(change.previousPath);
    if (change.status === "added" || change.status === "renamed") mayResolvePreviouslyUnresolved = true;
  }

  const reanalyzed = new Set<string>();
  for (const changedPath of changedPaths) if (targetPaths.has(changedPath)) reanalyzed.add(changedPath);
  for (const oldPath of oldPaths) {
    for (const edge of previousGraph.imports) if (edge.toPath === oldPath) reanalyzed.add(edge.fromPath);
  }
  for (const changedPath of changedPaths) {
    for (const edge of previousGraph.imports) if (edge.toPath === changedPath) reanalyzed.add(edge.fromPath);
  }
  if (mayResolvePreviouslyUnresolved) {
    for (const edge of previousGraph.imports) {
      if (edge.resolutionStatus === "unresolved") reanalyzed.add(edge.fromPath);
    }
  }
  for (const path of [...reanalyzed]) if (!targetPaths.has(path)) reanalyzed.delete(path);

  return { changedFileCount: changedPaths.size, reanalyzedPaths: [...reanalyzed].sort() };
}

function byPath(left: { path: string }, right: { path: string }): number {
  return left.path.localeCompare(right.path);
}

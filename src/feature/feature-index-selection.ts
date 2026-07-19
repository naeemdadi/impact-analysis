import type { BaselineGraph } from "../graph/types.js";
import type { FeatureIndexRequest } from "./feature-types.js";
import { isAiContextExcludedPath } from "./feature-context.js";

/** Selects only route/API cards that can be reached by reverse imports from the push's reanalyzed paths. */
export function selectFeatureIndexEntrypoints(graph: BaselineGraph, allEntrypoints: BaselineGraph["files"], request: FeatureIndexRequest): BaselineGraph["files"] {
  // Full builds and legacy jobs without paths retain the safe all-entrypoint behavior.
  if (request.mode === "full" || !request.changedPaths?.length) return allEntrypoints;
  const dependents = new Map<string, string[]>();
  for (const edge of graph.imports) {
    if (edge.resolutionStatus !== "resolved" || !edge.toPath) continue;
    dependents.set(edge.toPath, [...(dependents.get(edge.toPath) ?? []), edge.fromPath]);
  }
  const reachable = new Set<string>();
  const queue = [...new Set(request.changedPaths)].sort();
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (reachable.has(path)) continue;
    reachable.add(path);
    for (const dependent of (dependents.get(path) ?? []).sort()) if (!reachable.has(dependent)) queue.push(dependent);
  }
  return allEntrypoints.filter((entrypoint) => reachable.has(entrypoint.path));
}

/** Gets the minimal source set required to rebuild contexts for selected cards. */
export function collectFeatureContextPaths(graph: BaselineGraph, entryPaths: string[]): string[] {
  const dependencies = new Map<string, string[]>();
  const files = new Map(graph.files.map((file) => [file.path, file]));
  for (const edge of graph.imports) {
    if (edge.resolutionStatus !== "resolved" || !edge.toPath) continue;
    dependencies.set(edge.fromPath, [...(dependencies.get(edge.fromPath) ?? []), edge.toPath]);
  }
  const paths = new Set<string>();
  const queue = [...entryPaths].sort();
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (paths.has(path)) continue;
    const file = files.get(path);
    if (!file || file.kind === "tooling" || isAiContextExcludedPath(path)) continue;
    paths.add(path);
    for (const dependency of (dependencies.get(path) ?? []).sort()) if (!paths.has(dependency)) queue.push(dependency);
  }
  return [...paths].sort();
}

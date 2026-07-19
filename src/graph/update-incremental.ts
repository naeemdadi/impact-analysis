import { buildAndPersistBaselineGraph } from "./build-baseline.js";
import { isGraphFilePath } from "./baseline-graph-builder.js";
import { buildIncrementalGraph, determineReanalyzedPaths } from "./incremental-graph-builder.js";
import { createBuildingSnapshot, findReadySnapshotByIdentity, loadReadyGraphByIdentity, markSnapshotFailed, persistReadySnapshot } from "./snapshot-repository.js";
import { getRepoConfig, updateRepoIdentity } from "../storage/repo-config-repo.js";
import type { IncrementalGraphUpdateRequest, IncrementalGraphUpdateResult, RepositoryReader, RepositorySource, SupersededGraphUpdateResult } from "./types.js";
import { errorMessage, log } from "../server/logger.js";

const zeroSha = /^0+$/;

export async function updateGraphIncrementally(
  request: IncrementalGraphUpdateRequest,
  repositoryReader: RepositoryReader,
): Promise<IncrementalGraphUpdateResult | SupersededGraphUpdateResult | null> {
  if (zeroSha.test(request.afterSha)) {
    log("info", "incremental graph update skipped for deleted branch", { repoId: request.repoId, branch: request.branch, beforeSha: request.beforeSha });
    return null;
  }
  const startedAt = Date.now();
  log("info", "incremental graph update started", { repoId: request.repoId, branch: request.branch, beforeSha: request.beforeSha, afterSha: request.afterSha });
  const config = await getRepoConfig(request.repoId);
  if (!config) throw new Error(`repository configuration not found for ${request.repoId}`);
  if (!config.isActive) throw new Error(`repository ${request.repoId} is inactive`);
  if (request.branch !== config.trackedBranch) throw new Error(`push branch ${request.branch} is not tracked for repository ${request.repoId}`);

  const identity = config.owner && config.name ? { owner: config.owner, name: config.name } : await repositoryReader.resolveRepository(config.repoId, config.installationId);
  if (!config.owner || !config.name) await updateRepoIdentity(config.repoId, identity.owner, identity.name);
  const githubInput = { repoId: config.repoId, installationId: config.installationId, owner: identity.owner, name: identity.name, branch: request.branch };
  const liveSha = await repositoryReader.resolveBranchSha(githubInput);
  if (liveSha !== request.afterSha) {
    log("info", "incremental graph update superseded", { repoId: request.repoId, branch: request.branch, afterSha: request.afterSha, liveSha });
    return { status: "superseded", liveSha };
  }
  const ready = await findReadySnapshotByIdentity({ repoId: request.repoId, branch: request.branch, sha: request.afterSha });
  if (ready) {
    log("info", "incremental graph update reused current snapshot", { repoId: request.repoId, branch: request.branch, afterSha: request.afterSha, snapshotId: ready.snapshotId });
    return { ...ready, featureIndexPaths: [] };
  }

  const comparison = await repositoryReader.compareCommits({ ...githubInput, beforeSha: request.beforeSha, afterSha: request.afterSha });
  const forcedFallback = !comparison.comparable
    ? comparison.reason ?? "commit comparison unavailable"
    : comparison.changes.some((change) => isTsconfigPath(change.path) || isTsconfigPath(change.previousPath ?? ""))
      ? "tsconfig.json changed"
      : null;
  if (forcedFallback) {
    log("warn", "incremental graph update using full fallback", { repoId: request.repoId, branch: request.branch, afterSha: request.afterSha, reason: forcedFallback, changedFileCount: comparison.changes.length });
    return fullFallback(request, repositoryReader, forcedFallback, comparison.changes.map((change) => change.path));
  }

  const base = await loadReadyGraphByIdentity({ repoId: request.repoId, branch: request.branch, sha: request.beforeSha });
  if (!base) {
    const reason = "ready snapshot for before SHA is missing";
    log("warn", "incremental graph update using full fallback", { repoId: request.repoId, branch: request.branch, afterSha: request.afterSha, reason, changedFileCount: comparison.changes.length });
    return fullFallback(request, repositoryReader, reason, comparison.changes.map((change) => change.path));
  }

  try {
    const tree = await repositoryReader.fetchTree({ ...githubInput, sha: request.afterSha });
    const targetPaths = tree.map((entry) => entry.path);
    const provisional = determineReanalyzedPaths(base.graph, new Set(targetPaths.filter(isGraphFilePath)), comparison.changes);
    log("info", "incremental graph analysis planned", { repoId: request.repoId, branch: request.branch, afterSha: request.afterSha, changedFileCount: provisional.changedFileCount, reanalyzedFileCount: provisional.reanalyzedPaths.length });
    const requiredPaths = [...new Set(["tsconfig.json", ...provisional.reanalyzedPaths])];
    const files = await repositoryReader.fetchFiles({ ...githubInput, sha: request.afterSha, paths: requiredPaths });
    const targetSource: RepositorySource = { ...emptyTargetSource(githubInput, request.afterSha, targetPaths), files };
    const incremental = buildIncrementalGraph({ previousGraph: base.graph, targetSource, changes: comparison.changes });
    const snapshotId = await createBuildingSnapshot({
      repoId: request.repoId, branch: request.branch, sha: request.afterSha,
      metadata: { buildMode: "incremental", baseSnapshotId: base.snapshotId, changedFileCount: incremental.changedFileCount, reanalyzedFileCount: incremental.reanalyzedPaths.length },
    });
    try {
      const result = await persistReadySnapshot({
        snapshotId, repoId: request.repoId, branch: request.branch, sha: request.afterSha, graph: incremental.graph,
        buildDurationMs: Date.now() - startedAt,
        metadata: { buildMode: "incremental", baseSnapshotId: base.snapshotId, changedFileCount: incremental.changedFileCount, reanalyzedFileCount: incremental.reanalyzedPaths.length },
      });
      log("info", "incremental graph update completed", { repoId: result.repoId, branch: result.branch, afterSha: result.sha, snapshotId: result.snapshotId, buildMode: result.buildMode, changedFileCount: result.changedFileCount, reanalyzedFileCount: result.reanalyzedFileCount, durationMs: result.buildDurationMs });
      return { ...result, featureIndexPaths: featureIndexPaths(comparison.changes, incremental.reanalyzedPaths) };
    } catch (error) {
      await markSnapshotFailed(snapshotId, error instanceof Error ? error.message : "incremental snapshot persistence failed", Date.now() - startedAt);
      throw error;
    }
  } catch (error) {
    const reason = errorMessage(error);
    log("warn", "incremental graph analysis failed; retrying as full build", { repoId: request.repoId, branch: request.branch, afterSha: request.afterSha, durationMs: Date.now() - startedAt, error: reason });
    return fullFallback(request, repositoryReader, reason, comparison.changes.map((change) => change.path));
  }
}

async function fullFallback(request: IncrementalGraphUpdateRequest, repositoryReader: RepositoryReader, reason: string, changedPaths: string[]): Promise<IncrementalGraphUpdateResult> {
  const result = await buildAndPersistBaselineGraph({
    repoId: request.repoId, sha: request.afterSha, reuseReadySnapshot: true,
    buildMetadata: { buildMode: "full_fallback", fallbackReason: reason, changedFileCount: changedPaths.length },
  }, repositoryReader);
  return { ...result, featureIndexPaths: changedPaths };
}

function featureIndexPaths(changes: Array<{ path: string; previousPath?: string }>, reanalyzedPaths: string[]): string[] {
  return [...new Set([...reanalyzedPaths, ...changes.flatMap((change) => [change.path, ...(change.previousPath ? [change.previousPath] : [])])])].sort();
}

function emptyTargetSource(identity: { repoId: number; owner: string; name: string; branch: string }, sha: string, allFilePaths: string[]): RepositorySource {
  return { ...identity, sha, allFilePaths, files: [] };
}

function isTsconfigPath(path: string): boolean {
  return /(^|\/)tsconfig(?:\.[^/]+)?\.json$/.test(path);
}

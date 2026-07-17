import { buildAndPersistBaselineGraph } from "./build-baseline.js";
import { isGraphFilePath } from "./baseline-graph-builder.js";
import { buildIncrementalGraph, determineReanalyzedPaths } from "./incremental-graph-builder.js";
import { createBuildingSnapshot, findReadySnapshotByIdentity, loadReadyGraphByIdentity, markSnapshotFailed, persistReadySnapshot } from "./snapshot-repository.js";
import { getRepoConfig, updateRepoIdentity } from "../storage/repo-config-repo.js";
import type { BaselineBuildResult, IncrementalGraphUpdateRequest, RepositoryReader, RepositorySource, SupersededGraphUpdateResult } from "./types.js";

const zeroSha = /^0+$/;

export async function updateGraphIncrementally(
  request: IncrementalGraphUpdateRequest,
  repositoryReader: RepositoryReader,
): Promise<BaselineBuildResult | SupersededGraphUpdateResult | null> {
  if (zeroSha.test(request.afterSha)) return null;
  const startedAt = Date.now();
  const config = await getRepoConfig(request.repoId);
  if (!config) throw new Error(`repository configuration not found for ${request.repoId}`);
  if (!config.isActive) throw new Error(`repository ${request.repoId} is inactive`);
  if (request.branch !== config.trackedBranch) throw new Error(`push branch ${request.branch} is not tracked for repository ${request.repoId}`);

  const identity = config.owner && config.name ? { owner: config.owner, name: config.name } : await repositoryReader.resolveRepository(config.repoId, config.installationId);
  if (!config.owner || !config.name) await updateRepoIdentity(config.repoId, identity.owner, identity.name);
  const githubInput = { repoId: config.repoId, installationId: config.installationId, owner: identity.owner, name: identity.name, branch: request.branch };
  const liveSha = await repositoryReader.resolveBranchSha(githubInput);
  if (liveSha !== request.afterSha) return { status: "superseded", liveSha };
  const ready = await findReadySnapshotByIdentity({ repoId: request.repoId, branch: request.branch, sha: request.afterSha });
  if (ready) return ready;

  const comparison = await repositoryReader.compareCommits({ ...githubInput, beforeSha: request.beforeSha, afterSha: request.afterSha });
  const forcedFallback = !comparison.comparable
    ? comparison.reason ?? "commit comparison unavailable"
    : comparison.changes.some((change) => isTsconfigPath(change.path) || isTsconfigPath(change.previousPath ?? ""))
      ? "tsconfig.json changed"
      : null;
  if (forcedFallback) return fullFallback(request, repositoryReader, forcedFallback, comparison.changes.length);

  const base = await loadReadyGraphByIdentity({ repoId: request.repoId, branch: request.branch, sha: request.beforeSha });
  if (!base) return fullFallback(request, repositoryReader, "ready snapshot for before SHA is missing", comparison.changes.length);

  try {
    const tree = await repositoryReader.fetchTree({ ...githubInput, sha: request.afterSha });
    const targetPaths = tree.map((entry) => entry.path);
    const provisional = determineReanalyzedPaths(base.graph, new Set(targetPaths.filter(isGraphFilePath)), comparison.changes);
    const requiredPaths = [...new Set(["tsconfig.json", ...provisional.reanalyzedPaths])];
    const files = await repositoryReader.fetchFiles({ ...githubInput, sha: request.afterSha, paths: requiredPaths });
    const targetSource: RepositorySource = { ...emptyTargetSource(githubInput, request.afterSha, targetPaths), files };
    const incremental = buildIncrementalGraph({ previousGraph: base.graph, targetSource, changes: comparison.changes });
    const snapshotId = await createBuildingSnapshot({
      repoId: request.repoId, branch: request.branch, sha: request.afterSha,
      metadata: { buildMode: "incremental", baseSnapshotId: base.snapshotId, changedFileCount: incremental.changedFileCount, reanalyzedFileCount: incremental.reanalyzedPaths.length },
    });
    try {
      return await persistReadySnapshot({
        snapshotId, repoId: request.repoId, branch: request.branch, sha: request.afterSha, graph: incremental.graph,
        buildDurationMs: Date.now() - startedAt,
        metadata: { buildMode: "incremental", baseSnapshotId: base.snapshotId, changedFileCount: incremental.changedFileCount, reanalyzedFileCount: incremental.reanalyzedPaths.length },
      });
    } catch (error) {
      await markSnapshotFailed(snapshotId, error instanceof Error ? error.message : "incremental snapshot persistence failed", Date.now() - startedAt);
      throw error;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "incremental analysis failed";
    return fullFallback(request, repositoryReader, reason, comparison.changes.length);
  }
}

function fullFallback(request: IncrementalGraphUpdateRequest, repositoryReader: RepositoryReader, reason: string, changedFileCount: number): Promise<BaselineBuildResult> {
  return buildAndPersistBaselineGraph({
    repoId: request.repoId, sha: request.afterSha, reuseReadySnapshot: true,
    buildMetadata: { buildMode: "full_fallback", fallbackReason: reason, changedFileCount },
  }, repositoryReader);
}

function emptyTargetSource(identity: { repoId: number; owner: string; name: string; branch: string }, sha: string, allFilePaths: string[]): RepositorySource {
  return { ...identity, sha, allFilePaths, files: [] };
}

function isTsconfigPath(path: string): boolean {
  return /(^|\/)tsconfig(?:\.[^/]+)?\.json$/.test(path);
}

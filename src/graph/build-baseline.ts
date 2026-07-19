import { buildBaselineGraph, UnsupportedRepositoryError } from "./baseline-graph-builder.js";
import {
  createBuildingSnapshot,
  findReadySnapshotByIdentity,
  markSnapshotFailed,
  markSnapshotUnsupported,
  persistReadySnapshot,
} from "./snapshot-repository.js";
import { getRepoConfig, updateRepoIdentity } from "../storage/repo-config-repo.js";
import type { BaselineBuildRequest, BaselineBuildResult, RepositoryReader } from "./types.js";
import { errorMessage, log } from "../server/logger.js";

export async function buildAndPersistBaselineGraph(
  request: BaselineBuildRequest,
  repositoryReader: RepositoryReader,
): Promise<BaselineBuildResult> {
  const startedAt = Date.now();
  log("info", "baseline graph build started", { repoId: request.repoId, requestedSha: request.sha ?? null, reuseReadySnapshot: Boolean(request.reuseReadySnapshot), buildMode: request.buildMetadata?.buildMode ?? "full" });
  const config = await getRepoConfig(request.repoId);
  if (!config) throw new Error(`repository configuration not found for ${request.repoId}`);
  if (!config.isActive) throw new Error(`repository ${request.repoId} is inactive`);

  const identity =
    config.owner && config.name
      ? { owner: config.owner, name: config.name }
      : await repositoryReader.resolveRepository(config.repoId, config.installationId);
  if (!config.owner || !config.name) await updateRepoIdentity(config.repoId, identity.owner, identity.name);

  const sha =
    request.sha ??
    (await repositoryReader.resolveBranchSha({
      repoId: config.repoId,
      installationId: config.installationId,
      owner: identity.owner,
      name: identity.name,
      branch: config.trackedBranch,
    }));
  if (request.reuseReadySnapshot) {
    const existing = await findReadySnapshotByIdentity({
      repoId: config.repoId,
      branch: config.trackedBranch,
      sha,
    });
    if (existing) {
      log("info", "baseline graph build reused current snapshot", { repoId: config.repoId, branch: config.trackedBranch, sha, snapshotId: existing.snapshotId });
      return existing;
    }
  }
  const snapshotId = await createBuildingSnapshot({
    repoId: config.repoId,
    branch: config.trackedBranch,
    sha,
  });

  try {
    const source = await repositoryReader.fetchSource({
      repoId: config.repoId,
      installationId: config.installationId,
      owner: identity.owner,
      name: identity.name,
      branch: config.trackedBranch,
      sha,
    });
    log("info", "baseline graph source fetched", { repoId: config.repoId, branch: config.trackedBranch, sha, sourceFileCount: source.files.length, treePathCount: source.allFilePaths?.length ?? source.files.length });
    const graph = buildBaselineGraph(source);
    log("info", "baseline graph source analyzed", { repoId: config.repoId, branch: config.trackedBranch, sha, fileCount: graph.files.length, symbolCount: graph.symbols.length, importCount: graph.imports.length });
    const result = await persistReadySnapshot({
      snapshotId,
      repoId: config.repoId,
      branch: config.trackedBranch,
      sha,
      graph,
      buildDurationMs: Date.now() - startedAt,
      metadata: {
        buildMode: request.buildMetadata?.buildMode ?? "full",
        changedFileCount: request.buildMetadata?.changedFileCount ?? 0,
        reanalyzedFileCount: graph.files.length,
        fallbackReason: request.buildMetadata?.fallbackReason ?? null,
      },
    });
    log("info", "baseline graph build completed", { repoId: result.repoId, branch: result.branch, sha: result.sha, snapshotId: result.snapshotId, fileCount: result.fileCount, symbolCount: result.symbolCount, importCount: result.importCount, unresolvedImportCount: result.unresolvedImportCount, durationMs: result.buildDurationMs, buildMode: result.buildMode });
    return result;
  } catch (error) {
    const message = errorMessage(error);
    if (error instanceof UnsupportedRepositoryError) await markSnapshotUnsupported(snapshotId, message, Date.now() - startedAt);
    else await markSnapshotFailed(snapshotId, message, Date.now() - startedAt);
    log("error", "baseline graph build failed", { repoId: request.repoId, snapshotId, requestedSha: request.sha ?? null, durationMs: Date.now() - startedAt, error: message, unsupported: error instanceof UnsupportedRepositoryError });
    throw error;
  }
}

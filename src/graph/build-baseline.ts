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

export async function buildAndPersistBaselineGraph(
  request: BaselineBuildRequest,
  repositoryReader: RepositoryReader,
): Promise<BaselineBuildResult> {
  const startedAt = Date.now();
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
    if (existing) return existing;
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
    const graph = buildBaselineGraph(source);
    return await persistReadySnapshot({
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown baseline graph build error";
    if (error instanceof UnsupportedRepositoryError) await markSnapshotUnsupported(snapshotId, message, Date.now() - startedAt);
    else await markSnapshotFailed(snapshotId, message, Date.now() - startedAt);
    throw error;
  }
}

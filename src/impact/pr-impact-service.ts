import { buildBaselineGraph, isGraphFilePath, UnsupportedRepositoryError } from "../graph/baseline-graph-builder.js";
import { buildIncrementalGraph, determineReanalyzedPaths } from "../graph/incremental-graph-builder.js";
import { loadReadyGraphByIdentity } from "../graph/snapshot-repository.js";
import type { BaselineGraph, CommitFileChange, RepositoryReader, RepositorySource } from "../graph/types.js";
import { getRepoConfig, updateRepoIdentity } from "../storage/repo-config-repo.js";
import { analyzePrImpact, createInsufficientAnalysis } from "./pr-impact-engine.js";
import type { DeterministicPrAnalysis, PullRequestAnalysisRequest } from "./pr-impact-types.js";
import { errorMessage, log } from "../server/logger.js";
import { enqueueBranchReconciliation } from "../queue/reconciliation-queue.js";

/** Fetches exact PR source states and returns deterministic, non-persisted facts. */
export async function buildPullRequestImpactAnalysis(
  request: PullRequestAnalysisRequest,
  repositoryReader: RepositoryReader,
): Promise<DeterministicPrAnalysis> {
  return (await buildPullRequestImpactArtifacts(request, repositoryReader)).analysis;
}

/**
 * The PR worker needs the exact ephemeral graphs once: analysis consumes them
 * for reachability and the policy consumes their persisted technical roles.
 * They are deliberately never written as PR-branch graph state.
 */
export async function buildPullRequestImpactArtifacts(
  request: PullRequestAnalysisRequest,
  repositoryReader: RepositoryReader,
): Promise<{ analysis: DeterministicPrAnalysis; baseGraph: BaselineGraph | null; headGraph: BaselineGraph | null }> {
  const startedAt = Date.now();
  log("info", "PR impact analysis started", { repoId: request.repoId, pullRequestNumber: request.pullRequestNumber, baseRef: request.baseRef, baseSha: request.baseSha, headSha: request.headSha });
  const config = await getRepoConfig(request.repoId);
  if (!config) throw new Error(`repository configuration not found for ${request.repoId}`);
  if (!config.isActive) throw new Error(`repository ${request.repoId} is inactive`);
  if (request.baseRef !== config.trackedBranch) throw new Error(`pull request base branch ${request.baseRef} is not tracked for repository ${request.repoId}`);

  const identity = config.owner && config.name
    ? { owner: config.owner, name: config.name }
    : await repositoryReader.resolveRepository(config.repoId, config.installationId);
  if (!config.owner || !config.name) await updateRepoIdentity(config.repoId, identity.owner, identity.name);
  const sourceInput = { repoId: config.repoId, installationId: config.installationId, owner: identity.owner, name: identity.name, branch: request.baseRef };
  const comparison = await repositoryReader.compareCommits({
    installationId: config.installationId,
    owner: identity.owner,
    name: identity.name,
    beforeSha: request.baseSha,
    afterSha: request.headSha,
  });
  if (!comparison.comparable) {
    log("warn", "PR impact analysis has insufficient comparison evidence", { repoId: request.repoId, pullRequestNumber: request.pullRequestNumber, baseSha: request.baseSha, headSha: request.headSha, reason: comparison.reason, changedFileCount: comparison.changes.length, durationMs: Date.now() - startedAt });
    return { analysis: createInsufficientAnalysis(request, comparison.reason ?? "PR comparison is unavailable", comparison.changes), baseGraph: null, headGraph: null };
  }

  try {
    const baseGraph = await loadBaseGraph(request, repositoryReader, sourceInput);
    const headGraph = await buildHeadGraph(baseGraph, comparison.changes, request.headSha, repositoryReader, sourceInput);
    const result = analyzePrImpact({ request, baseGraph, headGraph, changes: comparison.changes });
    log("info", "PR impact analysis completed", { repoId: request.repoId, pullRequestNumber: request.pullRequestNumber, baseSha: request.baseSha, headSha: request.headSha, changedFileCount: result.changedFiles.length, changedSymbolCount: result.changedSymbols.length, affectedItemCount: result.affectedItems.length, unresolvedImportCount: result.unresolvedImportCount, impactLevel: result.impactLevel, durationMs: Date.now() - startedAt });
    return { analysis: result, baseGraph, headGraph };
  } catch (error) {
    if (error instanceof UnsupportedRepositoryError) {
      log("warn", "PR impact analysis has unsupported source profile", { repoId: request.repoId, pullRequestNumber: request.pullRequestNumber, headSha: request.headSha, reason: error.message, durationMs: Date.now() - startedAt });
      return { analysis: createInsufficientAnalysis(request, error.message, comparison.changes), baseGraph: null, headGraph: null };
    }
    log("error", "PR impact analysis failed", { repoId: request.repoId, pullRequestNumber: request.pullRequestNumber, headSha: request.headSha, durationMs: Date.now() - startedAt, error: errorMessage(error) });
    throw error;
  }
}

async function loadBaseGraph(
  request: PullRequestAnalysisRequest,
  repositoryReader: RepositoryReader,
  sourceInput: SourceInput,
): Promise<BaselineGraph> {
  const current = await loadReadyGraphByIdentity({ repoId: request.repoId, branch: request.baseRef, sha: request.baseSha });
  if (current) {
    log("info", "PR impact analysis reused current base graph", { repoId: request.repoId, pullRequestNumber: request.pullRequestNumber, baseSha: request.baseSha, snapshotId: current.snapshotId });
    return current.graph;
  }
  // This PR can still be analyzed against an exact ephemeral base. Reconcile
  // the live tracked branch separately so a missed push cannot leave it stale.
  try {
    const liveSha = await repositoryReader.resolveBranchSha({ repoId: sourceInput.repoId, installationId: sourceInput.installationId, owner: sourceInput.owner, name: sourceInput.name, branch: sourceInput.branch });
    await enqueueBranchReconciliation({ repoId: request.repoId, branch: sourceInput.branch, sha: liveSha, reason: "PR base graph was not the current tracked snapshot" });
  } catch (error) {
    log("warn", "PR graph reconciliation request could not be queued", { repoId: request.repoId, pullRequestNumber: request.pullRequestNumber, error: errorMessage(error) });
  }
  // Historical graph rows are intentionally not retained. Build this exact base
  // in memory and leave the mutable tracked-branch graph untouched.
  log("info", "PR impact analysis building ephemeral base graph", { repoId: request.repoId, pullRequestNumber: request.pullRequestNumber, baseSha: request.baseSha });
  return buildBaselineGraph(await repositoryReader.fetchSource({ ...sourceInput, sha: request.baseSha }));
}

async function buildHeadGraph(
  baseGraph: BaselineGraph,
  changes: CommitFileChange[],
  headSha: string,
  repositoryReader: RepositoryReader,
  sourceInput: SourceInput,
): Promise<BaselineGraph> {
  if (changes.some((change) => isTsconfigPath(change.path) || isTsconfigPath(change.previousPath ?? ""))) {
    log("info", "PR impact analysis building full head graph because tsconfig changed", { repoId: sourceInput.repoId, headSha });
    return buildBaselineGraph(await repositoryReader.fetchSource({ ...sourceInput, sha: headSha }));
  }
  const tree = await repositoryReader.fetchTree({ ...sourceInput, sha: headSha });
  const allFilePaths = tree.map((entry) => entry.path);
  const targetPaths = new Set(allFilePaths.filter(isGraphFilePath));
  const reanalyzed = determineReanalyzedPaths(baseGraph, targetPaths, changes).reanalyzedPaths;
  log("info", "PR impact analysis building incremental head graph", { repoId: sourceInput.repoId, headSha, changedFileCount: changes.length, reanalyzedFileCount: reanalyzed.length });
  const files = await repositoryReader.fetchFiles({
    ...sourceInput,
    sha: headSha,
    paths: [...new Set(["tsconfig.json", ...reanalyzed])],
  });
  const targetSource: RepositorySource = { ...sourceInput, sha: headSha, allFilePaths, files };
  return buildIncrementalGraph({ previousGraph: baseGraph, targetSource, changes }).graph;
}

interface SourceInput {
  repoId: number;
  installationId: number;
  owner: string;
  name: string;
  branch: string;
}

function isTsconfigPath(filePath: string): boolean {
  return /(^|\/)tsconfig(?:\.[^/]+)?\.json$/.test(filePath);
}

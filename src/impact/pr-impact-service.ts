import { buildBaselineGraph, isGraphFilePath, UnsupportedRepositoryError } from "../graph/baseline-graph-builder.js";
import { buildIncrementalGraph, determineReanalyzedPaths } from "../graph/incremental-graph-builder.js";
import { loadReadyGraphByIdentity } from "../graph/snapshot-repository.js";
import type { BaselineGraph, CommitFileChange, RepositoryReader, RepositorySource } from "../graph/types.js";
import { getRepoConfig, updateRepoIdentity } from "../storage/repo-config-repo.js";
import { analyzePrImpact, createInsufficientAnalysis } from "./pr-impact-engine.js";
import type { DeterministicPrAnalysis, PullRequestAnalysisRequest } from "./pr-impact-types.js";

/** Fetches exact PR source states and returns deterministic, non-persisted facts. */
export async function buildPullRequestImpactAnalysis(
  request: PullRequestAnalysisRequest,
  repositoryReader: RepositoryReader,
): Promise<DeterministicPrAnalysis> {
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
    return createInsufficientAnalysis(request, comparison.reason ?? "PR comparison is unavailable", comparison.changes);
  }

  try {
    const baseGraph = await loadBaseGraph(request, repositoryReader, sourceInput);
    const headGraph = await buildHeadGraph(baseGraph, comparison.changes, request.headSha, repositoryReader, sourceInput);
    return analyzePrImpact({ request, baseGraph, headGraph, changes: comparison.changes });
  } catch (error) {
    if (error instanceof UnsupportedRepositoryError) {
      return createInsufficientAnalysis(request, error.message, comparison.changes);
    }
    throw error;
  }
}

async function loadBaseGraph(
  request: PullRequestAnalysisRequest,
  repositoryReader: RepositoryReader,
  sourceInput: SourceInput,
): Promise<BaselineGraph> {
  const current = await loadReadyGraphByIdentity({ repoId: request.repoId, branch: request.baseRef, sha: request.baseSha });
  if (current) return current.graph;
  // Historical graph rows are intentionally not retained. Build this exact base
  // in memory and leave the mutable tracked-branch graph untouched.
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
    return buildBaselineGraph(await repositoryReader.fetchSource({ ...sourceInput, sha: headSha }));
  }
  const tree = await repositoryReader.fetchTree({ ...sourceInput, sha: headSha });
  const allFilePaths = tree.map((entry) => entry.path);
  const targetPaths = new Set(allFilePaths.filter(isGraphFilePath));
  const reanalyzed = determineReanalyzedPaths(baseGraph, targetPaths, changes).reanalyzedPaths;
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

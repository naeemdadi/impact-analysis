import { buildEphemeralFeatureCard, buildExactHeadFeatureContexts } from "../feature/feature-service.js";
import { findReadyFeatureCard } from "../feature/feature-card-repository.js";
import type { RepositoryReader, SourceFile } from "../graph/types.js";
import type { DeterministicPrAnalysis } from "../impact/pr-impact-types.js";
import { getRepoConfig } from "../storage/repo-config-repo.js";
import type { ChangedHunk, FeatureVerificationTarget } from "./report-types.js";

/** Creates bounded, exact-head semantic report inputs. It never changes graph facts. */
export async function buildPrSemanticContext(analysis: DeterministicPrAnalysis, repositoryReader: RepositoryReader): Promise<{
  targets: FeatureVerificationTarget[];
  changedHunks: ChangedHunk[];
}> {
  const entrypoints = analysis.affectedItems
    .filter((item) => item.kind === "page" || item.kind === "api_route")
    .sort((left, right) => Number(right.impact === "direct") - Number(left.impact === "direct") || left.dependencyPath.length - right.dependencyPath.length || left.path.localeCompare(right.path))
    .slice(0, 5);
  if (entrypoints.length === 0) return { targets: [], changedHunks: [] };
  const config = await getRepoConfig(analysis.repoId);
  if (!config) return { targets: [], changedHunks: [] };
  const exact = await buildExactHeadFeatureContexts({
    repoId: analysis.repoId, branch: config.trackedBranch, headSha: analysis.headSha, entryPaths: entrypoints.map((item) => item.path), repositoryReader,
  });
  if (!exact.semanticAiEnabled) return { targets: [], changedHunks: [] };

  const targets: FeatureVerificationTarget[] = [];
  for (const item of entrypoints) {
    const context = exact.contexts.get(item.path);
    if (!context) continue;
    let card = (await findReadyFeatureCard({ repoId: analysis.repoId, branch: exact.source.branch, entryPath: item.path, sourceFingerprint: context.sourceFingerprint }))?.card ?? null;
    if (!card) {
      try { card = await buildEphemeralFeatureCard({ context, semanticAiEnabled: true }); } catch { card = null; }
    }
    if (!card) continue;
    const id = `entry:${item.path}`;
    targets.push({
      id, path: item.path, kind: item.kind as "page" | "api_route", impact: item.impact, dependencyPath: item.dependencyPath,
      title: card.title, description: card.description,
      scenarios: card.scenarios.map((scenario) => ({
        id: `${id}:scenario:${scenario.id}`, title: scenario.title, steps: scenario.steps, contextIds: scenario.contextIds,
      })),
    });
  }
  const changedHunks = await fetchChangedHunks(analysis, repositoryReader, exact.source);
  return { targets, changedHunks };
}

async function fetchChangedHunks(analysis: DeterministicPrAnalysis, repositoryReader: RepositoryReader, headSource: { repoId: number; installationId?: number; owner: string; name: string; branch: string; sha: string }): Promise<ChangedHunk[]> {
  // Source does not carry installation metadata, so resolve it through the feature source's repository config by using the reader call input reconstructed below.
  // The exact source fetch above guarantees head content; base blobs are fetched only for changed graph files.
  const config = await getRepoConfig(analysis.repoId);
  if (!config) return [];
  const changed = analysis.changedFiles.filter((file) => file.graphRelevant).slice(0, 12);
  const headPaths = changed.filter((file) => file.status !== "removed").map((file) => file.path);
  const basePaths = changed.filter((file) => file.status !== "added").map((file) => file.previousPath ?? file.path);
  const input = { repoId: analysis.repoId, installationId: config.installationId, owner: headSource.owner, name: headSource.name, branch: headSource.branch };
  const [headFiles, baseFiles] = await Promise.all([
    repositoryReader.fetchFiles({ ...input, sha: analysis.headSha, paths: headPaths }),
    repositoryReader.fetchFiles({ ...input, sha: analysis.baseSha, paths: basePaths }),
  ]);
  const headByPath = new Map(headFiles.map((file) => [file.path, file]));
  const baseByPath = new Map(baseFiles.map((file) => [file.path, file]));
  return changed.flatMap((change, index) => {
    const before = baseByPath.get(change.previousPath ?? change.path);
    const after = headByPath.get(change.path);
    return toHunk(`hunk:${index + 1}`, change.path, before, after);
  });
}

function toHunk(id: string, path: string, before: SourceFile | undefined, after: SourceFile | undefined): ChangedHunk[] {
  const beforeLines = (before?.content ?? "").split("\n");
  const afterLines = (after?.content ?? "").split("\n");
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < beforeLines.length - prefix && suffix < afterLines.length - prefix && beforeLines[beforeLines.length - suffix - 1] === afterLines[afterLines.length - suffix - 1]) suffix++;
  const start = Math.max(0, prefix - 3);
  const beforeEnd = Math.min(beforeLines.length, beforeLines.length - suffix + 3);
  const afterEnd = Math.min(afterLines.length, afterLines.length - suffix + 3);
  const beforeExcerpt = beforeLines.slice(start, beforeEnd).join("\n").slice(0, 4_000);
  const afterExcerpt = afterLines.slice(start, afterEnd).join("\n").slice(0, 4_000);
  if (!beforeExcerpt && !afterExcerpt) return [];
  return [{ id, path, beforeStartLine: start + 1, afterStartLine: start + 1, beforeExcerpt, afterExcerpt }];
}

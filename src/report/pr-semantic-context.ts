import type { RepositoryReader, SourceFile } from "../graph/types.js";
import type { ImpactAssessment } from "../impact/impact-assessment.js";
import type { DeterministicPrAnalysis } from "../impact/pr-impact-types.js";
import { getRepoConfig } from "../storage/repo-config-repo.js";
import { targetIdFor } from "./templates.js";
import type { ChangedHunk, PrSemanticInput, SemanticEntrypointTarget, SourceContextItem } from "./report-types.js";

const maxHunks = 12;
const maxHunkCharacters = 4_000;
const maxRouteFiles = 6;
const maxRouteCharacters = 18_000;
const maxTotalRouteCharacters = 42_000;

/**
 * Builds the only source packet allowed to leave the repository for a PR.
 * It uses the exact PR head and never reads or writes branch-level AI state.
 */
export async function buildPrSemanticContext(
  analysis: DeterministicPrAnalysis,
  assessment: ImpactAssessment,
  repositoryReader: RepositoryReader,
): Promise<PrSemanticInput> {
  const config = await getRepoConfig(analysis.repoId);
  if (!config?.aiAssistanceEnabled || analysis.status !== "ready") return { version: 1, enabled: false, changedHunks: [], targets: [] };
  if (!config.owner || !config.name) return { version: 1, enabled: false, changedHunks: [], targets: [] };
  const source = { repoId: analysis.repoId, installationId: config.installationId, owner: config.owner, name: config.name, branch: config.trackedBranch };
  const changedHunks = await fetchChangedHunks(analysis, repositoryReader, source);
  const candidates = assessment.items.filter((item) => item.tier === "primary" || item.tier === "secondary").slice(0, 5);
  const targets: SemanticEntrypointTarget[] = [];
  let remaining = maxTotalRouteCharacters;
  for (const [targetIndex, item] of candidates.entries()) {
    if (remaining <= 0) break;
    // The entrypoint itself is mandatory. The remaining budget follows the
    // nearest nodes on its already-verified dependency path.
    const paths = [item.path, ...item.dependencyPath.filter((path) => path !== item.path).slice(-(maxRouteFiles - 1))]
      .filter(isAllowedSourcePath);
    if (!paths.length) continue;
    const files = await repositoryReader.fetchFiles({ ...source, sha: analysis.headSha, paths });
    const context = toContextItems(files, remaining, targetIndex + 1);
    remaining -= context.reduce((total, file) => total + file.excerpt.length, 0);
    if (!context.length) continue;
    targets.push({
      id: targetIdFor(item), path: item.path, kind: item.kind, tier: item.tier as "primary" | "secondary",
      changedSeedPath: item.changedSeedPath, dependencyPath: item.dependencyPath, context,
    });
  }
  return { version: 1, enabled: true, changedHunks, targets };
}

async function fetchChangedHunks(
  analysis: DeterministicPrAnalysis,
  repositoryReader: RepositoryReader,
  source: { repoId: number; installationId: number; owner: string; name: string; branch: string },
): Promise<ChangedHunk[]> {
  const changed = analysis.changedFiles.filter((file) => file.graphRelevant && isAllowedSourcePath(file.path)).slice(0, maxHunks);
  const headPaths = changed.filter((file) => file.status !== "removed").map((file) => file.path);
  const basePaths = changed.filter((file) => file.status !== "added").map((file) => file.previousPath ?? file.path);
  const [head, base] = await Promise.all([
    repositoryReader.fetchFiles({ ...source, sha: analysis.headSha, paths: headPaths }),
    repositoryReader.fetchFiles({ ...source, sha: analysis.baseSha, paths: basePaths }),
  ]);
  const headByPath = new Map(head.map((file) => [file.path, file]));
  const baseByPath = new Map(base.map((file) => [file.path, file]));
  return changed.flatMap((change, index) => toHunk(`hunk:${index + 1}`, change.path, baseByPath.get(change.previousPath ?? change.path), headByPath.get(change.path)));
}

function toHunk(id: string, path: string, before: SourceFile | undefined, after: SourceFile | undefined): ChangedHunk[] {
  const beforeLines = (before?.content ?? "").split("\n");
  const afterLines = (after?.content ?? "").split("\n");
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < beforeLines.length - prefix && suffix < afterLines.length - prefix && beforeLines[beforeLines.length - suffix - 1] === afterLines[afterLines.length - suffix - 1]) suffix++;
  const start = Math.max(0, prefix - 3);
  const beforeExcerpt = beforeLines.slice(start, Math.min(beforeLines.length, beforeLines.length - suffix + 3)).join("\n").slice(0, maxHunkCharacters);
  const afterExcerpt = afterLines.slice(start, Math.min(afterLines.length, afterLines.length - suffix + 3)).join("\n").slice(0, maxHunkCharacters);
  return beforeExcerpt || afterExcerpt ? [{ id, path, beforeStartLine: start + 1, afterStartLine: start + 1, beforeExcerpt, afterExcerpt }] : [];
}

function toContextItems(files: SourceFile[], remaining: number, targetIndex: number): SourceContextItem[] {
  let budget = Math.min(maxRouteCharacters, remaining);
  const items: SourceContextItem[] = [];
  for (const [index, file] of files.sort((a, b) => a.path.localeCompare(b.path)).entries()) {
    if (!isAllowedSourcePath(file.path) || budget <= 0) continue;
    const excerpt = file.content.slice(0, Math.min(4_000, budget));
    if (!excerpt) continue;
    items.push({ id: `context:${targetIndex}:${items.length + 1}`, path: file.path, blobSha: file.blobSha, startLine: 1, endLine: excerpt.split("\n").length, excerpt });
    budget -= excerpt.length;
  }
  return items;
}

/** Source exclusion is a privacy boundary, not a graph classification rule. */
export function isAllowedSourcePath(path: string): boolean {
  const value = path.toLowerCase();
  if (/(^|\/)(?:\.env|env)(?:\.|\/|$)/.test(value)) return false;
  if (/(?:lock\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(value)) return false;
  if (/(^|\/)(?:node_modules|dist|build|\.next|generated)(?:\/|$)/.test(value)) return false;
  if (/(^|\/)(?:scripts|drizzle)(?:\/|$)/.test(value)) return false;
  if (/(^|\/)(?:config|server\/db|database|migrations?)(?:\/|$)/.test(value)) return false;
  return /\.(?:ts|tsx|js|jsx|mjs|cjs|css|scss|sass|less)$/.test(value);
}

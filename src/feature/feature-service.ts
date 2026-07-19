import { buildBaselineGraph } from "../graph/baseline-graph-builder.js";
import { loadReadyGraphByIdentity } from "../graph/snapshot-repository.js";
import type { BaselineGraph, RepositoryReader, RepositorySource } from "../graph/types.js";
import { getRepoConfig, updateRepoIdentity } from "../storage/repo-config-repo.js";
import { buildFeatureContext, isFeatureCardEntrypoint } from "./feature-context.js";
import { deleteFeatureCardsAtPaths, deleteMissingFeatureCards, findReadyFeatureCard, upsertFeatureCard } from "./feature-card-repository.js";
import { OpenAIFeatureCardGenerator } from "./openai-feature-card-generator.js";
import type { FeatureCard, FeatureCardGenerator, FeatureContext, FeatureIndexRequest } from "./feature-types.js";
import { errorMessage, log } from "../server/logger.js";
import { collectFeatureContextPaths, selectFeatureIndexEntrypoints } from "./feature-index-selection.js";

/** Refreshes the current branch's page/API feature cards. Unchanged fingerprints never call OpenAI. */
export async function indexRepositoryFeatures(
  request: FeatureIndexRequest,
  repositoryReader: RepositoryReader,
  generatorFactory: () => FeatureCardGenerator = () => new OpenAIFeatureCardGenerator(),
): Promise<{ indexed: number; reused: number; unavailable: number }> {
  const startedAt = Date.now();
  log("info", "feature index started", { repoId: request.repoId, branch: request.branch, sha: request.sha, mode: request.mode });
  const config = await getRepoConfig(request.repoId);
  if (!config || !config.isActive || config.trackedBranch !== request.branch) {
    log("info", "feature index skipped: repository is inactive or branch is not tracked", { repoId: request.repoId, branch: request.branch });
    return { indexed: 0, reused: 0, unavailable: 0 };
  }
  // Without explicit consent there is no feature-map work to perform and no
  // repository source is sent to OpenAI.
  if (!config.semanticAiEnabled) {
    log("info", "feature index skipped: AI source context is disabled", { repoId: request.repoId, branch: request.branch, sha: request.sha });
    return { indexed: 0, reused: 0, unavailable: 0 };
  }
  const graphRecord = await loadReadyGraphByIdentity({ repoId: request.repoId, branch: request.branch, sha: request.sha });
  if (!graphRecord) throw new Error(`current graph snapshot ${request.sha} is unavailable for feature indexing`);
  const identity = config.owner && config.name ? { owner: config.owner, name: config.name } : await repositoryReader.resolveRepository(config.repoId, config.installationId);
  if (!config.owner || !config.name) await updateRepoIdentity(config.repoId, identity.owner, identity.name);
  const allEntrypoints = graphRecord.graph.files.filter((file) => isFeatureCardEntrypoint(file.path, file.kind)).sort((a, b) => a.path.localeCompare(b.path));
  const entrypoints = selectFeatureIndexEntrypoints(graphRecord.graph, allEntrypoints, request);
  const currentPaths = new Set(graphRecord.graph.files.map((file) => file.path));
  if (request.mode === "full") await deleteMissingFeatureCards(request.repoId, request.branch, allEntrypoints.map((file) => file.path));
  else await deleteFeatureCardsAtPaths(request.repoId, request.branch, [
    ...(request.changedPaths ?? []).filter((path) => !currentPaths.has(path)),
    ...graphRecord.graph.files.filter((file) => !isFeatureCardEntrypoint(file.path, file.kind)).map((file) => file.path),
  ]);
  log("info", "feature index entrypoints selected", { repoId: request.repoId, branch: request.branch, sha: request.sha, mode: request.mode, changedPathCount: request.changedPaths?.length ?? 0, totalEntrypointCount: allEntrypoints.length, selectedEntrypointCount: entrypoints.length });
  if (entrypoints.length === 0) return { indexed: 0, reused: 0, unavailable: 0 };
  const sourcePaths = collectFeatureContextPaths(graphRecord.graph, entrypoints.map((file) => file.path));
  const files = await repositoryReader.fetchFiles({ repoId: config.repoId, installationId: config.installationId, owner: identity.owner, name: identity.name, branch: request.branch, sha: request.sha, paths: sourcePaths });
  const source = { repoId: config.repoId, owner: identity.owner, name: identity.name, branch: request.branch, sha: request.sha, allFilePaths: sourcePaths, files };
  log("info", "feature index source fetched", { repoId: request.repoId, branch: request.branch, sha: request.sha, sourceFileCount: files.length, selectedEntrypointCount: entrypoints.length });
  let indexed = 0; let reused = 0; let unavailable = 0;
  for (const entrypoint of entrypoints) {
    const context = buildFeatureContext({ source, graph: graphRecord.graph, entryPath: entrypoint.path, entryKind: entrypoint.kind });
    if (!context) { unavailable++; continue; }
    const outcome = await ensureFeatureCard({ repoId: request.repoId, branch: request.branch, semanticAiEnabled: true, context }, generatorFactory);
    if (outcome === "reused") reused++; else if (outcome === "ready") indexed++; else unavailable++;
  }
  log("info", "feature index completed", { repoId: request.repoId, branch: request.branch, sha: request.sha, indexed, reused, unavailable, durationMs: Date.now() - startedAt });
  return { indexed, reused, unavailable };
}


/** Returns an exact-source feature card for PR reporting without mutating the tracked-branch map. */
export async function buildEphemeralFeatureCard(input: {
  context: FeatureContext;
  semanticAiEnabled: boolean;
  generatorFactory?: () => FeatureCardGenerator;
}): Promise<FeatureCard | null> {
  if (!input.semanticAiEnabled) return null;
  const generated = await (input.generatorFactory ?? (() => new OpenAIFeatureCardGenerator()))().generate(input.context);
  return generated.card;
}

export async function buildExactHeadFeatureContexts(input: {
  repoId: number;
  branch: string;
  headSha: string;
  entryPaths: string[];
  repositoryReader: RepositoryReader;
}): Promise<{ source: RepositorySource; graph: BaselineGraph; semanticAiEnabled: boolean; contexts: Map<string, FeatureContext> }> {
  const config = await getRepoConfig(input.repoId);
  if (!config) throw new Error(`repository configuration not found for ${input.repoId}`);
  const identity = config.owner && config.name ? { owner: config.owner, name: config.name } : await input.repositoryReader.resolveRepository(config.repoId, config.installationId);
  const source = await input.repositoryReader.fetchSource({ repoId: config.repoId, installationId: config.installationId, owner: identity.owner, name: identity.name, branch: input.branch, sha: input.headSha });
  const graph = buildBaselineGraph(source);
  const files = new Map(graph.files.map((file) => [file.path, file]));
  const contexts = new Map<string, FeatureContext>();
  for (const entryPath of input.entryPaths) {
    const entrypoint = files.get(entryPath);
    if (!entrypoint || !isFeatureCardEntrypoint(entrypoint.path, entrypoint.kind)) continue;
    const context = buildFeatureContext({ source, graph, entryPath, entryKind: entrypoint.kind });
    if (context) contexts.set(entryPath, context);
  }
  return { source, graph, semanticAiEnabled: config.semanticAiEnabled, contexts };
}

async function ensureFeatureCard(input: {
  repoId: number; branch: string; semanticAiEnabled: boolean; context: FeatureContext;
}, generatorFactory: () => FeatureCardGenerator): Promise<"ready" | "reused" | "unavailable"> {
  const existing = await findReadyFeatureCard({ repoId: input.repoId, branch: input.branch, entryPath: input.context.entryPath, sourceFingerprint: input.context.sourceFingerprint });
  if (existing) return "reused";
  if (!input.semanticAiEnabled) {
    await upsertFeatureCard({ ...input, status: "unavailable", card: null, failureReason: "semantic AI is disabled for this repository" });
    return "unavailable";
  }
  try {
    const generated = await generatorFactory().generate(input.context);
    await upsertFeatureCard({ ...input, status: "ready", card: generated.card, model: generated.model, providerResponseId: generated.providerResponseId });
    return "ready";
  } catch (error) {
    const reason = errorMessage(error);
    log("warn", "feature card generation unavailable", { repoId: input.repoId, branch: input.branch, entryPath: input.context.entryPath, error: reason });
    await upsertFeatureCard({ ...input, status: "unavailable", card: null, failureReason: reason });
    return "unavailable";
  }
}

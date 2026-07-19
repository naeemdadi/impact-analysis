import { getPrAnalysisId } from "../impact/pr-analysis-repository.js";
import type { DeterministicPrAnalysis } from "../impact/pr-impact-types.js";
import { buildReportEvidence } from "./evidence.js";
import { OpenAIReportSelector } from "./openai-report-selector.js";
import { createBuildingReport, findReadyReport, persistReadyReport } from "./pr-report-repository.js";
import { defaultSelection, buildSelectionCatalog, renderReport, validateSelection } from "./templates.js";
import type { ReportSelector } from "./report-types.js";
import type { RepositoryReader } from "../graph/types.js";
import { buildPrSemanticContext } from "./pr-semantic-context.js";
import { errorMessage, log } from "../server/logger.js";

/** Builds one durable report without allowing an LLM failure to block delivery. */
export async function ensurePrReport(
  analysis: DeterministicPrAnalysis,
  selectorFactory: () => ReportSelector = () => new OpenAIReportSelector(),
  repositoryReader?: RepositoryReader,
  options: { force?: boolean } = {},
): Promise<{ markdown: string; reused: boolean; llmStatus: "not_requested" | "completed" | "fallback" }> {
  const startedAt = Date.now();
  log("info", "PR report generation started", { repoId: analysis.repoId, pullRequestNumber: analysis.pullRequestNumber, headSha: analysis.headSha, analysisStatus: analysis.status, force: Boolean(options.force) });
  const analysisId = await getPrAnalysisId(analysis);
  const existing = await findReadyReport(analysisId);
  if (existing && !options.force) {
    log("info", "PR report reused", { repoId: analysis.repoId, pullRequestNumber: analysis.pullRequestNumber, headSha: analysis.headSha, llmStatus: existing.llmStatus });
    return { markdown: existing.markdown, reused: true, llmStatus: existing.llmStatus };
  }

  let semantic: { targets: import("./report-types.js").FeatureVerificationTarget[]; changedHunks: import("./report-types.js").ChangedHunk[] } = { targets: [], changedHunks: [] };
  if (analysis.status === "ready" && repositoryReader) {
    try {
      semantic = await buildPrSemanticContext(analysis, repositoryReader);
      log("info", "PR semantic context prepared", { repoId: analysis.repoId, pullRequestNumber: analysis.pullRequestNumber, headSha: analysis.headSha, featureTargetCount: semantic.targets.length, changedHunkCount: semantic.changedHunks.length });
    } catch (error) {
      log("warn", "PR semantic context unavailable; using deterministic report", { repoId: analysis.repoId, pullRequestNumber: analysis.pullRequestNumber, headSha: analysis.headSha, error: errorMessage(error) });
    }
  }
  const evidence = buildReportEvidence(analysis, { featureTargets: semantic.targets, changedHunks: semantic.changedHunks });
  const catalog = buildSelectionCatalog(evidence);
  let selection = defaultSelection(catalog);
  await createBuildingReport(analysisId, evidence, selection);

  let llmStatus: "not_requested" | "completed" | "fallback" = "not_requested";
  let llmError: string | null = null;
  let model: string | null = null;
  let providerResponseId: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  if (analysis.status === "ready" && evidence.featureTargets.length > 0) {
    try {
      const selected = await selectorFactory().select(evidence, catalog);
      selection = validateSelection(selected.selection, catalog);
      llmStatus = "completed";
      model = process.env.OPENAI_MODEL ?? "gpt-5.6-luna";
      providerResponseId = selected.providerResponseId;
      inputTokens = selected.inputTokens;
      outputTokens = selected.outputTokens;
    } catch (error) {
      llmStatus = "fallback";
      llmError = errorMessage(error);
      log("warn", "OpenAI report selection unavailable; using deterministic scenario selection", { repoId: analysis.repoId, pullRequestNumber: analysis.pullRequestNumber, headSha: analysis.headSha, error: llmError });
    }
  }

  const markdown = renderReport(evidence, selection);
  await persistReadyReport({
    analysisId,
    evidence,
    selection,
    markdown,
    model,
    providerResponseId,
    inputTokens,
    outputTokens,
    llmStatus,
    llmError,
  });
  log("info", "PR report generation completed", { repoId: analysis.repoId, pullRequestNumber: analysis.pullRequestNumber, headSha: analysis.headSha, llmStatus, featureTargetCount: evidence.featureTargets.length, verificationCount: selection.verifications.length, durationMs: Date.now() - startedAt });
  return { markdown, reused: false, llmStatus };
}

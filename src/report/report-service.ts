import { getPrAnalysisId } from "../impact/pr-analysis-repository.js";
import { findImpactAssessment } from "../impact/pr-impact-assessment-repository.js";
import type { DeterministicPrAnalysis } from "../impact/pr-impact-types.js";
import type { RepositoryReader } from "../graph/types.js";
import { log } from "../server/logger.js";
import { buildReportEvidence } from "./evidence.js";
import { OpenAIPrSemanticAnalyzer } from "./openai-pr-semantic-analyzer.js";
import { buildPrSemanticContext } from "./pr-semantic-context.js";
import { createBuildingReport, findReadyReport, persistReadyReport } from "./pr-report-repository.js";
import { classifySemanticFailure } from "./semantic-failure.js";
import { renderReport } from "./templates.js";
import type { PrSemanticAnalyzer, PrSemanticInput, PrSemanticResult, SemanticGuidanceState } from "./report-types.js";

/** Builds one durable report. Semantic failure is never allowed to block delivery. */
export async function ensurePrReport(
  analysis: DeterministicPrAnalysis,
  analyzerFactory: () => PrSemanticAnalyzer = () => new OpenAIPrSemanticAnalyzer(),
  repositoryReader?: RepositoryReader,
  options: { force?: boolean } = {},
): Promise<{ markdown: string; reused: boolean; llmStatus: "not_requested" | "completed" | "fallback" }> {
  const startedAt = Date.now();
  const analysisId = await getPrAnalysisId(analysis);
  const existing = await findReadyReport(analysisId);
  if (existing && !options.force) return { markdown: existing.markdown, reused: true, llmStatus: existing.llmStatus };

  const assessment = await findImpactAssessment(analysisId);
  if (!assessment) throw new Error(`PR impact assessment is missing for analysis ${analysisId}`);
  const evidence = buildReportEvidence(analysis, assessment);
  let semanticInput: PrSemanticInput = { version: 1, enabled: false, changedHunks: [], targets: [] };
  let guidance: SemanticGuidanceState = { status: "not_requested", notice: null };
  if (analysis.status === "ready" && repositoryReader) {
    try {
      semanticInput = await buildPrSemanticContext(analysis, assessment, repositoryReader);
    } catch (error) {
      guidance = { status: "fallback", notice: "PR source context could not be prepared for AI guidance." };
      log("warn", "PR semantic context unavailable; using deterministic report", { repoId: analysis.repoId, pullRequestNumber: analysis.pullRequestNumber, headSha: analysis.headSha, errorCategory: classifySemanticFailure(error).category });
    }
  }
  await createBuildingReport(analysisId, evidence, semanticInput);

  let semanticResult: PrSemanticResult | null = null;
  let llmStatus: "not_requested" | "completed" | "fallback" = guidance.status === "fallback" ? "fallback" : "not_requested";
  let llmError: string | null = null;
  let model: string | null = null;
  let providerResponseId: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  if (semanticInput.enabled && semanticInput.changedHunks.length > 0) {
    // Retain the configured model even when the provider rejects the request.
    // That makes a fallback report diagnosable without retaining provider text.
    model = process.env.OPENAI_MODEL ?? "gpt-5.6-luna";
    try {
      const generated = await analyzerFactory().analyze(semanticInput, evidence);
      semanticResult = generated.result;
      llmStatus = "completed";
      guidance = { status: "completed", notice: null };
      providerResponseId = generated.providerResponseId;
      inputTokens = generated.inputTokens;
      outputTokens = generated.outputTokens;
    } catch (error) {
      const failure = classifySemanticFailure(error);
      llmStatus = "fallback";
      llmError = failure.persistedReason;
      guidance = { status: "fallback", notice: failure.notice };
      log("warn", "PR semantic analysis unavailable; using deterministic report", {
        repoId: analysis.repoId,
        pullRequestNumber: analysis.pullRequestNumber,
        headSha: analysis.headSha,
        model,
        errorCategory: failure.category,
        providerStatus: failure.providerStatus,
        providerCode: failure.providerCode,
        providerType: failure.providerType,
        providerDiagnostic: failure.providerDiagnostic,
      });
    }
  }
  if (guidance.status === "fallback" && !llmError) llmError = "PR semantic source context unavailable";
  const markdown = renderReport(evidence, semanticResult, guidance, semanticInput);
  await persistReadyReport({ analysisId, evidence, semanticInput, semanticResult, markdown, model, providerResponseId, inputTokens, outputTokens, llmStatus, llmError });
  log("info", "PR report generation completed", { repoId: analysis.repoId, pullRequestNumber: analysis.pullRequestNumber, headSha: analysis.headSha, llmStatus, semanticTargetCount: semanticInput.targets.length, semanticSummaryCount: semanticResult?.changeSummaries.length ?? 0, durationMs: Date.now() - startedAt });
  return { markdown, reused: false, llmStatus };
}

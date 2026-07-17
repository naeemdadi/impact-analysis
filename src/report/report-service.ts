import { getPrAnalysisId } from "../impact/pr-analysis-repository.js";
import type { DeterministicPrAnalysis } from "../impact/pr-impact-types.js";
import { buildReportEvidence } from "./evidence.js";
import { OpenAIReportSelector } from "./openai-report-selector.js";
import { createBuildingReport, findReadyReport, persistReadyReport } from "./pr-report-repository.js";
import { defaultSelection, buildSelectionCatalog, renderReport, validateSelection } from "./templates.js";
import type { ReportSelector } from "./report-types.js";

/** Builds one durable report without allowing an LLM failure to block delivery. */
export async function ensurePrReport(
  analysis: DeterministicPrAnalysis,
  selectorFactory: () => ReportSelector = () => new OpenAIReportSelector(),
): Promise<{ markdown: string; reused: boolean; llmStatus: "not_requested" | "completed" | "fallback" }> {
  const analysisId = await getPrAnalysisId(analysis);
  const existing = await findReadyReport(analysisId);
  if (existing) return { markdown: existing.markdown, reused: true, llmStatus: existing.llmStatus };

  const evidence = buildReportEvidence(analysis);
  const catalog = buildSelectionCatalog(evidence);
  let selection = defaultSelection(catalog);
  await createBuildingReport(analysisId, evidence.confidence, evidence, selection);

  let llmStatus: "not_requested" | "completed" | "fallback" = "not_requested";
  let llmError: string | null = null;
  let model: string | null = null;
  let providerResponseId: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  if (analysis.status === "ready") {
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
      llmError = error instanceof Error ? error.message : "OpenAI report selection failed";
    }
  }

  const markdown = renderReport(evidence, selection);
  await persistReadyReport({
    analysisId,
    confidence: evidence.confidence,
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
  return { markdown, reused: false, llmStatus };
}

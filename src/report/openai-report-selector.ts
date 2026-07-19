import OpenAI from "openai";

import { reportSelectionSchema, type ReportEvidence, type ReportSelectionCatalog, type ReportSelectionResult, type ReportSelector } from "./report-types.js";
import { validateSelection } from "./templates.js";
import { log } from "../server/logger.js";

/** The model chooses only prevalidated feature scenarios; it cannot add factual prose. */
export class OpenAIReportSelector implements ReportSelector {
  private readonly client: OpenAI;
  constructor(private readonly model = process.env.OPENAI_MODEL ?? "gpt-5.6-luna", apiKey = process.env.OPENAI_API_KEY) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
    this.client = new OpenAI({ apiKey });
  }
  async select(evidence: ReportEvidence, catalog: ReportSelectionCatalog): Promise<ReportSelectionResult> {
    const startedAt = Date.now();
    log("info", "OpenAI PR report selection started", { repoId: evidence.repoId, pullRequestNumber: evidence.pullRequestNumber, headSha: evidence.headSha, featureTargetCount: evidence.featureTargets.length, changedHunkCount: evidence.changedHunks.length, model: this.model });
    const response = await this.client.responses.create({
      model: this.model,
      input: [
        { role: "developer", content: "Select up to five supplied route/API scenarios most relevant to the changed hunks. Never add facts, prose, IDs, or scenarios. Each selected entrypoint must appear once. Return JSON only." },
        { role: "user", content: JSON.stringify({ featureTargets: evidence.featureTargets, changedHunks: evidence.changedHunks, catalog }) },
      ],
      text: { format: { type: "json_schema", name: "pr_verification_selection", strict: true, schema: selectionJsonSchema(catalog) } },
    });
    const selection = validateSelection(reportSelectionSchema.parse(JSON.parse(response.output_text)), catalog);
    log("info", "OpenAI PR report selection completed", { repoId: evidence.repoId, pullRequestNumber: evidence.pullRequestNumber, headSha: evidence.headSha, selectionCount: selection.verifications.length, model: this.model, providerResponseId: response.id, inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null, durationMs: Date.now() - startedAt });
    return { selection, providerResponseId: response.id, inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null };
  }
}

function selectionJsonSchema(catalog: ReportSelectionCatalog) {
  return { type: "object", additionalProperties: false, required: ["summaryTemplate", "verifications"], properties: {
    summaryTemplate: { type: "string", enum: catalog.summaryTemplates },
    verifications: { type: "array", maxItems: 5, items: { type: "object", additionalProperties: false, required: ["entrypointId", "scenarioId", "hunkIds"], properties: {
      entrypointId: { type: "string", enum: catalog.verificationTargets.map((target) => target.id) },
      scenarioId: { type: "string" }, hunkIds: { type: "array", maxItems: 4, items: { type: "string" } },
    } } },
  } } as const;
}

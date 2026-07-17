import OpenAI from "openai";

import { reportSelectionSchema, type ReportEvidence, type ReportSelectionCatalog, type ReportSelectionResult, type ReportSelector } from "./report-types.js";
import { validateSelection } from "./templates.js";

export class OpenAIReportSelector implements ReportSelector {
  private readonly client: OpenAI;

  constructor(private readonly model = process.env.OPENAI_MODEL ?? "gpt-5.6-luna", apiKey = process.env.OPENAI_API_KEY) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
    this.client = new OpenAI({ apiKey });
  }

  async select(evidence: ReportEvidence, catalog: ReportSelectionCatalog): Promise<ReportSelectionResult> {
    const response = await this.client.responses.create({
      model: this.model,
      input: [
        {
          role: "developer",
          content: "Select only from the supplied report templates and verification targets. Do not write prose, add facts, or invent IDs. Return JSON matching the response schema.",
        },
        {
          role: "user",
          content: JSON.stringify({ evidence, catalog }),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "impact_report_selection",
          strict: true,
          schema: selectionJsonSchema(catalog),
        },
      },
    });
    const selection = validateSelection(reportSelectionSchema.parse(JSON.parse(response.output_text)), catalog);
    return {
      selection,
      providerResponseId: response.id,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
    };
  }
}

function selectionJsonSchema(catalog: ReportSelectionCatalog) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summaryTemplate", "verifications"],
    properties: {
      summaryTemplate: { type: "string", enum: catalog.summaryTemplates },
      verifications: catalog.verificationTargets.length === 0
        ? { type: "array", maxItems: 0 }
        : {
            type: "array",
            maxItems: 5,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["affectedItemId", "action"],
              properties: {
                affectedItemId: { type: "string", enum: catalog.verificationTargets.map((target) => target.id) },
                action: { type: "string", enum: ["render_page", "exercise_api_route", "exercise_component_state", "exercise_consumers"] },
              },
            },
          },
    },
  } as const;
}

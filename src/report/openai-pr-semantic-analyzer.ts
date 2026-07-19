import OpenAI from "openai";

import { prSemanticResultSchema, type PrSemanticAnalyzer, type PrSemanticInput, type SemanticAnalysisResult } from "./report-types.js";
import { SemanticAnalysisOutputError } from "./semantic-failure.js";
import { log } from "../server/logger.js";

/**
 * Explains approved source excerpts. It cannot select reachability targets or
 * write unbounded report prose; the renderer owns all evidence language.
 */
export class OpenAIPrSemanticAnalyzer implements PrSemanticAnalyzer {
  private readonly client: OpenAI;
  constructor(private readonly model = process.env.OPENAI_MODEL ?? "gpt-5.6-luna", apiKey = process.env.OPENAI_API_KEY) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
    this.client = new OpenAI({ apiKey });
  }

  async analyze(input: PrSemanticInput, evidence: { repoId: number; pullRequestNumber: number; headSha: string }): Promise<SemanticAnalysisResult> {
    const startedAt = Date.now();
    const targetIds = input.targets.map((target) => target.id);
    const response = await this.client.responses.create({
      model: this.model,
      input: [
        { role: "developer", content: [
          "Summarize only the supplied changed-code excerpts and propose verification checks only for supplied prioritized entrypoints.",
          "Never claim a regression, business motivation, runtime behavior not shown by context, or an affected route not supplied.",
          "Every summary must cite changed hunk IDs. Every check must cite its entrypoint, changed hunk IDs, and context IDs.",
          "Use concise developer-facing language. Return JSON only.",
        ].join(" ") },
        { role: "user", content: JSON.stringify(input) },
      ],
      text: { format: { type: "json_schema", name: "pr_semantic_analysis", strict: true, schema: semanticJsonSchema(targetIds) } },
    });
    if (!response.output_text.trim()) {
      throw new SemanticAnalysisOutputError("empty_output");
    }

    let parsedOutput: unknown;
    try {
      parsedOutput = JSON.parse(response.output_text);
    } catch {
      throw new SemanticAnalysisOutputError("malformed_json");
    }

    let schemaValidated: ReturnType<typeof prSemanticResultSchema.parse>;
    try {
      schemaValidated = prSemanticResultSchema.parse(parsedOutput);
    } catch {
      throw new SemanticAnalysisOutputError("schema_validation");
    }

    let result: ReturnType<typeof prSemanticResultSchema.parse>;
    try {
      result = validateSemanticResult(schemaValidated, input);
    } catch {
      throw new SemanticAnalysisOutputError("evidence_validation");
    }
    log("info", "OpenAI PR semantic analysis completed", { repoId: evidence.repoId, pullRequestNumber: evidence.pullRequestNumber, headSha: evidence.headSha, changedHunkCount: input.changedHunks.length, targetCount: input.targets.length, summaryCount: result.changeSummaries.length, verificationCount: result.verifications.length, model: this.model, providerResponseId: response.id, inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null, durationMs: Date.now() - startedAt });
    return { result, providerResponseId: response.id, inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null };
  }
}

export function validateSemanticResult(result: ReturnType<typeof prSemanticResultSchema.parse>, input: PrSemanticInput): ReturnType<typeof prSemanticResultSchema.parse> {
  const hunkIds = new Set(input.changedHunks.map((hunk) => hunk.id));
  const targets = new Map(input.targets.map((target) => [target.id, target]));
  const selectedTargets = new Set<string>();
  for (const summary of result.changeSummaries) for (const id of summary.hunkIds) if (!hunkIds.has(id)) throw new Error(`unknown changed hunk ${id}`);
  for (const verification of result.verifications) {
    if (selectedTargets.has(verification.entrypointId)) throw new Error(`duplicate semantic target ${verification.entrypointId}`);
    selectedTargets.add(verification.entrypointId);
    const target = targets.get(verification.entrypointId);
    if (!target) throw new Error(`unknown semantic target ${verification.entrypointId}`);
    const contextIds = new Set(target.context.map((item) => item.id));
    const checkTexts = new Set<string>();
    for (const check of verification.checks) {
      if (checkTexts.has(check.text)) throw new Error(`duplicate semantic verification check for ${verification.entrypointId}`);
      checkTexts.add(check.text);
      for (const id of check.hunkIds) if (!hunkIds.has(id)) throw new Error(`unknown changed hunk ${id}`);
      for (const id of check.contextIds) if (!contextIds.has(id)) throw new Error(`context ${id} does not belong to ${verification.entrypointId}`);
    }
  }
  return result;
}

/**
 * Strict Structured Outputs accepts a deliberately small JSON Schema subset.
 * Cardinality and length limits are therefore enforced by Zod after receiving
 * the response, not by API-schema keywords such as maxItems or minLength.
 */
export function semanticJsonSchema(targetIds: string[]) {
  const check = {
    type: "object",
    additionalProperties: false,
    required: ["text", "hunkIds", "contextIds"],
    properties: {
      text: { type: "string" },
      hunkIds: { type: "array", items: { type: "string" } },
      contextIds: { type: "array", items: { type: "string" } },
    },
  } as const;
  const verification = {
    type: "object",
    additionalProperties: false,
    required: ["entrypointId", "checks"],
    properties: {
      entrypointId: targetIds.length > 0 ? { type: "string", enum: targetIds } : { type: "string" },
      checks: { type: "array", items: check },
    },
  } as const;

  return {
    type: "object",
    additionalProperties: false,
    required: ["changeSummaries", "verifications"],
    properties: {
      changeSummaries: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["hunkIds", "summary"],
          properties: {
            hunkIds: { type: "array", items: { type: "string" } },
            summary: { type: "string" },
          },
        },
      },
      verifications: { type: "array", items: verification },
    },
  } as const;
}

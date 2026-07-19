import OpenAI from "openai";

import { featureCardSchema, type FeatureCardGenerationResult, type FeatureCardGenerator, type FeatureContext } from "./feature-types.js";
import { log } from "../server/logger.js";

export class OpenAIFeatureCardGenerator implements FeatureCardGenerator {
  private readonly client: OpenAI;
  constructor(private readonly model = process.env.OPENAI_MODEL ?? "gpt-5.6-luna", apiKey = process.env.OPENAI_API_KEY) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
    this.client = new OpenAI({ apiKey });
  }

  async generate(context: FeatureContext): Promise<FeatureCardGenerationResult> {
    const startedAt = Date.now();
    log("info", "OpenAI feature card request started", { entryPath: context.entryPath, entryKind: context.entryKind, contextFileCount: context.items.length, contextCharacterCount: context.items.reduce((total, item) => total + item.excerpt.length, 0), model: this.model });
    const response = await this.client.responses.create({
      model: this.model,
      input: [
        { role: "developer", content: "Describe only the user-facing feature represented by this route/API context. Return concise JSON. Suggest testable scenarios, not breakage claims. Every scenario must cite one or more supplied context IDs. Never mention source code, filenames, or facts outside the context." },
        { role: "user", content: JSON.stringify({ route: { path: context.entryPath, kind: context.entryKind, label: context.routeLabel }, context: context.items }) },
      ],
      text: { format: { type: "json_schema", name: "feature_card", strict: true, schema: featureCardJsonSchema(context.items.map((item) => item.id)) } },
    });
    const parsed = featureCardSchema.parse(JSON.parse(response.output_text));
    validateCardContext(parsed, new Set(context.items.map((item) => item.id)));
    log("info", "OpenAI feature card request completed", { entryPath: context.entryPath, scenarioCount: parsed.scenarios.length, model: this.model, providerResponseId: response.id, inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null, durationMs: Date.now() - startedAt });
    return { card: parsed, model: this.model, providerResponseId: response.id };
  }
}

export function validateCardContext(card: ReturnType<typeof featureCardSchema.parse>, allowedIds: Set<string>): void {
  const ids = new Set<string>();
  for (const scenario of card.scenarios) {
    if (ids.has(scenario.id)) throw new Error(`duplicate feature scenario ${scenario.id}`);
    ids.add(scenario.id);
    for (const contextId of scenario.contextIds) if (!allowedIds.has(contextId)) throw new Error(`unknown feature context ID ${contextId}`);
  }
}

function featureCardJsonSchema(contextIds: string[]) {
  return {
    type: "object", additionalProperties: false, required: ["version", "title", "description", "scenarios"],
    properties: {
      version: { type: "number", enum: [1] }, title: { type: "string", minLength: 3, maxLength: 100 }, description: { type: "string", minLength: 3, maxLength: 300 },
      scenarios: { type: "array", minItems: 1, maxItems: 5, items: { type: "object", additionalProperties: false, required: ["id", "title", "steps", "contextIds"], properties: {
        id: { type: "string", minLength: 1, maxLength: 64 }, title: { type: "string", minLength: 3, maxLength: 120 },
        steps: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", minLength: 3, maxLength: 220 } },
        contextIds: { type: "array", minItems: 1, maxItems: 4, items: { type: "string", enum: contextIds } },
      } } },
    },
  } as const;
}

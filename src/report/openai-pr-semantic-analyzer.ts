import OpenAI from "openai";
import { z } from "zod";

import { prSemanticResultSchema, type PrSemanticAnalyzer, type PrSemanticInput, type SemanticAnalysisResult } from "./report-types.js";
import { SemanticAnalysisOutputError } from "./semantic-failure.js";
import { log } from "../server/logger.js";

/**
 * Explains a deliberately small, source-cited PR packet. It cannot choose
 * reachability targets or write unbounded report prose; rendering owns facts.
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
          "Summarize only the supplied changed-code excerpts and propose verification scenarios only for supplied prioritized entrypoints.",
          "The graph, not you, establishes reachability. Never add a route, API, behavior, workflow, motivation, or regression that is not supported by supplied evidence.",
          "Every summary must cite changed hunk IDs. Every scenario must cite its entrypoint, at least one changed hunk from that target's verified dependency path, and supplied source-anchor IDs.",
          "A scenario needs a concise user-facing title, optional setup only when shown in evidence, manual actions, and observable expected results. Use no more than three actions and no more than three expected outcomes per scenario.",
          "The verifications object must include every supplied target ID. Return every distinct, evidence-grounded scenario supported by each supplied target; do not omit a supported target or scenario merely to keep the response short. Use an empty scenarios array only when that target has no supported user-facing scenario.",
          "Describe product behavior, not implementation. Never mention or suggest builds, TypeScript, compilation, imports, exports, linting, analytics, telemetry, instrumentation, callbacks, props, components, hooks, handlers, functions, types, interfaces, wiring, or CI/mechanical checks.",
          "Do not produce a scenario for an API target unless its supplied anchors establish an observable integration or operator contract.",
          "Use concise developer-facing language. Never include entrypoint IDs, hunk IDs, anchor IDs, source paths, or route URLs in user-facing titles. Return JSON only.",
        ].join(" ") },
        { role: "user", content: JSON.stringify(input) },
      ],
      text: { format: { type: "json_schema", name: "pr_verification_scenarios", strict: true, schema: semanticJsonSchema(targetIds) } },
    });
    if (!response.output_text.trim()) throw new SemanticAnalysisOutputError("empty_output");

    let parsedOutput: unknown;
    try {
      parsedOutput = normalizeProviderOutput(JSON.parse(response.output_text), targetIds);
    } catch {
      throw new SemanticAnalysisOutputError("malformed_json");
    }

    let schemaValidated: ReturnType<typeof prSemanticResultSchema.parse>;
    try {
      schemaValidated = prSemanticResultSchema.parse(parsedOutput);
    } catch (error) {
      throw new SemanticAnalysisOutputError("schema_validation", zodDiagnostic(error));
    }

    let result: ReturnType<typeof prSemanticResultSchema.parse>;
    try {
      result = validateSemanticResult(schemaValidated, input);
    } catch (error) {
      throw new SemanticAnalysisOutputError("evidence_validation", safeValidationDiagnostic(error));
    }
    log("info", "OpenAI PR verification scenarios completed", {
      repoId: evidence.repoId,
      pullRequestNumber: evidence.pullRequestNumber,
      headSha: evidence.headSha,
      changedHunkCount: input.changedHunks.length,
      targetCount: input.targets.length,
      anchorCount: input.targets.reduce((total, target) => total + target.anchors.length, 0),
      summaryCount: result.changeSummaries.length,
      scenarioCount: result.verifications.reduce((total, verification) => total + verification.scenarios.length, 0),
      rejectedScenarioCount: schemaValidated.verifications.reduce((total, verification) => total + verification.scenarios.length, 0)
        - result.verifications.reduce((total, verification) => total + verification.scenarios.length, 0),
      model: this.model,
      providerResponseId: response.id,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      durationMs: Date.now() - startedAt,
    });
    return { result, providerResponseId: response.id, inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null };
  }
}

export function validateSemanticResult(result: ReturnType<typeof prSemanticResultSchema.parse>, input: PrSemanticInput): ReturnType<typeof prSemanticResultSchema.parse> {
  const hunkById = new Map(input.changedHunks.map((hunk) => [hunk.id, hunk]));
  const targets = new Map(input.targets.map((target) => [target.id, target]));
  const selectedTargets = new Set<string>();

  const verifications = [] as ReturnType<typeof prSemanticResultSchema.parse>["verifications"];
  for (const verification of result.verifications) {
    // A malformed individual target must never contaminate valid guidance for
    // the rest of the PR. It is excluded before rendering, with the graph
    // evidence retained separately in the deterministic report.
    if (selectedTargets.has(verification.entrypointId)) continue;
    selectedTargets.add(verification.entrypointId);
    const target = targets.get(verification.entrypointId);
    if (!target) continue;
    if (target.kind === "api_route" && !target.apiVerificationAllowed) continue;
    const anchors = new Map(target.anchors.map((anchor) => [anchor.id, anchor]));
    // A route target may be semantically grounded through a changed child but
    // also be directly changed itself. Both hunks are valid evidence when they
    // sit on the exact verified path; requiring only changedSeedPath rejects a
    // sound scenario that correctly cites the route's own changed hunk.
    const allowedHunkPaths = new Set([target.path, target.changedSeedPath, ...target.dependencyPath]);
    const titles = new Set<string>();
    const scenarios = [] as typeof verification.scenarios;
    for (const rawScenario of verification.scenarios) {
      const scenario = { ...rawScenario, actions: rawScenario.actions.slice(0, 3), expected: rawScenario.expected.slice(0, 3) };
      if (titles.has(scenario.title)) continue;
      if (scenario.hunkIds.some((id) => !hunkById.has(id))) continue;
      if (!scenario.hunkIds.some((id) => allowedHunkPaths.has(hunkById.get(id)!.path))) continue;
      if (scenario.anchorIds.some((id) => !anchors.has(id))) continue;
      // The entrypoint ID already selects this exact route. Add its canonical
      // anchor deterministically when the model omits the redundant citation.
      const anchorIds = [...new Set(scenario.anchorIds)];
      const entrypointAnchor = target.anchors.find((anchor) => anchor.kind === "entrypoint");
      if (entrypointAnchor && !anchorIds.includes(entrypointAnchor.id)) anchorIds.unshift(entrypointAnchor.id);
      const behavioralAnchor = target.anchors.find((anchor) => ["interaction", "state", "api_contract", "test"].includes(anchor.kind));
      if (behavioralAnchor && !anchorIds.includes(behavioralAnchor.id)) anchorIds.splice(entrypointAnchor ? 1 : 0, 0, behavioralAnchor.id);
      if (anchorIds.length > 8) anchorIds.length = 8;
      const citedAnchors = anchorIds.map((id) => anchors.get(id)!);
      if (!citedAnchors.some((anchor) => anchor.kind === "entrypoint")) continue;
      if (!citedAnchors.some((anchor) => ["interaction", "state", "api_contract", "test"].includes(anchor.kind))) continue;
      const sanitized = sanitizeScenario(scenario);
      if (!sanitized) continue;
      titles.add(scenario.title);
      scenarios.push({ ...sanitized, anchorIds });
    }
    if (scenarios.length) verifications.push({ ...verification, scenarios });
  }
  return {
    ...result,
    changeSummaries: result.changeSummaries.flatMap((summary) => {
      if (summary.hunkIds.some((id) => !hunkById.has(id))) return [];
      const text = sanitizeProductText(summary.summary);
      return text ? [{ ...summary, summary: text }] : [];
    }),
    verifications,
  };
}

/** Product reports observable regressions; CI owns mechanical code checks. */
function sanitizeScenario<T extends { title: string; setup: string | null; actions: string[]; expected: string[] }>(scenario: T): T | null {
  const title = stripOpaqueTargetReference(sanitizeProductText(scenario.title) ?? "");
  const setup = scenario.setup === null ? null : sanitizeProductText(scenario.setup);
  const actions = scenario.actions.map(sanitizeProductText);
  const expected = scenario.expected.map(sanitizeProductText);
  if (!title || (scenario.setup !== null && !setup) || actions.some((value) => !value) || expected.some((value) => !value)) return null;
  return { ...scenario, title, setup, actions: actions as string[], expected: expected as string[] };
}

/** Models sometimes echo the transport-only target key in an otherwise valid title. */
function stripOpaqueTargetReference(value: string): string | null {
  const title = value.replace(/^\s*\[?entry(?:::[^\]\s]+)+\]?\s*/i, "").trim();
  return title || null;
}

function sanitizeProductText(text: string): string | null {
  // These phrases make a check compete with CI or ask for implementation work.
  if (/\b(?:typescript|typecheck|compile|compil(?:e|es|ation)|build(?:\s+check)?|lint(?:ing)?|eslint|prettier)\b/i.test(text)) return null;
  // A model may use a harmless code noun in an otherwise user-facing sentence.
  // Remove that noun instead of throwing away the customer-flow recommendation.
  const sanitized = text
    .replace(/\b(?:imports?|exports?|analytics|telemetry|instrumentation|tracking|callbacks?|interfaces?|wiring|components?|hooks?|handlers?|functions?|props?)\b/gi, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (/^(?:updates?|changes?|modifies?)\s+(?:for\s+)?[a-z0-9_-]+\.?$/i.test(sanitized)) return null;
  return sanitized.length ? sanitized : null;
}

/** Validation diagnostics intentionally contain only field paths and error codes. */
function zodDiagnostic(error: unknown): string | null {
  if (!(error instanceof z.ZodError)) return null;
  const details = error.issues.slice(0, 3).map((issue) => `${issue.path.map(String).join(".") || "root"}:${issue.code}`);
  return details.length ? details.join(", ") : null;
}

function safeValidationDiagnostic(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const value = error.message.replace(/[^a-z0-9_:. -]/gi, "").slice(0, 240).trim();
  return value || null;
}

/** Structured Outputs accepts this deliberately small JSON Schema subset. */
export function semanticJsonSchema(targetIds: string[]) {
  const scenario = {
    type: "object",
    additionalProperties: false,
    required: ["title", "setup", "actions", "expected", "hunkIds", "anchorIds"],
    properties: {
      title: { type: "string" },
      setup: { anyOf: [{ type: "string" }, { type: "null" }] },
      actions: { type: "array", items: { type: "string" } },
      expected: { type: "array", items: { type: "string" } },
      hunkIds: { type: "array", items: { type: "string" } },
      anchorIds: { type: "array", items: { type: "string" } },
    },
  } as const;
  const verification = {
    type: "object",
    additionalProperties: false,
    required: ["scenarios"],
    properties: {
      scenarios: { type: "array", items: scenario },
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
      verifications: {
        type: "object",
        additionalProperties: false,
        required: targetIds,
        properties: Object.fromEntries(targetIds.map((targetId) => [targetId, verification])),
      },
    },
  } as const;
}

/** Converts the provider's keyed, coverage-enforcing shape into our durable array contract. */
function normalizeProviderOutput(output: unknown, targetIds: string[]): unknown {
  if (typeof output !== "object" || output === null) return output;
  const record = output as Record<string, unknown>;
  if (typeof record.verifications !== "object" || record.verifications === null || Array.isArray(record.verifications)) return output;
  const keyed = record.verifications as Record<string, unknown>;
  return {
    ...record,
    verifications: targetIds.map((entrypointId) => {
      const value = keyed[entrypointId];
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? { entrypointId, ...(value as Record<string, unknown>) }
        : { entrypointId, scenarios: [] };
    }),
  };
}

import assert from "node:assert/strict";
import test from "node:test";

import { buildReportEvidence } from "../src/report/evidence.js";
import { semanticJsonSchema, validateSemanticResult } from "../src/report/openai-pr-semantic-analyzer.js";
import { classifySemanticFailure } from "../src/report/semantic-failure.js";
import { renderReport } from "../src/report/templates.js";
import type { ImpactAssessment } from "../src/impact/impact-assessment.js";
import type { DeterministicPrAnalysis } from "../src/impact/pr-impact-types.js";
import { prSemanticResultSchema, type PrSemanticInput } from "../src/report/report-types.js";

function analysis(): DeterministicPrAnalysis {
  return { status: "ready", repoId: 1, pullRequestNumber: 2, baseSha: "base", headSha: "head", impactLevel: "high",
    changedFiles: [{ path: "src/lib/price.ts", status: "modified", graphRelevant: true }],
    changedSymbols: [{ changeKind: "modified", filePath: "src/lib/price.ts", symbolKey: "src/lib/price.ts:function:price", name: "price", kind: "function" }],
    affectedItems: [{ path: "src/app/checkout/page.tsx", kind: "page", impact: "indirect", dependencyPath: ["src/lib/price.ts", "src/app/checkout/page.tsx"] }],
    unresolvedImportCount: 0, insufficientReason: null };
}

const assessment: ImpactAssessment = { version: 2, status: "ready", items: [{
  path: "src/app/checkout/page.tsx", kind: "page", tier: "primary", changedSeedPath: "src/lib/price.ts", technicalRole: "application",
  technicalRoleReason: "fixture", impact: "indirect", dependencyPath: ["src/lib/price.ts", "src/app/checkout/page.tsx"],
  reason: "Primary because changed application code reaches the route.",
}] };

const semanticInput: PrSemanticInput = { version: 1, enabled: true,
  changedHunks: [{ id: "hunk:1", path: "src/lib/price.ts", beforeStartLine: 1, afterStartLine: 1, beforeExcerpt: "old", afterExcerpt: "new" }],
  targets: [{ id: "entry:src/app/checkout/page.tsx", path: "src/app/checkout/page.tsx", kind: "page", tier: "primary", changedSeedPath: "src/lib/price.ts", dependencyPath: ["src/lib/price.ts", "src/app/checkout/page.tsx"], context: [{ id: "context:1:1", path: "src/app/checkout/page.tsx", blobSha: "blob", startLine: 1, endLine: 1, excerpt: "export default function Checkout() {}" }] }],
};

test("report renders PR-scoped semantic checks only for deterministic primary targets", () => {
  const evidence = buildReportEvidence(analysis(), assessment);
  const semantic = validateSemanticResult({ changeSummaries: [{ hunkIds: ["hunk:1"], summary: "Updates price handling." }], verifications: [{ entrypointId: "entry:src/app/checkout/page.tsx", checks: [{ text: "Complete a checkout and verify the displayed total.", hunkIds: ["hunk:1"], contextIds: ["context:1:1"] }] }] }, semanticInput);
  const report = renderReport(evidence, semantic);
  assert.equal(evidence.version, 4);
  assert.match(report, /Updates price handling/);
  assert.match(report, /Complete a checkout/);
  assert.match(report, /What to verify before merging/);
  assert.match(report, /Why: This page imports the modified `price` module/);
  assert.match(report, /price \(changed\)/);
  assert.match(report, /\/checkout \(page\)/);
  assert.match(report, /<summary>Technical evidence · 1 affected file · 0 unresolved import\(s\)<\/summary>/);
  assert.match(report, /```mermaid/);
  assert.match(report, /classDef changed/);
  assert.doesNotMatch(report, /All resolved dependency paths/);
  assert.match(report, /<\/details>/);
  assert.doesNotMatch(report, /Confidence|Impact level/);
});

test("semantic output cannot add routes or source references", () => {
  assert.throws(() => validateSemanticResult({ changeSummaries: [], verifications: [{ entrypointId: "entry:missing", checks: [{ text: "Test it", hunkIds: ["hunk:1"], contextIds: ["context:1:1"] }] }] }, semanticInput));
  assert.throws(() => validateSemanticResult({ changeSummaries: [{ hunkIds: ["hunk:missing"], summary: "No" }], verifications: [] }, semanticInput));
});

test("implementation-aware summaries and checks are removed while product checks remain", () => {
  const semantic = validateSemanticResult({
    changeSummaries: [
      { hunkIds: ["hunk:1"], summary: "Updates the callback wiring for the checkout component." },
      { hunkIds: ["hunk:1"], summary: "Updates the checkout total shown after a customer applies a discount." },
    ],
    verifications: [{
      entrypointId: "entry:src/app/checkout/page.tsx",
      checks: [
        { text: "Complete a checkout and verify the displayed total.", hunkIds: ["hunk:1"], contextIds: ["context:1:1"] },
        { text: "Run the TypeScript build and verify imports compile.", hunkIds: ["hunk:1"], contextIds: ["context:1:1"] },
        { text: "Verify analytics tracking event definitions.", hunkIds: ["hunk:1"], contextIds: ["context:1:1"] },
        { text: "Verify the success callback closes the dialog.", hunkIds: ["hunk:1"], contextIds: ["context:1:1"] },
      ],
    }],
  }, semanticInput);
  assert.deepEqual(semantic.changeSummaries.map((summary) => summary.summary), ["Updates the checkout total shown after a customer applies a discount."]);
  assert.deepEqual(semantic.verifications[0]?.checks.map((check) => check.text), ["Complete a checkout and verify the displayed total."]);
});

test("a route without an approved AI check uses its matching changed-behavior summary", () => {
  const evidence = buildReportEvidence(analysis(), assessment);
  const report = renderReport(evidence, {
    changeSummaries: [{ hunkIds: ["hunk:1"], summary: "Completing checkout now shows the updated total." }],
    verifications: [],
  }, { status: "completed", notice: null }, semanticInput);
  assert.match(report, /Confirm this changed behavior: Completing checkout now shows the updated total/);
  assert.doesNotMatch(report, /Review the user-visible behavior/);
});

test("strict provider schema uses only the supported subset; local validation keeps the bounds", () => {
  const schema = JSON.stringify(semanticJsonSchema(["entry:src/app/checkout/page.tsx"]));
  assert.doesNotMatch(schema, /minLength|maxLength|minItems|maxItems/);
  assert.throws(() => prSemanticResultSchema.parse({
    changeSummaries: [{ hunkIds: [], summary: "No evidence" }],
    verifications: [],
  }));
  assert.doesNotThrow(() => prSemanticResultSchema.parse({
    changeSummaries: [{ hunkIds: Array.from({ length: 12 }, (_, index) => `hunk:${index}`), summary: "All supplied changed hunks are relevant." }],
    verifications: [],
  }));
});

test("provider request rejections are surfaced separately from invalid model output", () => {
  const failure = classifySemanticFailure({ status: 400, code: "invalid_json_schema", type: "invalid_request_error", message: "Invalid schema for response format: unsupported keyword maxItems." });
  assert.equal(failure.category, "provider_request_rejected");
  assert.equal(failure.providerStatus, 400);
  assert.equal(failure.providerCode, "invalid_json_schema");
  assert.match(failure.persistedReason, /unsupported keyword maxItems/);
  assert.match(failure.notice, /rejected/);
});

test("missing OpenAI configuration is not mislabeled as invalid model output", () => {
  const failure = classifySemanticFailure(new Error("OPENAI_API_KEY is not configured"));
  assert.equal(failure.category, "configuration");
  assert.equal(failure.persistedReason, "OpenAI API key is not configured");
});

test("AI fallback is visible while deterministic evidence remains available", () => {
  const evidence = buildReportEvidence(analysis(), assessment);
  const report = renderReport(evidence, null, { status: "fallback", notice: "OpenAI authentication failed. Check the configured API key." });
  assert.match(report, /AI-assisted guidance unavailable/);
  assert.match(report, /OpenAI authentication failed/);
  assert.match(report, /deterministic dependency evidence/);
  assert.match(report, /What to verify before merging/);
});

test("insufficient evidence remains non-claiming", () => {
  const incomplete: DeterministicPrAnalysis = { ...analysis(), status: "insufficient_evidence", impactLevel: null, affectedItems: [], changedSymbols: [], insufficientReason: "comparison truncated" };
  const evidence = buildReportEvidence(incomplete, { version: 2, status: "insufficient_evidence", items: [] });
  assert.match(renderReport(evidence, null), /makes no impact claims/);
});

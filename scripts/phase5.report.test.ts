import assert from "node:assert/strict";
import test from "node:test";

import { buildReportEvidence } from "../src/report/evidence.js";
import { semanticJsonSchema, validateSemanticResult } from "../src/report/openai-pr-semantic-analyzer.js";
import { buildPrSemanticContext, lineHunks } from "../src/report/pr-semantic-context.js";
import { classifySemanticFailure } from "../src/report/semantic-failure.js";
import { renderReport } from "../src/report/templates.js";
import type { RepositoryReader, SourceFile } from "../src/graph/types.js";
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

const semanticInput: PrSemanticInput = { version: 2, enabled: true, repository: { owner: "acme", name: "shop" }, sourceReferences: [{ path: "src/lib/price.ts", revision: "head", startLine: 1, endLine: 2, symbolName: "price" }],
  changedHunks: [{ id: "hunk:1", path: "src/lib/price.ts", revision: "head", beforeStartLine: 1, beforeEndLine: 2, afterStartLine: 1, afterEndLine: 2, beforeExcerpt: "old", afterExcerpt: "new", symbolName: "price", symbolKind: "function" }],
  targets: [{
    id: "entry:src/app/checkout/page.tsx", path: "src/app/checkout/page.tsx", kind: "page", tier: "primary", changedSeedPath: "src/lib/price.ts", dependencyPath: ["src/lib/price.ts", "src/app/checkout/page.tsx"], apiVerificationAllowed: true,
    anchors: [
      { id: "anchor:1:1", kind: "changed_declaration", path: "src/lib/price.ts", revision: "head", blobSha: "price", startLine: 1, endLine: 2, label: "Changed price", excerpt: "export function price() {}" },
      { id: "anchor:1:2", kind: "entrypoint", path: "src/app/checkout/page.tsx", revision: "head", blobSha: "checkout", startLine: 1, endLine: 5, label: "Route entrypoint", excerpt: "export default function Checkout() {}" },
      { id: "anchor:1:3", kind: "interaction", path: "src/app/checkout/page.tsx", revision: "head", blobSha: "checkout", startLine: 6, endLine: 8, label: "Interactive control", excerpt: "<button>Pay</button>" },
      { id: "anchor:1:4", kind: "dependency_use", path: "src/app/checkout/page.tsx", revision: "head", blobSha: "checkout", startLine: 1, endLine: 1, label: "Dependency import", excerpt: "import { price } from '@/lib/price'" },
    ],
  }],
};

const scenario = {
  title: "Confirm the checkout total",
  setup: "A checkout item is available.",
  actions: ["Complete checkout with the item."],
  expected: ["The displayed total reflects the updated price."],
  hunkIds: ["hunk:1"],
  anchorIds: ["anchor:1:2", "anchor:1:3"],
};

test("report renders source-grounded scenarios without visible file paths or source lists", () => {
  const evidence = buildReportEvidence(analysis(), assessment);
  const semantic = validateSemanticResult({ changeSummaries: [{ hunkIds: ["hunk:1"], summary: "Updates the checkout total shown to customers." }], verifications: [{ entrypointId: "entry:src/app/checkout/page.tsx", scenarios: [scenario] }] }, semanticInput);
  const report = renderReport(evidence, semantic, { status: "completed", notice: null }, semanticInput);
  assert.equal(evidence.version, 5);
  assert.match(report, /What to verify before merging/);
  assert.match(report, /Confirm the checkout total/);
  assert.match(report, /Route: \/checkout/);
  assert.match(report, /\*\*Setup:\*\*/);
  assert.match(report, /\*\*Do:\*\*/);
  assert.match(report, /\*\*Expected Outcome:\*\*/);
  assert.match(report, /\*\*Why:\*\* This page imports the modified `price`/);
  assert.doesNotMatch(report, /in `src\//);
  assert.doesNotMatch(report, /All resolved dependency paths|Review the user-visible behavior/);
  assert.doesNotMatch(report, /^### Technical impact$/m);
  assert.doesNotMatch(report, /^### Changed source$/m);
  assert.match(report, /^### Impact map$/m);
  assert.doesNotMatch(report, /<details>/);
  assert.match(report, /```mermaid/);
});

test("technical-only reachability stays inside collapsed evidence", () => {
  const technicalAssessment: ImpactAssessment = {
    ...assessment,
    items: [
      ...assessment.items,
      {
        path: "src/app/analytics/page.tsx",
        kind: "page",
        tier: "technical_only",
        changedSeedPath: "src/lib/price.ts",
        technicalRole: "analytics",
        technicalRoleReason: "fixture",
        impact: "indirect",
        dependencyPath: ["src/lib/price.ts", "src/app/analytics/page.tsx"],
        reason: "Technical-only fixture.",
      },
    ],
  };
  const report = renderReport(buildReportEvidence(analysis(), technicalAssessment), null, { status: "not_requested", notice: null }, semanticInput);
  assert.doesNotMatch(report, /^### Technical impact$/m);
  assert.doesNotMatch(report, /^### Changed source$/m);
  assert.match(report, /^### Impact map$/m);
  assert.doesNotMatch(report, /<details>/);
  assert.match(report, /Dashed gray = technical-only reachability/);
});

test("report discloses prioritized entrypoints that were not expanded into scenarios", () => {
  const expandedAssessment: ImpactAssessment = {
    ...assessment,
    items: [
      ...assessment.items,
      {
        path: "src/app/refunds/page.tsx",
        kind: "page",
        tier: "primary",
        changedSeedPath: "src/lib/price.ts",
        technicalRole: "application",
        technicalRoleReason: "fixture",
        impact: "indirect",
        dependencyPath: ["src/lib/price.ts", "src/app/refunds/page.tsx"],
        reason: "Primary fixture.",
      },
    ],
  };
  const semantic = validateSemanticResult({
    changeSummaries: [],
    verifications: [{ entrypointId: "entry:src/app/checkout/page.tsx", scenarios: [scenario] }],
  }, semanticInput);
  const report = renderReport(buildReportEvidence(analysis(), expandedAssessment), semantic, { status: "completed", notice: null }, semanticInput);
  assert.match(report, /1 additional prioritized entrypoint was not expanded into scenarios/);
});

test("semantic output cannot add routes, unknown anchors, or uncited behavior", () => {
  assert.throws(() => validateSemanticResult({ changeSummaries: [], verifications: [{ entrypointId: "entry:missing", scenarios: [scenario] }] }, semanticInput));
  assert.throws(() => validateSemanticResult({ changeSummaries: [], verifications: [{ entrypointId: "entry:src/app/checkout/page.tsx", scenarios: [{ ...scenario, anchorIds: ["anchor:1:2", "anchor:missing"] }] }] }, semanticInput));
  const normalized = validateSemanticResult({ changeSummaries: [], verifications: [{ entrypointId: "entry:src/app/checkout/page.tsx", scenarios: [{ ...scenario, anchorIds: ["anchor:1:1", "anchor:1:4"] }] }] }, semanticInput);
  assert.ok(normalized.verifications[0]?.scenarios[0]?.anchorIds.includes("anchor:1:2"));
  assert.ok(normalized.verifications[0]?.scenarios[0]?.anchorIds.includes("anchor:1:3"));
  assert.throws(() => validateSemanticResult({ changeSummaries: [], verifications: [{ entrypointId: "entry:src/app/checkout/page.tsx", scenarios: [{ ...scenario, hunkIds: ["hunk:missing"] }] }] }, semanticInput));
});

test("implementation-aware scenarios are removed while product scenarios remain", () => {
  const result = validateSemanticResult({
    changeSummaries: [
      { hunkIds: ["hunk:1"], summary: "Updates callback wiring for checkout." },
      { hunkIds: ["hunk:1"], summary: "Updates the checkout total shown to customers." },
    ],
    verifications: [{ entrypointId: "entry:src/app/checkout/page.tsx", scenarios: [
      scenario,
      { ...scenario, title: "Run the TypeScript build", setup: null, actions: ["Compile the imports."], expected: ["The component typechecks."], anchorIds: ["anchor:1:2", "anchor:1:3"] },
    ] }],
  }, semanticInput);
  assert.deepEqual(result.changeSummaries.map((summary) => summary.summary), ["Updates the checkout total shown to customers."]);
  assert.deepEqual(result.verifications[0]?.scenarios.map((item) => item.title), ["Confirm the checkout total"]);
});

test("harmless implementation nouns are removed from user-facing scenario wording", () => {
  const result = validateSemanticResult({
    changeSummaries: [],
    verifications: [{ entrypointId: "entry:src/app/checkout/page.tsx", scenarios: [{
      ...scenario,
      title: "Confirm the checkout component",
      actions: ["Use the checkout component to pay."],
      expected: ["The component shows the updated total."],
    }] }],
  }, semanticInput);
  assert.equal(result.verifications[0]?.scenarios[0]?.title, "Confirm the checkout");
  assert.equal(result.verifications[0]?.scenarios[0]?.actions[0], "Use the checkout to pay.");
});

test("a valid model surplus is capped without discarding the report", () => {
  const result = validateSemanticResult({
    changeSummaries: [],
    verifications: [{ entrypointId: "entry:src/app/checkout/page.tsx", scenarios: [
      scenario,
      { ...scenario, title: "Check the confirmation total" },
      { ...scenario, title: "Check the receipt total" },
    ] }],
  }, semanticInput);
  assert.equal(result.verifications[0]?.scenarios.length, 2);
  assert.deepEqual(result.verifications[0]?.scenarios.map((item) => item.title), ["Confirm the checkout total", "Check the confirmation total"]);
});

test("valid action and expectation surplus is capped to a concise scenario", () => {
  const result = validateSemanticResult({
    changeSummaries: [],
    verifications: [{ entrypointId: "entry:src/app/checkout/page.tsx", scenarios: [{
      ...scenario,
      actions: ["Open checkout.", "Select pay.", "Confirm payment.", "Return to the cart."],
      expected: ["The total is shown.", "The confirmation is shown.", "The receipt is shown.", "The cart is cleared."],
    }] }],
  }, semanticInput);
  assert.equal(result.verifications[0]?.scenarios[0]?.actions.length, 3);
  assert.equal(result.verifications[0]?.scenarios[0]?.expected.length, 3);
});

test("separated changes retain separate hunks and overlapping declarations", () => {
  const before = { path: "src/lib/reviews.ts", blobSha: "before", content: [
    "export function first() {", "  return 'old one';", "}", "", "const spacer = true;", "", "", "", "", "", "", "", "export function second() {", "  return 'old two';", "}",
  ].join("\n") };
  const after = { path: "src/lib/reviews.ts", blobSha: "after", content: [
    "export function first() {", "  return 'new one';", "}", "", "const spacer = true;", "", "", "", "", "", "", "", "export function second() {", "  return 'new two';", "}",
  ].join("\n") };
  const hunks = lineHunks("src/lib/reviews.ts", "head", before, after);
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks.map((hunk) => hunk.symbolName), ["first", "second"]);
  assert.ok(hunks[0]!.afterStartLine < hunks[1]!.afterStartLine);
});

test("semantic context prioritizes route seeds and extracts AST and test anchors", async () => {
  const base: SourceFile[] = [
    { path: "src/lib/price.ts", blobSha: "base-price", content: "export function price() {\n  return 10;\n}\n" },
  ];
  const head: SourceFile[] = [
    { path: "src/lib/price.ts", blobSha: "head-price", content: "export function price() {\n  return 12;\n}\n" },
    { path: "src/hooks/use-analytics.ts", blobSha: "analytics", content: "export function track() {}\n" },
    { path: "src/app/checkout/page.tsx", blobSha: "checkout", content: "import { price } from '@/lib/price';\nexport default function Checkout() {\n  return <button aria-label=\"Pay now\">Pay {price()}</button>;\n}\n" },
    { path: "src/lib/price.test.ts", blobSha: "test", content: "import { price } from './price';\nit('shows the updated checkout total', () => expect(price()).toBe(12));\n" },
  ];
  const bySha = new Map([["base", base], ["head", head]]);
  const reader: RepositoryReader = {
    resolveRepository: async () => ({ owner: "acme", name: "shop", defaultBranch: "main" }),
    resolveBranchSha: async () => "head",
    fetchSource: async () => { throw new Error("not used"); },
    fetchTree: async () => head.map((file) => ({ path: file.path, blobSha: file.blobSha })),
    fetchFiles: async ({ sha, paths }) => (bySha.get(sha) ?? []).filter((file) => paths.includes(file.path)),
    compareCommits: async () => ({ comparable: true, reason: null, changes: [] }),
  };
  const input = await buildPrSemanticContext(
    { ...analysis(), changedFiles: [
      { path: "src/hooks/use-analytics.ts", status: "modified", graphRelevant: true },
      { path: "src/lib/price.ts", status: "modified", graphRelevant: true },
    ] },
    assessment,
    reader,
    { config: { repoId: 1, installationId: 1, owner: "acme", name: "shop", trackedBranch: "main", aiAssistanceEnabled: true } },
  );
  assert.equal(input.version, 2);
  assert.equal(input.changedHunks[0]?.path, "src/lib/price.ts");
  assert.equal(input.changedHunks[0]?.symbolName, "price");
  const anchors = input.targets[0]?.anchors ?? [];
  assert.ok(anchors.some((anchor) => anchor.kind === "changed_declaration"));
  assert.ok(anchors.some((anchor) => anchor.kind === "entrypoint"));
  assert.ok(anchors.some((anchor) => anchor.kind === "interaction"));
  assert.ok(anchors.some((anchor) => anchor.kind === "test"));
  assert.ok(anchors.every((anchor) => anchor.excerpt.length <= 1_600));
});

test("semantic context backfills past an ungrounded route candidate", async () => {
  const base: SourceFile[] = [
    { path: "src/lib/first.ts", blobSha: "base-first", content: "export function first() {\n  return 'old';\n}\n" },
    { path: "src/lib/price.ts", blobSha: "base-price", content: "export function price() {\n  return 10;\n}\n" },
  ];
  const head: SourceFile[] = [
    { path: "src/lib/first.ts", blobSha: "head-first", content: "export function first() {\n  return 'new';\n}\n" },
    { path: "src/lib/price.ts", blobSha: "head-price", content: "export function price() {\n  return 12;\n}\n" },
    { path: "src/app/no-anchor/page.tsx", blobSha: "no-anchor", content: "import { first } from '@/lib/first';\nexport default function NoAnchor() {\n  return <main>{first()}</main>;\n}\n" },
    { path: "src/app/checkout/page.tsx", blobSha: "checkout", content: "import { price } from '@/lib/price';\nexport default function Checkout() {\n  return <button>Pay {price()}</button>;\n}\n" },
  ];
  const bySha = new Map([["base", base], ["head", head]]);
  const reader: RepositoryReader = {
    resolveRepository: async () => ({ owner: "acme", name: "shop", defaultBranch: "main" }),
    resolveBranchSha: async () => "head",
    fetchSource: async () => { throw new Error("not used"); },
    fetchTree: async () => head.map((file) => ({ path: file.path, blobSha: file.blobSha })),
    fetchFiles: async ({ sha, paths }) => (bySha.get(sha) ?? []).filter((file) => paths.includes(file.path)),
    compareCommits: async () => ({ comparable: true, reason: null, changes: [] }),
  };
  const contextAssessment: ImpactAssessment = {
    ...assessment,
    items: [
      {
        path: "src/app/no-anchor/page.tsx",
        kind: "page",
        tier: "primary",
        changedSeedPath: "src/lib/first.ts",
        technicalRole: "application",
        technicalRoleReason: "fixture",
        impact: "indirect",
        dependencyPath: ["src/lib/first.ts", "src/app/no-anchor/page.tsx"],
        reason: "Primary fixture.",
      },
      assessment.items[0]!,
    ],
  };
  const input = await buildPrSemanticContext(
    {
      ...analysis(),
      changedFiles: [
        { path: "src/lib/first.ts", status: "modified", graphRelevant: true },
        { path: "src/lib/price.ts", status: "modified", graphRelevant: true },
      ],
    },
    contextAssessment,
    reader,
    { config: { repoId: 1, installationId: 1, owner: "acme", name: "shop", trackedBranch: "main", aiAssistanceEnabled: true } },
  );
  assert.deepEqual(input.targets.map((target) => target.path), ["src/app/checkout/page.tsx"]);
  assert.ok(input.changedHunks.some((hunk) => hunk.path === "src/lib/price.ts"));
});

test("strict provider schema uses only the supported subset; local validation keeps bounds", () => {
  const schema = JSON.stringify(semanticJsonSchema(["entry:src/app/checkout/page.tsx"]));
  assert.doesNotMatch(schema, /minLength|maxLength|minItems|maxItems/);
  assert.throws(() => prSemanticResultSchema.parse({ changeSummaries: [{ hunkIds: [], summary: "No evidence" }], verifications: [] }));
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

test("AI fallback does not fabricate generic verification work", () => {
  const evidence = buildReportEvidence(analysis(), assessment);
  const report = renderReport(evidence, null, { status: "fallback", notice: "OpenAI authentication failed." }, semanticInput);
  assert.match(report, /AI-assisted guidance unavailable/);
  assert.doesNotMatch(report, /What to verify before merging|Review the user-visible behavior/);
  assert.doesNotMatch(report, /Affected routes without a source-grounded scenario/);
});

test("insufficient evidence remains non-claiming", () => {
  const incomplete: DeterministicPrAnalysis = { ...analysis(), status: "insufficient_evidence", impactLevel: null, affectedItems: [], changedSymbols: [], insufficientReason: "comparison truncated" };
  const evidence = buildReportEvidence(incomplete, { version: 2, status: "insufficient_evidence", items: [] });
  assert.match(renderReport(evidence, null), /makes no impact claims/);
});

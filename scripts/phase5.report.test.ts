import assert from "node:assert/strict";
import test from "node:test";

import { buildReportEvidence } from "../src/report/evidence.js";
import { buildSelectionCatalog, defaultSelection, renderReport, validateSelection } from "../src/report/templates.js";
import type { DeterministicPrAnalysis } from "../src/impact/pr-impact-types.js";

function analysis(unresolvedImportCount = 0): DeterministicPrAnalysis {
  return {
    status: "ready",
    repoId: 1,
    pullRequestNumber: 2,
    baseSha: "base",
    headSha: "head",
    impactLevel: "high",
    changedFiles: [{ path: "src/lib/price.ts", status: "modified", graphRelevant: true }],
    changedSymbols: [{ changeKind: "modified", filePath: "src/lib/price.ts", symbolKey: "src/lib/price.ts:function:price", name: "price", kind: "function" }],
    affectedItems: [
      { path: "src/lib/price.ts", kind: "shared_module", impact: "direct", dependencyPath: ["src/lib/price.ts"] },
      { path: "src/app/checkout/page.tsx", kind: "page", impact: "indirect", dependencyPath: ["src/lib/price.ts", "src/app/checkout/page.tsx"] },
      { path: "src/app/api/orders/route.ts", kind: "api_route", impact: "indirect", dependencyPath: ["src/lib/price.ts", "src/app/api/orders/route.ts"] },
    ],
    unresolvedImportCount,
    insufficientReason: null,
  };
}

test("evidence has stable IDs and confidence thresholds", () => {
  assert.equal(buildReportEvidence(analysis(0)).confidence, "high");
  assert.equal(buildReportEvidence(analysis(3)).confidence, "medium");
  assert.equal(buildReportEvidence(analysis(4)).confidence, "low");
  const evidence = buildReportEvidence(analysis());
  assert.deepEqual(evidence.changedSymbols.map((item) => item.id), ["symbol:src/lib/price.ts:function:price"]);
  assert.ok(evidence.affectedItems.every((item) => item.id.startsWith("affected:") && item.dependencyPath.length > 0));
});

test("renderer uses only validated template selections and evidence paths", () => {
  const evidence = buildReportEvidence(analysis());
  const catalog = buildSelectionCatalog(evidence);
  const selection = defaultSelection(catalog);
  const report = renderReport(evidence, selection);
  assert.match(report, /\*\*Impact level:\*\* High/);
  assert.match(report, /src\/lib\/price\.ts → src\/app\/checkout\/page\.tsx/);
  assert.match(report, /modified: `price` in src\/lib\/price\.ts/);
  assert.throws(() => validateSelection({ summaryTemplate: "route_change", verifications: [] }, catalog));
  assert.throws(() => validateSelection({ summaryTemplate: "broad_shared_change", verifications: [{ affectedItemId: "affected:missing", action: "render_page" }] }, catalog));
});

test("insufficient evidence is non-claiming and has no LLM targets", () => {
  const incomplete: DeterministicPrAnalysis = { ...analysis(), status: "insufficient_evidence", impactLevel: null, affectedItems: [], changedSymbols: [], insufficientReason: "comparison truncated" };
  const evidence = buildReportEvidence(incomplete);
  const catalog = buildSelectionCatalog(evidence);
  assert.equal(evidence.confidence, "insufficient");
  assert.deepEqual(catalog.verificationTargets, []);
  assert.match(renderReport(evidence, defaultSelection(catalog)), /makes no impact claims/);
});

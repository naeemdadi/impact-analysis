import assert from "node:assert/strict";
import test from "node:test";

import { buildReportEvidence } from "../src/report/evidence.js";
import { buildSelectionCatalog, defaultSelection, renderReport, validateSelection } from "../src/report/templates.js";
import type { DeterministicPrAnalysis } from "../src/impact/pr-impact-types.js";

function analysis(): DeterministicPrAnalysis {
  return { status: "ready", repoId: 1, pullRequestNumber: 2, baseSha: "base", headSha: "head", impactLevel: "high",
    changedFiles: [{ path: "src/lib/price.ts", status: "modified", graphRelevant: true }],
    changedSymbols: [{ changeKind: "modified", filePath: "src/lib/price.ts", symbolKey: "src/lib/price.ts:function:price", name: "price", kind: "function" }],
    affectedItems: [
      { path: "src/lib/price.ts", kind: "shared_module", impact: "direct", dependencyPath: ["src/lib/price.ts"] },
      { path: "src/app/checkout/page.tsx", kind: "page", impact: "indirect", dependencyPath: ["src/lib/price.ts", "src/app/checkout/page.tsx"] },
    ], unresolvedImportCount: 0, insufficientReason: null };
}

test("evidence has stable IDs and feature scenarios render from validated context", () => {
  const evidence = buildReportEvidence(analysis(), { featureTargets: [{
    id: "entry:src/app/checkout/page.tsx", path: "src/app/checkout/page.tsx", kind: "page", impact: "indirect",
    dependencyPath: ["src/lib/price.ts", "src/app/checkout/page.tsx"], title: "Checkout", description: "Purchase flow",
    scenarios: [{ id: "entry:src/app/checkout/page.tsx:scenario:purchase", title: "Purchase", steps: ["Complete a checkout with one item."], contextIds: ["context:1"] }],
  }], changedHunks: [{ id: "hunk:1", path: "src/lib/price.ts", beforeStartLine: 1, afterStartLine: 1, beforeExcerpt: "old", afterExcerpt: "new" }] });
  assert.equal(evidence.version, 3);
  assert.deepEqual(evidence.changedSymbols.map((item) => item.id), ["symbol:src/lib/price.ts:function:price"]);
  const catalog = buildSelectionCatalog(evidence);
  const report = renderReport(evidence, defaultSelection(catalog));
  assert.match(report, /Before merging, verify/);
  assert.match(report, /Complete a checkout with one item/);
  assert.match(report, /src\/lib\/price\.ts → src\/app\/checkout\/page\.tsx/);
  assert.doesNotMatch(report, /Confidence/);
  assert.throws(() => validateSelection({ summaryTemplate: "broad_shared_change", verifications: [{ entrypointId: "entry:missing", scenarioId: "x", hunkIds: [] }] }, catalog));
});

test("insufficient evidence is non-claiming and has no LLM targets", () => {
  const incomplete: DeterministicPrAnalysis = { ...analysis(), status: "insufficient_evidence", impactLevel: null, affectedItems: [], changedSymbols: [], insufficientReason: "comparison truncated" };
  const evidence = buildReportEvidence(incomplete);
  assert.deepEqual(buildSelectionCatalog(evidence).verificationTargets, []);
  assert.match(renderReport(evidence, defaultSelection(buildSelectionCatalog(evidence))), /makes no impact claims/);
});

import assert from "node:assert/strict";
import test from "node:test";

import { analyzePrImpact, createInsufficientAnalysis } from "../src/impact/pr-impact-engine.js";
import type { BaselineGraph, CommitFileChange } from "../src/graph/types.js";

const request = { repoId: 1, pullRequestNumber: 42, baseRef: "main", baseSha: "base", headSha: "head" };

function graph(files: Array<[string, BaselineGraph["files"][number]["kind"]]>, edges: Array<[string, string | null, BaselineGraph["imports"][number]["resolutionStatus"]]> = [], symbols: BaselineGraph["symbols"] = []): BaselineGraph {
  return {
    files: files.map(([path, kind]) => ({ path, kind, blobSha: path, classificationReason: "fixture" })),
    symbols,
    imports: edges.map(([fromPath, toPath, resolutionStatus]) => ({ fromPath, toPath, resolutionStatus, specifier: toPath ?? "external", kind: "static", unresolvedReason: resolutionStatus === "unresolved" ? "fixture" : null })),
  };
}

function symbol(filePath: string, name: string, sourceHash: string) {
  return { filePath, symbolKey: `${filePath}:function:${name}`, name, kind: "function" as const, isExported: true, startLine: 1, startColumn: 1, endLine: 2, endColumn: 1, sourceHash };
}

test("shared change reaches multiple entrypoints with stable file evidence", () => {
  const base = graph(
    [["src/lib/discount.ts", "shared_module"], ["src/app/checkout/page.tsx", "page"], ["src/app/api/refund/route.ts", "api_route"], ["src/components/Price.tsx", "component"]],
    [["src/app/checkout/page.tsx", "src/lib/discount.ts", "resolved"], ["src/app/api/refund/route.ts", "src/lib/discount.ts", "resolved"], ["src/components/Price.tsx", "src/lib/discount.ts", "resolved"]],
    [symbol("src/lib/discount.ts", "calculateDiscount", "before")],
  );
  const head = { ...base, symbols: [symbol("src/lib/discount.ts", "calculateDiscount", "after")] };
  const changes: CommitFileChange[] = [{ path: "src/lib/discount.ts", status: "modified" }];
  const result = analyzePrImpact({ request, baseGraph: base, headGraph: head, changes });

  assert.equal(result.impactLevel, "high");
  assert.deepEqual(result.changedSymbols.map((entry) => entry.changeKind), ["modified"]);
  assert.deepEqual(result.affectedItems.map((entry) => entry.path), [
    "src/app/api/refund/route.ts",
    "src/components/Price.tsx",
    "src/app/checkout/page.tsx",
    "src/lib/discount.ts",
  ]);
  assert.deepEqual(result.affectedItems.find((entry) => entry.path === "src/app/checkout/page.tsx")?.dependencyPath, ["src/lib/discount.ts", "src/app/checkout/page.tsx"]);
});

test("changed route is medium and a local component with one page is low", () => {
  const route = graph([["src/app/checkout/page.tsx", "page"]], [], [symbol("src/app/checkout/page.tsx", "Checkout", "before")]);
  const changedRoute = analyzePrImpact({ request, baseGraph: route, headGraph: { ...route, symbols: [symbol("src/app/checkout/page.tsx", "Checkout", "after")] }, changes: [{ path: "src/app/checkout/page.tsx", status: "modified" }] });
  assert.equal(changedRoute.impactLevel, "medium");
  assert.equal(changedRoute.affectedItems[0].impact, "direct");

  const component = graph([["src/components/Button.tsx", "component"], ["src/app/checkout/page.tsx", "page"]], [["src/app/checkout/page.tsx", "src/components/Button.tsx", "resolved"]], [symbol("src/components/Button.tsx", "Button", "before")]);
  const changedComponent = analyzePrImpact({ request, baseGraph: component, headGraph: { ...component, symbols: [symbol("src/components/Button.tsx", "Button", "after")] }, changes: [{ path: "src/components/Button.tsx", status: "modified" }] });
  assert.equal(changedComponent.impactLevel, "low");
});

test("deleted modules use base reverse edges and unresolved imports create no affected paths", () => {
  const base = graph([["src/lib/old.ts", "shared_module"], ["src/app/page.tsx", "page"]], [["src/app/page.tsx", "src/lib/old.ts", "resolved"]], [symbol("src/lib/old.ts", "oldValue", "before")]);
  const head = graph([["src/app/page.tsx", "page"]], [["src/app/page.tsx", null, "unresolved"]]);
  const result = analyzePrImpact({ request, baseGraph: base, headGraph: head, changes: [{ path: "src/lib/old.ts", status: "removed" }] });
  assert.equal(result.impactLevel, "low");
  assert.deepEqual(result.affectedItems.find((entry) => entry.path === "src/app/page.tsx")?.dependencyPath, ["src/lib/old.ts", "src/app/page.tsx"]);
  assert.equal(result.unresolvedImportCount, 1);

  const insufficient = createInsufficientAnalysis(request, "comparison truncated", [{ path: "src/lib/old.ts", status: "modified" }]);
  assert.equal(insufficient.status, "insufficient_evidence");
  assert.equal(insufficient.affectedItems.length, 0);
});

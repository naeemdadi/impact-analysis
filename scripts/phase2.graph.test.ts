import assert from "node:assert/strict";
import test from "node:test";

import { buildBaselineGraph } from "../src/graph/baseline-graph-builder.js";
import type { RepositorySource } from "../src/graph/types.js";

function fixtureSource(): RepositorySource {
  return {
    repoId: 42,
    owner: "octo",
    name: "shop",
    branch: "main",
    sha: "abc123",
    files: [
      {
        path: "tsconfig.json",
        blobSha: "config",
        content: JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
      },
      {
        path: "src/app/checkout/page.tsx",
        blobSha: "page",
        content: 'import { PriceSummary } from "@/components/PriceSummary";\nimport { calculateDiscount } from "@/lib/discount";\nexport default function CheckoutPage() { return <PriceSummary />; }',
      },
      {
        path: "src/app/api/checkout/route.ts",
        blobSha: "route",
        content: 'import { calculateDiscount } from "@/lib/discount";\nexport async function POST() { return Response.json(calculateDiscount()); }',
      },
      {
        path: "src/components/PriceSummary.tsx",
        blobSha: "component",
        content: 'export const PriceSummary = () => <div />;',
      },
      {
        path: "src/lib/discount.ts",
        blobSha: "discount",
        content: 'export function calculateDiscount() { return 10; }',
      },
      {
        path: "src/lib/uses-external.ts",
        blobSha: "external",
        content: 'import React from "react"; import { missing } from "@/missing"; export const value = missing;',
      },
    ],
  };
}

test("builds deterministic files, symbols, import edges, and Next.js classifications", () => {
  const graph = buildBaselineGraph(fixtureSource());

  assert.deepEqual(
    graph.files.map((file) => [file.path, file.kind]),
    [
      ["src/app/api/checkout/route.ts", "api_route"],
      ["src/app/checkout/page.tsx", "page"],
      ["src/components/PriceSummary.tsx", "component"],
      ["src/lib/discount.ts", "module"],
      ["src/lib/uses-external.ts", "module"],
    ],
  );
  assert.ok(graph.symbols.some((symbol) => symbol.symbolKey === "src/lib/discount.ts:function:calculateDiscount"));
  assert.ok(graph.symbols.some((symbol) => symbol.symbolKey === "src/components/PriceSummary.tsx:component:PriceSummary"));
});

test("resolves aliases and supports reverse traversal from an imported file", () => {
  const graph = buildBaselineGraph(fixtureSource());
  const consumers = graph.imports
    .filter((entry) => entry.toPath === "src/lib/discount.ts")
    .map((entry) => entry.fromPath)
    .sort();

  assert.deepEqual(consumers, ["src/app/api/checkout/route.ts", "src/app/checkout/page.tsx"]);
  assert.equal(graph.imports.every((entry) => entry.fromPath !== "tsconfig.json"), true);
});

test("records external and unresolved imports without inventing targets", () => {
  const graph = buildBaselineGraph(fixtureSource());
  const external = graph.imports.find((entry) => entry.specifier === "react");
  const unresolved = graph.imports.find((entry) => entry.specifier === "@/missing");

  assert.deepEqual(external, {
    fromPath: "src/lib/uses-external.ts",
    toPath: null,
    specifier: "react",
    kind: "static",
    resolutionStatus: "external",
    unresolvedReason: null,
  });
  assert.equal(unresolved?.resolutionStatus, "unresolved");
  assert.equal(unresolved?.toPath, null);
  assert.match(unresolved?.unresolvedReason ?? "", /could not be resolved/);
});

test("uses conservative JavaScript defaults when no tsconfig or jsconfig exists", () => {
  const source = fixtureSource();
  source.files = source.files.filter((file) => file.path !== "tsconfig.json");
  const graph = buildBaselineGraph(source);
  assert.equal(graph.files.length, 5);
  assert.equal(graph.projects?.[0]?.configPath, null);
});

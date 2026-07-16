import assert from "node:assert/strict";
import test from "node:test";

import { buildBaselineGraph } from "../src/graph/baseline-graph-builder.js";
import { buildIncrementalGraph } from "../src/graph/incremental-graph-builder.js";
import type { CommitFileChange, RepositorySource } from "../src/graph/types.js";

function source(files: Record<string, string>, sha: string): RepositorySource {
  return {
    repoId: 42, owner: "octo", name: "shop", branch: "main", sha,
    allFilePaths: Object.keys(files),
    files: Object.entries(files).map(([path, content]) => ({ path, content, blobSha: `${path}:${Buffer.from(content).toString("base64")}` })),
  };
}

const baseFiles = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
  "src/app/page.tsx": 'import { price } from "@/lib/price"; export default function Page() { return <div>{price()}</div>; }',
  "src/lib/price.ts": "export function price() { return 1; }",
  "src/lib/missing.ts": 'import { later } from "@/lib/later"; export const value = later;',
};

function canonical(graph: ReturnType<typeof buildBaselineGraph>): unknown {
  return {
    files: graph.files.sort((a, b) => a.path.localeCompare(b.path)),
    symbols: graph.symbols.sort((a, b) => a.symbolKey.localeCompare(b.symbolKey)),
    imports: graph.imports.sort((a, b) => `${a.fromPath}:${a.specifier}`.localeCompare(`${b.fromPath}:${b.specifier}`)),
  };
}

test("reparses changed modules and reverse dependents, producing the full-build graph", () => {
  const previous = buildBaselineGraph(source(baseFiles, "before"));
  const target = source({ ...baseFiles, "src/lib/price.ts": "export function price() { return 2; }" }, "after");
  const changes: CommitFileChange[] = [{ path: "src/lib/price.ts", status: "modified" }];
  const incremental = buildIncrementalGraph({ previousGraph: previous, targetSource: target, changes });

  assert.deepEqual(incremental.reanalyzedPaths, ["src/app/page.tsx", "src/lib/price.ts"]);
  assert.deepEqual(canonical(incremental.graph), canonical(buildBaselineGraph(target)));
});

test("new source files re-evaluate previously unresolved local imports", () => {
  const previous = buildBaselineGraph(source(baseFiles, "before"));
  const target = source({ ...baseFiles, "src/lib/later.ts": "export const later = 1;" }, "after");
  const incremental = buildIncrementalGraph({
    previousGraph: previous,
    targetSource: target,
    changes: [{ path: "src/lib/later.ts", status: "added" }],
  });

  assert.ok(incremental.reanalyzedPaths.includes("src/lib/missing.ts"));
  assert.equal(incremental.graph.imports.find((entry) => entry.fromPath === "src/lib/missing.ts")?.toPath, "src/lib/later.ts");
});

test("deleted modules remove their facts and force reverse dependents to be re-resolved", () => {
  const previous = buildBaselineGraph(source(baseFiles, "before"));
  const target = source({ "tsconfig.json": baseFiles["tsconfig.json"], "src/app/page.tsx": baseFiles["src/app/page.tsx"], "src/lib/missing.ts": baseFiles["src/lib/missing.ts"] }, "after");
  const incremental = buildIncrementalGraph({
    previousGraph: previous,
    targetSource: target,
    changes: [{ path: "src/lib/price.ts", status: "removed" }],
  });

  assert.ok(incremental.reanalyzedPaths.includes("src/app/page.tsx"));
  assert.equal(incremental.graph.files.some((file) => file.path === "src/lib/price.ts"), false);
  assert.equal(incremental.graph.imports.find((entry) => entry.fromPath === "src/app/page.tsx")?.resolutionStatus, "unresolved");
});

test("renamed modules re-resolve reverse dependents without retaining the old target", () => {
  const previous = buildBaselineGraph(source(baseFiles, "before"));
  const target = source({ ...baseFiles, "src/lib/cost.ts": baseFiles["src/lib/price.ts"] }, "after");
  target.files = target.files.filter((file) => file.path !== "src/lib/price.ts");
  target.allFilePaths = target.files.map((file) => file.path);
  const incremental = buildIncrementalGraph({
    previousGraph: previous,
    targetSource: target,
    changes: [{ path: "src/lib/cost.ts", previousPath: "src/lib/price.ts", status: "renamed" }],
  });

  assert.ok(incremental.reanalyzedPaths.includes("src/app/page.tsx"));
  assert.equal(incremental.graph.files.some((file) => file.path === "src/lib/price.ts"), false);
});

test("JavaScript and stylesheet updates reanalyze their code consumers", () => {
  const files = {
    "tsconfig.json": baseFiles["tsconfig.json"],
    "src/app/page.tsx": 'import { env } from "@/env"; import "@/styles/site.css"; export default function Page() { return <div>{env.name}</div>; }',
    "src/env.js": "export const env = { name: 'before' };",
    "src/styles/site.css": "body { color: black; }",
  };
  const previous = buildBaselineGraph(source(files, "before"));
  const target = source({ ...files, "src/env.js": "export const env = { name: 'after' };", "src/styles/site.css": "body { color: blue; }" }, "after");
  const incremental = buildIncrementalGraph({
    previousGraph: previous,
    targetSource: target,
    changes: [{ path: "src/env.js", status: "modified" }, { path: "src/styles/site.css", status: "modified" }],
  });

  assert.deepEqual(incremental.reanalyzedPaths, ["src/app/page.tsx", "src/env.js", "src/styles/site.css"]);
  assert.deepEqual(canonical(incremental.graph), canonical(buildBaselineGraph(target)));
});

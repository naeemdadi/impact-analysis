import assert from "node:assert/strict";
import test from "node:test";

import { buildFeatureContext, isFeatureCardEntrypoint, routeLabelForPath } from "../src/feature/feature-context.js";
import { collectFeatureContextPaths, selectFeatureIndexEntrypoints } from "../src/feature/feature-index-selection.js";
import type { BaselineGraph, RepositorySource } from "../src/graph/types.js";

const source: RepositorySource = {
  repoId: 1, owner: "owner", name: "repo", branch: "main", sha: "head", allFilePaths: ["tsconfig.json", "src/app/s/[publicId]/page.tsx", "src/components/reviews.tsx"],
  files: [
    { path: "tsconfig.json", blobSha: "config", content: "{}" },
    { path: "src/app/s/[publicId]/page.tsx", blobSha: "page", content: "import { Reviews } from '@/components/reviews'; export default function Page() { return <Reviews />; }" },
    { path: "src/components/reviews.tsx", blobSha: "reviews", content: "export function Reviews() { return <section>Reviews</section>; }" },
  ],
};
const graph: BaselineGraph = {
  files: [
    { path: "src/app/s/[publicId]/page.tsx", blobSha: "page", kind: "page", classificationReason: "route" },
    { path: "src/components/reviews.tsx", blobSha: "reviews", kind: "component", classificationReason: "component" },
  ], symbols: [], imports: [{ fromPath: "src/app/s/[publicId]/page.tsx", toPath: "src/components/reviews.tsx", specifier: "@/components/reviews", kind: "static", resolutionStatus: "resolved", unresolvedReason: null }],
};

test("feature context is bounded, deterministic, and includes only route-reachable source", () => {
  const context = buildFeatureContext({ source, graph, entryPath: "src/app/s/[publicId]/page.tsx", entryKind: "page" });
  assert.ok(context);
  assert.equal(context!.routeLabel, "/s/[publicId]");
  assert.deepEqual(context!.items.map((item) => item.path), ["src/app/s/[publicId]/page.tsx", "src/components/reviews.tsx"]);
  assert.equal(context!.sourceFingerprint, buildFeatureContext({ source, graph, entryPath: "src/app/s/[publicId]/page.tsx", entryKind: "page" })!.sourceFingerprint);
  assert.equal(routeLabelForPath("src/app/api/reviews/route.ts", "api_route"), "API api/reviews");
});

test("incremental feature indexing selects only reverse-reachable entrypoints", () => {
  const allEntrypoints = graph.files.filter((file) => file.kind === "page" || file.kind === "api_route");
  const selected = selectFeatureIndexEntrypoints(graph, allEntrypoints, { repoId: 1, branch: "main", sha: "head", mode: "incremental", changedPaths: ["src/components/reviews.tsx"] });
  assert.deepEqual(selected.map((file) => file.path), ["src/app/s/[publicId]/page.tsx"]);
  assert.deepEqual(collectFeatureContextPaths(graph, selected.map((file) => file.path)), ["src/app/s/[publicId]/page.tsx", "src/components/reviews.tsx"]);
});

test("feature context excludes environment and database infrastructure while retaining graph facts", () => {
  const protectedSource: RepositorySource = {
    ...source,
    allFilePaths: [...(source.allFilePaths ?? []), "src/env.js", "src/server/db/schema.ts", "src/lib/cloudflare.ts"],
    files: [...source.files,
      { path: "src/env.js", blobSha: "env", content: "export const secret = process.env.SECRET" },
      { path: "src/server/db/schema.ts", blobSha: "schema", content: "export const databaseSchema = {}" },
      { path: "src/lib/cloudflare.ts", blobSha: "provider", content: "export const providerClient = {}" },
    ],
  };
  const protectedGraph: BaselineGraph = {
    files: [...graph.files,
      { path: "src/env.js", blobSha: "env", kind: "shared_module", classificationReason: "module" },
      { path: "src/server/db/schema.ts", blobSha: "schema", kind: "shared_module", classificationReason: "module" },
      { path: "src/lib/cloudflare.ts", blobSha: "provider", kind: "shared_module", classificationReason: "module" },
    ],
    symbols: [],
    imports: [...graph.imports,
      { fromPath: "src/app/s/[publicId]/page.tsx", toPath: "src/env.js", specifier: "@/env", kind: "static", resolutionStatus: "resolved", unresolvedReason: null },
      { fromPath: "src/app/s/[publicId]/page.tsx", toPath: "src/server/db/schema.ts", specifier: "@/server/db/schema", kind: "static", resolutionStatus: "resolved", unresolvedReason: null },
      { fromPath: "src/app/s/[publicId]/page.tsx", toPath: "src/lib/cloudflare.ts", specifier: "@/lib/cloudflare", kind: "static", resolutionStatus: "resolved", unresolvedReason: null },
    ],
  };
  const context = buildFeatureContext({ source: protectedSource, graph: protectedGraph, entryPath: "src/app/s/[publicId]/page.tsx", entryKind: "page" });
  assert.ok(context);
  assert.deepEqual(context!.items.map((item) => item.path), ["src/app/s/[publicId]/page.tsx", "src/components/reviews.tsx"]);
  assert.ok(!context!.reachablePaths.includes("src/env.js"));
  assert.ok(!context!.reachablePaths.includes("src/server/db/schema.ts"));
  assert.ok(!context!.reachablePaths.includes("src/lib/cloudflare.ts"));
  assert.equal(isFeatureCardEntrypoint("src/app/api/trpc/[trpc]/route.ts", "api_route"), false);
  assert.equal(isFeatureCardEntrypoint("src/app/api/trpc-slow/[trpc]/route.ts", "api_route"), false);
});

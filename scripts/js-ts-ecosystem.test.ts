import assert from "node:assert/strict";
import test from "node:test";

import { buildBaselineGraph } from "../src/graph/baseline-graph-builder.js";
import { analyzePrImpact } from "../src/impact/pr-impact-engine.js";
import type { RepositorySource } from "../src/graph/types.js";

function source(values: Record<string, string>): RepositorySource {
  return {
    repoId: 42,
    owner: "octo",
    name: "workspace",
    branch: "main",
    sha: "fixture",
    allFilePaths: Object.keys(values),
    files: Object.entries(values).map(([path, content]) => ({ path, content, blobSha: `blob:${path}` })),
  };
}

test("discovers pnpm workspace projects and resolves a shared package across applications", () => {
  const graph = buildBaselineGraph(source({
    "package.json": JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] }),
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
    "apps/next/package.json": JSON.stringify({ name: "@fixture/next", dependencies: { next: "1", "@fixture/pricing": "workspace:*" } }),
    "apps/next/jsconfig.json": JSON.stringify({ compilerOptions: { jsx: "preserve" } }),
    "apps/next/app/checkout/page.jsx": 'import { price } from "@fixture/pricing"; export default function Checkout() { return <p>{price()}</p>; }',
    "apps/router/package.json": JSON.stringify({ name: "@fixture/router", dependencies: { "react-router-dom": "1", "@fixture/pricing": "workspace:*" } }),
    "apps/router/src/routes.tsx": 'import { createBrowserRouter } from "react-router-dom"; import { Checkout } from "./checkout"; export const routes = createBrowserRouter([{ path: "/checkout", Component: Checkout }]);',
    "apps/router/src/jsx-routes.tsx": 'import { Route, Routes } from "react-router-dom"; import { Checkout } from "./checkout"; export function Router() { return <Routes><Route path="/orders"><Route path=":id" element={<Checkout />} /></Route></Routes>; }',
    "apps/router/src/checkout.tsx": 'import { price } from "@fixture/pricing"; export function Checkout() { return <p>{price()}</p>; }',
    "packages/pricing/package.json": JSON.stringify({ name: "@fixture/pricing", type: "module", exports: "./src/index.ts" }),
    "packages/pricing/src/index.ts": "export function price() { return 12; }",
  }));

  assert.deepEqual(graph.projects?.map((project) => project.rootPath), ["apps/next", "apps/router", "packages/pricing"]);
  const consumers = graph.imports.filter((edge) => edge.toPath === "packages/pricing/src/index.ts").map((edge) => edge.fromPath).sort();
  assert.deepEqual(consumers, ["apps/next/app/checkout/page.jsx", "apps/router/src/checkout.tsx"]);
  assert.ok(graph.entrypoints?.some((entrypoint) => entrypoint.projectRoot === "apps/next" && entrypoint.routePath === "/checkout"));
  assert.ok(graph.entrypoints?.some((entrypoint) => entrypoint.projectRoot === "apps/router" && entrypoint.routePath === "/checkout"));
  assert.ok(graph.entrypoints?.some((entrypoint) => entrypoint.projectRoot === "apps/router" && entrypoint.routePath === "/orders/:id"));
});

test("extracts Remix, Express, and statically proven tRPC facts", () => {
  const graph = buildBaselineGraph(source({
    "package.json": JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] }),
    "apps/remix/package.json": JSON.stringify({ name: "@fixture/remix", dependencies: { "@remix-run/react": "1" } }),
    "apps/remix/app/routes/orders.$orderId.tsx": "export default function Order() { return <p>Order</p>; }",
    "apps/api/package.json": JSON.stringify({ name: "@fixture/api", dependencies: { express: "1", "@trpc/server": "1" } }),
    "apps/api/src/health.ts": "export function health(_req: unknown, _res: unknown) {}",
    "apps/api/src/health-router.ts": 'import { health } from "./health"; declare const router: any; router.get("/health", health); export { router };',
    "apps/api/src/server.ts": 'import express from "express"; import { router } from "./health-router"; const app = express(); app.use("/api", router); export default app;',
    "apps/api/src/reviews-router.ts": 'const publicProcedure = { mutation: (value: unknown) => value }; function router(value: unknown) { return value; } export const reviewsRouter = router({ submit: publicProcedure.mutation(() => true) });',
    "apps/api/src/trpc.ts": 'import { reviewsRouter } from "./reviews-router"; function router(value: unknown) { return value; } export const appRouter = router({ reviews: reviewsRouter });',
    "apps/web/package.json": JSON.stringify({ name: "@fixture/web", dependencies: { "@trpc/react-query": "1" } }),
    "apps/web/src/review.tsx": "declare const trpc: any; export function Review() { trpc.reviews.submit.useMutation(); return null; }",
  }));

  assert.ok(graph.entrypoints?.some((entrypoint) => entrypoint.projectRoot === "apps/remix" && entrypoint.kind === "web_route" && entrypoint.routePath === "/orders/:orderId"));
  assert.ok(graph.entrypoints?.some((entrypoint) => entrypoint.projectRoot === "apps/api" && entrypoint.kind === "api_route" && entrypoint.routePath === "/api/health" && entrypoint.httpMethod === "GET"));
  assert.deepEqual(graph.protocolBindings?.map((binding) => [binding.callerFilePath, binding.handlerFilePath, binding.operation]), [["apps/web/src/review.tsx", "apps/api/src/reviews-router.ts", "reviews.submit"]]);
});

test("keeps runtime route construction graph-only", () => {
  const graph = buildBaselineGraph(source({
    "package.json": JSON.stringify({ dependencies: { "react-router-dom": "1" } }),
    "src/routes.tsx": "declare const remote: { path: string }; export const routes = remote.path;",
  }));
  assert.equal(graph.projects?.[0]?.primaryFramework, "react_router");
  assert.equal(graph.entrypoints?.length, 0);
});

test("requires explicit configuration to resolve conflicting framework evidence", () => {
  const files = {
    "package.json": JSON.stringify({ dependencies: { next: "1", express: "1" } }),
    "app/page.tsx": "export default function Page() { return <p>Home</p>; }",
  };
  const ambiguous = buildBaselineGraph(source(files));
  assert.equal(ambiguous.projects?.[0]?.status, "ambiguous");
  assert.equal(ambiguous.entrypoints?.length, 0);
  const selected = buildBaselineGraph(source({ ...files, "impact-analysis.config.json": JSON.stringify({ projects: [{ root: ".", adapter: "next" }] }) }));
  assert.equal(selected.projects?.[0]?.primaryFramework, "next");
  assert.deepEqual(selected.entrypoints?.map((entrypoint) => entrypoint.routePath), ["/"]);
});

test("uses framework entrypoints, not file conventions, for monorepo PR reachability", () => {
  const base = source({
    "package.json": JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] }),
    "apps/next/package.json": JSON.stringify({ name: "next", dependencies: { next: "1", pricing: "workspace:*" } }),
    "apps/next/app/page.tsx": 'import { price } from "pricing"; export default function Page() { return <p>{price()}</p>; }',
    "apps/router/package.json": JSON.stringify({ name: "router", dependencies: { "react-router-dom": "1", pricing: "workspace:*" } }),
    "apps/router/src/routes.tsx": 'import { createBrowserRouter } from "react-router-dom"; import { Orders } from "./orders"; export const routes = createBrowserRouter([{ path: "/orders", Component: Orders }]);',
    "apps/router/src/orders.tsx": 'import { price } from "pricing"; export function Orders() { return <p>{price()}</p>; }',
    "packages/pricing/package.json": JSON.stringify({ name: "pricing" }),
    "packages/pricing/src/index.ts": "export const price = () => 1;",
  });
  const head = source({ ...Object.fromEntries(base.files.map((file) => [file.path, file.content])), "packages/pricing/src/index.ts": "export const price = () => 2;" });
  const analysis = analyzePrImpact({
    request: { repoId: 42, pullRequestNumber: 7, baseRef: "main", baseSha: "base", headSha: "head" },
    baseGraph: buildBaselineGraph(base),
    headGraph: buildBaselineGraph(head),
    changes: [{ path: "packages/pricing/src/index.ts", status: "modified" }],
  });
  assert.deepEqual(analysis.affectedItems.filter((item) => item.kind === "page").map((item) => [item.projectRoot, item.routePath]).sort(), [["apps/next", "/"], ["apps/router", "/orders"]]);
});

test("reaches a UI route from a changed tRPC procedure only through a proven client binding", () => {
  const files = {
    "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"] }),
    "apps/web/package.json": JSON.stringify({ name: "web", dependencies: { next: "1", "@trpc/react-query": "1" } }),
    "apps/web/app/page.tsx": "declare const trpc: any; export default function Page() { trpc.reviews.submit.useMutation(); return <button>Submit</button>; }",
    "apps/api/package.json": JSON.stringify({ name: "api", dependencies: { "@trpc/server": "1" } }),
    "apps/api/src/reviews.ts": "const publicProcedure = { mutation: (value: unknown) => value }; function router(value: unknown) { return value; } export const appRouter = router({ reviews: router({ submit: publicProcedure.mutation(() => true) }) });",
  };
  const base = buildBaselineGraph(source(files));
  const head = buildBaselineGraph(source({ ...files, "apps/api/src/reviews.ts": "const publicProcedure = { mutation: (value: unknown) => value }; function router(value: unknown) { return value; } export const appRouter = router({ reviews: router({ submit: publicProcedure.mutation(() => false) }) });" }));
  const analysis = analyzePrImpact({
    request: { repoId: 42, pullRequestNumber: 9, baseRef: "main", baseSha: "base", headSha: "head" },
    baseGraph: base,
    headGraph: head,
    changes: [{ path: "apps/api/src/reviews.ts", status: "modified" }],
  });
  assert.deepEqual(analysis.affectedItems.filter((item) => item.kind === "page").map((item) => [item.projectRoot, item.routePath]), [["apps/web", "/"]]);
});

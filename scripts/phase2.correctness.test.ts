import assert from "node:assert/strict";
import test from "node:test";

import { buildBaselineGraph } from "../src/graph/baseline-graph-builder.js";
import type { RepositorySource } from "../src/graph/types.js";

function fixtureSource(): RepositorySource {
  const files = [
    ["tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } })],
    ["src/env.js", "export const env = { mode: 'test' };"],
    ["src/styles/globals.css", '@import "./tokens.css";\nbody { color: black; }'],
    ["src/styles/tokens.css", ":root { --brand: purple; }"],
    ["src/app/layout.tsx", 'import { env } from "@/env"; import "@/styles/globals.css"; export default function RootLayout({ children }: { children: React.ReactNode }) { return <html data-mode={env.mode}><body>{children}</body></html>; }'],
    ["src/app/loading.tsx", "export default function Loading() { return <p>Loading</p>; }"],
    ["src/app/error.tsx", '"use client"; export default function ErrorBoundary() { return <p>Error</p>; }'],
    ["src/app/robots.ts", "export default function robots() { return { rules: [] }; }"],
    ["src/components/ui/button.tsx", "function Button() { return <button />; } export { Button };"],
    ["src/components/ui/card.tsx", 'import * as React from "react"; const Card = React.forwardRef<HTMLDivElement>((_props, ref) => <div ref={ref} />); export { Card };'],
    ["src/components/logo.tsx", 'import logo from "@/assets/logo.svg"; export const Logo = () => <img src={logo} />;'],
    ["scripts/setup.ts", "export function setup() {}"],
  ].map(([path, content]) => ({ path, content, blobSha: String(path) }));
  return { repoId: 42, owner: "octo", name: "shop", branch: "main", sha: "abc", allFilePaths: [...files.map((file) => file.path), "src/assets/logo.svg"], files };
}

test("models JavaScript, styles, local assets, exports, and framework roles deterministically", () => {
  const graph = buildBaselineGraph(fixtureSource());
  const kind = (path: string) => graph.files.find((file) => file.path === path)?.kind;
  assert.equal(kind("src/env.js"), "shared_module");
  assert.equal(kind("src/styles/globals.css"), "style");
  assert.equal(kind("src/app/layout.tsx"), "layout");
  assert.equal(kind("src/app/loading.tsx"), "loading");
  assert.equal(kind("src/app/error.tsx"), "error_boundary");
  assert.equal(kind("src/app/robots.ts"), "metadata");
  assert.equal(kind("src/components/ui/button.tsx"), "component");
  assert.equal(kind("scripts/setup.ts"), "tooling");
  assert.equal(graph.symbols.find((symbol) => symbol.name === "Button")?.isExported, true);
  assert.partialDeepStrictEqual(graph.symbols.find((symbol) => symbol.name === "Card"), { kind: "component", isExported: true });
  assert.partialDeepStrictEqual(graph.imports.find((edge) => edge.specifier === "@/env"), { toPath: "src/env.js", resolutionStatus: "resolved" });
  assert.partialDeepStrictEqual(graph.imports.find((edge) => edge.specifier === "@/styles/globals.css"), { toPath: "src/styles/globals.css", resolutionStatus: "resolved" });
  assert.partialDeepStrictEqual(graph.imports.find((edge) => edge.specifier === "./tokens.css"), { toPath: "src/styles/tokens.css", resolutionStatus: "resolved" });
  assert.partialDeepStrictEqual(graph.imports.find((edge) => edge.specifier === "@/assets/logo.svg"), { toPath: null, resolutionStatus: "asset" });
});

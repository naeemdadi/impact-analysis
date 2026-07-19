import crypto from "node:crypto";

import type { FeatureContext, FeatureEntryKind, FeatureGraphInput } from "./feature-types.js";

const maxContextFiles = 8;
const maxExcerptChars = 5_000;
const maxTotalChars = 28_000;

/** Builds deterministic, bounded source context for one graph-proven entrypoint. */
export function buildFeatureContext(input: FeatureGraphInput): FeatureContext | null {
  if (!isFeatureCardEntrypoint(input.entryPath, input.entryKind)) return null;
  const files = new Map(input.graph.files.map((file) => [file.path, file]));
  const sourceFiles = new Map(input.source.files.map((file) => [file.path, file]));
  if (!files.has(input.entryPath) || !sourceFiles.has(input.entryPath)) return null;

  const dependencies = new Map<string, string[]>();
  for (const edge of input.graph.imports) {
    if (edge.resolutionStatus !== "resolved" || !edge.toPath) continue;
    dependencies.set(edge.fromPath, [...(dependencies.get(edge.fromPath) ?? []), edge.toPath]);
  }
  for (const paths of dependencies.values()) paths.sort();

  const reachable: string[] = [];
  const queue = [input.entryPath];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const file = files.get(path);
    if (!file || file.kind === "tooling" || isAiContextExcludedPath(path)) continue;
    reachable.push(path);
    for (const dependency of dependencies.get(path) ?? []) if (!seen.has(dependency)) queue.push(dependency);
  }

  const fingerprint = crypto.createHash("sha256")
    .update(reachable.slice().sort().map((path) => `${path}:${files.get(path)!.blobSha}`).join("\n"))
    .digest("hex");
  const items: FeatureContext["items"] = [];
  let remaining = maxTotalChars;
  for (const path of reachable) {
    if (items.length >= maxContextFiles || remaining <= 0) break;
    const sourceFile = sourceFiles.get(path);
    if (!sourceFile || isAiContextExcludedPath(path)) continue;
    const excerpt = sourceFile.content.slice(0, Math.min(maxExcerptChars, remaining));
    if (!excerpt.trim()) continue;
    items.push({
      id: `context:${items.length + 1}`,
      path,
      blobSha: sourceFile.blobSha,
      role: path === input.entryPath ? "entrypoint" : "dependency",
      excerpt,
    });
    remaining -= excerpt.length;
  }
  if (items.length === 0 || items[0].path !== input.entryPath) return null;
  return {
    entryPath: input.entryPath,
    entryKind: input.entryKind as FeatureEntryKind,
    routeLabel: routeLabelForPath(input.entryPath, input.entryKind as FeatureEntryKind),
    sourceFingerprint: fingerprint,
    commitSha: input.source.sha,
    items,
    reachablePaths: reachable,
  };
}

export function routeLabelForPath(entryPath: string, kind: FeatureEntryKind): string {
  const normalized = entryPath.replace(/^src\//, "").replace(/\.(?:tsx?|jsx?|mjs|cjs)$/, "");
  if (kind === "api_route") return `API ${normalized.replace(/(^app\/|^pages\/api\/|\/route$)/g, "")}`;
  const app = normalized.replace(/^app\/?/, "").replace(/\/page$/, "").replace(/\/index$/, "");
  const pages = normalized.replace(/^pages\/?/, "").replace(/\/index$/, "");
  const route = (entryPath.includes("/app/") || entryPath.startsWith("app/") ? app : pages) || "/";
  return route.startsWith("/") ? route : `/${route}`;
}

/** Graph nodes remain analyzable, but these paths must never be sent to OpenAI as feature context. */
export function isAiContextExcludedPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.includes(".env")
    || /(^|\/)env\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(lower)
    || lower.includes("secret")
    || lower.includes("credential")
    || lower.includes("private-key")
    || /(^|\/)server\/(?:db|supabase)(?:\/|$)/.test(lower)
    || /(^|\/)server\/utils\/(?:email|avatar-storage)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(lower)
    || /(^|\/)lib\/(?:cloudinary|cloudflare|storage|serper(?:-gl)?|instagram|rate-limiter|phone-constants)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(lower)
    || /(^|\/)(?:drizzle|prisma|knex)\.(?:config\.)?(?:ts|js|mjs|cjs)$/.test(lower);
}

/** tRPC adapters are protocol transport endpoints, not standalone product features. */
export function isFeatureCardEntrypoint(path: string, kind: string): boolean {
  if (kind !== "page" && kind !== "api_route") return false;
  const normalized = path.replace(/^src\//, "").toLowerCase();
  return !/^app\/api\/trpc(?:[-/]|$)/.test(normalized);
}

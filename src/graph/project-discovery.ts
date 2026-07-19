import path from "node:path";

import type { PrimaryFramework, ProjectDescriptor, ProtocolProfile, RepositorySource, SourceFile } from "./types.js";

const codePathPattern = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const stylePathPattern = /\.(?:css|scss|sass|less)$/;
const packageJsonPattern = /(^|\/)package\.json$/;
const tsConfigPattern = /(^|\/)tsconfig(?:\.[^/]+)?\.json$/;
const jsConfigPattern = /(^|\/)jsconfig\.json$/;
const frameworkConfigPattern = /(^|\/)(?:next|vite|remix|tailwind|postcss|vitest)\.config\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

export interface ImpactAnalysisProjectConfig {
  root: string;
  adapter?: PrimaryFramework;
  protocols?: ProtocolProfile[];
}

export interface ImpactAnalysisConfig {
  projects?: ImpactAnalysisProjectConfig[];
}

export function isGraphSourcePath(filePath: string): boolean {
  return codePathPattern.test(filePath) || stylePathPattern.test(filePath);
}

export function isGraphConfigurationPath(filePath: string): boolean {
  return packageJsonPattern.test(filePath)
    || tsConfigPattern.test(filePath)
    || jsConfigPattern.test(filePath)
    || frameworkConfigPattern.test(filePath)
    || filePath === "pnpm-workspace.yaml"
    || filePath === "turbo.json"
    || filePath === "nx.json"
    || filePath === "impact-analysis.config.json";
}

/**
 * Discovers independent JS/TS packages/apps without assuming a framework.
 * Discovery is deliberately source-only: a package must opt into a framework
 * through dependency evidence or the optional committed configuration.
 */
export function discoverProjects(source: RepositorySource): ProjectDescriptor[] {
  const allPaths = source.allFilePaths ?? source.files.map((file) => file.path);
  const files = new Map(source.files.map((file) => [file.path, file]));
  const rootPackage = parseJsonFile(files.get("package.json"));
  const config = parseImpactConfig(files.get("impact-analysis.config.json"));
  const workspacePatterns = workspacePatternsFrom(rootPackage, files.get("pnpm-workspace.yaml"));
  const packagePaths = allPaths.filter((filePath) => packageJsonPattern.test(filePath)).sort();
  const packageRoots = new Set<string>();

  if (packagePaths.includes("package.json")) packageRoots.add("");
  for (const packagePath of packagePaths) {
    const root = dirname(packagePath);
    if (root === "") continue;
    if (workspacePatterns.some((pattern) => pathMatchesWorkspacePattern(root, pattern))) packageRoots.add(root);
  }
  // A repository with nested packages but no workspace manifest is still a
  // usable source graph when explicitly configured.
  for (const project of config?.projects ?? []) packageRoots.add(normalizeRoot(project.root));
  if (packageRoots.size === 0 && allPaths.some(isGraphSourcePath)) packageRoots.add("");

  const overrides = new Map((config?.projects ?? []).map((project) => [normalizeRoot(project.root), project]));
  const descriptors = [...packageRoots]
    .sort(compareRoots)
    .map((rootPath) => descriptorFor(rootPath, files, overrides.get(rootPath), allPaths))
    .filter((project) => hasSourceUnder(project.rootPath, allPaths));
  const nestedRoots = descriptors.filter((project) => project.rootPath !== "").map((project) => project.rootPath);
  return descriptors.filter((project) => project.rootPath !== "" || nestedRoots.length === 0 || allPaths.some((filePath) => isGraphSourcePath(filePath) && !nestedRoots.some((root) => isUnderRoot(filePath, root))));
}

export function projectForPath(projects: ProjectDescriptor[], filePath: string): ProjectDescriptor | null {
  const matching = projects.filter((project) => isUnderRoot(filePath, project.rootPath)).sort((left, right) => right.rootPath.length - left.rootPath.length);
  return matching[0] ?? null;
}

export function normalizeRoot(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
  return normalized === "." ? "" : normalized;
}

function descriptorFor(rootPath: string, files: Map<string, SourceFile>, override: ImpactAnalysisProjectConfig | undefined, allPaths: string[]): ProjectDescriptor {
  const packageValue = parseJsonFile(files.get(joinRoot(rootPath, "package.json"))) ?? {};
  const configPath = ["tsconfig.json", "jsconfig.json"].map((name) => joinRoot(rootPath, name)).find((filePath) => files.has(filePath)) ?? null;
  const detected = detectFramework(packageValue, rootPath, allPaths);
  const selected = override?.adapter ?? detected.primary;
  const protocolProfiles = uniqueProtocols([...(detected.protocols), ...(override?.protocols ?? [])]);
  const ambiguous = !override?.adapter && detected.candidates.length > 1;
  return {
    rootPath,
    packageName: typeof packageValue.name === "string" ? packageValue.name : null,
    packageType: packageValue.type === "module" ? "module" : packageValue.type === "commonjs" ? "commonjs" : "unspecified",
    configPath,
    primaryFramework: ambiguous ? "ambiguous" : selected,
    protocolProfiles,
    status: ambiguous ? "ambiguous" : selected === "generic" ? "graph_only" : "supported",
    reason: ambiguous
      ? `multiple framework dependencies detected: ${detected.candidates.join(", ")}; select one in impact-analysis.config.json`
      : selected === "generic"
        ? "no supported framework adapter was detected"
        : null,
  };
}

function detectFramework(packageValue: Record<string, unknown>, rootPath: string, allPaths: string[]): { primary: PrimaryFramework; candidates: Exclude<PrimaryFramework, "generic" | "ambiguous">[]; protocols: ProtocolProfile[] } {
  const dependencies = { ...asObject(packageValue.dependencies), ...asObject(packageValue.devDependencies), ...asObject(packageValue.peerDependencies) };
  const has = (name: string) => Object.prototype.hasOwnProperty.call(dependencies, name);
  const hasNextRouteConvention = allPaths.some((filePath) => isUnderRoot(filePath, rootPath) && /^(?:src\/)?(?:app\/(?:.*\/)?(?:page|route)|pages\/.+)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(relativePath(rootPath, filePath)));
  const hasRemixRouteConvention = allPaths.some((filePath) => /^app\/routes\/.+\.(?:ts|tsx|js|jsx)$/.test(relativePath(rootPath, filePath)));

  // A framework route convention is direct, static evidence of the app's
  // routing model. It is more reliable than an incidental server dependency
  // such as Express inside an otherwise Next.js application.
  if (hasNextRouteConvention) {
    return {
      primary: "next",
      candidates: ["next"],
      protocols: has("@trpc/server") || has("@trpc/client") || has("@trpc/react-query") ? ["trpc"] : [],
    };
  }
  if (hasRemixRouteConvention) {
    return {
      primary: "remix",
      candidates: ["remix"],
      protocols: has("@trpc/server") || has("@trpc/client") || has("@trpc/react-query") ? ["trpc"] : [],
    };
  }

  const candidates: Exclude<PrimaryFramework, "generic" | "ambiguous">[] = [];
  if (has("next")) candidates.push("next");
  if (has("@remix-run/react") || has("@remix-run/node") || has("remix")) candidates.push("remix");
  if (has("express")) candidates.push("express");
  if (has("react-router-dom") || has("react-router")) candidates.push("react_router");
  return {
    primary: candidates.length === 1 ? candidates[0] : "generic",
    candidates,
    protocols: has("@trpc/server") || has("@trpc/client") || has("@trpc/react-query") ? ["trpc"] : [],
  };
}

function workspacePatternsFrom(rootPackage: Record<string, unknown> | null, pnpmWorkspace: SourceFile | undefined): string[] {
  const fromPackage = rootPackage?.workspaces;
  const workspacePackages = fromPackage && typeof fromPackage === "object" && !Array.isArray(fromPackage)
    ? (fromPackage as Record<string, unknown>).packages
    : undefined;
  const patterns = Array.isArray(fromPackage)
    ? fromPackage.filter((value): value is string => typeof value === "string")
    : workspacePackages
      ? Array.isArray(workspacePackages)
        ? workspacePackages.filter((value): value is string => typeof value === "string")
        : []
      : [];
  if (!pnpmWorkspace) return patterns;
  return [...patterns, ...parsePnpmWorkspacePatterns(pnpmWorkspace.content)];
}

function parsePnpmWorkspacePatterns(content: string): string[] {
  const match = /^packages:\s*\n((?:\s*-\s*[^\n]+\n?)*)/m.exec(content);
  if (!match) return [];
  return [...match[1].matchAll(/^\s*-\s*["']?([^"'\n]+)["']?\s*$/gm)].map((entry) => entry[1].trim()).filter(Boolean);
}

function parseImpactConfig(file: SourceFile | undefined): ImpactAnalysisConfig | null {
  const value = parseJsonFile(file);
  if (!value) return null;
  if (value.projects !== undefined && !Array.isArray(value.projects)) return null;
  const projects = (value.projects ?? []).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || typeof (candidate as Record<string, unknown>).root !== "string") return [];
    const raw = candidate as Record<string, unknown>;
    const adapter = raw.adapter;
    const protocols = raw.protocols;
    if (adapter !== undefined && !["next", "react_router", "remix", "express", "generic"].includes(String(adapter))) return [];
    return [{ root: raw.root as string, adapter: adapter as PrimaryFramework | undefined, protocols: Array.isArray(protocols) ? protocols.filter((value): value is ProtocolProfile => value === "trpc") : undefined }];
  });
  return { projects };
}

function parseJsonFile(file: SourceFile | undefined): Record<string, unknown> | null {
  if (!file) return null;
  try {
    const parsed = JSON.parse(file.content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function uniqueProtocols(value: ProtocolProfile[]): ProtocolProfile[] { return [...new Set(value)].sort(); }
function joinRoot(rootPath: string, filePath: string): string { return rootPath ? `${rootPath}/${filePath}` : filePath; }
function dirname(filePath: string): string { const value = path.posix.dirname(filePath); return value === "." ? "" : value; }
function hasSourceUnder(rootPath: string, paths: string[]): boolean { return paths.some((filePath) => isGraphSourcePath(filePath) && isUnderRoot(filePath, rootPath)); }
function isUnderRoot(filePath: string, rootPath: string): boolean { return rootPath === "" || filePath === rootPath || filePath.startsWith(`${rootPath}/`); }
function relativePath(rootPath: string, filePath: string): string { return rootPath ? filePath.slice(rootPath.length + 1) : filePath; }
function compareRoots(left: string, right: string): number { return left.localeCompare(right) || left.length - right.length; }

function pathMatchesWorkspacePattern(rootPath: string, pattern: string): boolean {
  const normalized = normalizeRoot(pattern);
  const expression = `^${normalized.split("**").map((part) => part.split("*").map(escapeRegExp).join("[^/]+") ).join(".*")}$`;
  return new RegExp(expression).test(rootPath);
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

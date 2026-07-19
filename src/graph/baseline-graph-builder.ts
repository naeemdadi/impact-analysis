import crypto from "node:crypto";
import path from "node:path";
import * as ts from "typescript";

import { extractAdapterFacts } from "./adapters.js";
import { discoverProjects, isGraphConfigurationPath, isGraphSourcePath, projectForPath } from "./project-discovery.js";
import type {
  BaselineGraph,
  GraphFile,
  GraphFileKind,
  GraphImport,
  GraphImportKind,
  GraphProject,
  GraphSymbol,
  GraphSymbolKind,
  ProjectDescriptor,
  RepositorySource,
  SourceFile,
} from "./types.js";

const virtualRoot = "/repository";

export class UnsupportedRepositoryError extends Error {}

/** Backwards-compatible public name used by queue and PR code. */
export function isGraphFilePath(filePath: string): boolean { return isGraphSourcePath(filePath); }
export { isGraphConfigurationPath } from "./project-discovery.js";

export function buildBaselineGraph(source: RepositorySource): BaselineGraph {
  return buildGraphForFiles(source, source.files.filter((file) => isGraphSourcePath(file.path)).map((file) => file.path));
}

/** Builds selected module facts while resolving against the full target repository tree. */
export function buildGraphForFiles(source: RepositorySource, pathsToAnalyze: string[]): BaselineGraph {
  const projects = discoverProjects(source) as GraphProject[];
  if (projects.length === 0) throw new UnsupportedRepositoryError("no JavaScript or TypeScript source project was discovered");

  const requestedPaths = new Set(pathsToAnalyze);
  const sourceFiles = source.files.filter((file) => isGraphSourcePath(file.path) && requestedPaths.has(file.path));
  const availablePaths = source.allFilePaths ?? source.files.map((file) => file.path);
  const loadedFiles = new Map(source.files.map((file) => [file.path, file]));
  const filesByVirtualPath = new Map<string, SourceFile>(availablePaths.map((filePath) => [toVirtualPath(filePath), loadedFiles.get(filePath) ?? { path: filePath, blobSha: "", content: "" }]));
  const workspaceProjects = new Map(projects.filter((project) => project.packageName).map((project) => [project.packageName!, project]));
  const compilerByProject = new Map(projects.map((project) => [project.rootPath, compilerOptionsFor(project, loadedFiles, filesByVirtualPath)]));
  const graphFiles: GraphFile[] = [];
  const symbols: GraphSymbol[] = [];
  const imports: GraphImport[] = [];

  for (const file of sourceFiles.sort((left, right) => left.path.localeCompare(right.path))) {
    const project = projectForPath(projects, file.path);
    if (!project) continue;
    const compilerOptions = compilerByProject.get(project.rootPath)!;
    if (isStylePath(file.path)) {
      const classification = classifyFile(file.path, [], project);
      graphFiles.push({ path: file.path, projectRoot: project.rootPath, blobSha: file.blobSha, kind: classification.kind, classificationReason: classification.reason, ...classifyTechnicalRole(file.path, classification.kind, "") });
      imports.push(...extractStyleImports(file, compilerOptions, filesByVirtualPath, workspaceProjects));
      continue;
    }
    const parsed = ts.createSourceFile(toVirtualPath(file.path), file.content, ts.ScriptTarget.ES2022, true, scriptKindForPath(file.path));
    const fileSymbols = extractTopLevelSymbols(file, parsed);
    const classification = classifyFile(file.path, fileSymbols, project);
    graphFiles.push({ path: file.path, projectRoot: project.rootPath, blobSha: file.blobSha, kind: classification.kind, classificationReason: classification.reason, ...classifyTechnicalRole(file.path, classification.kind, parsed.text) });
    symbols.push(...fileSymbols);
    imports.push(...extractImports(parsed, compilerOptions, filesByVirtualPath, workspaceProjects));
  }

  const graph: BaselineGraph = { projects, files: graphFiles.sort(byPath), symbols, imports: deduplicateImports(imports), entrypoints: [], protocolBindings: [] };
  const facts = extractAdapterFacts({ source, projects, files: graph.files, imports: graph.imports });
  graph.entrypoints = facts.entrypoints.filter((entrypoint) => graph.files.some((file) => file.path === entrypoint.filePath));
  graph.protocolBindings = facts.protocolBindings.filter((binding) => graph.files.some((file) => file.path === binding.callerFilePath || file.path === binding.handlerFilePath));
  // Compatibility projection for existing role/report consumers. Route truth is
  // stored in graph.entrypoints; this only gives its backing module a concise
  // display classification until all readers consume entrypoint rows directly.
  const entrypointByFile = new Map(graph.entrypoints.map((entrypoint) => [entrypoint.filePath, entrypoint]));
  graph.files = graph.files.map((file) => {
    const entrypoint = entrypointByFile.get(file.path);
    return entrypoint ? { ...file, kind: entrypoint.kind === "web_route" ? "page" : "api_route", classificationReason: entrypoint.reason } : file;
  });
  return graph;
}

function compilerOptionsFor(project: ProjectDescriptor, loadedFiles: Map<string, SourceFile>, filesByVirtualPath: Map<string, SourceFile>): ts.CompilerOptions {
  const config = project.configPath ? loadedFiles.get(project.configPath) : undefined;
  if (!config) return { allowJs: true, checkJs: false, jsx: ts.JsxEmit.Preserve, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, resolveJsonModule: true, baseUrl: toVirtualPath(project.rootPath) };
  const parsed = ts.parseConfigFileTextToJson(config.path, config.content);
  if (parsed.error) throw new UnsupportedRepositoryError(`${config.path} is invalid: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n")}`);
  const projectRoot = toVirtualPath(project.rootPath);
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    readDirectory: () => [],
    fileExists: (fileName) => filesByVirtualPath.has(normalizeVirtualPath(fileName)),
    readFile: (fileName) => filesByVirtualPath.get(normalizeVirtualPath(fileName))?.content,
  };
  const result = ts.parseJsonConfigFileContent(parsed.config, host, projectRoot, undefined, toVirtualPath(config.path));
  const fatal = result.errors.filter((diagnostic) => diagnostic.code !== 18003);
  if (fatal.length > 0) throw new UnsupportedRepositoryError(`${config.path} is invalid: ${ts.flattenDiagnosticMessageText(fatal[0].messageText, "\n")}`);
  return { allowJs: true, checkJs: false, jsx: ts.JsxEmit.Preserve, ...result.options };
}

function extractTopLevelSymbols(file: SourceFile, sourceFile: ts.SourceFile): GraphSymbol[] {
  const symbols: GraphSymbol[] = [];
  const exportedNames = collectExportedLocalNames(sourceFile);
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      symbols.push(createSymbol(file, sourceFile, statement, statement.name.text, classifyFunctionSymbol(file.path, statement.name.text), isExported(statement, statement.name.text, exportedNames)));
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name) {
      symbols.push(createSymbol(file, sourceFile, statement, statement.name.text, "class", isExported(statement, statement.name.text, exportedNames)));
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const name = declaration.name.text;
      const exported = isExported(statement, name, exportedNames);
      const component = isComponentInitializer(declaration.initializer, name, exported);
      if (!isFunctionLikeInitializer(declaration.initializer) && !component) continue;
      symbols.push(createSymbol(file, sourceFile, declaration, name, component ? "component" : "function", exported));
    }
  }
  return symbols;
}

function collectExportedLocalNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) for (const element of statement.exportClause.elements) names.add((element.propertyName ?? element.name).text);
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) names.add(statement.expression.text);
  }
  return names;
}

function createSymbol(file: SourceFile, sourceFile: ts.SourceFile, node: ts.Node, name: string, kind: GraphSymbolKind, isExportedValue: boolean): GraphSymbol {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return { filePath: file.path, symbolKey: `${file.path}:${kind}:${name}`, name, kind, isExported: isExportedValue, startLine: start.line + 1, startColumn: start.character + 1, endLine: end.line + 1, endColumn: end.character + 1, sourceHash: crypto.createHash("sha256").update(node.getText(sourceFile)).digest("hex") };
}

function extractImports(sourceFile: ts.SourceFile, compilerOptions: ts.CompilerOptions, filesByVirtualPath: Map<string, SourceFile>, workspaceProjects: Map<string, ProjectDescriptor>): GraphImport[] {
  const imports: GraphImport[] = [];
  const addImport = createImportAdder(fromVirtualPath(sourceFile.fileName), compilerOptions, filesByVirtualPath, workspaceProjects, imports);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) addImport(node.moduleSpecifier.text, node.importClause?.isTypeOnly ? "type_only" : "static");
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) addImport(node.moduleSpecifier.text, "static");
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) addImport(node.arguments[0].text, "dynamic");
    else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) addImport(node.arguments[0].text, "require");
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

function extractStyleImports(file: SourceFile, compilerOptions: ts.CompilerOptions, filesByVirtualPath: Map<string, SourceFile>, workspaceProjects: Map<string, ProjectDescriptor>): GraphImport[] {
  const imports: GraphImport[] = [];
  const addImport = createImportAdder(file.path, compilerOptions, filesByVirtualPath, workspaceProjects, imports);
  for (const match of file.content.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g)) addImport(match[1], "static");
  return imports;
}

function createImportAdder(fromPath: string, compilerOptions: ts.CompilerOptions, filesByVirtualPath: Map<string, SourceFile>, workspaceProjects: Map<string, ProjectDescriptor>, imports: GraphImport[]) {
  const fromVirtual = toVirtualPath(fromPath);
  const resolutionHost: ts.ModuleResolutionHost = {
    fileExists: (fileName) => filesByVirtualPath.has(normalizeVirtualPath(fileName)),
    readFile: (fileName) => filesByVirtualPath.get(normalizeVirtualPath(fileName))?.content,
    directoryExists: (directoryName) => [...filesByVirtualPath.keys()].some((fileName) => fileName.startsWith(`${normalizeVirtualPath(directoryName).replace(/\/$/, "")}/`)),
    getCurrentDirectory: () => virtualRoot,
    getDirectories: () => [],
    realpath: normalizeVirtualPath,
  };
  return (specifier: string, kind: GraphImportKind): void => {
    const resolvedModule = ts.resolveModuleName(specifier, fromVirtual, compilerOptions, resolutionHost).resolvedModule?.resolvedFileName;
    const resolvedPath = resolvedModule ? normalizeVirtualPath(resolvedModule) : resolveLocalPath(specifier, fromVirtual, compilerOptions, filesByVirtualPath, workspaceProjects);
    const resolvedFile = resolvedPath ? filesByVirtualPath.get(resolvedPath) : undefined;
    if (resolvedFile && isGraphSourcePath(resolvedFile.path)) {
      imports.push({ fromPath, toPath: resolvedFile.path, specifier, kind, resolutionStatus: "resolved", unresolvedReason: null });
    } else if (resolvedFile) {
      imports.push({ fromPath, toPath: null, specifier, kind, resolutionStatus: "asset", unresolvedReason: null });
    } else if (isExternalSpecifier(specifier, compilerOptions, workspaceProjects)) {
      imports.push({ fromPath, toPath: null, specifier, kind, resolutionStatus: "external", unresolvedReason: null });
    } else {
      imports.push({ fromPath, toPath: null, specifier, kind, resolutionStatus: "unresolved", unresolvedReason: "module could not be resolved from the repository tree" });
    }
  };
}

function resolveLocalPath(specifier: string, fromVirtualPath: string, compilerOptions: ts.CompilerOptions, filesByVirtualPath: Map<string, SourceFile>, workspaceProjects: Map<string, ProjectDescriptor>): string | undefined {
  const candidates: string[] = [];
  if (specifier.startsWith(".") || specifier.startsWith("/")) candidates.push(path.posix.resolve(path.posix.dirname(fromVirtualPath), specifier));
  const baseUrl = compilerOptions.baseUrl ? normalizeVirtualPath(compilerOptions.baseUrl) : virtualRoot;
  for (const [alias, targets] of Object.entries(compilerOptions.paths ?? {})) {
    const prefix = alias.replace(/\*$/, "");
    if (!specifier.startsWith(prefix)) continue;
    const wildcard = alias.includes("*") ? specifier.slice(prefix.length) : "";
    for (const target of targets) candidates.push(path.posix.resolve(baseUrl, target.replace("*", wildcard)));
  }
  const workspace = workspaceProjects.get(packageNameFromSpecifier(specifier));
  if (workspace) {
    const subpath = specifier.slice(packageNameFromSpecifier(specifier).length).replace(/^\//, "");
    candidates.push(toVirtualPath(workspace.rootPath ? `${workspace.rootPath}/${subpath}` : subpath));
    candidates.push(toVirtualPath(workspace.rootPath ? `${workspace.rootPath}/src/${subpath}` : `src/${subpath}`));
    candidates.push(toVirtualPath(workspace.rootPath ? `${workspace.rootPath}/src/index` : "src/index"));
    candidates.push(toVirtualPath(workspace.rootPath ? `${workspace.rootPath}/index` : "index"));
  }
  for (const candidate of candidates.map(normalizeVirtualPath)) {
    const exact = resolveCandidate(candidate, filesByVirtualPath);
    if (exact) return exact;
  }
  return undefined;
}

function resolveCandidate(candidate: string, files: Map<string, SourceFile>): string | undefined {
  const suffixes = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".css", ".scss", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];
  return suffixes.map((suffix) => normalizeVirtualPath(`${candidate}${suffix}`)).find((filePath) => files.has(filePath));
}

function classifyFile(pathValue: string, symbols: GraphSymbol[], _project: ProjectDescriptor): { kind: GraphFileKind; reason: string } {
  if (isStylePath(pathValue)) return { kind: "style", reason: "stylesheet extension convention" };
  if (isToolingPath(pathValue)) return { kind: "tooling", reason: "repository tooling/configuration convention" };
  if (isJsxPath(pathValue) && /(^|\/)(components|ui)\//.test(pathValue)) return { kind: "component", reason: "component directory convention" };
  if (isJsxPath(pathValue) && symbols.some((symbol) => symbol.kind === "component" && symbol.isExported)) return { kind: "component", reason: "JSX module exports a component candidate" };
  return { kind: "module", reason: "generic JavaScript/TypeScript module" };
}

export function classifyTechnicalRole(pathValue: string, kind: GraphFileKind, source: string): Pick<GraphFile, "technicalRole" | "technicalRoleReason" | "technicalRoleStrength"> {
  const lower = pathValue.toLowerCase();
  const text = source.toLowerCase();
  if (kind === "style") return { technicalRole: "styling", technicalRoleReason: "stylesheet graph role", technicalRoleStrength: "strong" };
  if (kind === "tooling" || /(?:config|\.env|scripts\/)/.test(lower)) return { technicalRole: "configuration", technicalRoleReason: "tooling/configuration path convention", technicalRoleStrength: "strong" };
  if (/(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|\.|$)/.test(lower)) return { technicalRole: "testing", technicalRoleReason: "test path convention", technicalRoleStrength: "strong" };
  if (/(?:components\/ui|\/ui\/|design-system|primitives)/.test(lower)) return { technicalRole: "ui_primitive", technicalRoleReason: "UI primitive path convention", technicalRoleStrength: "strong" };
  if (/(?:analytics|telemetry|tracking|segment|posthog|mixpanel)/.test(lower) || /(?:useanalytics|track\(|capture\()/.test(text)) return { technicalRole: "analytics", technicalRoleReason: "analytics path or API signal", technicalRoleStrength: "strong" };
  if (/(?:^|\/)(?:db|database|cache|queue|transport|adapter|storage|cloudinary|provider|infra)(?:\/|$)/.test(lower)) return { technicalRole: "infrastructure", technicalRoleReason: "infrastructure path convention", technicalRoleStrength: "strong" };
  if (kind === "component") return { technicalRole: "presentation", technicalRoleReason: "component graph role", technicalRoleStrength: "strong" };
  if (/(?:utils?|helpers?|format|constants?)/.test(lower)) return { technicalRole: "utility", technicalRoleReason: "utility path convention", technicalRoleStrength: "heuristic" };
  if (["module", "shared_module", "page", "api_route", "layout", "loading", "error_boundary", "metadata"].includes(kind)) return { technicalRole: "application", technicalRoleReason: "application code without a stronger technical role", technicalRoleStrength: "heuristic" };
  return { technicalRole: "unknown", technicalRoleReason: "no deterministic technical-role rule", technicalRoleStrength: "unknown" };
}

function isStylePath(filePath: string): boolean { return /\.(?:css|scss|sass|less)$/.test(filePath); }
function isJsxPath(filePath: string): boolean { return /\.(?:tsx|jsx)$/.test(filePath); }
function scriptKindForPath(filePath: string): ts.ScriptKind { if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX; if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX; if (/\.(?:js|mjs|cjs)$/.test(filePath)) return ts.ScriptKind.JS; return ts.ScriptKind.TS; }
function classifyFunctionSymbol(filePath: string, name: string): GraphSymbolKind { return isJsxPath(filePath) && /^[A-Z]/.test(name) ? "component" : "function"; }
function isFunctionLikeInitializer(node: ts.Expression): boolean { const value = unwrapExpression(node); return ts.isArrowFunction(value) || ts.isFunctionExpression(value); }
function isComponentInitializer(node: ts.Expression, name: string, exported: boolean): boolean { if (!/^[A-Z]/.test(name)) return false; const value = unwrapExpression(node); if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return true; if (ts.isCallExpression(value)) { const callee = ts.isPropertyAccessExpression(value.expression) ? value.expression.name.text : ts.isIdentifier(value.expression) ? value.expression.text : ""; return ["forwardRef", "memo", "lazy"].includes(callee); } return exported && (ts.isPropertyAccessExpression(value) || ts.isIdentifier(value)); }
function unwrapExpression(node: ts.Expression): ts.Expression { return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) ? unwrapExpression(node.expression) : node; }
function isExported(node: ts.Node, name: string, exportedNames: Set<string>): boolean { return hasExportModifier(node) || exportedNames.has(name); }
function hasExportModifier(node: ts.Node): boolean { return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)); }
function isToolingPath(pathValue: string): boolean { return pathValue.startsWith("scripts/") || /(^|\/)(?:drizzle|next|tailwind|postcss|eslint|prettier|vite|vitest|remix)\.config\.(?:ts|js|mjs|cjs)$/.test(pathValue) || /(^|\/)sentry\..+\.config\.(?:ts|js|mjs|cjs)$/.test(pathValue); }
function isExternalSpecifier(specifier: string, compilerOptions: ts.CompilerOptions, workspaceProjects: Map<string, ProjectDescriptor>): boolean { if (specifier.startsWith(".") || specifier.startsWith("/")) return false; if (workspaceProjects.has(packageNameFromSpecifier(specifier))) return false; return !Object.keys(compilerOptions.paths ?? {}).some((alias) => specifier.startsWith(alias.replace(/\*$/, ""))); }
function packageNameFromSpecifier(specifier: string): string { if (!specifier.startsWith("@")) return specifier.split("/")[0]; return specifier.split("/").slice(0, 2).join("/"); }
function deduplicateImports(imports: GraphImport[]): GraphImport[] { const seen = new Set<string>(); return imports.filter((entry) => { const key = [entry.fromPath, entry.toPath ?? "", entry.specifier, entry.kind, entry.resolutionStatus].join("\u0000"); if (seen.has(key)) return false; seen.add(key); return true; }); }
function toVirtualPath(relativePath: string): string { return path.posix.join(virtualRoot, relativePath); }
function fromVirtualPath(filePath: string): string { return filePath.startsWith(`${virtualRoot}/`) ? filePath.slice(virtualRoot.length + 1) : filePath; }
function normalizeVirtualPath(filePath: string): string { return path.posix.normalize(filePath.replace(/\\/g, "/")); }
function byPath(left: { path: string }, right: { path: string }): number { return left.path.localeCompare(right.path); }

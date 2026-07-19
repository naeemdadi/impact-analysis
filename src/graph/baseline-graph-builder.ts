import crypto from "node:crypto";
import path from "node:path";
import * as ts from "typescript";

import type {
  BaselineGraph,
  GraphFile,
  GraphFileKind,
  GraphImport,
  GraphImportKind,
  GraphSymbol,
  GraphSymbolKind,
  RepositorySource,
  SourceFile,
} from "./types.js";

const virtualRoot = "/repository";
const codePathPattern = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const stylePathPattern = /\.(?:css|scss|sass|less)$/;
const appRouterEntryPattern = /(?:page|route|layout|template|default|loading|error|global-error|not-found|robots|sitemap|manifest|icon|apple-icon|opengraph-image|twitter-image)\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

export class UnsupportedRepositoryError extends Error {}

export function isGraphFilePath(filePath: string): boolean {
  return codePathPattern.test(filePath) || stylePathPattern.test(filePath);
}

export function buildBaselineGraph(source: RepositorySource): BaselineGraph {
  return buildGraphForFiles(source, source.files.filter((file) => isGraphFilePath(file.path)).map((file) => file.path));
}

/** Builds facts for selected paths while resolving imports against the complete target tree. */
export function buildGraphForFiles(source: RepositorySource, pathsToAnalyze: string[]): BaselineGraph {
  const tsconfig = source.files.find((file) => file.path === "tsconfig.json");
  if (!tsconfig) throw new UnsupportedRepositoryError("tsconfig.json is required to build a baseline graph");

  const requestedPaths = new Set(pathsToAnalyze);
  const sourceFiles = source.files.filter((file) => isGraphFilePath(file.path) && requestedPaths.has(file.path));
  const availablePaths = source.allFilePaths ?? source.files.map((file) => file.path);
  const loadedFiles = new Map(source.files.map((file) => [file.path, file]));
  const filesByVirtualPath = new Map<string, SourceFile>(
    availablePaths.map((filePath) => [toVirtualPath(filePath), loadedFiles.get(filePath) ?? { path: filePath, blobSha: "", content: "" }]),
  );
  const compilerOptions = parseCompilerOptions(tsconfig, filesByVirtualPath);
  const graphFiles = new Map<string, GraphFile>();
  const symbols: GraphSymbol[] = [];
  const imports: GraphImport[] = [];

  for (const file of sourceFiles.sort((left, right) => left.path.localeCompare(right.path))) {
    if (isStylePath(file.path)) {
      const classification = classifyFile(file.path, []);
      graphFiles.set(file.path, { path: file.path, blobSha: file.blobSha, kind: classification.kind, classificationReason: classification.reason, ...classifyTechnicalRole(file.path, classification.kind, []) });
      imports.push(...extractStyleImports(file, compilerOptions, filesByVirtualPath));
      continue;
    }

    const sourceFile = ts.createSourceFile(toVirtualPath(file.path), file.content, ts.ScriptTarget.ES2022, true, scriptKindForPath(file.path));
    const fileSymbols = extractTopLevelSymbols(file, sourceFile);
    const classification = classifyFile(file.path, fileSymbols);
    graphFiles.set(file.path, { path: file.path, blobSha: file.blobSha, kind: classification.kind, classificationReason: classification.reason, ...classifyTechnicalRole(file.path, classification.kind, sourceFile.statements.map((statement) => statement.getText(sourceFile)).join("\n")) });
    symbols.push(...fileSymbols);
    imports.push(...extractImports(sourceFile, compilerOptions, filesByVirtualPath));
  }

  return { files: [...graphFiles.values()], symbols, imports };
}

function parseCompilerOptions(tsconfig: SourceFile, filesByVirtualPath: Map<string, SourceFile>): ts.CompilerOptions {
  const parsedJson = ts.parseConfigFileTextToJson(tsconfig.path, tsconfig.content);
  if (parsedJson.error) throw new UnsupportedRepositoryError(`tsconfig.json is invalid: ${ts.flattenDiagnosticMessageText(parsedJson.error.messageText, "\n")}`);
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    readDirectory: () => [],
    fileExists: (fileName) => filesByVirtualPath.has(normalizeVirtualPath(fileName)),
    readFile: (fileName) => filesByVirtualPath.get(normalizeVirtualPath(fileName))?.content,
  };
  const result = ts.parseJsonConfigFileContent(parsedJson.config, host, virtualRoot, undefined, toVirtualPath(tsconfig.path));
  const fatalErrors = result.errors.filter((diagnostic) => diagnostic.code !== 18003);
  if (fatalErrors.length > 0) throw new UnsupportedRepositoryError(`tsconfig.json is invalid: ${ts.flattenDiagnosticMessageText(fatalErrors[0].messageText, "\n")}`);
  return result.options;
}

function extractTopLevelSymbols(file: SourceFile, sourceFile: ts.SourceFile): GraphSymbol[] {
  const symbols: GraphSymbol[] = [];
  const exportedNames = collectExportedLocalNames(sourceFile);
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const name = statement.name.text;
      symbols.push(createSymbol(file, sourceFile, statement, name, classifyFunctionSymbol(file.path, name), isExported(statement, name, exportedNames)));
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name) {
      const name = statement.name.text;
      symbols.push(createSymbol(file, sourceFile, statement, name, "class", isExported(statement, name, exportedNames)));
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
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.add((element.propertyName ?? element.name).text);
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) names.add(statement.expression.text);
  }
  return names;
}

function createSymbol(file: SourceFile, sourceFile: ts.SourceFile, node: ts.Node, name: string, kind: GraphSymbolKind, isExportedValue: boolean): GraphSymbol {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    filePath: file.path, symbolKey: `${file.path}:${kind}:${name}`, name, kind, isExported: isExportedValue,
    startLine: start.line + 1, startColumn: start.character + 1, endLine: end.line + 1, endColumn: end.character + 1,
    sourceHash: crypto.createHash("sha256").update(node.getText(sourceFile)).digest("hex"),
  };
}

function extractImports(sourceFile: ts.SourceFile, compilerOptions: ts.CompilerOptions, filesByVirtualPath: Map<string, SourceFile>): GraphImport[] {
  const imports: GraphImport[] = [];
  const addImport = createImportAdder(fromVirtualPath(sourceFile.fileName), compilerOptions, filesByVirtualPath, imports);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      addImport(node.moduleSpecifier.text, node.importClause?.isTypeOnly ? "type_only" : "static");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      addImport(node.moduleSpecifier.text, "static");
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      addImport(node.arguments[0].text, "dynamic");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return deduplicateImports(imports);
}

function extractStyleImports(file: SourceFile, compilerOptions: ts.CompilerOptions, filesByVirtualPath: Map<string, SourceFile>): GraphImport[] {
  const imports: GraphImport[] = [];
  const addImport = createImportAdder(file.path, compilerOptions, filesByVirtualPath, imports);
  const pattern = /@import\s+(?:url\(\s*)?["']([^"']+)["']/g;
  for (const match of file.content.matchAll(pattern)) addImport(match[1], "static");
  return deduplicateImports(imports);
}

function createImportAdder(fromPath: string, compilerOptions: ts.CompilerOptions, filesByVirtualPath: Map<string, SourceFile>, imports: GraphImport[]) {
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
    const resolvedPath = resolvedModule ? normalizeVirtualPath(resolvedModule) : resolveExactLocalPath(specifier, fromVirtual, compilerOptions, filesByVirtualPath);
    const resolvedFile = resolvedPath ? filesByVirtualPath.get(resolvedPath) : undefined;
    if (resolvedFile && isGraphFilePath(resolvedFile.path)) {
      imports.push({ fromPath, toPath: resolvedFile.path, specifier, kind, resolutionStatus: "resolved", unresolvedReason: null });
      return;
    }
    if (resolvedFile) {
      imports.push({ fromPath, toPath: null, specifier, kind, resolutionStatus: "asset", unresolvedReason: null });
      return;
    }
    if (isExternalSpecifier(specifier, compilerOptions)) {
      imports.push({ fromPath, toPath: null, specifier, kind, resolutionStatus: "external", unresolvedReason: null });
      return;
    }
    imports.push({ fromPath, toPath: null, specifier, kind, resolutionStatus: "unresolved", unresolvedReason: "module could not be resolved from the repository tree" });
  };
}

function resolveExactLocalPath(specifier: string, fromVirtualPath: string, compilerOptions: ts.CompilerOptions, filesByVirtualPath: Map<string, SourceFile>): string | undefined {
  const candidates: string[] = [];
  if (specifier.startsWith(".") || specifier.startsWith("/")) candidates.push(path.posix.resolve(path.posix.dirname(fromVirtualPath), specifier));
  const baseUrl = compilerOptions.baseUrl ? normalizeVirtualPath(compilerOptions.baseUrl) : virtualRoot;
  for (const [alias, targets] of Object.entries(compilerOptions.paths ?? {})) {
    const prefix = alias.replace(/\*$/, "");
    if (!specifier.startsWith(prefix)) continue;
    const wildcard = alias.includes("*") ? specifier.slice(prefix.length) : "";
    for (const target of targets) candidates.push(path.posix.resolve(baseUrl, target.replace("*", wildcard)));
  }
  return candidates.map(normalizeVirtualPath).find((candidate) => filesByVirtualPath.has(candidate));
}

function classifyFile(pathValue: string, symbols: GraphSymbol[]): { kind: GraphFileKind; reason: string } {
  const normalized = pathValue.replace(/^src\//, "");
  if (isStylePath(pathValue)) return { kind: "style", reason: "Stylesheet extension convention" };
  if (isToolingPath(pathValue)) return { kind: "tooling", reason: "Repository tooling or configuration convention" };
  const extension = "(?:ts|tsx|js|jsx|mjs|cjs)";
  if (new RegExp(`^app/(?:.*\\/)?page\\.${extension}$`).test(normalized)) return { kind: "page", reason: "Next.js App Router page convention" };
  if (new RegExp(`^app/(?:.*\\/)?route\\.${extension}$`).test(normalized)) return { kind: "api_route", reason: "Next.js App Router route convention" };
  if (new RegExp(`^app/(?:.*\\/)?(?:layout|template|default)\\.${extension}$`).test(normalized)) return { kind: "layout", reason: "Next.js App Router layout boundary convention" };
  if (new RegExp(`^app/(?:.*\\/)?loading\\.${extension}$`).test(normalized)) return { kind: "loading", reason: "Next.js App Router loading boundary convention" };
  if (new RegExp(`^app/(?:.*\\/)?(?:error|global-error|not-found)\\.${extension}$`).test(normalized)) return { kind: "error_boundary", reason: "Next.js App Router error boundary convention" };
  if (new RegExp(`^app/(?:.*\\/)?(?:robots|sitemap|manifest|icon|apple-icon|opengraph-image|twitter-image)\\.${extension}$`).test(normalized)) return { kind: "metadata", reason: "Next.js metadata route convention" };
  if (new RegExp(`^pages/api/.+\\.${extension}$`).test(normalized)) return { kind: "api_route", reason: "Next.js Pages Router API convention" };
  if (new RegExp(`^pages/.+\\.${extension}$`).test(normalized)) return { kind: "page", reason: "Next.js Pages Router page convention" };
  if (isJsxPath(pathValue) && /(^|\/)(components|ui)\//.test(normalized)) return { kind: "component", reason: "Component directory convention" };
  if (isJsxPath(pathValue) && symbols.some((symbol) => symbol.kind === "component" && symbol.isExported)) return { kind: "component", reason: "JSX module exports a React component candidate" };
  if (isCodePath(pathValue)) return { kind: "shared_module", reason: "Code module outside a framework entrypoint convention" };
  return { kind: "unknown", reason: "File did not meet a deterministic graph classification rule" };
}

export function classifyTechnicalRole(pathValue: string, kind: GraphFileKind, source: string | string[]): Pick<GraphFile, "technicalRole" | "technicalRoleReason" | "technicalRoleStrength"> {
  const lower = pathValue.toLowerCase();
  const text = Array.isArray(source) ? source.join("\n").toLowerCase() : source.toLowerCase();
  if (kind === "style") return { technicalRole: "styling", technicalRoleReason: "Stylesheet graph role", technicalRoleStrength: "strong" };
  if (kind === "tooling" || /(?:config|\.env|scripts\/)/.test(lower)) return { technicalRole: "configuration", technicalRoleReason: "Tooling/configuration path convention", technicalRoleStrength: "strong" };
  if (/(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|\.|$)/.test(lower)) return { technicalRole: "testing", technicalRoleReason: "Test path convention", technicalRoleStrength: "strong" };
  if (/(?:components\/ui|\/ui\/|design-system|primitives)/.test(lower)) return { technicalRole: "ui_primitive", technicalRoleReason: "UI primitive path convention", technicalRoleStrength: "strong" };
  if (/(?:analytics|telemetry|tracking|segment|posthog|mixpanel)/.test(lower) || /(?:useanalytics|track\(|capture\()/i.test(text)) return { technicalRole: "analytics", technicalRoleReason: "Analytics path or API signal", technicalRoleStrength: "strong" };
  if (/(?:^|\/)(?:db|database|cache|queue|transport|adapter|storage|cloudinary|provider|infra)(?:\/|$)/.test(lower)) return { technicalRole: "infrastructure", technicalRoleReason: "Infrastructure path convention", technicalRoleStrength: "strong" };
  if (kind === "component") return { technicalRole: "presentation", technicalRoleReason: "Component graph role", technicalRoleStrength: "strong" };
  if (kind === "page" || kind === "api_route") return { technicalRole: "application", technicalRoleReason: "User-facing entrypoint graph role", technicalRoleStrength: "strong" };
  if (/(?:utils?|helpers?|format|constants?)/.test(lower)) return { technicalRole: "utility", technicalRoleReason: "Utility path convention", technicalRoleStrength: "heuristic" };
  if (kind === "shared_module" || kind === "layout" || kind === "loading" || kind === "error_boundary" || kind === "metadata") return { technicalRole: "application", technicalRoleReason: "Application code without a stronger technical role", technicalRoleStrength: "heuristic" };
  return { technicalRole: "unknown", technicalRoleReason: "No deterministic technical-role rule", technicalRoleStrength: "unknown" };
}

function isCodePath(filePath: string): boolean { return codePathPattern.test(filePath); }
function isStylePath(filePath: string): boolean { return stylePathPattern.test(filePath); }
function isJsxPath(filePath: string): boolean { return /\.(?:tsx|jsx)$/.test(filePath); }
function scriptKindForPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/.test(filePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
function classifyFunctionSymbol(filePath: string, name: string): GraphSymbolKind { return isJsxPath(filePath) && /^[A-Z]/.test(name) ? "component" : "function"; }
function isFunctionLikeInitializer(node: ts.Expression): boolean {
  const value = unwrapExpression(node);
  return ts.isArrowFunction(value) || ts.isFunctionExpression(value);
}
function isComponentInitializer(node: ts.Expression, name: string, exported: boolean): boolean {
  if (!/^[A-Z]/.test(name)) return false;
  const value = unwrapExpression(node);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return true;
  if (ts.isCallExpression(value)) {
    const callee = ts.isPropertyAccessExpression(value.expression) ? value.expression.name.text : ts.isIdentifier(value.expression) ? value.expression.text : "";
    return callee === "forwardRef" || callee === "memo" || callee === "lazy";
  }
  return exported && (ts.isPropertyAccessExpression(value) || ts.isIdentifier(value));
}
function unwrapExpression(node: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) return unwrapExpression(node.expression);
  return node;
}
function isExported(node: ts.Node, name: string, exportedNames: Set<string>): boolean { return hasExportModifier(node) || exportedNames.has(name); }
function hasExportModifier(node: ts.Node): boolean { return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)); }
function isToolingPath(pathValue: string): boolean {
  return pathValue.startsWith("scripts/") || /(^|\/)(?:drizzle|next|tailwind|postcss|eslint|prettier|vite|vitest)\.config\.(?:ts|js|mjs|cjs)$/.test(pathValue) || /(^|\/)sentry\..+\.config\.(?:ts|js|mjs|cjs)$/.test(pathValue);
}
function isExternalSpecifier(specifier: string, compilerOptions: ts.CompilerOptions): boolean {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  return !Object.keys(compilerOptions.paths ?? {}).some((alias) => specifier.startsWith(alias.replace(/\*$/, "")));
}
function deduplicateImports(imports: GraphImport[]): GraphImport[] {
  const seen = new Set<string>();
  return imports.filter((entry) => {
    const key = [entry.fromPath, entry.toPath ?? "", entry.specifier, entry.kind, entry.resolutionStatus].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function toVirtualPath(relativePath: string): string { return path.posix.join(virtualRoot, relativePath); }
function fromVirtualPath(filePath: string): string { return filePath.startsWith(`${virtualRoot}/`) ? filePath.slice(virtualRoot.length + 1) : filePath; }
function normalizeVirtualPath(filePath: string): string { return path.posix.normalize(filePath.replace(/\\/g, "/")); }

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

export function buildBaselineGraph(source: RepositorySource): BaselineGraph {
  const tsconfig = source.files.find((file) => file.path === "tsconfig.json");
  if (!tsconfig) {
    throw new Error("tsconfig.json is required to build a baseline graph");
  }

  const sourceFiles = source.files.filter((file) => /\.(?:ts|tsx)$/.test(file.path));
  const filesByVirtualPath = new Map(source.files.map((file) => [toVirtualPath(file.path), file]));
  const compilerOptions = parseCompilerOptions(tsconfig, filesByVirtualPath);
  const graphFiles = new Map<string, GraphFile>();
  const symbols: GraphSymbol[] = [];
  const imports: GraphImport[] = [];

  for (const file of sourceFiles.sort((left, right) => left.path.localeCompare(right.path))) {
    const sourceFile = ts.createSourceFile(
      toVirtualPath(file.path),
      file.content,
      ts.ScriptTarget.ES2022,
      true,
      file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const fileSymbols = extractTopLevelSymbols(file, sourceFile);
    const classification = classifyFile(file.path, fileSymbols);
    graphFiles.set(file.path, {
      path: file.path,
      blobSha: file.blobSha,
      kind: classification.kind,
      classificationReason: classification.reason,
    });
    symbols.push(...fileSymbols);
    imports.push(...extractImports(sourceFile, compilerOptions, filesByVirtualPath));
  }

  return {
    files: [...graphFiles.values()],
    symbols,
    imports,
  };
}

function parseCompilerOptions(tsconfig: SourceFile, filesByVirtualPath: Map<string, SourceFile>): ts.CompilerOptions {
  const parsedJson = ts.parseConfigFileTextToJson(tsconfig.path, tsconfig.content);
  if (parsedJson.error) {
    throw new Error(`tsconfig.json is invalid: ${ts.flattenDiagnosticMessageText(parsedJson.error.messageText, "\n")}`);
  }

  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    readDirectory: () => [],
    fileExists: (fileName) => filesByVirtualPath.has(normalizeVirtualPath(fileName)),
    readFile: (fileName) => filesByVirtualPath.get(normalizeVirtualPath(fileName))?.content,
  };
  const result = ts.parseJsonConfigFileContent(
    parsedJson.config,
    host,
    virtualRoot,
    undefined,
    toVirtualPath(tsconfig.path),
  );
  const fatalErrors = result.errors.filter((diagnostic) => diagnostic.code !== 18003);
  if (fatalErrors.length > 0) {
    throw new Error(`tsconfig.json is invalid: ${ts.flattenDiagnosticMessageText(fatalErrors[0].messageText, "\n")}`);
  }
  return result.options;
}

function extractTopLevelSymbols(file: SourceFile, sourceFile: ts.SourceFile): GraphSymbol[] {
  const symbols: GraphSymbol[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      symbols.push(createSymbol(file, sourceFile, statement, statement.name.text, classifyFunctionSymbol(file.path, statement.name.text), hasExportModifier(statement)));
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name) {
      symbols.push(createSymbol(file, sourceFile, statement, statement.name.text, "class", hasExportModifier(statement)));
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer && isFunctionLikeInitializer(declaration.initializer)) {
          symbols.push(
            createSymbol(
              file,
              sourceFile,
              declaration,
              declaration.name.text,
              classifyFunctionSymbol(file.path, declaration.name.text),
              hasExportModifier(statement),
            ),
          );
        }
      }
    }
  }
  return symbols;
}

function createSymbol(
  file: SourceFile,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  name: string,
  kind: GraphSymbolKind,
  isExported: boolean,
): GraphSymbol {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  const source = node.getText(sourceFile);
  return {
    filePath: file.path,
    symbolKey: `${file.path}:${kind}:${name}`,
    name,
    kind,
    isExported,
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
    sourceHash: crypto.createHash("sha256").update(source).digest("hex"),
  };
}

function extractImports(
  sourceFile: ts.SourceFile,
  compilerOptions: ts.CompilerOptions,
  filesByVirtualPath: Map<string, SourceFile>,
): GraphImport[] {
  const imports: GraphImport[] = [];
  const resolutionHost: ts.ModuleResolutionHost = {
    fileExists: (fileName) => filesByVirtualPath.has(normalizeVirtualPath(fileName)),
    readFile: (fileName) => filesByVirtualPath.get(normalizeVirtualPath(fileName))?.content,
    directoryExists: (directoryName) => {
      const normalized = normalizeVirtualPath(directoryName).replace(/\/$/, "");
      return [...filesByVirtualPath.keys()].some((fileName) => fileName.startsWith(`${normalized}/`));
    },
    getCurrentDirectory: () => virtualRoot,
    getDirectories: () => [],
    realpath: normalizeVirtualPath,
  };

  const addImport = (specifier: string, kind: GraphImportKind): void => {
    const result = ts.resolveModuleName(specifier, sourceFile.fileName, compilerOptions, resolutionHost);
    const resolvedPath = result.resolvedModule?.resolvedFileName;
    const resolvedFile = resolvedPath ? filesByVirtualPath.get(normalizeVirtualPath(resolvedPath)) : undefined;
    if (resolvedFile && /\.(?:ts|tsx)$/.test(resolvedFile.path)) {
      imports.push({
        fromPath: fromVirtualPath(sourceFile.fileName),
        toPath: resolvedFile.path,
        specifier,
        kind,
        resolutionStatus: "resolved",
        unresolvedReason: null,
      });
      return;
    }

    if (isExternalSpecifier(specifier, compilerOptions)) {
      imports.push({
        fromPath: fromVirtualPath(sourceFile.fileName),
        toPath: null,
        specifier,
        kind,
        resolutionStatus: "external",
        unresolvedReason: null,
      });
      return;
    }

    imports.push({
      fromPath: fromVirtualPath(sourceFile.fileName),
      toPath: null,
      specifier,
      kind,
      resolutionStatus: "unresolved",
      unresolvedReason: "module could not be resolved from the fetched source tree",
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      addImport(node.moduleSpecifier.text, node.importClause?.isTypeOnly ? "type_only" : "static");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      addImport(node.moduleSpecifier.text, "static");
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      addImport(node.arguments[0].text, "dynamic");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return deduplicateImports(imports);
}

function classifyFile(pathValue: string, symbols: GraphSymbol[]): { kind: GraphFileKind; reason: string } {
  const normalized = pathValue.replace(/^src\//, "");
  if (/^app\/.+\/page\.tsx?$/.test(normalized) || normalized === "app/page.tsx" || normalized === "app/page.ts") {
    return { kind: "page", reason: "Next.js App Router page convention" };
  }
  if (/^app\/.+\/route\.tsx?$/.test(normalized) || normalized === "app/route.ts" || normalized === "app/route.tsx") {
    return { kind: "api_route", reason: "Next.js App Router route convention" };
  }
  if (/^pages\/api\/.+\.tsx?$/.test(normalized)) {
    return { kind: "api_route", reason: "Next.js Pages Router API convention" };
  }
  if (/^pages\/.+\.tsx?$/.test(normalized)) {
    return { kind: "page", reason: "Next.js Pages Router page convention" };
  }
  if (pathValue.endsWith(".tsx") && symbols.some((symbol) => symbol.kind === "component" && symbol.isExported)) {
    return { kind: "component", reason: "TSX module exports an uppercase React component candidate" };
  }
  if (pathValue.endsWith(".ts")) {
    return { kind: "shared_module", reason: "TypeScript module outside a Next.js entrypoint convention" };
  }
  return { kind: "unknown", reason: "TSX module did not meet the deterministic component rule" };
}

function classifyFunctionSymbol(filePath: string, name: string): GraphSymbolKind {
  return filePath.endsWith(".tsx") && /^[A-Z]/.test(name) ? "component" : "function";
}

function isFunctionLikeInitializer(node: ts.Expression): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function isExternalSpecifier(specifier: string, compilerOptions: ts.CompilerOptions): boolean {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return false;
  }
  const pathAliases = Object.keys(compilerOptions.paths ?? {});
  return !pathAliases.some((alias) => {
    const prefix = alias.replace(/\*$/, "");
    return specifier.startsWith(prefix);
  });
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

function toVirtualPath(relativePath: string): string {
  return path.posix.join(virtualRoot, relativePath);
}

function fromVirtualPath(filePath: string): string {
  return filePath.startsWith(`${virtualRoot}/`) ? filePath.slice(virtualRoot.length + 1) : filePath;
}

function normalizeVirtualPath(filePath: string): string {
  return path.posix.normalize(filePath.replace(/\\/g, "/"));
}

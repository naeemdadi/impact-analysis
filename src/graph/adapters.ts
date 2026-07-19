import path from "node:path";
import * as ts from "typescript";

import type {
  BaselineGraph,
  GraphEntrypoint,
  GraphEntrypointKind,
  GraphFile,
  GraphProject,
  GraphProtocolBinding,
  ProjectDescriptor,
  RepositorySource,
  SourceFile,
} from "./types.js";

export interface AdapterExtractionInput {
  source: RepositorySource;
  projects: GraphProject[];
  files: GraphFile[];
  imports: BaselineGraph["imports"];
}

export interface AdapterExtractionResult {
  entrypoints: GraphEntrypoint[];
  protocolBindings: GraphProtocolBinding[];
}

/** Framework facts are extracted after generic module resolution succeeds. */
export function extractAdapterFacts(input: AdapterExtractionInput): AdapterExtractionResult {
  const sourceFiles = new Map(input.source.files.map((file) => [file.path, file]));
  const entrypoints = input.projects.flatMap((project) => {
    if (project.status !== "supported") return [];
    if (project.primaryFramework === "next") return extractNextEntrypoints(project, sourceFiles);
    if (project.primaryFramework === "remix") return extractRemixEntrypoints(project, sourceFiles);
    if (project.primaryFramework === "react_router") return extractReactRouterEntrypoints(project, sourceFiles, input.imports);
    if (project.primaryFramework === "express") return extractExpressEntrypoints(project, sourceFiles, input.imports);
    return [];
  });
  const protocolBindings = input.projects.some((project) => project.protocolProfiles.includes("trpc"))
    ? extractTrpcBindings(input.projects, sourceFiles, input.imports)
    : [];
  return { entrypoints: dedupeEntrypoints(entrypoints), protocolBindings: dedupeBindings(protocolBindings) };
}

function extractNextEntrypoints(project: ProjectDescriptor, files: Map<string, SourceFile>): GraphEntrypoint[] {
  const entries: GraphEntrypoint[] = [];
  for (const file of files.values()) {
    const local = relativeToProject(project.rootPath, file.path);
    const appMatch = /^(?:src\/)?app\/(?:(.*)\/)?(page|route)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.exec(local);
    if (appMatch) {
      const routePath = nextRoutePath(appMatch[1] ?? "");
      const kind: GraphEntrypointKind = appMatch[2] === "route" ? "api_route" : "web_route";
      const methods = kind === "api_route" ? httpMethodsFromSource(file) : [null];
      for (const method of methods) entries.push(entry(project, file.path, kind, routePath, method, kind === "web_route" ? "Next.js App Router page convention" : "Next.js App Router route handler convention"));
      continue;
    }
    const pagesMatch = /^(?:src\/)?pages\/(.*)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.exec(local);
    if (!pagesMatch || pagesMatch[1].startsWith("_")) continue;
    const api = pagesMatch[1].startsWith("api/");
    const routePath = nextRoutePath(api ? pagesMatch[1].slice(4) : pagesMatch[1]);
    for (const method of api ? httpMethodsFromSource(file) : [null]) entries.push(entry(project, file.path, api ? "api_route" : "web_route", routePath, method, api ? "Next.js Pages Router API convention" : "Next.js Pages Router page convention"));
  }
  return entries;
}

function extractRemixEntrypoints(project: ProjectDescriptor, files: Map<string, SourceFile>): GraphEntrypoint[] {
  const entries: GraphEntrypoint[] = [];
  for (const file of files.values()) {
    const local = relativeToProject(project.rootPath, file.path);
    const match = /^app\/routes\/(.+)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.exec(local);
    if (!match) continue;
    const source = sourceFile(file);
    const hasDefault = source.statements.some((statement) => ts.isExportAssignment(statement) || (ts.isFunctionDeclaration(statement) && hasDefaultModifier(statement)));
    const hasServerExport = source.statements.some((statement) => ts.isFunctionDeclaration(statement) && Boolean(statement.name && ["loader", "action"].includes(statement.name.text)));
    entries.push(entry(project, file.path, hasServerExport && !hasDefault ? "api_route" : "web_route", remixRoutePath(match[1]), null, "Remix app/routes convention"));
  }
  return entries;
}

function extractReactRouterEntrypoints(project: ProjectDescriptor, files: Map<string, SourceFile>, imports: BaselineGraph["imports"]): GraphEntrypoint[] {
  const results: GraphEntrypoint[] = [];
  for (const file of files.values()) {
    if (!isProjectFile(project, file.path) || !/\.(?:tsx|jsx|ts|js)$/.test(file.path)) continue;
    const source = sourceFile(file);
    const bindings = importBindings(file.path, source, imports);
    const routeArrays = topLevelRouteArrays(source);
    const visit = (node: ts.Node, parentPath: string): void => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tagName = ts.isJsxElement(node) ? node.openingElement.tagName.getText(source) : node.tagName.getText(source);
        if (tagName === "Route") {
          const attributes = ts.isJsxElement(node) ? node.openingElement.attributes.properties : node.attributes.properties;
          const declaredPath = jsxStringAttribute(attributes, "path");
          const routePath = declaredPath ?? (hasJsxAttribute(attributes, "index") ? "" : null);
          const target = jsxRouteTarget(attributes, source, bindings, file.path);
          if (routePath !== null && target) results.push(entry(project, target, "web_route", joinRoute(parentPath, routePath), null, "React Router literal JSX Route registration"));
          if (ts.isJsxElement(node)) {
            for (const child of node.children) visit(child, routePath === null ? parentPath : joinRoute(parentPath, routePath));
          }
          return;
        }
      }
      if (ts.isCallExpression(node) && isRouterFactory(node.expression, source)) {
        const routes = routeArgument(node.arguments[0], routeArrays);
        if (routes) extractRouteObjects(project, routes, source, bindings, file.path, "", results);
      }
      ts.forEachChild(node, (child) => visit(child, parentPath));
    };
    visit(source, "");
  }
  return results;
}

function extractRouteObjects(project: ProjectDescriptor, array: ts.ArrayLiteralExpression, source: ts.SourceFile, bindings: Map<string, string>, fallbackPath: string, parentPath: string, results: GraphEntrypoint[]): void {
  for (const item of array.elements) {
    if (!ts.isObjectLiteralExpression(item)) continue;
    const routePath = objectStringProperty(item, "path") ?? "";
    const currentPath = joinRoute(parentPath, routePath);
    const target = objectRouteTarget(item, source, bindings, fallbackPath);
    if (target && routePath !== "") results.push(entry(project, target, "web_route", currentPath, null, "React Router literal route-object registration"));
    const children = objectArrayProperty(item, "children");
    if (children) extractRouteObjects(project, children, source, bindings, fallbackPath, currentPath, results);
  }
}

function extractExpressEntrypoints(project: ProjectDescriptor, files: Map<string, SourceFile>, imports: BaselineGraph["imports"]): GraphEntrypoint[] {
  const results: GraphEntrypoint[] = [];
  const projectFiles = [...files.values()].filter((file) => isProjectFile(project, file.path) && /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file.path));
  const mountedPrefixes = new Map<string, string[]>();
  // First establish cross-file router mounts such as
  // `app.use("/api", ordersRouter)` where ordersRouter is imported locally.
  for (const file of projectFiles) {
    const source = sourceFile(file);
    const bindings = importBindings(file.path, source, imports);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "use" && node.arguments.length >= 2 && ts.isStringLiteral(node.arguments[0]) && ts.isIdentifier(node.arguments[1])) {
        const target = bindings.get(node.arguments[1].text);
        if (target) mountedPrefixes.set(target, [...(mountedPrefixes.get(target) ?? []), node.arguments[0].text]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const file of projectFiles) {
    const source = sourceFile(file);
    const bindings = importBindings(file.path, source, imports);
    const prefixes = new Map<string, string>();
    const calls: Array<{ call: ts.CallExpression; expression: ts.PropertyAccessExpression }> = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) calls.push({ call: node, expression: node.expression });
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const { call, expression } of calls) {
      const receiver = expression.expression.getText(source);
      const method = expression.name.text.toLowerCase();
      if (method !== "use" || call.arguments.length < 2 || !ts.isStringLiteral(call.arguments[0]) || !ts.isIdentifier(call.arguments[1])) continue;
      prefixes.set(call.arguments[1].text, call.arguments[0].text);
    }
    for (const { call, expression } of calls) {
      const receiver = expression.expression.getText(source);
      const method = expression.name.text.toLowerCase();
      if (!httpMethods.has(method) || call.arguments.length < 2 || !ts.isStringLiteral(call.arguments[0])) continue;
      const handler = call.arguments[call.arguments.length - 1];
      const target = handlerTarget(handler, source, bindings, file.path);
      if (!target) continue;
      const routePrefixes = [...new Set([prefixes.get(receiver) ?? "", ...(mountedPrefixes.get(file.path) ?? [])])];
      for (const prefix of routePrefixes) results.push(entry(project, target, "api_route", joinRoute(prefix, call.arguments[0].text), method.toUpperCase(), mountedPrefixes.has(file.path) ? "Express mounted local router registration" : "Express literal route registration"));
    }
  }
  return results;
}

interface TrpcRouterObject { filePath: string; name: string; object: ts.ObjectLiteralExpression; source: ts.SourceFile; }

function extractTrpcBindings(projects: GraphProject[], files: Map<string, SourceFile>, imports: BaselineGraph["imports"]): GraphProtocolBinding[] {
  const procedures = new Map<string, { filePath: string; source: ts.SourceFile }>();
  const routerObjects = new Map<string, TrpcRouterObject>();
  const parsedFiles = new Map<string, ts.SourceFile>();
  for (const file of files.values()) {
    if (!isCode(file.path)) continue;
    const source = sourceFile(file);
    parsedFiles.set(file.path, source);
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isCallExpression(declaration.initializer) || !isNamedCall(declaration.initializer.expression, source, "router")) continue;
        const argument = declaration.initializer.arguments[0];
        if (argument && ts.isObjectLiteralExpression(argument)) routerObjects.set(`${file.path}\u0000${declaration.name.text}`, { filePath: file.path, name: declaration.name.text, object: argument, source });
      }
    }
  }
  for (const file of files.values()) {
    const project = projects.find((candidate) => isProjectFile(candidate, file.path));
    if (!project?.protocolProfiles.includes("trpc") || !isCode(file.path)) continue;
    const source = parsedFiles.get(file.path)!;
    const bindings = importBindings(file.path, source, imports);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isNamedCall(node.expression, source, "router") && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) collectTrpcProcedures(node.arguments[0], source, file.path, "", procedures, routerObjects, bindings, new Set());
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const bindings: GraphProtocolBinding[] = [];
  for (const file of files.values()) {
    if (!isCode(file.path)) continue;
    const source = sourceFile(file);
    const visit = (node: ts.Node): void => {
      if (!ts.isCallExpression(node)) return ts.forEachChild(node, visit);
      const chain = propertyChain(node.expression, source);
      const hook = chain.at(-1);
      if (!hook || !["useQuery", "useMutation", "query", "mutate"].includes(hook)) return ts.forEachChild(node, visit);
      const operation = chain.slice(1, -1).join(".");
      const match = procedures.get(operation) ?? [...procedures.entries()].find(([key]) => key.endsWith(`.${operation}`))?.[1];
      if (match) {
        const start = source.getLineAndCharacterOfPosition(node.getStart(source));
        bindings.push({ protocol: "trpc", callerFilePath: file.path, handlerFilePath: match.filePath, operation, startLine: start.line + 1, startColumn: start.character + 1, reason: "static tRPC client procedure call matched to a router procedure" });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return bindings;
}

function collectTrpcProcedures(object: ts.ObjectLiteralExpression, source: ts.SourceFile, filePath: string, prefix: string, output: Map<string, { filePath: string; source: ts.SourceFile }>, routerObjects: Map<string, TrpcRouterObject>, bindings: Map<string, string>, visited: Set<string>): void {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) continue;
    const key = property.name.text;
    const name = prefix ? `${prefix}.${key}` : key;
    if (ts.isCallExpression(property.initializer) && isNamedCall(property.initializer.expression, source, "router") && property.initializer.arguments[0] && ts.isObjectLiteralExpression(property.initializer.arguments[0])) {
      collectTrpcProcedures(property.initializer.arguments[0], source, filePath, name, output, routerObjects, bindings, visited);
      continue;
    }
    if (ts.isIdentifier(property.initializer)) {
      const importedTarget = bindings.get(property.initializer.text);
      const direct = routerObjects.get(`${filePath}\u0000${property.initializer.text}`);
      const imported = importedTarget ? routerObjects.get(`${importedTarget}\u0000${property.initializer.text}`) ?? [...routerObjects.values()].find((candidate) => candidate.filePath === importedTarget) : undefined;
      const router = direct ?? imported;
      if (router) {
        const marker = `${router.filePath}\u0000${router.name}\u0000${name}`;
        if (!visited.has(marker)) {
          visited.add(marker);
          collectTrpcProcedures(router.object, router.source, router.filePath, name, output, routerObjects, new Map(), visited);
        }
        continue;
      }
    }
    if (containsProcedureTerminal(property.initializer, source)) output.set(name, { filePath, source });
  }
}

function containsProcedureTerminal(node: ts.Node, source: ts.SourceFile): boolean {
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (ts.isPropertyAccessExpression(candidate) && ["query", "mutation", "subscription"].includes(candidate.name.text)) found = true;
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

function entry(project: ProjectDescriptor, filePath: string, kind: GraphEntrypointKind, routePath: string, httpMethod: string | null, reason: string): GraphEntrypoint {
  return { projectRoot: project.rootPath, filePath, kind, routePath: routePath || "/", httpMethod, startLine: 1, startColumn: 1, reason };
}

function importBindings(filePath: string, source: ts.SourceFile, imports: BaselineGraph["imports"]): Map<string, string> {
  const resolvedBySpecifier = new Map(imports.filter((edge) => edge.fromPath === filePath && edge.toPath).map((edge) => [edge.specifier, edge.toPath!]));
  const result = new Map<string, string>();
  for (const [specifier, target] of resolvedBySpecifier) result.set(`#specifier:${specifier}`, target);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = resolvedBySpecifier.get(statement.moduleSpecifier.text);
    if (!target || !statement.importClause) continue;
    if (statement.importClause.name) result.set(statement.importClause.name.text, target);
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) result.set(item.name.text, target);
  }
  return result;
}

function topLevelRouteArrays(source: ts.SourceFile): Map<string, ts.ArrayLiteralExpression> {
  const values = new Map<string, ts.ArrayLiteralExpression>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isArrayLiteralExpression(declaration.initializer)) values.set(declaration.name.text, declaration.initializer);
  }
  return values;
}
function routeArgument(value: ts.Expression | undefined, arrays: Map<string, ts.ArrayLiteralExpression>): ts.ArrayLiteralExpression | null { return value && ts.isArrayLiteralExpression(value) ? value : value && ts.isIdentifier(value) ? arrays.get(value.text) ?? null : null; }
function isRouterFactory(expression: ts.Expression, source: ts.SourceFile): boolean { return ["createBrowserRouter", "createHashRouter", "createMemoryRouter"].includes(expression.getText(source)); }
function jsxStringAttribute(attributes: ts.JsxAttributes["properties"], name: string): string | null { const attribute = attributes.find((item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText() === name); return attribute?.initializer && ts.isStringLiteral(attribute.initializer) ? attribute.initializer.text : null; }
function hasJsxAttribute(attributes: ts.JsxAttributes["properties"], name: string): boolean { return attributes.some((item) => ts.isJsxAttribute(item) && item.name.getText() === name); }
function jsxRouteTarget(attributes: ts.JsxAttributes["properties"], source: ts.SourceFile, bindings: Map<string, string>, fallback: string): string | null {
  const component = attributes.find((item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText() === "Component");
  if (component?.initializer && ts.isJsxExpression(component.initializer) && component.initializer.expression && ts.isIdentifier(component.initializer.expression)) return bindings.get(component.initializer.expression.text) ?? fallback;
  const element = attributes.find((item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText() === "element");
  if (element?.initializer && ts.isJsxExpression(element.initializer) && element.initializer.expression) return expressionComponentTarget(element.initializer.expression, source, bindings, fallback);
  return null;
}
function objectStringProperty(object: ts.ObjectLiteralExpression, key: string): string | null { const property = object.properties.find((item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item) && item.name.getText() === key); return property && ts.isStringLiteral(property.initializer) ? property.initializer.text : null; }
function objectArrayProperty(object: ts.ObjectLiteralExpression, key: string): ts.ArrayLiteralExpression | null { const property = object.properties.find((item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item) && item.name.getText() === key); return property && ts.isArrayLiteralExpression(property.initializer) ? property.initializer : null; }
function objectRouteTarget(object: ts.ObjectLiteralExpression, source: ts.SourceFile, bindings: Map<string, string>, fallback: string): string | null {
  const property = object.properties.find((item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item) && ["Component", "element", "lazy"].includes(item.name.getText()));
  if (!property) return null;
  if (property.name.getText() === "lazy" && ts.isArrowFunction(property.initializer) && ts.isCallExpression(property.initializer.body) && property.initializer.body.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(property.initializer.body.arguments[0])) return bindings.get(`#specifier:${property.initializer.body.arguments[0].text}`) ?? fallback;
  return expressionComponentTarget(property.initializer, source, bindings, fallback);
}
function expressionComponentTarget(expression: ts.Expression, _source: ts.SourceFile, bindings: Map<string, string>, fallback: string): string | null {
  if (ts.isIdentifier(expression)) return bindings.get(expression.text) ?? fallback;
  if (ts.isJsxElement(expression) || ts.isJsxSelfClosingElement(expression)) {
    const tag = ts.isJsxElement(expression) ? expression.openingElement.tagName.getText() : expression.tagName.getText();
    return bindings.get(tag) ?? fallback;
  }
  return null;
}
function handlerTarget(handler: ts.Expression, source: ts.SourceFile, bindings: Map<string, string>, fallback: string): string | null { return ts.isIdentifier(handler) ? bindings.get(handler.text) ?? fallback : ts.isArrowFunction(handler) || ts.isFunctionExpression(handler) ? fallback : null; }
function httpMethodsFromSource(file: SourceFile): Array<string | null> { const source = sourceFile(file); const methods = source.statements.flatMap((statement) => ts.isFunctionDeclaration(statement) && statement.name && /^[A-Z]+$/.test(statement.name.text) ? [statement.name.text] : []); return methods.length > 0 ? methods : [null]; }
function hasDefaultModifier(statement: ts.FunctionDeclaration): boolean { return Boolean(ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)); }
function isNamedCall(expression: ts.Expression, source: ts.SourceFile, name: string): boolean { return ts.isIdentifier(expression) ? expression.text === name : ts.isPropertyAccessExpression(expression) ? expression.name.text === name : expression.getText(source) === name; }
function propertyChain(expression: ts.Expression, source: ts.SourceFile): string[] { const values: string[] = []; let current: ts.Expression = expression; while (ts.isPropertyAccessExpression(current)) { values.unshift(current.name.text); current = current.expression; } if (ts.isIdentifier(current)) values.unshift(current.text); else if (current.getText(source)) values.unshift(current.getText(source)); return values; }
function sourceFile(file: SourceFile): ts.SourceFile { return ts.createSourceFile(file.path, file.content, ts.ScriptTarget.ES2022, true, scriptKindForPath(file.path)); }
function scriptKindForPath(filePath: string): ts.ScriptKind { if (/\.tsx$/.test(filePath)) return ts.ScriptKind.TSX; if (/\.jsx$/.test(filePath)) return ts.ScriptKind.JSX; if (/\.(?:js|mjs|cjs)$/.test(filePath)) return ts.ScriptKind.JS; return ts.ScriptKind.TS; }
function isCode(filePath: string): boolean { return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(filePath); }
function isProjectFile(project: ProjectDescriptor, filePath: string): boolean { return project.rootPath === "" || filePath.startsWith(`${project.rootPath}/`); }
function relativeToProject(rootPath: string, filePath: string): string { return rootPath === "" ? filePath : filePath.slice(rootPath.length + 1); }
function joinRoute(base: string, part: string): string { const cleaned = [base, part].flatMap((value) => value.split("/")).filter(Boolean); return `/${cleaned.join("/")}`.replace(/\/$/, "") || "/"; }
function nextRoutePath(value: string): string { return joinRoute("", value.split("/").filter((segment) => !/^\(.+\)$/.test(segment) && !segment.startsWith("@")).map(routeSegment).join("/")); }
function remixRoutePath(value: string): string { const withoutIndex = value.replace(/(?:^|\.)_index$/, ""); return joinRoute("", withoutIndex.split(".").filter(Boolean).map((segment) => segment.startsWith("$") ? `:${segment.slice(1)}` : segment).join("/")); }
function routeSegment(value: string): string { if (/^\[\.\.\.(.+)\]$/.test(value)) return `:${RegExp.$1}*`; if (/^\[(.+)\]$/.test(value)) return `:${RegExp.$1}`; return value; }
function dedupeEntrypoints(values: GraphEntrypoint[]): GraphEntrypoint[] { const seen = new Map<string, GraphEntrypoint>(); for (const value of values) seen.set([value.projectRoot, value.kind, value.httpMethod ?? "", value.routePath].join("\u0000"), value); return [...seen.values()].sort((left, right) => left.projectRoot.localeCompare(right.projectRoot) || left.routePath.localeCompare(right.routePath) || (left.httpMethod ?? "").localeCompare(right.httpMethod ?? "")); }
function dedupeBindings(values: GraphProtocolBinding[]): GraphProtocolBinding[] { const seen = new Map<string, GraphProtocolBinding>(); for (const value of values) seen.set([value.callerFilePath, value.handlerFilePath, value.operation].join("\u0000"), value); return [...seen.values()].sort((left, right) => left.callerFilePath.localeCompare(right.callerFilePath) || left.operation.localeCompare(right.operation)); }
const httpMethods = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

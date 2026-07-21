import path from "node:path";
import * as ts from "typescript";

import type { RepositoryReader, SourceFile } from "../graph/types.js";
import type { ImpactAssessment, ImpactAssessmentItem, ImpactAssessmentSupportingPath } from "../impact/impact-assessment.js";
import type { DeterministicPrAnalysis } from "../impact/pr-impact-types.js";
import { log } from "../server/logger.js";
import { targetIdFor } from "./templates.js";
import type { ChangedHunk, PrSemanticInput, SemanticAnchorKind, SemanticEntrypointTarget, SourceContextItem, SourceReference, SourceRevision } from "./report-types.js";

const maxTargetAnchors = 8;
const maxAnchorCharacters = 1_600;
const maxTargetCharacters = 9_000;
const hunkContextLines = 3;

type SourceIdentity = { repoId: number; installationId: number; owner: string; name: string; branch: string };
type UnidentifiedHunk = Omit<ChangedHunk, "id">;
export interface SemanticContextRepositoryConfig {
  repoId: number;
  installationId: number;
  owner: string | null;
  name: string | null;
  trackedBranch: string;
  aiAssistanceEnabled: boolean;
}

/**
 * Builds the only source packet allowed to leave the repository for a PR.
 * It uses exact base/head blobs and does not persist branch-level AI state.
 */
export async function buildPrSemanticContext(
  analysis: DeterministicPrAnalysis,
  assessment: ImpactAssessment,
  repositoryReader: RepositoryReader,
  options: { config?: SemanticContextRepositoryConfig | null } = {},
): Promise<PrSemanticInput> {
  // Keep diff/anchor helpers importable by pure report tests without opening a
  // database connection. Repository consent is only needed for a live build.
  const config = options.config === undefined
    ? await (await import("../storage/repo-config-repo.js")).getRepoConfig(analysis.repoId)
    : options.config;
  if (!config?.aiAssistanceEnabled || analysis.status !== "ready" || !config.owner || !config.name) return disabledInput();

  const source: SourceIdentity = { repoId: analysis.repoId, installationId: config.installationId, owner: config.owner, name: config.name, branch: config.trackedBranch };
  // Assessment items are already deterministically ranked. Every candidate
  // with enough route-and-behavior evidence is included. Request batching and
  // presentation ordering must never silently suppress a valid user scenario.
  const candidates = scenarioCandidates(assessment);
  const changed = rankChangedFiles(analysis, candidates);
  const [headFiles, baseFiles] = await Promise.all([
    repositoryReader.fetchFiles({ ...source, sha: analysis.headSha, paths: changed.filter((file) => file.status !== "removed").map((file) => file.path) }),
    repositoryReader.fetchFiles({ ...source, sha: analysis.baseSha, paths: changed.filter((file) => file.status !== "added").map((file) => file.previousPath ?? file.path) }),
  ]);
  const headByPath = new Map(headFiles.map((file) => [file.path, file]));
  const baseByPath = new Map(baseFiles.map((file) => [file.path, file]));
  const allHunks = changed.flatMap((change) => lineHunks(
    change.path,
    change.status === "removed" ? "base" : "head",
    baseByPath.get(change.previousPath ?? change.path),
    headByPath.get(change.path),
  ));
  const candidateHunks = allHunks.map((hunk, index) => ({ ...hunk, id: `candidate-hunk:${index + 1}` }));
  const tests = await findRelatedTests(repositoryReader, source, analysis, candidates);

  const targets: SemanticEntrypointTarget[] = [];
  const selectedItems: Array<ImpactAssessmentItem & { tier: "primary" | "secondary" }> = [];
  const selectedTargetIds = new Set<string>();
  for (const [index, item] of candidates.entries()) {
    const targetId = targetIdFor(item);
    if (selectedTargetIds.has(targetId)) continue;
    const targetHunks = candidateHunks.filter((hunk) => hunk.path === item.changedSeedPath);
    if (!targetHunks.length) continue;
    const paths = uniquePaths([item.path, ...item.dependencyPath.slice(0, -1).reverse(), item.changedSeedPath]).filter(isAllowedSourcePath);
    const files = await repositoryReader.fetchFiles({ ...source, sha: analysis.headSha, paths });
    const fileByPath = new Map(files.map((file) => [file.path, file]));
    for (const [filePath, file] of headByPath) if (!fileByPath.has(filePath)) fileByPath.set(filePath, file);
    const anchors = buildTargetAnchors(item, targetHunks, fileByPath, tests, index + 1);
    if (!hasScenarioGrounding(item, anchors)) continue;
    selectedItems.push(item);
    selectedTargetIds.add(targetId);
    targets.push({
      id: targetId,
      path: item.path,
      kind: item.kind,
      tier: item.tier,
      changedSeedPath: item.changedSeedPath,
      dependencyPath: item.dependencyPath,
      apiVerificationAllowed: item.kind === "page" || anchors.some((anchor) => anchor.kind === "api_contract" || anchor.kind === "test"),
      anchors,
    });
  }
  const changedHunks = selectHunks(allHunks, selectedItems).map((hunk, index) => ({ ...hunk, id: `hunk:${index + 1}` }));

  log("info", "PR verification source context prepared", {
    repoId: analysis.repoId,
    pullRequestNumber: analysis.pullRequestNumber,
    headSha: analysis.headSha,
    changedHunkCount: changedHunks.length,
    prioritizedCandidateCount: candidates.length,
    targetCount: targets.length,
    anchorCounts: countAnchorKinds(targets),
    testAnchorCount: targets.reduce((total, target) => total + target.anchors.filter((anchor) => anchor.kind === "test").length, 0),
  });
  return {
    version: 2,
    enabled: true,
    repository: { owner: config.owner, name: config.name },
    sourceReferences: sourceReferencesFromHunks(allHunks),
    changedHunks,
    targets,
  };
}

function hasScenarioGrounding(
  item: ImpactAssessmentItem & { tier: "primary" | "secondary" },
  anchors: SourceContextItem[],
): boolean {
  if (!anchors.some((anchor) => anchor.kind === "entrypoint")) return false;
  if (item.kind === "page") return anchors.some((anchor) => anchor.kind === "interaction" || anchor.kind === "state" || anchor.kind === "test");
  return anchors.some((anchor) => anchor.kind === "api_contract" || anchor.kind === "test");
}

function disabledInput(): PrSemanticInput {
  return { version: 2, enabled: false, repository: null, sourceReferences: [], changedHunks: [], targets: [] };
}

function sourceReferencesFromHunks(hunks: UnidentifiedHunk[]): SourceReference[] {
  const references = new Map<string, SourceReference>();
  for (const hunk of hunks) {
    const startLine = hunk.revision === "head" ? hunk.afterStartLine : hunk.beforeStartLine;
    const endLine = hunk.revision === "head" ? hunk.afterEndLine : hunk.beforeEndLine;
    const key = `${hunk.path}\u0000${hunk.symbolName ?? ""}`;
    if (!references.has(key)) references.set(key, { path: hunk.path, revision: hunk.revision, startLine, endLine, symbolName: hunk.symbolName });
  }
  return [...references.values()].sort((left, right) => left.path.localeCompare(right.path) || (left.symbolName ?? "").localeCompare(right.symbolName ?? ""));
}

function isScenarioCandidate(item: ImpactAssessmentItem): item is ImpactAssessmentItem & { tier: "primary" | "secondary" } {
  return item.tier === "primary" || item.tier === "secondary";
}

/**
 * Assessment deduplicates visible entrypoints at their highest tier. Preserve
 * its ranking, but expand each entrypoint into the independently proven paths
 * that may supply user-visible interaction evidence for a scenario.
 */
function scenarioCandidates(assessment: ImpactAssessment): Array<ImpactAssessmentItem & { tier: "primary" | "secondary" }> {
  return assessment.items.flatMap((item) => {
    if (!isScenarioCandidate(item)) return [];
    const supportingPaths = item.supportingPaths?.length ? item.supportingPaths : [supportingPathFromItem(item)];
    return supportingPaths
      .filter((path) => path.tier === "primary" || path.tier === "secondary")
      .map((path) => ({
        ...item,
        // Keep the entrypoint's visible tier. Its supporting path supplies
        // hunk and behavioral evidence, not a second report target.
        tier: item.tier,
        changedSeedPath: path.changedSeedPath,
        technicalRole: path.technicalRole,
        technicalRoleReason: path.technicalRoleReason,
        impact: path.impact,
        dependencyPath: path.dependencyPath,
      }));
  });
}

function supportingPathFromItem(item: ImpactAssessmentItem): ImpactAssessmentSupportingPath {
  return {
    changedSeedPath: item.changedSeedPath,
    technicalRole: item.technicalRole,
    technicalRoleReason: item.technicalRoleReason,
    tier: item.tier,
    impact: item.impact,
    dependencyPath: item.dependencyPath,
  };
}

function rankChangedFiles(analysis: DeterministicPrAnalysis, candidates: ImpactAssessmentItem[]): DeterministicPrAnalysis["changedFiles"] {
  const seedRanks = new Map<string, number>();
  for (const [index, item] of candidates.entries()) if (!seedRanks.has(item.changedSeedPath)) seedRanks.set(item.changedSeedPath, index);
  return analysis.changedFiles
    .filter((file) => file.graphRelevant && isEligibleChangedSourcePath(file.path))
    .sort((left, right) => {
      const leftRank = seedRanks.get(left.path) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = seedRanks.get(right.path) ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank || left.path.localeCompare(right.path);
    });
}

function selectHunks(allHunks: UnidentifiedHunk[], candidates: ImpactAssessmentItem[]): UnidentifiedHunk[] {
  const grouped = new Map<string, UnidentifiedHunk[]>();
  for (const hunk of allHunks) {
    const entries = grouped.get(hunk.path) ?? [];
    entries.push(hunk);
    grouped.set(hunk.path, entries);
  }
  const selected: UnidentifiedHunk[] = [];
  const used = new Set<UnidentifiedHunk>();
  for (const item of candidates) {
    const hunk = grouped.get(item.changedSeedPath)?.[0];
    if (hunk && !used.has(hunk)) {
      selected.push(hunk);
      used.add(hunk);
    }
  }
  for (const hunk of allHunks) {
    if (used.has(hunk)) continue;
    selected.push(hunk);
    used.add(hunk);
  }
  return selected;
}

/** A deterministic Myers line diff, grouped into independent review hunks. */
export function lineHunks(pathValue: string, revision: SourceRevision, before: SourceFile | undefined, after: SourceFile | undefined): UnidentifiedHunk[] {
  const beforeLines = linesOf(before?.content ?? "");
  const afterLines = linesOf(after?.content ?? "");
  const operations = myersLineDiff(beforeLines, afterLines);
  const changedIndexes = operations.flatMap((operation, index) => operation.kind === "equal" ? [] : [index]);
  if (!changedIndexes.length) return [];
  const groups: Array<{ start: number; end: number }> = [];
  for (const index of changedIndexes) {
    const previous = groups.at(-1);
    if (!previous || index - previous.end > hunkContextLines * 2 + 1) groups.push({ start: index, end: index });
    else previous.end = index;
  }
  const source = revision === "head" ? after : before;
  const parsed = source ? parseSource(source) : null;
  return groups.flatMap((group) => {
    const start = Math.max(0, group.start - hunkContextLines);
    const end = Math.min(operations.length, group.end + hunkContextLines + 1);
    const window = operations.slice(start, end);
    const beforeStartLine = countLinesBefore(operations, start, "before") + 1;
    const afterStartLine = countLinesBefore(operations, start, "after") + 1;
    const beforeExcerpt = limitExcerpt(window.filter((operation) => operation.kind !== "insert").map((operation) => operation.line).join("\n"));
    const afterExcerpt = limitExcerpt(window.filter((operation) => operation.kind !== "delete").map((operation) => operation.line).join("\n"));
    if (!beforeExcerpt && !afterExcerpt) return [];
    const beforeEndLine = beforeStartLine + Math.max(0, beforeExcerpt.split("\n").length - 1);
    const afterEndLine = afterStartLine + Math.max(0, afterExcerpt.split("\n").length - 1);
    const changedStart = revision === "head" ? countLinesBefore(operations, group.start, "after") + 1 : countLinesBefore(operations, group.start, "before") + 1;
    const changedEnd = revision === "head" ? countLinesBefore(operations, group.end + 1, "after") : countLinesBefore(operations, group.end + 1, "before");
    const symbol = parsed ? declarationAtLines(parsed, changedStart, Math.max(changedStart, changedEnd)) : null;
    return [{
      path: pathValue,
      revision,
      beforeStartLine,
      beforeEndLine,
      afterStartLine,
      afterEndLine,
      beforeExcerpt,
      afterExcerpt,
      symbolName: symbol?.name ?? null,
      symbolKind: symbol?.kind ?? null,
    }];
  });
}

type DiffOperation = { kind: "equal" | "insert" | "delete"; line: string };

function myersLineDiff(before: string[], after: string[]): DiffOperation[] {
  const max = before.length + after.length;
  const trace: Array<Map<number, number>> = [];
  let frontier = new Map<number, number>([[1, 0]]);
  for (let distance = 0; distance <= max; distance += 1) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const moveDown = diagonal === -distance || (diagonal !== distance && (frontier.get(diagonal - 1) ?? -Infinity) < (frontier.get(diagonal + 1) ?? -Infinity));
      let x = moveDown ? (frontier.get(diagonal + 1) ?? 0) : (frontier.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      frontier.set(diagonal, x);
      if (x >= before.length && y >= after.length) return backtrackMyers(trace, before, after);
    }
  }
  return [];
}

function backtrackMyers(trace: Array<Map<number, number>>, before: string[], after: string[]): DiffOperation[] {
  let x = before.length;
  let y = after.length;
  const operations: DiffOperation[] = [];
  for (let distance = trace.length - 1; distance > 0; distance -= 1) {
    // trace[d] is the frontier immediately before edit distance d. It is the
    // predecessor frontier for the current x/y position, not trace[d - 1].
    const frontier = trace[distance]!;
    const diagonal = x - y;
    const moveDown = diagonal === -distance || (diagonal !== distance && (frontier.get(diagonal - 1) ?? -Infinity) < (frontier.get(diagonal + 1) ?? -Infinity));
    const previousDiagonal = moveDown ? diagonal + 1 : diagonal - 1;
    const previousX = frontier.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      operations.push({ kind: "equal", line: before[x - 1] ?? "" });
      x -= 1;
      y -= 1;
    }
    if (x === previousX) {
      operations.push({ kind: "insert", line: after[y - 1] ?? "" });
      y -= 1;
    } else {
      operations.push({ kind: "delete", line: before[x - 1] ?? "" });
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    operations.push({ kind: "equal", line: before[x - 1] ?? "" });
    x -= 1;
    y -= 1;
  }
  while (x > 0) operations.push({ kind: "delete", line: before[--x] ?? "" });
  while (y > 0) operations.push({ kind: "insert", line: after[--y] ?? "" });
  return operations.reverse();
}

function countLinesBefore(operations: DiffOperation[], index: number, side: "before" | "after"): number {
  return operations.slice(0, index).filter((operation) => side === "before" ? operation.kind !== "insert" : operation.kind !== "delete").length;
}

function buildTargetAnchors(
  item: ImpactAssessmentItem & { tier: "primary" | "secondary" },
  hunks: ChangedHunk[],
  fileByPath: Map<string, SourceFile>,
  tests: SourceFile[],
  targetIndex: number,
): SourceContextItem[] {
  const anchors: SourceContextItem[] = [];
  const seedFile = fileByPath.get(item.changedSeedPath);
  const routeFile = fileByPath.get(item.path);
  for (const hunk of hunks) {
    const file = hunk.revision === "head" ? seedFile : undefined;
    anchors.push(anchor({
      kind: "changed_declaration",
      path: hunk.path,
      revision: hunk.revision,
      blobSha: file?.blobSha ?? "",
      startLine: hunk.revision === "head" ? hunk.afterStartLine : hunk.beforeStartLine,
      endLine: hunk.revision === "head" ? hunk.afterEndLine : hunk.beforeEndLine,
      label: hunk.symbolName ? `Changed ${humanizeIdentifier(hunk.symbolName)}` : `Changed ${humanizePath(hunk.path)}`,
      excerpt: hunk.revision === "head" ? hunk.afterExcerpt : hunk.beforeExcerpt,
    }, targetIndex, anchors.length));
  }
  if (routeFile) {
    const source = parseSource(routeFile);
    const entrypoint = routeEntrypointAnchor(source, routeFile, targetIndex, anchors.length);
    if (entrypoint) anchors.push(entrypoint);
    anchors.push(...behaviorAnchors(source, routeFile, targetIndex, anchors.length + anchors.length));
  }
  if (seedFile && seedFile.path !== routeFile?.path) {
    anchors.push(...behaviorAnchors(parseSource(seedFile), seedFile, targetIndex, anchors.length + anchors.length));
  }
  for (let index = 1; index < item.dependencyPath.length; index += 1) {
    const consumer = fileByPath.get(item.dependencyPath[index] ?? "");
    const dependency = item.dependencyPath[index - 1] ?? "";
    if (!consumer) continue;
    const dependencyUse = dependencyUseAnchor(parseSource(consumer), consumer, dependency, targetIndex, anchors.length);
    if (dependencyUse) anchors.push(dependencyUse);
  }
  anchors.push(...testAnchors(tests, item, targetIndex, anchors.length));
  return trimAnchors(anchors, maxTargetCharacters);
}

function anchor(input: Omit<SourceContextItem, "id">, targetIndex: number, index: number): SourceContextItem {
  return { ...input, id: `anchor:${targetIndex}:${index + 1}`, excerpt: limitExcerpt(input.excerpt) };
}

function routeEntrypointAnchor(source: ts.SourceFile, file: SourceFile, targetIndex: number, index: number): SourceContextItem | null {
  const statement = source.statements.find((candidate) => ts.isFunctionDeclaration(candidate) || ts.isClassDeclaration(candidate) || ts.isVariableStatement(candidate) || ts.isExportAssignment(candidate));
  if (!statement) return null;
  return nodeAnchor("entrypoint", "Route entrypoint", source, statement, file, targetIndex, index);
}

function dependencyUseAnchor(source: ts.SourceFile, file: SourceFile, dependencyPath: string, targetIndex: number, index: number): SourceContextItem | null {
  const dependencyNames = importPathHints(dependencyPath);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text.toLowerCase();
    if (!dependencyNames.some((name) => specifier.includes(name))) continue;
    return nodeAnchor("dependency_use", `Dependency import for ${humanizePath(dependencyPath)}`, source, statement, file, targetIndex, index);
  }
  return null;
}

function behaviorAnchors(source: ts.SourceFile, file: SourceFile, targetIndex: number, startIndex: number): SourceContextItem[] {
  const found: SourceContextItem[] = [];
  const add = (kind: Extract<SemanticAnchorKind, "interaction" | "state" | "api_contract">, label: string, node: ts.Node): void => {
    if (found.length >= 4) return;
    const candidate = nodeAnchor(kind, label, source, node, file, targetIndex, startIndex + found.length);
    if (candidate) found.push(candidate);
  };
  const visit = (node: ts.Node): void => {
    if (found.length >= 4) return;
    if (ts.isJsxElement(node) && isInteractiveJsxTag(node.openingElement.tagName.getText(source))) {
      const text = visibleJsxText(node, source);
      add("interaction", text ? `Interactive control “${text}”` : "Interactive control", node);
      return;
    }
    if (ts.isJsxSelfClosingElement(node) && isInteractiveJsxTag(node.tagName.getText(source))) {
      const label = jsxAttributeValue(node, source, "aria-label") ?? jsxAttributeValue(node, source, "title");
      add("interaction", label ? `Interactive control “${label}”` : "Interactive control", node);
      return;
    }
    if (ts.isConditionalExpression(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)) {
      add("state", "Conditional user-visible state", node);
      return;
    }
    if (ts.isCallExpression(node)) {
      const name = calledName(node.expression);
      if (/^(?:open|close|submit|save|create|delete|redirect|push|replace|review)/i.test(name)) add("interaction", `User action ${humanizeIdentifier(name)}`, node);
      return;
    }
    if (ts.isReturnStatement(node) && /(?:Response|NextResponse)\.(?:json|redirect)|new Response/.test(node.getText(source))) {
      add("api_contract", "API response behavior", node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function nodeAnchor(kind: SemanticAnchorKind, label: string, source: ts.SourceFile, node: ts.Node, file: SourceFile, targetIndex: number, index: number): SourceContextItem | null {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const end = source.getLineAndCharacterOfPosition(node.getEnd());
  const excerpt = node.getText(source);
  if (!excerpt.trim()) return null;
  return anchor({ kind, path: file.path, revision: "head", blobSha: file.blobSha, startLine: start.line + 1, endLine: end.line + 1, label, excerpt }, targetIndex, index);
}

function testAnchors(tests: SourceFile[], item: ImpactAssessmentItem, targetIndex: number, startIndex: number): SourceContextItem[] {
  const hints = importPathHints(item.changedSeedPath).concat(importPathHints(item.path));
  const result: SourceContextItem[] = [];
  for (const file of tests) {
    if (result.length >= 2 || !hints.some((hint) => file.content.toLowerCase().includes(hint))) continue;
    const source = parseSource(file);
    const strings: ts.StringLiteral[] = [];
    const visit = (node: ts.Node): void => {
      if (strings.length >= 2) return;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^(?:it|test|describe)$/.test(node.expression.text) && ts.isStringLiteral(node.arguments[0])) strings.push(node.arguments[0]);
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const literal of strings) {
      const candidate = nodeAnchor("test", `Tested behavior “${literal.text}”`, source, literal.parent, file, targetIndex, startIndex + result.length);
      if (candidate) result.push(candidate);
    }
  }
  return result;
}

async function findRelatedTests(
  repositoryReader: RepositoryReader,
  source: SourceIdentity,
  analysis: DeterministicPrAnalysis,
  candidates: ImpactAssessmentItem[],
): Promise<SourceFile[]> {
  let tree: Awaited<ReturnType<RepositoryReader["fetchTree"]>>;
  try {
    tree = await repositoryReader.fetchTree({ ...source, sha: analysis.headSha });
  } catch {
    return [];
  }
  const hints = candidates.flatMap((item) => importPathHints(item.changedSeedPath).concat(importPathHints(item.path)));
  const paths = tree.map((entry) => entry.path)
    .filter((filePath) => isTestPath(filePath) && hints.some((hint) => filePath.toLowerCase().includes(hint)))
    .slice(0, 8);
  if (!paths.length) return [];
  return repositoryReader.fetchFiles({ ...source, sha: analysis.headSha, paths });
}

function trimAnchors(anchors: SourceContextItem[], budget: number): SourceContextItem[] {
  const result: SourceContextItem[] = [];
  const seen = new Set<string>();
  let remaining = budget;
  const priority: Record<SemanticAnchorKind, number> = { changed_declaration: 0, entrypoint: 1, interaction: 2, state: 3, api_contract: 3, dependency_use: 4, test: 5 };
  for (const item of [...anchors].sort((left, right) => priority[left.kind] - priority[right.kind] || left.path.localeCompare(right.path) || left.startLine - right.startLine)) {
    const key = [item.kind, item.path, item.startLine, item.endLine].join("\u0000");
    if (seen.has(key) || result.length >= maxTargetAnchors || remaining <= 0) continue;
    const excerpt = item.excerpt.slice(0, Math.min(maxAnchorCharacters, remaining));
    if (!excerpt.trim()) continue;
    result.push({ ...item, excerpt });
    remaining -= excerpt.length;
    seen.add(key);
  }
  return result;
}

function declarationAtLines(source: ts.SourceFile, startLine: number, endLine: number): { name: string; kind: ChangedHunk["symbolKind"] } | null {
  let selected: { name: string; kind: NonNullable<ChangedHunk["symbolKind"]>; span: number } | null = null;
  const visit = (node: ts.Node): void => {
    const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    if (start > endLine || end < startLine) return;
    const candidate = declarationName(node);
    if (candidate) {
      const span = end - start;
      if (!selected || span < selected.span) selected = { ...candidate, span };
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const match = selected as { name: string; kind: NonNullable<ChangedHunk["symbolKind"]>; span: number } | null;
  return match ? { name: match.name, kind: match.kind } : null;
}

function declarationName(node: ts.Node): { name: string; kind: NonNullable<ChangedHunk["symbolKind"]> } | null {
  if (ts.isFunctionDeclaration(node) && node.name) return { name: node.name.text, kind: "function" };
  if (ts.isClassDeclaration(node) && node.name) return { name: node.name.text, kind: "class" };
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const value = node.initializer;
    return { name: node.name.text, kind: value && /^[A-Z]/.test(node.name.text) && (ts.isArrowFunction(value) || ts.isCallExpression(value)) ? "component" : "variable" };
  }
  return null;
}

function parseSource(file: SourceFile): ts.SourceFile {
  return ts.createSourceFile(file.path, file.content, ts.ScriptTarget.ES2022, true, scriptKindForPath(file.path));
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/.test(filePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isInteractiveJsxTag(tag: string): boolean { return /^(?:button|a|input|select|textarea|form|Button|Link|Dialog|Sheet|Popover|DropdownMenu)$/.test(tag); }
function visibleJsxText(node: ts.JsxElement, source: ts.SourceFile): string | null {
  const text = node.children.filter(ts.isJsxText).map((child) => child.getText(source).replace(/\s+/g, " ").trim()).find(Boolean);
  return text ? text.slice(0, 100) : null;
}
function jsxAttributeValue(node: ts.JsxSelfClosingElement, source: ts.SourceFile, name: string): string | null {
  const attribute = node.attributes.properties.find((property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText(source) === name);
  return attribute?.initializer && ts.isStringLiteral(attribute.initializer) ? attribute.initializer.text : null;
}
function calledName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return "";
}
function importPathHints(filePath: string): string[] {
  const normalized = filePath.toLowerCase().replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
  const parts = normalized.split("/").filter((part) => part && part !== "src" && part !== "index");
  return [...new Set([parts.at(-1), parts.at(-2)].filter((part): part is string => Boolean(part && part.length > 2)))];
}
function humanizeIdentifier(value: string): string { return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function humanizePath(value: string): string { return humanizeIdentifier(path.posix.basename(value).replace(/\.[^.]+$/, "")); }
function uniquePaths(paths: string[]): string[] { return [...new Set(paths)]; }
function linesOf(content: string): string[] { return content ? content.split("\n") : []; }
function limitExcerpt(value: string): string { return value.slice(0, maxAnchorCharacters); }
function isTestPath(value: string): boolean { return /(?:^|\/)(?:__tests__|tests?|e2e|cypress|playwright|stories)(?:\/|$)|\.(?:test|spec|stories)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(value); }
function isEligibleChangedSourcePath(value: string): boolean { return isAllowedSourcePath(value) && !isTestPath(value); }

/** Source exclusion is a privacy boundary, not a graph classification rule. */
export function isAllowedSourcePath(pathValue: string): boolean {
  const value = pathValue.toLowerCase();
  if (/(^|\/)(?:\.env|env)(?:\.|\/|$)/.test(value)) return false;
  if (/(?:lock\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(value)) return false;
  if (/(^|\/)(?:node_modules|dist|build|\.next|generated)(?:\/|$)/.test(value)) return false;
  if (/(^|\/)(?:scripts|drizzle|config|server|db|database|migrations?|infra(?:structure)?|adapters?|providers?)(?:\/|$)/.test(value)) return false;
  if (/(?:^|\/)(?:next|tailwind|postcss|eslint|prettier|vite|vitest)\.config\./.test(value)) return false;
  return /\.(?:ts|tsx|js|jsx|mjs|cjs|css|scss|sass|less)$/.test(value);
}

function countAnchorKinds(targets: SemanticEntrypointTarget[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const target of targets) for (const anchor of target.anchors) counts[anchor.kind] = (counts[anchor.kind] ?? 0) + 1;
  return counts;
}

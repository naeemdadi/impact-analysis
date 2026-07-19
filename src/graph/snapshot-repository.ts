import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../storage/db.js";
import {
  graphEntrypointTable,
  graphFileTable,
  graphImportTable,
  graphProjectTable,
  graphProtocolBindingTable,
  graphSnapshotTable,
  graphSymbolTable,
} from "../storage/schema.js";
import type { BaselineBuildResult, BaselineGraph, GraphFile, GraphImport, GraphProject } from "./types.js";

export interface SnapshotBuildMetadata {
  buildMode: "full" | "incremental" | "full_fallback";
  baseSnapshotId?: string | null;
  changedFileCount?: number;
  reanalyzedFileCount?: number;
  fallbackReason?: string | null;
}

export async function createBuildingSnapshot(input: { repoId: number; branch: string; sha: string; metadata?: SnapshotBuildMetadata }): Promise<string> {
  const existing = await db.select({ id: graphSnapshotTable.id, status: graphSnapshotTable.status, isCurrent: graphSnapshotTable.isCurrent })
    .from(graphSnapshotTable)
    .where(and(eq(graphSnapshotTable.repoId, input.repoId), eq(graphSnapshotTable.branch, input.branch), eq(graphSnapshotTable.commitSha, input.sha)))
    .limit(1);
  if (existing.length > 0) {
    if (existing[0].status === "ready" && existing[0].isCurrent) throw new Error(`current graph snapshot already exists for repo ${input.repoId}, branch ${input.branch}, SHA ${input.sha}`);
    await db.update(graphSnapshotTable).set(buildSnapshotFields(input.metadata)).where(eq(graphSnapshotTable.id, existing[0].id));
    return existing[0].id;
  }
  const rows = await db.insert(graphSnapshotTable).values({ repoId: input.repoId, branch: input.branch, commitSha: input.sha, ...buildSnapshotFields(input.metadata) }).returning({ id: graphSnapshotTable.id });
  return rows[0].id;
}

/** Only current mutable facts can be reused as exact evidence. */
export async function findReadySnapshotByIdentity(input: { repoId: number; branch: string; sha: string }): Promise<BaselineBuildResult | null> {
  const rows = await db.select(snapshotResultFields).from(graphSnapshotTable).where(and(
    eq(graphSnapshotTable.repoId, input.repoId), eq(graphSnapshotTable.branch, input.branch), eq(graphSnapshotTable.commitSha, input.sha),
    eq(graphSnapshotTable.status, "ready"), eq(graphSnapshotTable.isCurrent, true),
  )).limit(1);
  return rows.length === 0 ? null : toBuildResult(rows[0]);
}

/** Atomically replaces the one materialized repository graph at a branch SHA. */
export async function persistReadySnapshot(input: {
  snapshotId: string;
  repoId: number;
  branch: string;
  sha: string;
  graph: BaselineGraph;
  buildDurationMs: number;
  metadata?: SnapshotBuildMetadata;
}): Promise<BaselineBuildResult> {
  const graph = normalizedGraph(input.graph);
  const unresolvedImportCount = graph.imports.filter((entry) => entry.resolutionStatus === "unresolved").length;
  await db.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.repoId}:${input.branch}`}))`);
    const current = await transaction.select({ id: graphSnapshotTable.id }).from(graphSnapshotTable).where(and(
      eq(graphSnapshotTable.repoId, input.repoId), eq(graphSnapshotTable.branch, input.branch), eq(graphSnapshotTable.isCurrent, true),
    )).limit(1).for("update");

    if (current.length > 0) {
      // Move current mutable rows to the incoming identity before replacement.
      await transaction.update(graphProtocolBindingTable).set({ snapshotId: input.snapshotId }).where(eq(graphProtocolBindingTable.snapshotId, current[0].id));
      await transaction.update(graphEntrypointTable).set({ snapshotId: input.snapshotId }).where(eq(graphEntrypointTable.snapshotId, current[0].id));
      await transaction.update(graphImportTable).set({ snapshotId: input.snapshotId }).where(eq(graphImportTable.snapshotId, current[0].id));
      await transaction.update(graphSymbolTable).set({ snapshotId: input.snapshotId }).where(eq(graphSymbolTable.snapshotId, current[0].id));
      await transaction.update(graphFileTable).set({ snapshotId: input.snapshotId }).where(eq(graphFileTable.snapshotId, current[0].id));
    } else {
      const branchSnapshots = await transaction.select({ id: graphSnapshotTable.id }).from(graphSnapshotTable).where(and(eq(graphSnapshotTable.repoId, input.repoId), eq(graphSnapshotTable.branch, input.branch)));
      const snapshotIds = branchSnapshots.map((snapshot) => snapshot.id);
      if (snapshotIds.length > 0) {
        await transaction.delete(graphProtocolBindingTable).where(inArray(graphProtocolBindingTable.snapshotId, snapshotIds));
        await transaction.delete(graphEntrypointTable).where(inArray(graphEntrypointTable.snapshotId, snapshotIds));
        await transaction.delete(graphImportTable).where(inArray(graphImportTable.snapshotId, snapshotIds));
        await transaction.delete(graphSymbolTable).where(inArray(graphSymbolTable.snapshotId, snapshotIds));
        await transaction.delete(graphFileTable).where(inArray(graphFileTable.snapshotId, snapshotIds));
      }
    }

    const projectsByRoot = await upsertProjects(transaction, input.repoId, graph.projects);
    // These facts have no stable standalone identity; replace them each build.
    await transaction.delete(graphProtocolBindingTable).where(eq(graphProtocolBindingTable.snapshotId, input.snapshotId));
    await transaction.delete(graphEntrypointTable).where(eq(graphEntrypointTable.snapshotId, input.snapshotId));
    await transaction.delete(graphImportTable).where(eq(graphImportTable.snapshotId, input.snapshotId));

    const filesByPath = new Map<string, number>();
    for (const file of graph.files) {
      const projectId = projectsByRoot.get(file.projectRoot);
      if (!projectId) throw new Error(`graph file ${file.path} has no discovered project ${file.projectRoot}`);
      const rows = await transaction.insert(graphFileTable).values({
        snapshotId: input.snapshotId, projectId, path: file.path, blobSha: file.blobSha, kind: file.kind,
        classificationReason: file.classificationReason, technicalRole: file.technicalRole,
        technicalRoleReason: file.technicalRoleReason, technicalRoleStrength: file.technicalRoleStrength,
      }).onConflictDoUpdate({
        target: [graphFileTable.snapshotId, graphFileTable.path],
        set: { projectId, blobSha: file.blobSha, kind: file.kind, classificationReason: file.classificationReason, technicalRole: file.technicalRole, technicalRoleReason: file.technicalRoleReason, technicalRoleStrength: file.technicalRoleStrength },
      }).returning({ id: graphFileTable.id });
      filesByPath.set(file.path, rows[0].id);
    }

    const targetSymbolKeys = new Set(graph.symbols.map((symbol) => symbol.symbolKey));
    const existingSymbols = await transaction.select({ id: graphSymbolTable.id, symbolKey: graphSymbolTable.symbolKey }).from(graphSymbolTable).where(eq(graphSymbolTable.snapshotId, input.snapshotId));
    const obsoleteSymbolIds = existingSymbols.filter((symbol) => !targetSymbolKeys.has(symbol.symbolKey)).map((symbol) => symbol.id);
    if (obsoleteSymbolIds.length > 0) await transaction.delete(graphSymbolTable).where(inArray(graphSymbolTable.id, obsoleteSymbolIds));
    for (const symbol of graph.symbols) {
      const fileId = filesByPath.get(symbol.filePath);
      if (!fileId) throw new Error(`graph symbol ${symbol.symbolKey} refers to missing file ${symbol.filePath}`);
      await transaction.insert(graphSymbolTable).values({ snapshotId: input.snapshotId, fileId, ...symbol }).onConflictDoUpdate({
        target: [graphSymbolTable.snapshotId, graphSymbolTable.symbolKey],
        set: { fileId, name: symbol.name, kind: symbol.kind, isExported: symbol.isExported, startLine: symbol.startLine, startColumn: symbol.startColumn, endLine: symbol.endLine, endColumn: symbol.endColumn, sourceHash: symbol.sourceHash },
      });
    }

    const staleFiles = await transaction.select({ id: graphFileTable.id, path: graphFileTable.path }).from(graphFileTable).where(eq(graphFileTable.snapshotId, input.snapshotId));
    const obsoleteFileIds = staleFiles.filter((file) => !filesByPath.has(file.path)).map((file) => file.id);
    if (obsoleteFileIds.length > 0) await transaction.delete(graphFileTable).where(inArray(graphFileTable.id, obsoleteFileIds));

    for (const edge of graph.imports) {
      const fromFileId = filesByPath.get(edge.fromPath);
      const toFileId = edge.toPath ? filesByPath.get(edge.toPath) : null;
      if (!fromFileId) throw new Error(`graph import ${edge.specifier} refers to missing importer ${edge.fromPath}`);
      if (edge.resolutionStatus === "resolved" && !toFileId) throw new Error(`resolved graph import ${edge.specifier} refers to missing target ${edge.toPath}`);
      await transaction.insert(graphImportTable).values({ snapshotId: input.snapshotId, fromFileId, toFileId: toFileId ?? null, specifier: edge.specifier, kind: edge.kind, resolutionStatus: edge.resolutionStatus, unresolvedReason: edge.unresolvedReason });
    }
    for (const entrypoint of graph.entrypoints) {
      const fileId = filesByPath.get(entrypoint.filePath);
      const projectId = projectsByRoot.get(entrypoint.projectRoot);
      if (!fileId || !projectId) continue;
      await transaction.insert(graphEntrypointTable).values({ snapshotId: input.snapshotId, projectId, fileId, kind: entrypoint.kind, routePath: entrypoint.routePath, httpMethod: entrypoint.httpMethod, startLine: entrypoint.startLine, startColumn: entrypoint.startColumn, reason: entrypoint.reason });
    }
    for (const binding of graph.protocolBindings) {
      const callerFileId = filesByPath.get(binding.callerFilePath);
      const handlerFileId = filesByPath.get(binding.handlerFilePath);
      if (!callerFileId || !handlerFileId) continue;
      await transaction.insert(graphProtocolBindingTable).values({ snapshotId: input.snapshotId, protocol: binding.protocol, callerFileId, handlerFileId, operation: binding.operation, startLine: binding.startLine, startColumn: binding.startColumn, reason: binding.reason });
    }

    await transaction.update(graphSnapshotTable).set({ isCurrent: false }).where(and(eq(graphSnapshotTable.repoId, input.repoId), eq(graphSnapshotTable.branch, input.branch), eq(graphSnapshotTable.isCurrent, true)));
    await transaction.update(graphSnapshotTable).set({
      status: "ready", isCurrent: true, projectCount: graph.projects.length, entrypointCount: graph.entrypoints.length, protocolBindingCount: graph.protocolBindings.length,
      fileCount: graph.files.length, symbolCount: graph.symbols.length, importCount: graph.imports.length, unresolvedImportCount,
      buildDurationMs: input.buildDurationMs, completedAt: new Date(),
    }).where(eq(graphSnapshotTable.id, input.snapshotId));
  });
  return {
    snapshotId: input.snapshotId, repoId: input.repoId, branch: input.branch, sha: input.sha, status: "ready",
    projectCount: graph.projects.length, entrypointCount: graph.entrypoints.length, protocolBindingCount: graph.protocolBindings.length,
    fileCount: graph.files.length, symbolCount: graph.symbols.length, importCount: graph.imports.length, unresolvedImportCount,
    buildDurationMs: input.buildDurationMs, buildMode: input.metadata?.buildMode ?? "full", baseSnapshotId: input.metadata?.baseSnapshotId ?? null,
    changedFileCount: input.metadata?.changedFileCount ?? 0, reanalyzedFileCount: input.metadata?.reanalyzedFileCount ?? 0, fallbackReason: input.metadata?.fallbackReason ?? null,
  };
}

async function upsertProjects(transaction: Parameters<Parameters<typeof db.transaction>[0]>[0], repoId: number, projects: GraphProject[]): Promise<Map<string, number>> {
  const activeRoots = new Set(projects.map((project) => project.rootPath));
  const existing = await transaction.select({ id: graphProjectTable.id, rootPath: graphProjectTable.rootPath }).from(graphProjectTable).where(eq(graphProjectTable.repoId, repoId));
  const obsolete = existing.filter((project) => !activeRoots.has(project.rootPath)).map((project) => project.id);
  if (obsolete.length > 0) await transaction.update(graphProjectTable).set({ isActive: false, updatedAt: new Date() }).where(inArray(graphProjectTable.id, obsolete));
  const values = new Map<string, number>();
  for (const project of projects) {
    const rows = await transaction.insert(graphProjectTable).values({
      repoId, rootPath: project.rootPath, packageName: project.packageName, packageType: project.packageType, configPath: project.configPath,
      primaryFramework: project.primaryFramework, protocolProfiles: project.protocolProfiles, status: project.status, reason: project.reason, isActive: true, updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [graphProjectTable.repoId, graphProjectTable.rootPath],
      set: { packageName: project.packageName, packageType: project.packageType, configPath: project.configPath, primaryFramework: project.primaryFramework, protocolProfiles: project.protocolProfiles, status: project.status, reason: project.reason, isActive: true, updatedAt: new Date() },
    }).returning({ id: graphProjectTable.id });
    values.set(project.rootPath, rows[0].id);
  }
  return values;
}

/** Historical snapshots are metadata-only; only current facts are loadable. */
export async function loadReadyGraphByIdentity(input: { repoId: number; branch: string; sha: string }): Promise<{ snapshotId: string; graph: BaselineGraph } | null> {
  const snapshot = await findReadySnapshotByIdentity(input);
  if (!snapshot) return null;
  const projects = await db.select().from(graphProjectTable).where(and(eq(graphProjectTable.repoId, input.repoId), eq(graphProjectTable.isActive, true)));
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const files = await db.select().from(graphFileTable).where(eq(graphFileTable.snapshotId, snapshot.snapshotId));
  const filesById = new Map(files.map((file) => [file.id, file]));
  const pathsById = new Map(files.map((file) => [file.id, file.path]));
  const symbols = await db.select().from(graphSymbolTable).where(eq(graphSymbolTable.snapshotId, snapshot.snapshotId));
  const imports = await db.select().from(graphImportTable).where(eq(graphImportTable.snapshotId, snapshot.snapshotId));
  const entrypoints = await db.select().from(graphEntrypointTable).where(eq(graphEntrypointTable.snapshotId, snapshot.snapshotId));
  const bindings = await db.select().from(graphProtocolBindingTable).where(eq(graphProtocolBindingTable.snapshotId, snapshot.snapshotId));
  return {
    snapshotId: snapshot.snapshotId,
    graph: {
      projects: projects.map((project) => ({ rootPath: project.rootPath, packageName: project.packageName, packageType: project.packageType as GraphProject["packageType"], configPath: project.configPath, primaryFramework: project.primaryFramework as GraphProject["primaryFramework"], protocolProfiles: project.protocolProfiles as GraphProject["protocolProfiles"], status: project.status as GraphProject["status"], reason: project.reason })),
      files: files.flatMap((file) => {
        const project = projectsById.get(file.projectId);
        return project ? [{ path: file.path, projectRoot: project.rootPath, blobSha: file.blobSha, kind: file.kind as GraphFile["kind"], classificationReason: file.classificationReason, technicalRole: file.technicalRole as GraphFile["technicalRole"], technicalRoleReason: file.technicalRoleReason, technicalRoleStrength: file.technicalRoleStrength as GraphFile["technicalRoleStrength"] }] : [];
      }),
      symbols: symbols.map((symbol) => ({ filePath: pathsById.get(symbol.fileId)!, symbolKey: symbol.symbolKey, name: symbol.name, kind: symbol.kind as BaselineGraph["symbols"][number]["kind"], isExported: symbol.isExported, startLine: symbol.startLine, startColumn: symbol.startColumn, endLine: symbol.endLine, endColumn: symbol.endColumn, sourceHash: symbol.sourceHash })),
      imports: imports.map((edge) => ({ fromPath: pathsById.get(edge.fromFileId)!, toPath: edge.toFileId ? pathsById.get(edge.toFileId)! : null, specifier: edge.specifier, kind: edge.kind as GraphImport["kind"], resolutionStatus: edge.resolutionStatus as GraphImport["resolutionStatus"], unresolvedReason: edge.unresolvedReason })),
      entrypoints: entrypoints.flatMap((value) => {
        const project = projectsById.get(value.projectId); const file = filesById.get(value.fileId);
        return project && file ? [{ projectRoot: project.rootPath, filePath: file.path, kind: value.kind as NonNullable<BaselineGraph["entrypoints"]>[number]["kind"], routePath: value.routePath, httpMethod: value.httpMethod, startLine: value.startLine, startColumn: value.startColumn, reason: value.reason }] : [];
      }),
      protocolBindings: bindings.flatMap((value) => {
        const caller = pathsById.get(value.callerFileId); const handler = pathsById.get(value.handlerFileId);
        return caller && handler ? [{ protocol: value.protocol as "trpc", callerFilePath: caller, handlerFilePath: handler, operation: value.operation, startLine: value.startLine, startColumn: value.startColumn, reason: value.reason }] : [];
      }),
    },
  };
}

export async function getCurrentSnapshotSha(repoId: number, branch: string): Promise<string | null> {
  const rows = await db.select({ sha: graphSnapshotTable.commitSha }).from(graphSnapshotTable).where(and(eq(graphSnapshotTable.repoId, repoId), eq(graphSnapshotTable.branch, branch), eq(graphSnapshotTable.status, "ready"), eq(graphSnapshotTable.isCurrent, true))).limit(1);
  return rows[0]?.sha ?? null;
}
export async function markSnapshotFailed(snapshotId: string, reason: string, buildDurationMs: number): Promise<void> { await db.update(graphSnapshotTable).set({ status: "failed", isCurrent: false, failureReason: reason, buildDurationMs, completedAt: new Date() }).where(eq(graphSnapshotTable.id, snapshotId)); }
export async function markSnapshotUnsupported(snapshotId: string, reason: string, buildDurationMs: number): Promise<void> { await db.update(graphSnapshotTable).set({ status: "unsupported", isCurrent: false, failureReason: reason, buildDurationMs, completedAt: new Date() }).where(eq(graphSnapshotTable.id, snapshotId)); }

const snapshotResultFields = {
  snapshotId: graphSnapshotTable.id, repoId: graphSnapshotTable.repoId, branch: graphSnapshotTable.branch, sha: graphSnapshotTable.commitSha,
  projectCount: graphSnapshotTable.projectCount, entrypointCount: graphSnapshotTable.entrypointCount, protocolBindingCount: graphSnapshotTable.protocolBindingCount,
  fileCount: graphSnapshotTable.fileCount, symbolCount: graphSnapshotTable.symbolCount, importCount: graphSnapshotTable.importCount, unresolvedImportCount: graphSnapshotTable.unresolvedImportCount,
  buildDurationMs: graphSnapshotTable.buildDurationMs, buildMode: graphSnapshotTable.buildMode, baseSnapshotId: graphSnapshotTable.baseSnapshotId,
  changedFileCount: graphSnapshotTable.changedFileCount, reanalyzedFileCount: graphSnapshotTable.reanalyzedFileCount, fallbackReason: graphSnapshotTable.fallbackReason,
};
function buildSnapshotFields(metadata: SnapshotBuildMetadata | undefined) { return { status: "building", isCurrent: false, failureReason: null, completedAt: null, buildDurationMs: null, buildMode: metadata?.buildMode ?? "full", baseSnapshotId: metadata?.baseSnapshotId ?? null, changedFileCount: metadata?.changedFileCount ?? 0, reanalyzedFileCount: metadata?.reanalyzedFileCount ?? 0, fallbackReason: metadata?.fallbackReason ?? null }; }
type SnapshotResultRow = typeof snapshotResultFields extends Record<string, infer _> ? {
  snapshotId: string; repoId: number; branch: string; sha: string; projectCount: number; entrypointCount: number; protocolBindingCount: number; fileCount: number; symbolCount: number; importCount: number; unresolvedImportCount: number; buildDurationMs: number | null; buildMode: string; baseSnapshotId: string | null; changedFileCount: number; reanalyzedFileCount: number; fallbackReason: string | null;
} : never;
function toBuildResult(row: SnapshotResultRow): BaselineBuildResult { return { ...row, status: "ready", buildDurationMs: row.buildDurationMs ?? 0, buildMode: row.buildMode as BaselineBuildResult["buildMode"] }; }

function normalizedGraph(graph: BaselineGraph): BaselineGraph & { projects: GraphProject[]; entrypoints: NonNullable<BaselineGraph["entrypoints"]>; protocolBindings: NonNullable<BaselineGraph["protocolBindings"]>; files: Array<GraphFile & { projectRoot: string }> } {
  const projects = graph.projects ?? [{ rootPath: "", packageName: null, packageType: "unspecified", configPath: null, primaryFramework: "generic", protocolProfiles: [], status: "graph_only", reason: "legacy graph fixture without project discovery" }];
  return {
    ...graph,
    projects,
    files: graph.files.map((file) => ({ ...file, projectRoot: file.projectRoot ?? "" })),
    entrypoints: graph.entrypoints ?? [],
    protocolBindings: graph.protocolBindings ?? [],
  };
}

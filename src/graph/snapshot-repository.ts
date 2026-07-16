import { and, eq } from "drizzle-orm";

import { db } from "../storage/db.js";
import { graphFileTable, graphImportTable, graphSnapshotTable, graphSymbolTable } from "../storage/schema.js";
import { CURRENT_GRAPH_SCHEMA_VERSION, type BaselineGraph, type BaselineBuildResult } from "./types.js";

export interface SnapshotBuildMetadata {
  buildMode: "full" | "incremental" | "full_fallback";
  baseSnapshotId?: string | null;
  changedFileCount?: number;
  reanalyzedFileCount?: number;
  fallbackReason?: string | null;
}

export async function createBuildingSnapshot(input: {
  repoId: number;
  branch: string;
  sha: string;
  metadata?: SnapshotBuildMetadata;
}): Promise<string> {
  const existing = await db
    .select({ id: graphSnapshotTable.id, status: graphSnapshotTable.status })
    .from(graphSnapshotTable)
    .where(
      and(
        eq(graphSnapshotTable.repoId, input.repoId),
        eq(graphSnapshotTable.branch, input.branch),
        eq(graphSnapshotTable.commitSha, input.sha),
        eq(graphSnapshotTable.graphSchemaVersion, CURRENT_GRAPH_SCHEMA_VERSION),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    if (existing[0].status !== "failed") {
      throw new Error(`baseline snapshot already exists for repo ${input.repoId}, branch ${input.branch}, SHA ${input.sha}`);
    }
    // Failed snapshots contain no trustworthy graph. Reusing their identity permits a safe later recovery.
    await db.transaction(async (transaction) => {
      await transaction.delete(graphImportTable).where(eq(graphImportTable.snapshotId, existing[0].id));
      await transaction.delete(graphSymbolTable).where(eq(graphSymbolTable.snapshotId, existing[0].id));
      await transaction.delete(graphFileTable).where(eq(graphFileTable.snapshotId, existing[0].id));
      await transaction.update(graphSnapshotTable).set({
        status: "building", failureReason: null, completedAt: null, buildDurationMs: null,
        buildMode: input.metadata?.buildMode ?? "full", baseSnapshotId: input.metadata?.baseSnapshotId ?? null,
        changedFileCount: input.metadata?.changedFileCount ?? 0, reanalyzedFileCount: input.metadata?.reanalyzedFileCount ?? 0,
        fallbackReason: input.metadata?.fallbackReason ?? null,
      }).where(eq(graphSnapshotTable.id, existing[0].id));
    });
    return existing[0].id;
  }

  const rows = await db
    .insert(graphSnapshotTable)
    .values({
      repoId: input.repoId,
      branch: input.branch,
      commitSha: input.sha,
      status: "building",
      graphSchemaVersion: CURRENT_GRAPH_SCHEMA_VERSION,
      buildMode: input.metadata?.buildMode ?? "full",
      baseSnapshotId: input.metadata?.baseSnapshotId ?? null,
      changedFileCount: input.metadata?.changedFileCount ?? 0,
      reanalyzedFileCount: input.metadata?.reanalyzedFileCount ?? 0,
      fallbackReason: input.metadata?.fallbackReason ?? null,
    })
    .returning({ id: graphSnapshotTable.id });
  return rows[0].id;
}

export async function findReadySnapshotByIdentity(input: {
  repoId: number;
  branch: string;
  sha: string;
}): Promise<BaselineBuildResult | null> {
  const rows = await db
    .select({
      snapshotId: graphSnapshotTable.id,
      repoId: graphSnapshotTable.repoId,
      branch: graphSnapshotTable.branch,
      sha: graphSnapshotTable.commitSha,
      graphSchemaVersion: graphSnapshotTable.graphSchemaVersion,
      fileCount: graphSnapshotTable.fileCount,
      symbolCount: graphSnapshotTable.symbolCount,
      importCount: graphSnapshotTable.importCount,
      unresolvedImportCount: graphSnapshotTable.unresolvedImportCount,
      buildDurationMs: graphSnapshotTable.buildDurationMs,
      buildMode: graphSnapshotTable.buildMode,
      baseSnapshotId: graphSnapshotTable.baseSnapshotId,
      changedFileCount: graphSnapshotTable.changedFileCount,
      reanalyzedFileCount: graphSnapshotTable.reanalyzedFileCount,
      fallbackReason: graphSnapshotTable.fallbackReason,
    })
    .from(graphSnapshotTable)
    .where(
      and(
        eq(graphSnapshotTable.repoId, input.repoId),
        eq(graphSnapshotTable.branch, input.branch),
        eq(graphSnapshotTable.commitSha, input.sha),
        eq(graphSnapshotTable.graphSchemaVersion, CURRENT_GRAPH_SCHEMA_VERSION),
        eq(graphSnapshotTable.status, "ready"),
      ),
    )
    .limit(1);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    ...row,
    status: "ready",
    graphSchemaVersion: row.graphSchemaVersion,
    buildDurationMs: row.buildDurationMs ?? 0,
    buildMode: row.buildMode as BaselineBuildResult["buildMode"],
    baseSnapshotId: row.baseSnapshotId,
    changedFileCount: row.changedFileCount,
    reanalyzedFileCount: row.reanalyzedFileCount,
    fallbackReason: row.fallbackReason,
  };
}

export async function persistReadySnapshot(input: {
  snapshotId: string;
  repoId: number;
  branch: string;
  sha: string;
  graph: BaselineGraph;
  buildDurationMs: number;
  metadata?: SnapshotBuildMetadata;
}): Promise<BaselineBuildResult> {
  const unresolvedImportCount = input.graph.imports.filter((entry) => entry.resolutionStatus === "unresolved").length;

  await db.transaction(async (transaction) => {
    const fileIds = new Map<string, number>();
    for (const file of input.graph.files) {
      const rows = await transaction
        .insert(graphFileTable)
        .values({
          snapshotId: input.snapshotId,
          path: file.path,
          blobSha: file.blobSha,
          kind: file.kind,
          classificationReason: file.classificationReason,
        })
        .returning({ id: graphFileTable.id });
      fileIds.set(file.path, rows[0].id);
    }

    for (const symbol of input.graph.symbols) {
      const fileId = fileIds.get(symbol.filePath);
      if (!fileId) throw new Error(`symbol references missing graph file: ${symbol.filePath}`);
      await transaction.insert(graphSymbolTable).values({
        snapshotId: input.snapshotId,
        fileId,
        symbolKey: symbol.symbolKey,
        name: symbol.name,
        kind: symbol.kind,
        isExported: symbol.isExported,
        startLine: symbol.startLine,
        startColumn: symbol.startColumn,
        endLine: symbol.endLine,
        endColumn: symbol.endColumn,
        sourceHash: symbol.sourceHash,
      });
    }

    for (const graphImport of input.graph.imports) {
      const fromFileId = fileIds.get(graphImport.fromPath);
      if (!fromFileId) throw new Error(`import references missing importer file: ${graphImport.fromPath}`);
      const toFileId = graphImport.toPath ? fileIds.get(graphImport.toPath) : undefined;
      if (graphImport.toPath && !toFileId) throw new Error(`import references missing target file: ${graphImport.toPath}`);
      await transaction.insert(graphImportTable).values({
        snapshotId: input.snapshotId,
        fromFileId,
        toFileId: toFileId ?? null,
        specifier: graphImport.specifier,
        kind: graphImport.kind,
        resolutionStatus: graphImport.resolutionStatus,
        unresolvedReason: graphImport.unresolvedReason,
      });
    }

    await transaction
      .update(graphSnapshotTable)
      .set({
        status: "ready",
        fileCount: input.graph.files.length,
        symbolCount: input.graph.symbols.length,
        importCount: input.graph.imports.length,
        unresolvedImportCount,
        buildDurationMs: input.buildDurationMs,
        completedAt: new Date(),
      })
      .where(eq(graphSnapshotTable.id, input.snapshotId));
  });

  return {
    snapshotId: input.snapshotId,
    repoId: input.repoId,
    branch: input.branch,
    sha: input.sha,
    status: "ready",
    graphSchemaVersion: CURRENT_GRAPH_SCHEMA_VERSION,
    fileCount: input.graph.files.length,
    symbolCount: input.graph.symbols.length,
    importCount: input.graph.imports.length,
    unresolvedImportCount,
    buildDurationMs: input.buildDurationMs,
    buildMode: input.metadata?.buildMode ?? "full",
    baseSnapshotId: input.metadata?.baseSnapshotId ?? null,
    changedFileCount: input.metadata?.changedFileCount ?? 0,
    reanalyzedFileCount: input.metadata?.reanalyzedFileCount ?? 0,
    fallbackReason: input.metadata?.fallbackReason ?? null,
  };
}

export async function loadReadyGraphByIdentity(input: { repoId: number; branch: string; sha: string }): Promise<{ snapshotId: string; graph: BaselineGraph } | null> {
  const snapshot = await findReadySnapshotByIdentity(input);
  if (!snapshot) return null;
  const files = await db.select().from(graphFileTable).where(eq(graphFileTable.snapshotId, snapshot.snapshotId));
  const pathsById = new Map(files.map((file) => [file.id, file.path]));
  const symbols = await db.select().from(graphSymbolTable).where(eq(graphSymbolTable.snapshotId, snapshot.snapshotId));
  const imports = await db.select().from(graphImportTable).where(eq(graphImportTable.snapshotId, snapshot.snapshotId));
  return {
    snapshotId: snapshot.snapshotId,
    graph: {
      files: files.map((file) => ({ path: file.path, blobSha: file.blobSha, kind: file.kind as BaselineGraph["files"][number]["kind"], classificationReason: file.classificationReason })),
      symbols: symbols.map((symbol) => ({
        filePath: pathsById.get(symbol.fileId)!, symbolKey: symbol.symbolKey, name: symbol.name,
        kind: symbol.kind as BaselineGraph["symbols"][number]["kind"], isExported: symbol.isExported,
        startLine: symbol.startLine, startColumn: symbol.startColumn, endLine: symbol.endLine, endColumn: symbol.endColumn, sourceHash: symbol.sourceHash,
      })),
      imports: imports.map((entry) => ({
        fromPath: pathsById.get(entry.fromFileId)!, toPath: entry.toFileId ? pathsById.get(entry.toFileId)! : null,
        specifier: entry.specifier, kind: entry.kind as BaselineGraph["imports"][number]["kind"],
        resolutionStatus: entry.resolutionStatus as BaselineGraph["imports"][number]["resolutionStatus"], unresolvedReason: entry.unresolvedReason,
      })),
    },
  };
}

export async function markSnapshotFailed(snapshotId: string, reason: string, buildDurationMs: number): Promise<void> {
  await db
    .update(graphSnapshotTable)
    .set({
      status: "failed",
      failureReason: reason,
      buildDurationMs,
      completedAt: new Date(),
    })
    .where(eq(graphSnapshotTable.id, snapshotId));
}

export async function markSnapshotUnsupported(snapshotId: string, reason: string, buildDurationMs: number): Promise<void> {
  await db
    .update(graphSnapshotTable)
    .set({ status: "unsupported", failureReason: reason, buildDurationMs, completedAt: new Date() })
    .where(eq(graphSnapshotTable.id, snapshotId));
}

export async function loadReadySnapshot(snapshotId: string): Promise<{
  id: string;
  repoId: number;
  branch: string;
  sha: string;
  fileCount: number;
  symbolCount: number;
  importCount: number;
}> {
  const rows = await db
    .select({
      id: graphSnapshotTable.id,
      repoId: graphSnapshotTable.repoId,
      branch: graphSnapshotTable.branch,
      sha: graphSnapshotTable.commitSha,
      fileCount: graphSnapshotTable.fileCount,
      symbolCount: graphSnapshotTable.symbolCount,
      importCount: graphSnapshotTable.importCount,
    })
    .from(graphSnapshotTable)
    .where(and(
      eq(graphSnapshotTable.id, snapshotId),
      eq(graphSnapshotTable.status, "ready"),
      eq(graphSnapshotTable.graphSchemaVersion, CURRENT_GRAPH_SCHEMA_VERSION),
    ))
    .limit(1);
  if (rows.length === 0) throw new Error(`ready snapshot not found: ${snapshotId}`);
  return rows[0];
}

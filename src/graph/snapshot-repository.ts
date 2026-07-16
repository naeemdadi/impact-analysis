import { and, eq } from "drizzle-orm";

import { db } from "../storage/db.js";
import { graphFileTable, graphImportTable, graphSnapshotTable, graphSymbolTable } from "../storage/schema.js";
import type { BaselineGraph, BaselineBuildResult } from "./types.js";

export async function createBuildingSnapshot(input: {
  repoId: number;
  branch: string;
  sha: string;
}): Promise<string> {
  const existing = await db
    .select({ id: graphSnapshotTable.id })
    .from(graphSnapshotTable)
    .where(
      and(
        eq(graphSnapshotTable.repoId, input.repoId),
        eq(graphSnapshotTable.branch, input.branch),
        eq(graphSnapshotTable.commitSha, input.sha),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    throw new Error(`baseline snapshot already exists for repo ${input.repoId}, branch ${input.branch}, SHA ${input.sha}`);
  }

  const rows = await db
    .insert(graphSnapshotTable)
    .values({
      repoId: input.repoId,
      branch: input.branch,
      commitSha: input.sha,
      status: "building",
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
      fileCount: graphSnapshotTable.fileCount,
      symbolCount: graphSnapshotTable.symbolCount,
      importCount: graphSnapshotTable.importCount,
      unresolvedImportCount: graphSnapshotTable.unresolvedImportCount,
      buildDurationMs: graphSnapshotTable.buildDurationMs,
    })
    .from(graphSnapshotTable)
    .where(
      and(
        eq(graphSnapshotTable.repoId, input.repoId),
        eq(graphSnapshotTable.branch, input.branch),
        eq(graphSnapshotTable.commitSha, input.sha),
        eq(graphSnapshotTable.status, "ready"),
      ),
    )
    .limit(1);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    ...row,
    status: "ready",
    buildDurationMs: row.buildDurationMs ?? 0,
  };
}

export async function persistReadySnapshot(input: {
  snapshotId: string;
  repoId: number;
  branch: string;
  sha: string;
  graph: BaselineGraph;
  buildDurationMs: number;
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
    fileCount: input.graph.files.length,
    symbolCount: input.graph.symbols.length,
    importCount: input.graph.imports.length,
    unresolvedImportCount,
    buildDurationMs: input.buildDurationMs,
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
    .where(and(eq(graphSnapshotTable.id, snapshotId), eq(graphSnapshotTable.status, "ready")))
    .limit(1);
  if (rows.length === 0) throw new Error(`ready snapshot not found: ${snapshotId}`);
  return rows[0];
}

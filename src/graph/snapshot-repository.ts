import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../storage/db.js";
import {
  graphFileTable,
  graphImportTable,
  graphSnapshotTable,
  graphSymbolTable,
} from "../storage/schema.js";
import {
  type BaselineGraph,
  type BaselineBuildResult,
  type GraphFile,
  type GraphImport,
} from "./types.js";

export interface SnapshotBuildMetadata {
  buildMode: "full" | "incremental" | "full_fallback";
  baseSnapshotId?: string | null;
  changedFileCount?: number;
  reanalyzedFileCount?: number;
  fallbackReason?: string | null;
}

/**
 * Creates the audit record before source analysis starts.  Snapshot metadata is
 * retained by SHA, while the fact tables intentionally hold only the current
 * graph for a repository branch.
 */
export async function createBuildingSnapshot(input: {
  repoId: number;
  branch: string;
  sha: string;
  metadata?: SnapshotBuildMetadata;
}): Promise<string> {
  const existing = await db
    .select({
      id: graphSnapshotTable.id,
      status: graphSnapshotTable.status,
      isCurrent: graphSnapshotTable.isCurrent,
    })
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
    if (existing[0].status === "ready" && existing[0].isCurrent) {
      throw new Error(`current graph snapshot already exists for repo ${input.repoId}, branch ${input.branch}, SHA ${input.sha}`);
    }
    await db
      .update(graphSnapshotTable)
      .set(buildSnapshotFields(input.metadata))
      .where(eq(graphSnapshotTable.id, existing[0].id));
    return existing[0].id;
  }

  const rows = await db
    .insert(graphSnapshotTable)
    .values({
      repoId: input.repoId,
      branch: input.branch,
      commitSha: input.sha,
      ...buildSnapshotFields(input.metadata),
    })
    .returning({ id: graphSnapshotTable.id });
  return rows[0].id;
}

/** Only the snapshot that currently owns the mutable fact rows can be reused or read. */
export async function findReadySnapshotByIdentity(input: {
  repoId: number;
  branch: string;
  sha: string;
}): Promise<BaselineBuildResult | null> {
  const rows = await db
    .select(snapshotResultFields)
    .from(graphSnapshotTable)
    .where(
      and(
        eq(graphSnapshotTable.repoId, input.repoId),
        eq(graphSnapshotTable.branch, input.branch),
        eq(graphSnapshotTable.commitSha, input.sha),
        eq(graphSnapshotTable.status, "ready"),
        eq(graphSnapshotTable.isCurrent, true),
      ),
    )
    .limit(1);
  return rows.length === 0 ? null : toBuildResult(rows[0]);
}

/**
 * Replaces the one materialized graph for this repository branch. The entire
 * transition is atomic: readers see either the old current graph or the new
 * one, never a mixture. Rows are rewritten in place rather than accumulated
 * per commit, so graph storage stays bounded by the current source tree.
 */
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
    // A lock is needed even before a current row exists, so concurrent push jobs
    // cannot both claim the mutable graph for the same repository branch.
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.repoId}:${input.branch}`}))`);

    const current = await transaction
      .select({ id: graphSnapshotTable.id })
      .from(graphSnapshotTable)
      .where(
        and(
          eq(graphSnapshotTable.repoId, input.repoId),
          eq(graphSnapshotTable.branch, input.branch),
          eq(graphSnapshotTable.isCurrent, true),
        ),
      )
      .limit(1)
      .for("update");

    if (current.length > 0) {
      // The existing graph rows become owned by the incoming snapshot before
      // they are replaced. This preserves referential integrity throughout the
      // transaction and makes snapshot_id an accurate current-graph pointer.
      await transaction
        .update(graphImportTable)
        .set({ snapshotId: input.snapshotId })
        .where(eq(graphImportTable.snapshotId, current[0].id));
      await transaction
        .update(graphSymbolTable)
        .set({ snapshotId: input.snapshotId })
        .where(eq(graphSymbolTable.snapshotId, current[0].id));
      await transaction
        .update(graphFileTable)
        .set({ snapshotId: input.snapshotId })
        .where(eq(graphFileTable.snapshotId, current[0].id));
    } else {
      // First mutable-graph build: any existing fact rows for this branch no
      // longer have an owner selected as current, so replace them before the
      // incoming snapshot becomes the sole graph owner.
      const branchSnapshots = await transaction
        .select({ id: graphSnapshotTable.id })
        .from(graphSnapshotTable)
        .where(and(eq(graphSnapshotTable.repoId, input.repoId), eq(graphSnapshotTable.branch, input.branch)));
      const snapshotIds = branchSnapshots.map((snapshot) => snapshot.id);
      if (snapshotIds.length > 0) {
        await transaction.delete(graphImportTable).where(inArray(graphImportTable.snapshotId, snapshotIds));
        await transaction.delete(graphSymbolTable).where(inArray(graphSymbolTable.snapshotId, snapshotIds));
        await transaction.delete(graphFileTable).where(inArray(graphFileTable.snapshotId, snapshotIds));
      }
    }

    // Import edges do not have a stable database identity yet, so replace that
    // one edge set. Files and symbols, however, are reconciled by their stable
    // path/key identities and retain their rows when unchanged.
    await transaction.delete(graphImportTable).where(eq(graphImportTable.snapshotId, input.snapshotId));

    const filesByPath = new Map<string, number>();
    for (const file of input.graph.files) {
      const rows = await transaction
        .insert(graphFileTable)
        .values({
          snapshotId: input.snapshotId,
          path: file.path,
          blobSha: file.blobSha,
          kind: file.kind,
          classificationReason: file.classificationReason,
          technicalRole: file.technicalRole,
          technicalRoleReason: file.technicalRoleReason,
          technicalRoleStrength: file.technicalRoleStrength,
        })
        .onConflictDoUpdate({
          target: [graphFileTable.snapshotId, graphFileTable.path],
          set: {
            blobSha: file.blobSha,
            kind: file.kind,
            classificationReason: file.classificationReason,
            technicalRole: file.technicalRole,
            technicalRoleReason: file.technicalRoleReason,
            technicalRoleStrength: file.technicalRoleStrength,
          },
        })
        .returning({ id: graphFileTable.id });
      filesByPath.set(file.path, rows[0].id);
    }

    const targetSymbolKeys = new Set(input.graph.symbols.map((symbol) => symbol.symbolKey));
    const existingSymbols = await transaction
      .select({ id: graphSymbolTable.id, symbolKey: graphSymbolTable.symbolKey })
      .from(graphSymbolTable)
      .where(eq(graphSymbolTable.snapshotId, input.snapshotId));
    const obsoleteSymbolIds = existingSymbols
      .filter((symbol) => !targetSymbolKeys.has(symbol.symbolKey))
      .map((symbol) => symbol.id);
    if (obsoleteSymbolIds.length > 0) {
      await transaction.delete(graphSymbolTable).where(inArray(graphSymbolTable.id, obsoleteSymbolIds));
    }

    for (const symbol of input.graph.symbols) {
      const fileId = filesByPath.get(symbol.filePath);
      if (!fileId) throw new Error(`graph symbol ${symbol.symbolKey} refers to missing file ${symbol.filePath}`);
      await transaction
        .insert(graphSymbolTable)
        .values({
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
        })
        .onConflictDoUpdate({
          target: [graphSymbolTable.snapshotId, graphSymbolTable.symbolKey],
          set: {
            fileId,
            name: symbol.name,
            kind: symbol.kind,
            isExported: symbol.isExported,
            startLine: symbol.startLine,
            startColumn: symbol.startColumn,
            endLine: symbol.endLine,
            endColumn: symbol.endColumn,
            sourceHash: symbol.sourceHash,
          },
        });
    }

    const staleFiles = await transaction
      .select({ id: graphFileTable.id, path: graphFileTable.path })
      .from(graphFileTable)
      .where(eq(graphFileTable.snapshotId, input.snapshotId));
    const obsoleteFileIds = staleFiles
      .filter((file) => !filesByPath.has(file.path))
      .map((file) => file.id);
    if (obsoleteFileIds.length > 0) {
      // All imports were cleared above; symbols for removed paths have already
      // been removed because their keys are absent from the target graph.
      await transaction.delete(graphFileTable).where(inArray(graphFileTable.id, obsoleteFileIds));
    }

    for (const graphImport of input.graph.imports) {
      const fromFileId = filesByPath.get(graphImport.fromPath);
      const toFileId = graphImport.toPath ? filesByPath.get(graphImport.toPath) : null;
      if (!fromFileId) throw new Error(`graph import ${graphImport.specifier} refers to missing importer ${graphImport.fromPath}`);
      if (graphImport.resolutionStatus === "resolved" && !toFileId) {
        throw new Error(`resolved graph import ${graphImport.specifier} refers to missing target ${graphImport.toPath}`);
      }
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

    // Clear the old pointer before claiming the new one, satisfying the
    // one-current-snapshot-per-branch database constraint.
    await transaction
      .update(graphSnapshotTable)
      .set({ isCurrent: false })
      .where(
        and(
          eq(graphSnapshotTable.repoId, input.repoId),
          eq(graphSnapshotTable.branch, input.branch),
          eq(graphSnapshotTable.isCurrent, true),
        ),
      );
    await transaction
      .update(graphSnapshotTable)
      .set({
        status: "ready",
        isCurrent: true,
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
    buildMode: input.metadata?.buildMode ?? "full",
    baseSnapshotId: input.metadata?.baseSnapshotId ?? null,
    changedFileCount: input.metadata?.changedFileCount ?? 0,
    reanalyzedFileCount: input.metadata?.reanalyzedFileCount ?? 0,
    fallbackReason: input.metadata?.fallbackReason ?? null,
  };
}

/**
 * Historical snapshot metadata intentionally has no graph rows after the head
 * advances. Callers must never use it as evidence for an old commit.
 */
export async function loadReadyGraphByIdentity(input: {
  repoId: number;
  branch: string;
  sha: string;
}): Promise<{ snapshotId: string; graph: BaselineGraph } | null> {
  const snapshot = await findReadySnapshotByIdentity(input);
  if (!snapshot) return null;

  const files = await db.select().from(graphFileTable).where(eq(graphFileTable.snapshotId, snapshot.snapshotId));
  const pathsById = new Map(files.map((file) => [file.id, file.path]));
  const symbols = await db.select().from(graphSymbolTable).where(eq(graphSymbolTable.snapshotId, snapshot.snapshotId));
  const imports = await db.select().from(graphImportTable).where(eq(graphImportTable.snapshotId, snapshot.snapshotId));

  return {
    snapshotId: snapshot.snapshotId,
    graph: {
      files: files.map((file) => ({
        path: file.path,
        blobSha: file.blobSha,
        kind: file.kind as GraphFile["kind"],
        classificationReason: file.classificationReason,
        technicalRole: file.technicalRole as GraphFile["technicalRole"],
        technicalRoleReason: file.technicalRoleReason,
        technicalRoleStrength: file.technicalRoleStrength as GraphFile["technicalRoleStrength"],
      })),
      symbols: symbols.map((symbol) => ({
        filePath: pathsById.get(symbol.fileId)!,
        symbolKey: symbol.symbolKey,
        name: symbol.name,
        kind: symbol.kind as BaselineGraph["symbols"][number]["kind"],
        isExported: symbol.isExported,
        startLine: symbol.startLine,
        startColumn: symbol.startColumn,
        endLine: symbol.endLine,
        endColumn: symbol.endColumn,
        sourceHash: symbol.sourceHash,
      })),
      imports: imports.map((edge) => ({
        fromPath: pathsById.get(edge.fromFileId)!,
        toPath: edge.toFileId ? pathsById.get(edge.toFileId)! : null,
        specifier: edge.specifier,
        kind: edge.kind as GraphImport["kind"],
        resolutionStatus: edge.resolutionStatus as GraphImport["resolutionStatus"],
        unresolvedReason: edge.unresolvedReason,
      })),
    },
  };
}

export async function getCurrentSnapshotSha(repoId: number, branch: string): Promise<string | null> {
  const rows = await db.select({ sha: graphSnapshotTable.commitSha }).from(graphSnapshotTable).where(and(
    eq(graphSnapshotTable.repoId, repoId), eq(graphSnapshotTable.branch, branch),
    eq(graphSnapshotTable.status, "ready"), eq(graphSnapshotTable.isCurrent, true),
  )).limit(1);
  return rows[0]?.sha ?? null;
}

export async function markSnapshotFailed(snapshotId: string, reason: string, buildDurationMs: number): Promise<void> {
  await db
    .update(graphSnapshotTable)
    .set({ status: "failed", isCurrent: false, failureReason: reason, buildDurationMs, completedAt: new Date() })
    .where(eq(graphSnapshotTable.id, snapshotId));
}

export async function markSnapshotUnsupported(snapshotId: string, reason: string, buildDurationMs: number): Promise<void> {
  await db
    .update(graphSnapshotTable)
    .set({ status: "unsupported", isCurrent: false, failureReason: reason, buildDurationMs, completedAt: new Date() })
    .where(eq(graphSnapshotTable.id, snapshotId));
}

const snapshotResultFields = {
  snapshotId: graphSnapshotTable.id,
  repoId: graphSnapshotTable.repoId,
  branch: graphSnapshotTable.branch,
  sha: graphSnapshotTable.commitSha,
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
};

function buildSnapshotFields(metadata: SnapshotBuildMetadata | undefined) {
  return {
    status: "building",
    isCurrent: false,
    failureReason: null,
    completedAt: null,
    buildDurationMs: null,
    buildMode: metadata?.buildMode ?? "full",
    baseSnapshotId: metadata?.baseSnapshotId ?? null,
    changedFileCount: metadata?.changedFileCount ?? 0,
    reanalyzedFileCount: metadata?.reanalyzedFileCount ?? 0,
    fallbackReason: metadata?.fallbackReason ?? null,
  };
}

interface SnapshotResultRow {
  snapshotId: string;
  repoId: number;
  branch: string;
  sha: string;
  fileCount: number;
  symbolCount: number;
  importCount: number;
  unresolvedImportCount: number;
  buildDurationMs: number | null;
  buildMode: string;
  baseSnapshotId: string | null;
  changedFileCount: number;
  reanalyzedFileCount: number;
  fallbackReason: string | null;
}

function toBuildResult(row: SnapshotResultRow): BaselineBuildResult {
  return {
    ...row,
    status: "ready",
    buildDurationMs: row.buildDurationMs ?? 0,
    buildMode: row.buildMode as BaselineBuildResult["buildMode"],
  };
}

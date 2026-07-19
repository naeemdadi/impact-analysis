import { db } from "./db.js";
import { repoConfigTable } from "./schema.js";
import { and, eq, sql } from "drizzle-orm";

export type RepoAccessState = "active" | "suspended" | "removed" | "deleted";

export interface RepoConfig {
  repoId: number;
  installationId: number;
  owner: string | null;
  name: string | null;
  trackedBranch: string;
  isActive: boolean;
  accessState: RepoAccessState;
  semanticAiEnabled: boolean;
}

export async function upsertRepoConfig(config: RepoConfig): Promise<void> {
  await db
    .insert(repoConfigTable)
    .values({
      repoId: config.repoId,
      installationId: config.installationId,
      owner: config.owner,
      name: config.name,
      trackedBranch: config.trackedBranch,
      isActive: config.isActive,
      accessState: config.accessState,
      semanticAiEnabled: config.semanticAiEnabled,
    })
    .onConflictDoUpdate({
      target: repoConfigTable.repoId,
      set: {
        installationId: config.installationId,
        owner: config.owner,
        name: config.name,
        trackedBranch: config.trackedBranch,
        isActive: config.isActive,
        accessState: config.accessState,
        updatedAt: sql`NOW()`,
      },
    });
}

export async function getRepoConfig(repoId: number): Promise<RepoConfig | null> {
  const rows = await db
    .select({
      repoId: repoConfigTable.repoId,
      installationId: repoConfigTable.installationId,
      owner: repoConfigTable.owner,
      name: repoConfigTable.name,
      trackedBranch: repoConfigTable.trackedBranch,
      isActive: repoConfigTable.isActive,
      accessState: repoConfigTable.accessState,
      semanticAiEnabled: repoConfigTable.semanticAiEnabled,
    })
    .from(repoConfigTable)
    .where(eq(repoConfigTable.repoId, repoId))
    .limit(1);

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];
  return {
    repoId: row.repoId,
    installationId: row.installationId,
    owner: row.owner,
    name: row.name,
    trackedBranch: row.trackedBranch,
    isActive: row.isActive,
    accessState: row.accessState as RepoAccessState,
    semanticAiEnabled: row.semanticAiEnabled,
  };
}

export async function updateRepoIdentity(repoId: number, owner: string, name: string): Promise<void> {
  await db
    .update(repoConfigTable)
    .set({ owner, name, updatedAt: sql`NOW()` })
    .where(eq(repoConfigTable.repoId, repoId));
}

export async function setRepoConfigAccessState(repoId: number, accessState: RepoAccessState): Promise<void> {
  await db
    .update(repoConfigTable)
    .set({ isActive: accessState === "active", accessState, updatedAt: sql`NOW()` })
    .where(eq(repoConfigTable.repoId, repoId));
}

/** Explicit repository consent for bounded source-context requests to OpenAI. */
export async function setSemanticAiEnabled(repoId: number, semanticAiEnabled: boolean): Promise<void> {
  await db.update(repoConfigTable).set({ semanticAiEnabled, updatedAt: sql`NOW()` }).where(eq(repoConfigTable.repoId, repoId));
}

export async function transitionInstallationRepoAccessState(
  installationId: number,
  fromState: RepoAccessState,
  toState: RepoAccessState,
): Promise<number[]> {
  const rows = await db
    .update(repoConfigTable)
    .set({ isActive: toState === "active", accessState: toState, updatedAt: sql`NOW()` })
    .where(and(eq(repoConfigTable.installationId, installationId), eq(repoConfigTable.accessState, fromState)))
    .returning({ repoId: repoConfigTable.repoId });
  return rows.map((row) => row.repoId);
}

export async function setInstallationRepoAccessState(
  installationId: number,
  accessState: RepoAccessState,
): Promise<number[]> {
  const rows = await db
    .update(repoConfigTable)
    .set({ isActive: accessState === "active", accessState, updatedAt: sql`NOW()` })
    .where(eq(repoConfigTable.installationId, installationId))
    .returning({ repoId: repoConfigTable.repoId });
  return rows.map((row) => row.repoId);
}

export async function getRepoConfigsForInstallation(installationId: number): Promise<RepoConfig[]> {
  const rows = await db
    .select({
      repoId: repoConfigTable.repoId,
      installationId: repoConfigTable.installationId,
      owner: repoConfigTable.owner,
      name: repoConfigTable.name,
      trackedBranch: repoConfigTable.trackedBranch,
      isActive: repoConfigTable.isActive,
      accessState: repoConfigTable.accessState,
      semanticAiEnabled: repoConfigTable.semanticAiEnabled,
    })
    .from(repoConfigTable)
    .where(eq(repoConfigTable.installationId, installationId));
  return rows.map((row) => ({ ...row, accessState: row.accessState as RepoAccessState }));
}

export async function listActiveRepoConfigs(): Promise<RepoConfig[]> {
  const rows = await db.select({
    repoId: repoConfigTable.repoId, installationId: repoConfigTable.installationId, owner: repoConfigTable.owner,
    name: repoConfigTable.name, trackedBranch: repoConfigTable.trackedBranch, isActive: repoConfigTable.isActive,
    accessState: repoConfigTable.accessState, semanticAiEnabled: repoConfigTable.semanticAiEnabled,
  }).from(repoConfigTable).where(eq(repoConfigTable.isActive, true));
  return rows.map((row) => ({ ...row, accessState: row.accessState as RepoAccessState }));
}

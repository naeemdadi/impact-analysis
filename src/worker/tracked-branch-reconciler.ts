import { GitHubRepositoryReader } from "../graph/github-repository-reader.js";
import { reconcileUndeliveredPullRequestCommentsOnce } from "../delivery/pr-comment-delivery-reconciler.js";
import { getCurrentSnapshotSha } from "../graph/snapshot-repository.js";
import { enqueueBranchReconciliation } from "../queue/reconciliation-queue.js";
import { reapExpiredJobLeases } from "../queue/worker-repository.js";
import { log } from "../server/logger.js";
import { listActiveRepoConfigs } from "../storage/repo-config-repo.js";

export async function reconcileTrackedBranchesOnce(): Promise<void> {
  await reapExpiredJobLeases();
  try {
    await reconcileUndeliveredPullRequestCommentsOnce();
  } catch (error) {
    log("warn", "pull request comment reconciliation scan failed", {
      error: error instanceof Error ? error.message : "unknown error",
    });
  }
  const reader = new GitHubRepositoryReader();
  for (const config of await listActiveRepoConfigs()) {
    if (!config.owner || !config.name) continue;
    try {
      const liveSha = await reader.resolveBranchSha({ installationId: config.installationId, owner: config.owner, name: config.name, branch: config.trackedBranch });
      const currentSha = await getCurrentSnapshotSha(config.repoId, config.trackedBranch);
      if (currentSha !== liveSha) {
        await enqueueBranchReconciliation({ repoId: config.repoId, branch: config.trackedBranch, sha: liveSha, reason: currentSha ? "current graph SHA is stale" : "current graph snapshot is missing" });
        log("warn", "tracked branch reconciliation queued", { repoId: config.repoId, branch: config.trackedBranch, currentSha, liveSha });
      }
    } catch (error) {
      log("warn", "tracked branch reconciliation scan failed", { repoId: config.repoId, branch: config.trackedBranch, error: error instanceof Error ? error.message : "unknown error" });
    }
  }
}

export async function runTrackedBranchReconciler(): Promise<void> {
  log("info", "tracked branch reconciler started");
  while (true) {
    await reconcileTrackedBranchesOnce();
    await new Promise((resolve) => setTimeout(resolve, 5 * 60_000));
  }
}

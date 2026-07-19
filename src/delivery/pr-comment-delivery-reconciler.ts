import { log } from "../server/logger.js";
import { enqueueUndeliveredPullRequestComment } from "./pr-comment-delivery-queue.js";
import { findUndeliveredPrCommentDeliveries } from "./pr-comment-delivery-repository.js";

/**
 * Repairs a missed queue enqueue or a legacy row that predates delivery-state
 * tracking. The queue's idempotency key keeps repeated scans harmless.
 */
export async function reconcileUndeliveredPullRequestCommentsOnce(): Promise<void> {
  const deliveries = await findUndeliveredPrCommentDeliveries();
  for (const delivery of deliveries) {
    await enqueueUndeliveredPullRequestComment({
      repoId: delivery.repoId,
      pullRequestNumber: delivery.pullRequestNumber,
      prAnalysisId: delivery.analysisId,
      headSha: delivery.headSha,
      deliveryState: delivery.deliveryState,
    });
  }
  if (deliveries.length > 0) {
    log("warn", "undelivered pull request comments reconciled", {
      deliveryCount: deliveries.length,
    });
  }
}

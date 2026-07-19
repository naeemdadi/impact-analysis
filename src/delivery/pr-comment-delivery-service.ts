import { getRepoConfig } from "../storage/repo-config-repo.js";
import { getPrAnalysisDeliveryState } from "../impact/pr-analysis-repository.js";
import { findReadyReport } from "../report/pr-report-repository.js";
import type { PullRequestCommentWriter } from "../github/pull-request-comment-writer.js";
import { getPrCommentDelivery, markPrCommentDelivered, withPrCommentDeliveryLock } from "./pr-comment-delivery-repository.js";
import type { PullRequestDeliveryRequest } from "./pr-comment-delivery-queue.js";
import { commentMarker, renderPrCommentBody } from "./pr-comment-body.js";

export type DeliveryAction = "created" | "updated" | "recreated" | "skipped_stale";

export async function deliverPullRequestComment(
  request: PullRequestDeliveryRequest,
  writer: PullRequestCommentWriter,
): Promise<{ action: DeliveryAction; commentId: number | null }> {
  return withPrCommentDeliveryLock(request.repoId, request.pullRequestNumber, async () => {
    const delivery = await getPrCommentDelivery(request.repoId, request.pullRequestNumber);
    if (!delivery || delivery.desiredAnalysisId !== request.prAnalysisId || delivery.desiredHeadSha !== request.headSha || delivery.desiredState !== request.deliveryState) {
      return { action: "skipped_stale", commentId: delivery?.commentId ?? null };
    }

    const [config, analysis] = await Promise.all([
      getRepoConfig(request.repoId),
      getPrAnalysisDeliveryState(request.prAnalysisId),
    ]);
    if (!config?.isActive || !config.owner || !config.name) throw new Error("active repository configuration with owner and name is required for comment delivery");
    if (!analysis || analysis.headSha !== request.headSha) throw new Error("requested PR analysis was not found for comment delivery");

    const marker = commentMarker(request.repoId, request.pullRequestNumber);
    const report = analysis.status === "ready" ? await findReadyReport(request.prAnalysisId) : null;
    const body = renderPrCommentBody({ marker, analysis, markdown: report?.markdown ?? null });
    let commentId = delivery.commentId;
    let action: DeliveryAction;

    if (commentId) {
      try {
        await writer.updateComment({ installationId: config.installationId, owner: config.owner, name: config.name, commentId, body });
        action = "updated";
      } catch (error) {
        if (githubStatus(error) !== 404) throw error;
        const existing = await writer.findCommentByMarker({ installationId: config.installationId, owner: config.owner, name: config.name, pullRequestNumber: request.pullRequestNumber, marker });
        if (existing) {
          commentId = existing;
          await writer.updateComment({ installationId: config.installationId, owner: config.owner, name: config.name, commentId, body });
          action = "recreated";
        } else {
          commentId = await writer.createComment({ installationId: config.installationId, owner: config.owner, name: config.name, pullRequestNumber: request.pullRequestNumber, body });
          action = "recreated";
        }
      }
    } else {
      const existing = await writer.findCommentByMarker({ installationId: config.installationId, owner: config.owner, name: config.name, pullRequestNumber: request.pullRequestNumber, marker });
      if (existing) {
        commentId = existing;
        await writer.updateComment({ installationId: config.installationId, owner: config.owner, name: config.name, commentId, body });
        action = "updated";
      } else {
        commentId = await writer.createComment({ installationId: config.installationId, owner: config.owner, name: config.name, pullRequestNumber: request.pullRequestNumber, body });
        action = "created";
      }
    }

    await markPrCommentDelivered({
      repoId: request.repoId,
      pullRequestNumber: request.pullRequestNumber,
      analysisId: request.prAnalysisId,
      headSha: request.headSha,
      deliveryState: request.deliveryState,
      commentId,
    });
    return { action, commentId };
  });
}

function githubStatus(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") return error.status;
  return null;
}

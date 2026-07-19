import { App } from "@octokit/app";
import { readFile } from "node:fs/promises";

export interface PullRequestCommentWriter {
  createComment(input: { installationId: number; owner: string; name: string; pullRequestNumber: number; body: string }): Promise<number>;
  updateComment(input: { installationId: number; owner: string; name: string; commentId: number; body: string }): Promise<void>;
  findCommentByMarker(input: { installationId: number; owner: string; name: string; pullRequestNumber: number; marker: string }): Promise<number | null>;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for GitHub PR comment delivery`);
  return value;
}

export class GitHubPullRequestCommentWriter implements PullRequestCommentWriter {
  private appPromise: Promise<App> | null = null;

  private async octokit(installationId: number) {
    if (!this.appPromise) {
      this.appPromise = readFile(requiredEnvironment("GITHUB_PRIVATE_KEY_PATH"), "utf8").then((privateKey) => new App({
        appId: requiredEnvironment("GITHUB_APP_ID"),
        privateKey,
      }));
    }
    return (await this.appPromise).getInstallationOctokit(installationId);
  }

  async createComment(input: { installationId: number; owner: string; name: string; pullRequestNumber: number; body: string }): Promise<number> {
    const response = await (await this.octokit(input.installationId)).request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: input.owner, repo: input.name, issue_number: input.pullRequestNumber, body: input.body,
    });
    return response.data.id;
  }

  async updateComment(input: { installationId: number; owner: string; name: string; commentId: number; body: string }): Promise<void> {
    await (await this.octokit(input.installationId)).request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
      owner: input.owner, repo: input.name, comment_id: input.commentId, body: input.body,
    });
  }

  async findCommentByMarker(input: { installationId: number; owner: string; name: string; pullRequestNumber: number; marker: string }): Promise<number | null> {
    const octokit = await this.octokit(input.installationId);
    for (let page = 1; ; page += 1) {
      const response = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner: input.owner, repo: input.name, issue_number: input.pullRequestNumber, per_page: 100, page,
      });
      const match = response.data.find((comment) => comment.body?.includes(input.marker));
      if (match) return match.id;
      if (response.data.length < 100) return null;
    }
  }
}

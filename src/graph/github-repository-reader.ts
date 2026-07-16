import { App } from "@octokit/app";
import { readFile } from "node:fs/promises";

import type { RepositoryReader, RepositorySource, SourceFile } from "./types.js";

const sourcePathPattern = /\.(?:ts|tsx)$/;
const configPathPattern = /(^|\/)tsconfig(?:\.[^/]+)?\.json$/;

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for baseline graph builds`);
  }
  return value;
}

export class GitHubRepositoryReader implements RepositoryReader {
  private appPromise: Promise<App> | null = null;

  private async getApp(): Promise<App> {
    if (!this.appPromise) {
      this.appPromise = readFile(requireEnvironment("GITHUB_PRIVATE_KEY_PATH"), "utf8").then(
        (privateKey) =>
          new App({
            appId: requireEnvironment("GITHUB_APP_ID"),
            privateKey,
          }),
      );
    }
    return this.appPromise;
  }

  private async getInstallationOctokit(installationId: number) {
    return (await this.getApp()).getInstallationOctokit(installationId);
  }

  async resolveRepository(
    repoId: number,
    installationId: number,
  ): Promise<{ owner: string; name: string; defaultBranch: string }> {
    const octokit = await this.getInstallationOctokit(installationId);
    const response = await octokit.request("GET /repositories/{repository_id}", {
      repository_id: repoId,
    });
    return {
      owner: response.data.owner.login,
      name: response.data.name,
      defaultBranch: response.data.default_branch,
    };
  }

  async resolveBranchSha(input: {
    installationId: number;
    owner: string;
    name: string;
    branch: string;
  }): Promise<string> {
    const octokit = await this.getInstallationOctokit(input.installationId);
    const response = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner: input.owner,
      repo: input.name,
      ref: `heads/${input.branch}`,
    });
    return response.data.object.sha;
  }

  async fetchSource(input: {
    repoId: number;
    installationId: number;
    owner: string;
    name: string;
    branch: string;
    sha: string;
  }): Promise<RepositorySource> {
    const octokit = await this.getInstallationOctokit(input.installationId);
    const tree = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner: input.owner,
      repo: input.name,
      tree_sha: input.sha,
      recursive: "1",
    });

    if (tree.data.truncated) {
      throw new Error("repository tree is truncated; refusing to build a partial baseline graph");
    }

    const entries = tree.data.tree.filter(
      (entry) =>
        entry.type === "blob" &&
        entry.path &&
        entry.sha &&
        (sourcePathPattern.test(entry.path) || configPathPattern.test(entry.path)),
    );

    const files = await mapWithConcurrency(entries, 8, async (entry): Promise<SourceFile> => {
      const blob = await octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
        owner: input.owner,
        repo: input.name,
        file_sha: entry.sha!,
      });
      if (blob.data.encoding !== "base64") {
        throw new Error(`unsupported blob encoding for ${entry.path}`);
      }
      return {
        path: entry.path!,
        blobSha: entry.sha!,
        content: Buffer.from(blob.data.content, "base64").toString("utf8"),
      };
    });

    return {
      repoId: input.repoId,
      owner: input.owner,
      name: input.name,
      branch: input.branch,
      sha: input.sha,
      files,
    };
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

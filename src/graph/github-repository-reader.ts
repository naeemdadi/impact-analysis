import { App } from "@octokit/app";
import { readFile } from "node:fs/promises";

import type { CommitComparison, RepositoryReader, RepositorySource, RepositoryTreeEntry, SourceFile } from "./types.js";

const analyzablePathPattern = /\.(?:ts|tsx|js|jsx|mjs|cjs|css|scss|sass|less)$/;
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
    const entries = await this.fetchTree(input);
    const files = await this.fetchFiles({
      ...input,
      paths: entries.filter((entry) => analyzablePathPattern.test(entry.path) || configPathPattern.test(entry.path)).map((entry) => entry.path),
    });
    return {
      repoId: input.repoId,
      owner: input.owner,
      name: input.name,
      branch: input.branch,
      sha: input.sha,
      allFilePaths: entries.map((entry) => entry.path),
      files,
    };
  }

  async fetchTree(input: {
    repoId: number;
    installationId: number;
    owner: string;
    name: string;
    branch: string;
    sha: string;
  }): Promise<RepositoryTreeEntry[]> {
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

    return tree.data.tree.filter(
      (entry) =>
        entry.type === "blob" &&
        entry.path &&
        entry.sha,
    ).map((entry) => ({ path: entry.path!, blobSha: entry.sha! }));
  }

  async fetchFiles(input: {
    repoId: number;
    installationId: number;
    owner: string;
    name: string;
    branch: string;
    sha: string;
    paths: string[];
  }): Promise<SourceFile[]> {
    const requestedPaths = new Set(input.paths);
    const entries = (await this.fetchTree(input)).filter((entry) => requestedPaths.has(entry.path));
    const octokit = await this.getInstallationOctokit(input.installationId);
    return mapWithConcurrency(entries, 8, async (entry): Promise<SourceFile> => {
      const blob = await octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
        owner: input.owner,
        repo: input.name,
        file_sha: entry.blobSha,
      });
      if (blob.data.encoding !== "base64") {
        throw new Error(`unsupported blob encoding for ${entry.path}`);
      }
      return {
        path: entry.path,
        blobSha: entry.blobSha,
        content: Buffer.from(blob.data.content, "base64").toString("utf8"),
      };
    });
  }

  async compareCommits(input: {
    installationId: number;
    owner: string;
    name: string;
    beforeSha: string;
    afterSha: string;
  }): Promise<CommitComparison> {
    const octokit = await this.getInstallationOctokit(input.installationId);
    try {
      const response = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
        owner: input.owner,
        repo: input.name,
        basehead: `${input.beforeSha}...${input.afterSha}`,
      });
      const files = response.data.files;
      if (response.data.status !== "ahead" || !files || files.length >= 300) {
        const reason = files && files.length >= 300
          ? "commit comparison file list may be truncated"
          : `commit comparison status is ${response.data.status}`;
        return { comparable: false, reason, changes: [] };
      }
      return {
        comparable: true,
        reason: null,
        changes: files.map((file) => ({
          path: file.filename,
          status: file.status === "renamed" ? "renamed" : file.status === "removed" ? "removed" : file.status === "added" ? "added" : "modified",
          previousPath: file.previous_filename,
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "commit comparison failed";
      return { comparable: false, reason: message, changes: [] };
    }
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

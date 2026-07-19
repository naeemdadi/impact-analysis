import "dotenv/config";
import { sql } from "drizzle-orm";

import { db, pool } from "../src/storage/db.js";
import { GitHubRepositoryReader } from "../src/graph/github-repository-reader.js";
import { listActiveRepoConfigs } from "../src/storage/repo-config-repo.js";

const rows = await db.execute(sql`
  SELECT
    job_type,
    status,
    count(*)::int AS count,
    round(avg(extract(epoch FROM (first_started_at - enqueued_at))) FILTER (WHERE first_started_at IS NOT NULL), 1) AS average_queue_latency_seconds,
    max(extract(epoch FROM (now() - enqueued_at))) FILTER (WHERE status = 'pending')::int AS oldest_pending_seconds
  FROM job_queue_enqueued
  GROUP BY job_type, status
  ORDER BY job_type, status
`);
const graphs = await db.execute(sql`
  SELECT repo_id, branch, commit_sha, project_count, entrypoint_count, protocol_binding_count, build_duration_ms, completed_at
  FROM graph_snapshot WHERE is_current = true ORDER BY completed_at DESC
`);
const projects = await db.execute(sql`
  SELECT repo_id, root_path, package_name, primary_framework, status, reason
  FROM graph_project WHERE is_active = true ORDER BY repo_id, root_path
`);
const recentPrs = await db.execute(sql`
  SELECT a.repo_id, a.pull_request_number, a.head_sha, a.status AS analysis_status,
         r.status AS report_status, d.status AS delivery_status, d.last_delivered_head_sha
  FROM pr_analysis a
  LEFT JOIN pr_report r ON r.pr_analysis_id = a.id
  LEFT JOIN pr_comment_delivery d ON d.repo_id = a.repo_id AND d.pull_request_number = a.pull_request_number
  ORDER BY a.created_at DESC LIMIT 20
`);
const currentByBranch = new Map<string, string>(graphs.rows.map((row) => [`${String(row.repo_id)}:${String(row.branch)}`, String(row.commit_sha)]));
const staleBranches: Array<{ repoId: number; branch: string; currentSha: string | null; liveSha: string | null; error?: string }> = [];
const reader = new GitHubRepositoryReader();
for (const config of await listActiveRepoConfigs()) {
  if (!config.owner || !config.name) continue;
  try {
    const liveSha = await reader.resolveBranchSha({ installationId: config.installationId, owner: config.owner, name: config.name, branch: config.trackedBranch });
    const currentSha = currentByBranch.get(`${config.repoId}:${config.trackedBranch}`) ?? null;
    if (currentSha !== liveSha) staleBranches.push({ repoId: config.repoId, branch: config.trackedBranch, currentSha, liveSha });
  } catch (error) {
    staleBranches.push({ repoId: config.repoId, branch: config.trackedBranch, currentSha: currentByBranch.get(`${config.repoId}:${config.trackedBranch}`) ?? null, liveSha: null, error: error instanceof Error ? error.message : "unknown error" });
  }
}
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), jobs: rows.rows, currentGraphs: graphs.rows, projects: projects.rows, staleBranches, recentPrs: recentPrs.rows }, null, 2));
await pool.end();

import { z } from "zod";

import type { BaselineGraph, GraphFileKind, RepositorySource } from "../graph/types.js";

export type FeatureEntryKind = "page" | "api_route";

export interface FeatureContextItem {
  id: string;
  path: string;
  blobSha: string;
  role: "entrypoint" | "dependency";
  excerpt: string;
}

export interface FeatureContext {
  entryPath: string;
  entryKind: FeatureEntryKind;
  routeLabel: string;
  sourceFingerprint: string;
  commitSha: string;
  items: FeatureContextItem[];
  reachablePaths: string[];
}

export interface FeatureScenario {
  id: string;
  title: string;
  steps: string[];
  contextIds: string[];
}

export interface FeatureCard {
  version: 1;
  title: string;
  description: string;
  scenarios: FeatureScenario[];
}

export interface FeatureCardGenerationResult {
  card: FeatureCard;
  model: string;
  providerResponseId: string | null;
}

export interface FeatureCardGenerator {
  generate(context: FeatureContext): Promise<FeatureCardGenerationResult>;
}

export const featureCardSchema = z.object({
  version: z.literal(1),
  title: z.string().min(3).max(100),
  description: z.string().min(3).max(300),
  scenarios: z.array(z.object({
    id: z.string().min(1).max(64),
    title: z.string().min(3).max(120),
    steps: z.array(z.string().min(3).max(220)).min(1).max(3),
    contextIds: z.array(z.string().min(1)).min(1).max(4),
  })).min(1).max(5),
});

export interface FeatureIndexRequest {
  repoId: number;
  branch: string;
  sha: string;
  mode: "full" | "incremental";
  // Graph paths that were reanalyzed for this push. Incremental indexing starts
  // reverse traversal here instead of scanning every route.
  changedPaths?: string[];
}

export interface FeatureCardRecord {
  entryPath: string;
  entryKind: FeatureEntryKind;
  sourceFingerprint: string;
  sourceCommitSha: string;
  status: "ready" | "unavailable";
  card: FeatureCard | null;
}

export interface FeatureGraphInput {
  source: RepositorySource;
  graph: BaselineGraph;
  entryPath: string;
  entryKind: GraphFileKind;
}

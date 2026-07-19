// Legacy values remain readable in fixtures/persisted reports, but new graph
// construction emits generic module kinds and stores route meaning separately.
export type GraphFileKind = "module" | "component" | "style" | "tooling" | "unknown" | "page" | "api_route" | "layout" | "loading" | "error_boundary" | "metadata" | "shared_module";
export type GraphSymbolKind = "function" | "class" | "component" | "variable";
export type GraphImportKind = "static" | "dynamic" | "type_only" | "require";
export type GraphImportResolutionStatus = "resolved" | "unresolved" | "external" | "asset";
/** A conservative deterministic description of a module's technical job. */
export type TechnicalRole = "application" | "presentation" | "ui_primitive" | "analytics" | "infrastructure" | "styling" | "configuration" | "testing" | "utility" | "unknown";
export type TechnicalRoleStrength = "strong" | "heuristic" | "unknown";

export type PrimaryFramework = "next" | "react_router" | "remix" | "express" | "generic" | "ambiguous";
export type ProtocolProfile = "trpc";
export type ProjectStatus = "supported" | "graph_only" | "ambiguous" | "unsupported";
export type GraphEntrypointKind = "web_route" | "api_route";

export interface SourceFile {
  path: string;
  blobSha: string;
  content: string;
}

/** A source project/package discovered at a specific repository SHA. */
export interface ProjectDescriptor {
  rootPath: string;
  packageName: string | null;
  packageType: "module" | "commonjs" | "unspecified";
  configPath: string | null;
  primaryFramework: PrimaryFramework;
  protocolProfiles: ProtocolProfile[];
  status: ProjectStatus;
  reason: string | null;
}

export interface GraphProject extends ProjectDescriptor {}

export interface RepositorySource {
  repoId: number;
  owner: string;
  name: string;
  branch: string;
  sha: string;
  /** Full repository path set at this commit. `files` may be a targeted subset. */
  allFilePaths?: string[];
  files: SourceFile[];
}

export interface RepositoryTreeEntry {
  path: string;
  blobSha: string;
}

export interface CommitFileChange {
  path: string;
  status: "added" | "modified" | "removed" | "renamed";
  previousPath?: string;
}

export interface CommitComparison {
  comparable: boolean;
  reason: string | null;
  changes: CommitFileChange[];
}

export interface GraphFile {
  path: string;
  projectRoot?: string;
  blobSha: string;
  kind: GraphFileKind;
  classificationReason: string;
  technicalRole: TechnicalRole;
  technicalRoleReason: string;
  technicalRoleStrength: TechnicalRoleStrength;
}

export interface GraphSymbol {
  filePath: string;
  symbolKey: string;
  name: string;
  kind: GraphSymbolKind;
  isExported: boolean;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  sourceHash: string;
}

/** A resolved source-module dependency. External dependencies intentionally have no target. */
export interface GraphImport {
  fromPath: string;
  toPath: string | null;
  specifier: string;
  kind: GraphImportKind;
  resolutionStatus: GraphImportResolutionStatus;
  unresolvedReason: string | null;
}

/** A framework-proven HTTP/page entrypoint. */
export interface GraphEntrypoint {
  projectRoot: string;
  filePath: string;
  kind: GraphEntrypointKind;
  routePath: string;
  httpMethod: string | null;
  startLine: number;
  startColumn: number;
  reason: string;
}

/** A statically proven protocol connection that augments normal imports. */
export interface GraphProtocolBinding {
  protocol: "trpc";
  callerFilePath: string;
  handlerFilePath: string;
  operation: string;
  startLine: number;
  startColumn: number;
  reason: string;
}

export interface BaselineGraph {
  projects?: GraphProject[];
  files: GraphFile[];
  symbols: GraphSymbol[];
  imports: GraphImport[];
  entrypoints?: GraphEntrypoint[];
  protocolBindings?: GraphProtocolBinding[];
}

export interface BaselineBuildRequest {
  repoId: number;
  sha?: string;
  reuseReadySnapshot?: boolean;
  buildMetadata?: {
    buildMode: "full" | "full_fallback";
    fallbackReason?: string | null;
    changedFileCount?: number;
  };
}

export interface BaselineBuildResult {
  snapshotId: string;
  repoId: number;
  branch: string;
  sha: string;
  status: "ready";
  projectCount: number;
  entrypointCount: number;
  protocolBindingCount: number;
  fileCount: number;
  symbolCount: number;
  importCount: number;
  unresolvedImportCount: number;
  buildDurationMs: number;
  buildMode: "full" | "incremental" | "full_fallback";
  baseSnapshotId: string | null;
  changedFileCount: number;
  reanalyzedFileCount: number;
  fallbackReason: string | null;
}

export interface IncrementalGraphUpdateRequest {
  repoId: number;
  branch: string;
  beforeSha: string;
  afterSha: string;
}

export interface SupersededGraphUpdateResult { status: "superseded"; liveSha: string; }
export interface IncrementalGraphUpdateResult extends BaselineBuildResult { reanalyzedPaths: string[]; }

export interface RepositoryReader {
  resolveRepository(repoId: number, installationId: number): Promise<{ owner: string; name: string; defaultBranch: string }>;
  resolveBranchSha(input: { repoId: number; installationId: number; owner: string; name: string; branch: string }): Promise<string>;
  fetchSource(input: { repoId: number; installationId: number; owner: string; name: string; branch: string; sha: string }): Promise<RepositorySource>;
  fetchTree(input: { repoId: number; installationId: number; owner: string; name: string; branch: string; sha: string }): Promise<RepositoryTreeEntry[]>;
  fetchFiles(input: { repoId: number; installationId: number; owner: string; name: string; branch: string; sha: string; paths: string[] }): Promise<SourceFile[]>;
  compareCommits(input: { installationId: number; owner: string; name: string; beforeSha: string; afterSha: string }): Promise<CommitComparison>;
}

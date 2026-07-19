export type GraphFileKind =
  | "page"
  | "api_route"
  | "layout"
  | "loading"
  | "error_boundary"
  | "metadata"
  | "component"
  | "style"
  | "tooling"
  | "shared_module"
  | "unknown";
export type GraphSymbolKind = "function" | "class" | "component" | "variable";
export type GraphImportKind = "static" | "dynamic" | "type_only";
export type GraphImportResolutionStatus = "resolved" | "unresolved" | "external" | "asset";
export type TechnicalRole = "business_logic" | "presentation" | "ui_primitive" | "analytics" | "infrastructure" | "styling" | "configuration" | "testing" | "utility" | "application_module" | "unknown";
export type TechnicalRoleStrength = "strong" | "heuristic" | "unknown";

export interface SourceFile {
  path: string;
  blobSha: string;
  content: string;
}

export interface RepositorySource {
  repoId: number;
  owner: string;
  name: string;
  branch: string;
  sha: string;
  // Complete TypeScript/TSX path set at this commit. `files` may contain only
  // the blobs required for an incremental analysis.
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
  blobSha: string;
  kind: GraphFileKind;
  classificationReason: string;
  technicalRole?: TechnicalRole;
  technicalRoleReason?: string;
  technicalRoleStrength?: TechnicalRoleStrength;
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

export interface GraphImport {
  fromPath: string;
  toPath: string | null;
  specifier: string;
  kind: GraphImportKind;
  resolutionStatus: GraphImportResolutionStatus;
  unresolvedReason: string | null;
}

export interface BaselineGraph {
  files: GraphFile[];
  symbols: GraphSymbol[];
  imports: GraphImport[];
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

export interface SupersededGraphUpdateResult {
  status: "superseded";
  liveSha: string;
}

/** Additional non-persisted data used to scope downstream feature-card work. */
export interface IncrementalGraphUpdateResult extends BaselineBuildResult {
  // Paths reanalyzed while producing the current graph. They include reverse
  // dependents of deleted/renamed files, which makes them safe feature-index seeds.
  featureIndexPaths: string[];
}

export interface RepositoryReader {
  resolveRepository(repoId: number, installationId: number): Promise<{
    owner: string;
    name: string;
    defaultBranch: string;
  }>;
  resolveBranchSha(input: {
    repoId: number;
    installationId: number;
    owner: string;
    name: string;
    branch: string;
  }): Promise<string>;
  fetchSource(input: {
    repoId: number;
    installationId: number;
    owner: string;
    name: string;
    branch: string;
    sha: string;
  }): Promise<RepositorySource>;
  fetchTree(input: {
    repoId: number;
    installationId: number;
    owner: string;
    name: string;
    branch: string;
    sha: string;
  }): Promise<RepositoryTreeEntry[]>;
  fetchFiles(input: {
    repoId: number;
    installationId: number;
    owner: string;
    name: string;
    branch: string;
    sha: string;
    paths: string[];
  }): Promise<SourceFile[]>;
  compareCommits(input: {
    installationId: number;
    owner: string;
    name: string;
    beforeSha: string;
    afterSha: string;
  }): Promise<CommitComparison>;
}

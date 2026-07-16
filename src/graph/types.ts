export type GraphFileKind = "page" | "api_route" | "component" | "shared_module" | "unknown";
export type GraphSymbolKind = "function" | "class" | "component" | "variable";
export type GraphImportKind = "static" | "dynamic" | "type_only";
export type GraphImportResolutionStatus = "resolved" | "unresolved" | "external";

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
  files: SourceFile[];
}

export interface GraphFile {
  path: string;
  blobSha: string;
  kind: GraphFileKind;
  classificationReason: string;
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
}

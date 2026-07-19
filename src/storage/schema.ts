import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Repository-level app configuration used by webhook handlers.
export const repoConfigTable = pgTable("repo_config", {
  // GitHub repository id. Primary key because one config row per repo.
  repoId: bigint("repo_id", { mode: "number" }).primaryKey(),
  // GitHub App installation id that owns this repository config.
  installationId: bigint("installation_id", { mode: "number" }).notNull(),
  // GitHub account or organization that owns the repository; needed for GitHub content API calls.
  owner: text("owner"),
  // GitHub repository name within owner; together with owner identifies the repository for API calls.
  name: text("name"),
  // Single tracked base branch for MVP impact analysis.
  trackedBranch: text("tracked_branch").notNull().default("main"),
  // Soft enable/disable flag without deleting config history.
  isActive: boolean("is_active").notNull().default(true),
  // Why this configuration is active or inactive: active, suspended, removed, or deleted.
  // This prevents a later unsuspend event from reactivating a repository that was removed.
  accessState: text("access_state").notNull().default("active"),
  // Explicit control for bounded PR source context sent to OpenAI. Graph facts
  // and reachability are deterministic regardless of this setting.
  aiAssistanceEnabled: boolean("ai_assistance_enabled").notNull().default(true),
  // Row creation timestamp.
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Last config update timestamp.
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Immutable build metadata for one repository branch commit. Fact tables below
// belong only to the snapshot currently selected for that repository branch.
export const graphSnapshotTable = pgTable(
  "graph_snapshot",
  {
    // Internal snapshot identifier; referenced by the current mutable graph facts.
    id: uuid("id").primaryKey().defaultRandom(),
    // Installed GitHub repository whose source graph this snapshot represents.
    repoId: bigint("repo_id", { mode: "number" })
      .notNull()
      .references(() => repoConfigTable.repoId),
    // Tracked branch name used to resolve the baseline commit.
    branch: text("branch").notNull(),
    // Exact Git commit SHA analyzed; every future impact claim must be tied to this source state.
    commitSha: text("commit_sha").notNull(),
    // Build lifecycle: building while incomplete, ready when valid, failed when no trustworthy graph was produced.
    status: text("status").notNull(),
    // How this snapshot was produced: a complete build, a partial recomputation, or its safe fallback.
    buildMode: text("build_mode").notNull().default("full"),
    // Previous current snapshot used as the source for an incremental build; null for a full build.
    baseSnapshotId: uuid("base_snapshot_id"),
    // True only for the snapshot currently represented by the mutable graph fact tables for this branch.
    isCurrent: boolean("is_current").notNull().default(false),
    // Number of paths reported by GitHub as changed for this commit transition.
    changedFileCount: integer("changed_file_count").notNull().default(0),
    // Number of source files parsed again for this snapshot.
    reanalyzedFileCount: integer("reanalyzed_file_count").notNull().default(0),
    // Why a full fallback was selected instead of incremental analysis, if applicable.
    fallbackReason: text("fallback_reason"),
    // Number of analyzed code and style files successfully stored in this snapshot.
    fileCount: integer("file_count").notNull().default(0),
    // Number of discovered JS/TS projects/packages represented by this repository snapshot.
    projectCount: integer("project_count").notNull().default(0),
    // Number of verified framework entrypoints (pages and HTTP handlers).
    entrypointCount: integer("entrypoint_count").notNull().default(0),
    // Number of verified protocol bindings such as a tRPC client call to a procedure.
    protocolBindingCount: integer("protocol_binding_count").notNull().default(0),
    // Number of top-level function, class, variable, or component symbols stored in this snapshot.
    symbolCount: integer("symbol_count").notNull().default(0),
    // Number of directed import relationships stored in this snapshot.
    importCount: integer("import_count").notNull().default(0),
    // Number of local imports that could not be resolved; retained as report evidence.
    unresolvedImportCount: integer("unresolved_import_count").notNull().default(0),
    // End-to-end fetch, analysis, and persistence duration for Phase 2 build metrics.
    buildDurationMs: integer("build_duration_ms"),
    // Deterministic error message retained when a build fails; failed snapshots are never used for analysis.
    failureReason: text("failure_reason"),
    // When this snapshot record was created in the building state.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // When the build transitioned to ready or failed.
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    // Enforces one snapshot metadata record for a repository, tracked branch, and exact commit.
    uniqueIndex("graph_snapshot_repo_branch_sha_unique").on(table.repoId, table.branch, table.commitSha),
    // A branch has one materialized graph. Historical snapshot rows remain metadata only.
    uniqueIndex("graph_snapshot_current_branch_unique").on(table.repoId, table.branch).where(sql`"is_current" = true`),
  ],
);

// Stable repository-local project/package identity. A project is selected by
// its deepest repository-relative root, not by an inferred framework route.
export const graphProjectTable = pgTable(
  "graph_project",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    repoId: bigint("repo_id", { mode: "number" }).notNull().references(() => repoConfigTable.repoId),
    rootPath: text("root_path").notNull(),
    packageName: text("package_name"),
    packageType: text("package_type").notNull(),
    configPath: text("config_path"),
    primaryFramework: text("primary_framework").notNull(),
    protocolProfiles: jsonb("protocol_profiles").$type<string[]>().notNull().default([]),
    status: text("status").notNull(),
    reason: text("reason"),
    isActive: boolean("is_active").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("graph_project_repo_root_unique").on(table.repoId, table.rootPath)],
);

// Current mutable source-file facts for a repository branch.
export const graphFileTable = pgTable(
  "graph_file",
  {
    // Internal file-row identifier used by symbol and import foreign keys.
    id: bigserial("id", { mode: "number" }).primaryKey(),
    // Current snapshot that owns this fact. Ownership moves forward on each successful build.
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => graphSnapshotTable.id),
    // Project/package that owns this path in a monorepo. Cross-project imports
    // remain normal import rows pointing to another graph_file.
    projectId: bigint("project_id", { mode: "number" }).notNull().references(() => graphProjectTable.id),
    // Repository-relative source path, for example src/app/checkout/page.tsx.
    path: text("path").notNull(),
    // Git blob SHA proving the exact file content observed during this snapshot build.
    blobSha: text("blob_sha").notNull(),
    // Deterministic role: route entrypoint, component, style, tooling, shared module, or unknown fallback.
    kind: text("kind").notNull(),
    // Explicit filesystem/AST rule that produced kind; used as report evidence rather than inference.
    classificationReason: text("classification_reason").notNull(),
    technicalRole: text("technical_role").notNull(),
    technicalRoleReason: text("technical_role_reason").notNull(),
    technicalRoleStrength: text("technical_role_strength").notNull(),
  },
  (table) => [
    // A repository path can appear only once in the current materialized graph.
    uniqueIndex("graph_file_snapshot_path_unique").on(table.snapshotId, table.path),
  ],
);

// Framework-proven user-facing routes and server handlers. These facts are
// separate from graph_file because generic source files do not imply routes.
export const graphEntrypointTable = pgTable(
  "graph_entrypoint",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    snapshotId: uuid("snapshot_id").notNull().references(() => graphSnapshotTable.id),
    projectId: bigint("project_id", { mode: "number" }).notNull().references(() => graphProjectTable.id),
    fileId: bigint("file_id", { mode: "number" }).notNull().references(() => graphFileTable.id),
    kind: text("kind").notNull(),
    routePath: text("route_path").notNull(),
    httpMethod: text("http_method"),
    startLine: integer("start_line").notNull(),
    startColumn: integer("start_column").notNull(),
    reason: text("reason").notNull(),
  },
  (table) => [
    uniqueIndex("graph_entrypoint_snapshot_identity_unique").on(table.snapshotId, table.projectId, table.kind, table.routePath, table.httpMethod),
    index("graph_entrypoint_snapshot_file_idx").on(table.snapshotId, table.fileId),
  ],
);

// Verified source-level protocol links. The initial supported protocol is tRPC;
// keeping it separate prevents protocol claims from masquerading as imports.
export const graphProtocolBindingTable = pgTable(
  "graph_protocol_binding",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    snapshotId: uuid("snapshot_id").notNull().references(() => graphSnapshotTable.id),
    protocol: text("protocol").notNull(),
    callerFileId: bigint("caller_file_id", { mode: "number" }).notNull().references(() => graphFileTable.id),
    handlerFileId: bigint("handler_file_id", { mode: "number" }).notNull().references(() => graphFileTable.id),
    operation: text("operation").notNull(),
    startLine: integer("start_line").notNull(),
    startColumn: integer("start_column").notNull(),
    reason: text("reason").notNull(),
  },
  (table) => [
    uniqueIndex("graph_protocol_binding_snapshot_identity_unique").on(table.snapshotId, table.callerFileId, table.handlerFileId, table.operation),
    index("graph_protocol_binding_snapshot_handler_idx").on(table.snapshotId, table.handlerFileId),
  ],
);

// Top-level source symbols used as deterministic change evidence in later phases.
export const graphSymbolTable = pgTable(
  "graph_symbol",
  {
    // Internal symbol-row identifier.
    id: bigserial("id", { mode: "number" }).primaryKey(),
    // Current snapshot that owns this symbol fact.
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => graphSnapshotTable.id),
    // File declaration containing this top-level symbol.
    fileId: bigint("file_id", { mode: "number" })
      .notNull()
      .references(() => graphFileTable.id),
    // Stable within-snapshot logical identity: repository path, symbol kind, and declared name.
    symbolKey: text("symbol_key").notNull(),
    // Declared source name, such as calculateDiscount or CheckoutPage.
    name: text("name").notNull(),
    // Deterministic declaration kind: function, class, variable, or component.
    kind: text("kind").notNull(),
    // Whether the declaration is explicitly exported from its module.
    isExported: boolean("is_exported").notNull(),
    // One-based start line of the declaration for human-readable evidence.
    startLine: integer("start_line").notNull(),
    // One-based start column of the declaration for human-readable evidence.
    startColumn: integer("start_column").notNull(),
    // One-based end line of the declaration for human-readable evidence.
    endLine: integer("end_line").notNull(),
    // One-based end column of the declaration for human-readable evidence.
    endColumn: integer("end_column").notNull(),
    // SHA-256 of the declaration source; Phase 4 can compare it to identify changed symbols.
    sourceHash: text("source_hash").notNull(),
  },
  (table) => [
    // Prevents conflicting symbol facts for the same logical symbol in the current graph.
    uniqueIndex("graph_symbol_snapshot_key_unique").on(table.snapshotId, table.symbolKey),
  ],
);

// Directed file import edges. Querying target_file_id yields the reverse graph.
export const graphImportTable = pgTable(
  "graph_import",
  {
    // Internal import-edge identifier.
    id: bigserial("id", { mode: "number" }).primaryKey(),
    // Current snapshot that owns this dependency edge.
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => graphSnapshotTable.id),
    // File that declares the import; this is the forward edge origin.
    fromFileId: bigint("from_file_id", { mode: "number" })
      .notNull()
      .references(() => graphFileTable.id),
    // Resolved local graph target; null for external packages, static assets outside the graph, and unresolved imports.
    toFileId: bigint("to_file_id", { mode: "number" }).references(() => graphFileTable.id),
    // Literal source specifier, for example @/lib/discount or ../components/Button.
    specifier: text("specifier").notNull(),
    // Import form: static, dynamic import(), or type_only.
    kind: text("kind").notNull(),
    // Resolution result: resolved graph edge, unresolved, external package, or local asset outside the graph.
    resolutionStatus: text("resolution_status").notNull(),
    // Why a local import could not resolve; null for resolved, external, and known asset imports.
    unresolvedReason: text("unresolved_reason"),
  },
  (table) => [
    // Supports normal dependency lookup: what does this file import?
    index("graph_import_snapshot_from_file_idx").on(table.snapshotId, table.fromFileId),
    // Supports reverse traversal: which files depend on this file? No duplicate reverse rows are stored.
    index("graph_import_snapshot_to_file_idx").on(table.snapshotId, table.toFileId),
  ],
);

// One durable deterministic analysis result for a PR head commit. Phase 5 reads
// this evidence; it does not need to rebuild or infer the impact graph.
export const prAnalysisTable = pgTable(
  "pr_analysis",
  {
    // Internal analysis-run identifier.
    id: uuid("id").primaryKey().defaultRandom(),
    // Repository and GitHub PR number that own this analysis.
    repoId: bigint("repo_id", { mode: "number" }).notNull().references(() => repoConfigTable.repoId),
    pullRequestNumber: integer("pull_request_number").notNull(),
    // Exact source pair used as deterministic evidence.
    baseSha: text("base_sha").notNull(),
    headSha: text("head_sha").notNull(),
    // building, ready, insufficient_evidence, or failed.
    status: text("status").notNull(),
    // high, medium, or low when analysis is ready; null otherwise.
    impactLevel: text("impact_level"),
    // Validated deterministic result payload consumed by Phase 5.
    resultJson: jsonb("result_json").$type<Record<string, unknown>>(),
    // Deterministic insufficiency or operational failure reason.
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    // Repeated webhook deliveries for the same PR head reuse one analysis result.
    uniqueIndex("pr_analysis_repo_pr_head_unique").on(table.repoId, table.pullRequestNumber, table.headSha),
    index("pr_analysis_repo_pr_status_idx").on(table.repoId, table.pullRequestNumber, table.status),
  ],
);

// Rendered deterministic report for one PR analysis. Phase 6 reads this row to
// deliver a comment without recomputing graph facts or calling an LLM again.
export const prReportTable = pgTable(
  "pr_report",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    prAnalysisId: uuid("pr_analysis_id").notNull().references(() => prAnalysisTable.id),
    // building or ready; a model failure still produces a ready fallback report.
    status: text("status").notNull(),
    evidenceJson: jsonb("evidence_json").$type<Record<string, unknown>>().notNull(),
    // Exact bounded source packet that was permitted to leave the repository.
    semanticInputJson: jsonb("semantic_input_json").$type<Record<string, unknown>>().notNull(),
    // Validated model output. Null for deterministic fallback reports.
    semanticResultJson: jsonb("semantic_result_json").$type<Record<string, unknown>>(),
    markdown: text("markdown").notNull(),
    model: text("model"),
    providerResponseId: text("provider_response_id"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    // not_requested for insufficient evidence, completed, or fallback.
    llmStatus: text("llm_status").notNull(),
    llmError: text("llm_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("pr_report_analysis_unique").on(table.prAnalysisId),
  ],
);

// One mutable pointer to the single sticky GitHub timeline comment for a PR.
// Analyses and reports are immutable per head SHA; this record selects which
// report is currently visible to developers on the pull request.
export const prCommentDeliveryTable = pgTable(
  "pr_comment_delivery",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: bigint("repo_id", { mode: "number" }).notNull().references(() => repoConfigTable.repoId),
    pullRequestNumber: integer("pull_request_number").notNull(),
    // GitHub issue-comment ID. Null until the first successful delivery.
    commentId: bigint("comment_id", { mode: "number" }),
    // Newest analysis selected for delivery; older queued jobs must not overwrite it.
    desiredAnalysisId: uuid("desired_analysis_id").references(() => prAnalysisTable.id),
    desiredHeadSha: text("desired_head_sha").notNull(),
    lastDeliveredAnalysisId: uuid("last_delivered_analysis_id").references(() => prAnalysisTable.id),
    lastDeliveredHeadSha: text("last_delivered_head_sha"),
    // pending, delivered, or failed. Analysis/report lifecycle remains elsewhere.
    status: text("status").notNull().default("pending"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pr_comment_delivery_repo_pr_unique").on(table.repoId, table.pullRequestNumber),
  ],
);

// Auditable policy output between raw deterministic analysis and presentation.
export const prImpactAssessmentTable = pgTable("pr_impact_assessment", {
  id: uuid("id").primaryKey().defaultRandom(), prAnalysisId: uuid("pr_analysis_id").notNull().references(() => prAnalysisTable.id),
  version: integer("version").notNull(), status: text("status").notNull(), assessmentJson: jsonb("assessment_json").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [uniqueIndex("pr_impact_assessment_analysis_unique").on(table.prAnalysisId)]);

// Raw webhook delivery ledger for traceability and dedupe support.
export const eventIngestTable = pgTable("event_ingest", {
  // GitHub delivery id. One row per webhook delivery.
  deliveryId: text("delivery_id").primaryKey(),
  // Top-level GitHub event name such as installation or pull_request.
  eventName: text("event_name").notNull(),
  // Event action such as opened or synchronize when present.
  eventAction: text("event_action"),
  // Repository id if available in payload.
  repoId: bigint("repo_id", { mode: "number" }),
  // SHA256 hash of the raw payload body for integrity/audit.
  payloadSha256: text("payload_sha256").notNull(),
  // Time this delivery was recorded.
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

// Durable queue intent table with idempotency protection.
export const jobQueueEnqueuedTable = pgTable("job_queue_enqueued", {
  // Internal surrogate id for ordering and diagnostics.
  id: bigserial("id", { mode: "number" }).primaryKey(),
  // Deterministic dedupe key computed from delivery and event identity.
  idempotencyKey: text("idempotency_key").notNull().unique(),
  // Source webhook delivery id for traceability back to event_ingest.
  deliveryId: text("delivery_id")
    .notNull()
    .references(() => eventIngestTable.deliveryId),
  // Internal job type consumed by downstream workers.
  jobType: text("job_type").notNull(),
  // Canonical JSON payload for the queued job.
  jobPayload: jsonb("job_payload").$type<Record<string, unknown>>().notNull(),
  // Durable worker lifecycle: pending, running, completed, or failed.
  status: text("status").notNull().default("pending"),
  // Number of times a worker has claimed this job.
  attempts: integer("attempts").notNull().default(0),
  // First claim time; retained across retries to measure queue latency.
  firstStartedAt: timestamp("first_started_at", { withTimezone: true }),
  // Earliest time a worker may claim this job; supports future retry backoff.
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  // When a worker claimed this job for processing.
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  // Fenced worker ownership. Completion updates must match this token.
  leaseToken: uuid("lease_token"),
  // A crashed worker's lease can be reclaimed after this time.
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  // When a worker completed processing this job successfully.
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // Last deterministic processing error, retained when the job fails.
  lastError: text("last_error"),
  // transient, permanent, timeout, cancelled, or worker_lost.
  lastErrorKind: text("last_error_kind"),
  // Final completion/failure time, distinct from a retry's intermediate state.
  terminalAt: timestamp("terminal_at", { withTimezone: true }),
  // Time this job intent was persisted.
  enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Lets workers efficiently claim ready jobs of a supported type.
  index("job_queue_enqueued_status_available_idx").on(table.status, table.availableAt),
]);

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
  // Row creation timestamp.
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Last config update timestamp.
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Immutable baseline graph metadata for one repository branch commit.
export const graphSnapshotTable = pgTable(
  "graph_snapshot",
  {
    // Internal immutable snapshot identifier; referenced by all graph facts below.
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
    // Version of the persisted graph format, allowing future readers to reject incompatible snapshots.
    graphSchemaVersion: integer("graph_schema_version").notNull().default(1),
    // Number of TypeScript/TSX files successfully stored in this snapshot.
    fileCount: integer("file_count").notNull().default(0),
    // Number of top-level function, class, variable, or component symbols stored in this snapshot.
    symbolCount: integer("symbol_count").notNull().default(0),
    // Number of directed import relationships stored in this snapshot.
    importCount: integer("import_count").notNull().default(0),
    // Number of local imports that could not be resolved; later phases use this to lower confidence.
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
    // Enforces one immutable baseline graph for a repository, tracked branch, and exact commit.
    uniqueIndex("graph_snapshot_repo_branch_sha_unique").on(table.repoId, table.branch, table.commitSha),
  ],
);

// Source file facts belonging to one immutable graph snapshot.
export const graphFileTable = pgTable(
  "graph_file",
  {
    // Internal file-row identifier used by symbol and import foreign keys.
    id: bigserial("id", { mode: "number" }).primaryKey(),
    // Immutable snapshot that owns this file fact.
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => graphSnapshotTable.id),
    // Repository-relative source path, for example src/app/checkout/page.tsx.
    path: text("path").notNull(),
    // Git blob SHA proving the exact file content observed during this snapshot build.
    blobSha: text("blob_sha").notNull(),
    // Deterministic role: page, api_route, component, shared_module, or unknown.
    kind: text("kind").notNull(),
    // Explicit filesystem/AST rule that produced kind; used as report evidence rather than inference.
    classificationReason: text("classification_reason").notNull(),
  },
  (table) => [
    // A repository path can appear only once in one immutable snapshot.
    uniqueIndex("graph_file_snapshot_path_unique").on(table.snapshotId, table.path),
  ],
);

// Top-level source symbols used as deterministic change evidence in later phases.
export const graphSymbolTable = pgTable(
  "graph_symbol",
  {
    // Internal symbol-row identifier.
    id: bigserial("id", { mode: "number" }).primaryKey(),
    // Immutable snapshot that owns this symbol fact.
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
    // Prevents conflicting symbol facts for the same logical symbol in one snapshot.
    uniqueIndex("graph_symbol_snapshot_key_unique").on(table.snapshotId, table.symbolKey),
  ],
);

// Directed file import edges. Querying target_file_id yields the reverse graph.
export const graphImportTable = pgTable(
  "graph_import",
  {
    // Internal import-edge identifier.
    id: bigserial("id", { mode: "number" }).primaryKey(),
    // Immutable snapshot that owns this dependency edge.
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => graphSnapshotTable.id),
    // File that declares the import; this is the forward edge origin.
    fromFileId: bigint("from_file_id", { mode: "number" })
      .notNull()
      .references(() => graphFileTable.id),
    // Resolved local target file; null for external packages and unresolved local imports.
    toFileId: bigint("to_file_id", { mode: "number" }).references(() => graphFileTable.id),
    // Literal source specifier, for example @/lib/discount or ../components/Button.
    specifier: text("specifier").notNull(),
    // Import form: static, dynamic import(), or type_only.
    kind: text("kind").notNull(),
    // Resolution result: resolved, unresolved, or external package.
    resolutionStatus: text("resolution_status").notNull(),
    // Why a local import could not resolve; null for resolved and external imports.
    unresolvedReason: text("unresolved_reason"),
  },
  (table) => [
    // Supports normal dependency lookup: what does this file import?
    index("graph_import_snapshot_from_file_idx").on(table.snapshotId, table.fromFileId),
    // Supports reverse traversal: which files depend on this file? No duplicate reverse rows are stored.
    index("graph_import_snapshot_to_file_idx").on(table.snapshotId, table.toFileId),
  ],
);

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
  // Earliest time a worker may claim this job; supports future retry backoff.
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  // When a worker claimed this job for processing.
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  // When a worker completed processing this job successfully.
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // Last deterministic processing error, retained when the job fails.
  lastError: text("last_error"),
  // Time this job intent was persisted.
  enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Lets workers efficiently claim ready jobs of a supported type.
  index("job_queue_enqueued_status_available_idx").on(table.status, table.availableAt),
]);

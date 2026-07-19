CREATE TABLE "repo_config" (
  "repo_id" bigint PRIMARY KEY NOT NULL,
  "installation_id" bigint NOT NULL,
  "owner" text,
  "name" text,
  "tracked_branch" text DEFAULT 'main' NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "access_state" text DEFAULT 'active' NOT NULL,
  "ai_assistance_enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_ingest" (
  "delivery_id" text PRIMARY KEY NOT NULL,
  "event_name" text NOT NULL,
  "event_action" text,
  "repo_id" bigint,
  "payload_sha256" text NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_snapshot" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id" bigint NOT NULL,
  "branch" text NOT NULL,
  "commit_sha" text NOT NULL,
  "status" text NOT NULL,
  "build_mode" text DEFAULT 'full' NOT NULL,
  "base_snapshot_id" uuid,
  "is_current" boolean DEFAULT false NOT NULL,
  "changed_file_count" integer DEFAULT 0 NOT NULL,
  "reanalyzed_file_count" integer DEFAULT 0 NOT NULL,
  "fallback_reason" text,
  "file_count" integer DEFAULT 0 NOT NULL,
  "symbol_count" integer DEFAULT 0 NOT NULL,
  "import_count" integer DEFAULT 0 NOT NULL,
  "unresolved_import_count" integer DEFAULT 0 NOT NULL,
  "build_duration_ms" integer,
  "failure_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "graph_file" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "snapshot_id" uuid NOT NULL,
  "path" text NOT NULL,
  "blob_sha" text NOT NULL,
  "kind" text NOT NULL,
  "classification_reason" text NOT NULL,
  "technical_role" text NOT NULL,
  "technical_role_reason" text NOT NULL,
  "technical_role_strength" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_symbol" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "snapshot_id" uuid NOT NULL,
  "file_id" bigint NOT NULL,
  "symbol_key" text NOT NULL,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "is_exported" boolean NOT NULL,
  "start_line" integer NOT NULL,
  "start_column" integer NOT NULL,
  "end_line" integer NOT NULL,
  "end_column" integer NOT NULL,
  "source_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_import" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "snapshot_id" uuid NOT NULL,
  "from_file_id" bigint NOT NULL,
  "to_file_id" bigint,
  "specifier" text NOT NULL,
  "kind" text NOT NULL,
  "resolution_status" text NOT NULL,
  "unresolved_reason" text
);
--> statement-breakpoint
CREATE TABLE "pr_analysis" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id" bigint NOT NULL,
  "pull_request_number" integer NOT NULL,
  "base_sha" text NOT NULL,
  "head_sha" text NOT NULL,
  "status" text NOT NULL,
  "impact_level" text,
  "result_json" jsonb,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pr_impact_assessment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pr_analysis_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "status" text NOT NULL,
  "assessment_json" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pr_report" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pr_analysis_id" uuid NOT NULL,
  "status" text NOT NULL,
  "evidence_json" jsonb NOT NULL,
  "semantic_input_json" jsonb NOT NULL,
  "semantic_result_json" jsonb,
  "markdown" text NOT NULL,
  "model" text,
  "provider_response_id" text,
  "input_tokens" integer,
  "output_tokens" integer,
  "llm_status" text NOT NULL,
  "llm_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pr_comment_delivery" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id" bigint NOT NULL,
  "pull_request_number" integer NOT NULL,
  "comment_id" bigint,
  "desired_analysis_id" uuid,
  "desired_head_sha" text NOT NULL,
  "last_delivered_analysis_id" uuid,
  "last_delivered_head_sha" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_queue_enqueued" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "idempotency_key" text NOT NULL UNIQUE,
  "delivery_id" text NOT NULL,
  "job_type" text NOT NULL,
  "job_payload" jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "first_started_at" timestamp with time zone,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "locked_at" timestamp with time zone,
  "lease_token" uuid,
  "lease_expires_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "last_error" text,
  "last_error_kind" text,
  "terminal_at" timestamp with time zone,
  "enqueued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "graph_snapshot" ADD CONSTRAINT "graph_snapshot_repo_id_repo_config_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "repo_config"("repo_id");
--> statement-breakpoint
ALTER TABLE "graph_file" ADD CONSTRAINT "graph_file_snapshot_id_graph_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "graph_snapshot"("id");
--> statement-breakpoint
ALTER TABLE "graph_symbol" ADD CONSTRAINT "graph_symbol_snapshot_id_graph_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "graph_snapshot"("id");
--> statement-breakpoint
ALTER TABLE "graph_symbol" ADD CONSTRAINT "graph_symbol_file_id_graph_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "graph_file"("id");
--> statement-breakpoint
ALTER TABLE "graph_import" ADD CONSTRAINT "graph_import_snapshot_id_graph_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "graph_snapshot"("id");
--> statement-breakpoint
ALTER TABLE "graph_import" ADD CONSTRAINT "graph_import_from_file_id_graph_file_id_fk" FOREIGN KEY ("from_file_id") REFERENCES "graph_file"("id");
--> statement-breakpoint
ALTER TABLE "graph_import" ADD CONSTRAINT "graph_import_to_file_id_graph_file_id_fk" FOREIGN KEY ("to_file_id") REFERENCES "graph_file"("id");
--> statement-breakpoint
ALTER TABLE "pr_analysis" ADD CONSTRAINT "pr_analysis_repo_id_repo_config_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "repo_config"("repo_id");
--> statement-breakpoint
ALTER TABLE "pr_impact_assessment" ADD CONSTRAINT "pr_impact_assessment_pr_analysis_id_pr_analysis_id_fk" FOREIGN KEY ("pr_analysis_id") REFERENCES "pr_analysis"("id");
--> statement-breakpoint
ALTER TABLE "pr_report" ADD CONSTRAINT "pr_report_pr_analysis_id_pr_analysis_id_fk" FOREIGN KEY ("pr_analysis_id") REFERENCES "pr_analysis"("id");
--> statement-breakpoint
ALTER TABLE "pr_comment_delivery" ADD CONSTRAINT "pr_comment_delivery_repo_id_repo_config_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "repo_config"("repo_id");
--> statement-breakpoint
ALTER TABLE "pr_comment_delivery" ADD CONSTRAINT "pr_comment_delivery_desired_analysis_id_pr_analysis_id_fk" FOREIGN KEY ("desired_analysis_id") REFERENCES "pr_analysis"("id");
--> statement-breakpoint
ALTER TABLE "pr_comment_delivery" ADD CONSTRAINT "pr_comment_delivery_last_delivered_analysis_id_pr_analysis_id_fk" FOREIGN KEY ("last_delivered_analysis_id") REFERENCES "pr_analysis"("id");
--> statement-breakpoint
ALTER TABLE "job_queue_enqueued" ADD CONSTRAINT "job_queue_enqueued_delivery_id_event_ingest_delivery_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "event_ingest"("delivery_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "graph_snapshot_repo_branch_sha_unique" ON "graph_snapshot" ("repo_id", "branch", "commit_sha");
--> statement-breakpoint
CREATE UNIQUE INDEX "graph_snapshot_current_branch_unique" ON "graph_snapshot" ("repo_id", "branch") WHERE "is_current" = true;
--> statement-breakpoint
CREATE UNIQUE INDEX "graph_file_snapshot_path_unique" ON "graph_file" ("snapshot_id", "path");
--> statement-breakpoint
CREATE UNIQUE INDEX "graph_symbol_snapshot_key_unique" ON "graph_symbol" ("snapshot_id", "symbol_key");
--> statement-breakpoint
CREATE INDEX "graph_import_snapshot_from_file_idx" ON "graph_import" ("snapshot_id", "from_file_id");
--> statement-breakpoint
CREATE INDEX "graph_import_snapshot_to_file_idx" ON "graph_import" ("snapshot_id", "to_file_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "pr_analysis_repo_pr_head_unique" ON "pr_analysis" ("repo_id", "pull_request_number", "head_sha");
--> statement-breakpoint
CREATE INDEX "pr_analysis_repo_pr_status_idx" ON "pr_analysis" ("repo_id", "pull_request_number", "status");
--> statement-breakpoint
CREATE UNIQUE INDEX "pr_impact_assessment_analysis_unique" ON "pr_impact_assessment" ("pr_analysis_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "pr_report_analysis_unique" ON "pr_report" ("pr_analysis_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "pr_comment_delivery_repo_pr_unique" ON "pr_comment_delivery" ("repo_id", "pull_request_number");
--> statement-breakpoint
CREATE INDEX "job_queue_enqueued_status_available_idx" ON "job_queue_enqueued" ("status", "available_at");
--> statement-breakpoint
CREATE INDEX "job_queue_enqueued_running_lease_idx" ON "job_queue_enqueued" ("status", "lease_expires_at");

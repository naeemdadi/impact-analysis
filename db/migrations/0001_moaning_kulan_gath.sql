CREATE TABLE "graph_file" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"path" text NOT NULL,
	"blob_sha" text NOT NULL,
	"kind" text NOT NULL,
	"classification_reason" text NOT NULL
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
CREATE TABLE "graph_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" bigint NOT NULL,
	"branch" text NOT NULL,
	"commit_sha" text NOT NULL,
	"status" text NOT NULL,
	"graph_schema_version" integer DEFAULT 1 NOT NULL,
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
ALTER TABLE "repo_config" ADD COLUMN "owner" text;--> statement-breakpoint
ALTER TABLE "repo_config" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "graph_file" ADD CONSTRAINT "graph_file_snapshot_id_graph_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."graph_snapshot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_import" ADD CONSTRAINT "graph_import_snapshot_id_graph_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."graph_snapshot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_import" ADD CONSTRAINT "graph_import_from_file_id_graph_file_id_fk" FOREIGN KEY ("from_file_id") REFERENCES "public"."graph_file"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_import" ADD CONSTRAINT "graph_import_to_file_id_graph_file_id_fk" FOREIGN KEY ("to_file_id") REFERENCES "public"."graph_file"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_snapshot" ADD CONSTRAINT "graph_snapshot_repo_id_repo_config_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repo_config"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_symbol" ADD CONSTRAINT "graph_symbol_snapshot_id_graph_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."graph_snapshot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_symbol" ADD CONSTRAINT "graph_symbol_file_id_graph_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."graph_file"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "graph_file_snapshot_path_unique" ON "graph_file" USING btree ("snapshot_id","path");--> statement-breakpoint
CREATE INDEX "graph_import_snapshot_from_file_idx" ON "graph_import" USING btree ("snapshot_id","from_file_id");--> statement-breakpoint
CREATE INDEX "graph_import_snapshot_to_file_idx" ON "graph_import" USING btree ("snapshot_id","to_file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "graph_snapshot_repo_branch_sha_unique" ON "graph_snapshot" USING btree ("repo_id","branch","commit_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "graph_symbol_snapshot_key_unique" ON "graph_symbol" USING btree ("snapshot_id","symbol_key");
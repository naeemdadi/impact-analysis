ALTER TABLE "graph_snapshot" ADD COLUMN "build_mode" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_snapshot" ADD COLUMN "base_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "graph_snapshot" ADD COLUMN "changed_file_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_snapshot" ADD COLUMN "reanalyzed_file_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_snapshot" ADD COLUMN "fallback_reason" text;

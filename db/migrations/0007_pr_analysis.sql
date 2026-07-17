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
ALTER TABLE "pr_analysis" ADD CONSTRAINT "pr_analysis_repo_id_repo_config_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repo_config"("repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_analysis_repo_pr_head_unique" ON "pr_analysis" USING btree ("repo_id","pull_request_number","head_sha");--> statement-breakpoint
CREATE INDEX "pr_analysis_repo_pr_status_idx" ON "pr_analysis" USING btree ("repo_id","pull_request_number","status");

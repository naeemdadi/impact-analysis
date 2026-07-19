ALTER TABLE "graph_file" ADD COLUMN "technical_role" text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "graph_file" ADD COLUMN "technical_role_reason" text DEFAULT 'not indexed' NOT NULL;
--> statement-breakpoint
ALTER TABLE "graph_file" ADD COLUMN "technical_role_strength" text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
CREATE TABLE "module_domain_card" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "repo_id" bigint NOT NULL, "branch" text NOT NULL, "path" text NOT NULL, "source_fingerprint" text NOT NULL, "status" text NOT NULL, "domain_json" jsonb, "provenance_json" jsonb NOT NULL, "model" text, "provider_response_id" text, "failure_reason" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL);
--> statement-breakpoint
ALTER TABLE "module_domain_card" ADD CONSTRAINT "module_domain_card_repo_id_repo_config_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repo_config"("repo_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "module_domain_card_repo_branch_path_unique" ON "module_domain_card" USING btree ("repo_id", "branch", "path");
--> statement-breakpoint
CREATE TABLE "pr_impact_assessment" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "pr_analysis_id" uuid NOT NULL, "version" integer NOT NULL, "status" text NOT NULL, "assessment_json" jsonb NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "completed_at" timestamp with time zone);
--> statement-breakpoint
ALTER TABLE "pr_impact_assessment" ADD CONSTRAINT "pr_impact_assessment_pr_analysis_id_pr_analysis_id_fk" FOREIGN KEY ("pr_analysis_id") REFERENCES "public"."pr_analysis"("id");
--> statement-breakpoint
CREATE UNIQUE INDEX "pr_impact_assessment_analysis_unique" ON "pr_impact_assessment" USING btree ("pr_analysis_id");

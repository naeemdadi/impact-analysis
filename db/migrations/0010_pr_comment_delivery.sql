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
ALTER TABLE "pr_comment_delivery" ADD CONSTRAINT "pr_comment_delivery_repo_id_repo_config_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repo_config"("repo_id");
--> statement-breakpoint
ALTER TABLE "pr_comment_delivery" ADD CONSTRAINT "pr_comment_delivery_desired_analysis_id_pr_analysis_id_fk" FOREIGN KEY ("desired_analysis_id") REFERENCES "public"."pr_analysis"("id");
--> statement-breakpoint
ALTER TABLE "pr_comment_delivery" ADD CONSTRAINT "pr_comment_delivery_last_delivered_analysis_id_pr_analysis_id_fk" FOREIGN KEY ("last_delivered_analysis_id") REFERENCES "public"."pr_analysis"("id");
--> statement-breakpoint
CREATE UNIQUE INDEX "pr_comment_delivery_repo_pr_unique" ON "pr_comment_delivery" USING btree ("repo_id", "pull_request_number");

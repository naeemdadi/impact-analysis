ALTER TABLE "repo_config" ADD COLUMN "semantic_ai_enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE TABLE "feature_card" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id" bigint NOT NULL,
  "branch" text NOT NULL,
  "entry_path" text NOT NULL,
  "entry_kind" text NOT NULL,
  "source_fingerprint" text NOT NULL,
  "source_commit_sha" text NOT NULL,
  "status" text NOT NULL,
  "card_json" jsonb,
  "provenance_json" jsonb NOT NULL,
  "model" text,
  "provider_response_id" text,
  "failure_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feature_card" ADD CONSTRAINT "feature_card_repo_id_repo_config_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repo_config"("repo_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "feature_card_repo_branch_entry_unique" ON "feature_card" USING btree ("repo_id", "branch", "entry_path");
--> statement-breakpoint
CREATE INDEX "feature_card_repo_branch_fingerprint_idx" ON "feature_card" USING btree ("repo_id", "branch", "source_fingerprint");

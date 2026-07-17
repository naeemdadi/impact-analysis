CREATE TABLE "pr_report" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pr_analysis_id" uuid NOT NULL,
  "status" text NOT NULL,
  "confidence" text NOT NULL,
  "evidence_json" jsonb NOT NULL,
  "selection_json" jsonb NOT NULL,
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
ALTER TABLE "pr_report" ADD CONSTRAINT "pr_report_pr_analysis_id_pr_analysis_id_fk" FOREIGN KEY ("pr_analysis_id") REFERENCES "public"."pr_analysis"("id");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_report_analysis_unique" ON "pr_report" USING btree ("pr_analysis_id");

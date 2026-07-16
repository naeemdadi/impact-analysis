ALTER TABLE "job_queue_enqueued" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_queue_enqueued" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_queue_enqueued" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "job_queue_enqueued" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_queue_enqueued" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_queue_enqueued" ADD COLUMN "last_error" text;--> statement-breakpoint
CREATE INDEX "job_queue_enqueued_status_available_idx" ON "job_queue_enqueued" USING btree ("status","available_at");
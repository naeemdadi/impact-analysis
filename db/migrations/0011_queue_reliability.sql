ALTER TABLE "job_queue_enqueued" ADD COLUMN "first_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "job_queue_enqueued" ADD COLUMN "lease_token" uuid;
--> statement-breakpoint
ALTER TABLE "job_queue_enqueued" ADD COLUMN "lease_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "job_queue_enqueued" ADD COLUMN "last_error_kind" text;
--> statement-breakpoint
ALTER TABLE "job_queue_enqueued" ADD COLUMN "terminal_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "job_queue_enqueued_running_lease_idx" ON "job_queue_enqueued" USING btree ("status", "lease_expires_at");

CREATE TABLE "event_ingest" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"event_name" text NOT NULL,
	"event_action" text,
	"repo_id" bigint,
	"payload_sha256" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_queue_enqueued" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"delivery_id" text NOT NULL,
	"job_type" text NOT NULL,
	"job_payload" jsonb NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_queue_enqueued_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "repo_config" (
	"repo_id" bigint PRIMARY KEY NOT NULL,
	"installation_id" bigint NOT NULL,
	"tracked_branch" text DEFAULT 'main' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_queue_enqueued" ADD CONSTRAINT "job_queue_enqueued_delivery_id_event_ingest_delivery_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."event_ingest"("delivery_id") ON DELETE no action ON UPDATE no action;
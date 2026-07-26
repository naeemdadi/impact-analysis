ALTER TABLE "pr_comment_delivery"
  ADD COLUMN "desired_sequence" bigint;
--> statement-breakpoint
-- Fence existing rows on rollout: a high-water mark above every already-enqueued
-- job, so an in-flight stale retry loses while the first genuinely new event wins.
UPDATE "pr_comment_delivery"
  SET "desired_sequence" = (SELECT COALESCE(MAX("id"), 0) + 1 FROM "job_queue_enqueued")
  WHERE "desired_sequence" IS NULL;

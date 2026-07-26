ALTER TABLE "pr_comment_delivery"
  ADD COLUMN "desired_sequence" bigint;
--> statement-breakpoint
-- Fence existing rows on rollout at the current max job id: an in-flight stale
-- retry (lower id) loses, while the first new event (higher id) still wins.
UPDATE "pr_comment_delivery"
  SET "desired_sequence" = (SELECT COALESCE(MAX("id"), 0) FROM "job_queue_enqueued")
  WHERE "desired_sequence" IS NULL;

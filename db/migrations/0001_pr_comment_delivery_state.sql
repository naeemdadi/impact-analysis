ALTER TABLE "pr_comment_delivery"
  ADD COLUMN "desired_state" text NOT NULL DEFAULT 'ready',
  ADD COLUMN "last_delivered_state" text;

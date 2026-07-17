ALTER TABLE "graph_snapshot" ADD COLUMN "is_current" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DROP INDEX "graph_snapshot_repo_branch_sha_schema_unique";--> statement-breakpoint
ALTER TABLE "graph_snapshot" DROP COLUMN "graph_schema_version";--> statement-breakpoint
CREATE UNIQUE INDEX "graph_snapshot_repo_branch_sha_unique" ON "graph_snapshot" USING btree ("repo_id","branch","commit_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "graph_snapshot_current_branch_unique" ON "graph_snapshot" USING btree ("repo_id","branch") WHERE "is_current" = true;

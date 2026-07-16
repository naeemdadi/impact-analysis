ALTER TABLE "graph_snapshot" ALTER COLUMN "graph_schema_version" SET DEFAULT 2;--> statement-breakpoint
DROP INDEX "graph_snapshot_repo_branch_sha_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "graph_snapshot_repo_branch_sha_schema_unique" ON "graph_snapshot" USING btree ("repo_id","branch","commit_sha","graph_schema_version");

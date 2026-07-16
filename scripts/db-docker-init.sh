#!/usr/bin/env bash
set -euo pipefail

docker compose up -d postgres

# Wait for postgres to become healthy before running migrations.
until [ "$(docker inspect --format='{{.State.Health.Status}}' impact-analysis-postgres 2>/dev/null || true)" = "healthy" ]; do
  sleep 1
done

pnpm run db:migrate

echo "Database is ready and migrations are applied."

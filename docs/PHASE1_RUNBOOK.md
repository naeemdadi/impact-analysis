# Phase 1 Runbook

## 1) Configure environment

1. Copy `.env.example` to `.env`.
2. Set `GITHUB_WEBHOOK_SECRET`.
3. Set `DATABASE_URL`.
4. Set `MANAGED_QUEUE_KIND` to your queue provider name or keep `inline` for local smoke checks.

## 2) Start local Postgres with Docker

Run:

`pnpm run db:docker:init`

This starts Postgres via `docker compose`, waits for readiness and runs `pnpm run db:migrate`.

Useful commands:

- Start only DB: `pnpm run db:docker:up`
- Follow DB logs: `pnpm run db:docker:logs`
- Stop containers: `pnpm run db:docker:down`

## 3) Apply migrations manually (optional)

Run:

`pnpm run db:migrate`

Drizzle Kit commands are also wired:

- Generate migration from schema changes: `pnpm run db:generate`
- Apply pending migrations: `pnpm run db:migrate`
- Check migration health: `pnpm run db:check`
- Open Drizzle Studio: `pnpm run db:studio`

## 4) Start service and installation worker

In one terminal, run:

`pnpm run dev`

In a second terminal, run:

`pnpm run worker`

The worker consumes `installation.sync` jobs. When a repository is installed or added to an existing installation, it builds and stores that repository's initial baseline graph automatically.

Health check:

`curl http://localhost:3000/health`

## 5) Register GitHub App

Use the settings in [github-app/manifest.md](../github-app/manifest.md):

- Webhook URL: `https://<your-url>/webhooks/github`
- Events: `installation`, `push`, `pull_request`
- Permissions: metadata(read), contents(read), pull_requests(read), checks(read/write)

## 6) Install app on a test repo

Install the app and trigger at least one `installation` event.

Expected:

- Service logs `installation event processed`.
- A repo row exists in `repo_config`.
- A job row exists in `job_queue_enqueued` with `job_type = installation.sync`.

Check with:

`SELECT repo_id, tracked_branch, is_active FROM repo_config ORDER BY updated_at DESC LIMIT 5;`

## 7) Validate push and pull_request intake

1. Push one commit to tracked branch.
2. Open or update a PR targeting tracked branch.

Expected:

- Push creates `branch.push` queue row.
- PR creates `pull_request.analyze` queue row.
- Unsupported branches and unsupported PR actions are logged and ignored.

## 8) Validate duplicate suppression

Replay any captured webhook payload with same `x-github-delivery` and same body.

Expected:

- API returns accepted response.
- `event_ingest` has one row for that `delivery_id`.
- `job_queue_enqueued` has one row for that `idempotency_key`.

Check with:

`SELECT delivery_id, COUNT(*) FROM event_ingest GROUP BY delivery_id HAVING COUNT(*) > 1;`

`SELECT idempotency_key, COUNT(*) FROM job_queue_enqueued GROUP BY idempotency_key HAVING COUNT(*) > 1;`

Both queries must return zero rows.

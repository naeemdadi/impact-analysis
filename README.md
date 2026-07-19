# Impact Analysis

Impact Analysis is a GitHub App that posts an evidence-backed Change Impact
Report on pull requests. It answers one bounded question: what should a
developer verify before merging, and which resolved dependency paths support
that recommendation?

The dependency graph proves reachability. AI only summarizes bounded PR source
context and suggests checks for routes already prioritized by deterministic
analysis.

## Run locally

1. Copy `.env.example` to `.env` and set the GitHub App, Postgres, and OpenAI
   values.
2. Start local Postgres and apply the clean baseline migration:

   ```sh
   pnpm db:docker:init
   ```

3. Start the single service. It receives webhooks and runs all durable workers:

   ```sh
   pnpm dev
   ```

4. Configure the GitHub App webhook as:

   ```text
   https://<host>/webhooks/github
   ```

The health endpoint is `GET /health`.

## Commands

```sh
pnpm build                 # Type-check and compile to dist/
pnpm start                 # Run the compiled single service
pnpm test                  # Run all fixture and reliability tests
pnpm db:migrate            # Apply database migrations
pnpm reliability:status    # Inspect queue, graph, and delivery health
```

Use `pnpm set-ai-assistance -- <repoId> <true|false>` to change whether
bounded PR source context is sent to OpenAI for that repository.

## Deployment

For Render, use:

```text
Build command: pnpm install --frozen-lockfile && pnpm build
Start command: node dist/src/server/index.js
Health check: /health
```

This deployment is one always-on Node service plus Postgres. The durable queue
is stored in Postgres; no Redis or external queue is required.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [JavaScript/TypeScript support](docs/JS_TS_SUPPORT.md)
- [Phase plan](docs/PHASE_PLAN.md)
- [GitHub App permissions](github-app/manifest.md)

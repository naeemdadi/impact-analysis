# Impact Analysis High Level Phase Plan

## Purpose

Ship a reliable GitHub App for the hackathon that posts a trusted Change Impact Report on pull requests.

This plan is phase based so we can execute one phase at a time with clear exit criteria.

## Scope Lock for MVP

- One tracked base branch per repository
- Next.js plus React plus TypeScript repositories only
- Pull request analysis for `opened` `synchronize` and `reopened`
- Report posted as one sticky PR comment
- Deterministic evidence first then LLM explanation

## Non Goals for MVP

- Multi branch tracking
- Runtime tracing
- Test generation
- Security or code quality review
- Full business flow understanding

## Phase 0: Foundation and Constraints

### Goal

Define hard boundaries so implementation stays small and reliable.

### Deliverables

- Final MVP scope doc: `docs/PHASE0_MVP_SCOPE.md`
- Success metrics doc: `docs/PHASE0_SUCCESS_METRICS.md`
- Risk register with mitigations: `docs/PHASE0_RISK_REGISTER.md`
- Demo scenario list with 2 to 3 realistic PRs: `docs/PHASE0_DEMO_SCENARIOS.md`

### Exit Criteria

- Team agrees on one tracked branch model
- Team agrees on deterministic first principle
- Team agrees on what will not be built in MVP

### Phase 0 Status

- Draft deliverables created
- Ready for review and lock

## Phase 1: GitHub App Skeleton

### Goal

Receive GitHub events safely and queue work.

### Deliverables

- GitHub App with required permissions and webhook setup
- Webhook signature verification
- Event handlers for `installation` `push` and `pull_request`
- Job queue plumbing with idempotency keys
- Repository config storage with `tracked_branch`

### Exit Criteria

- App can be installed on a test repo
- Webhook events are received and logged
- Duplicate events do not create duplicate jobs

## Phase 2: Baseline Graph Build

### Goal

Build first graph snapshot for the tracked branch.

### Deliverables

- Repository fetch at target commit SHA
- TypeScript path resolution support from `tsconfig`
- Graph builder for files symbols imports and reverse edges
- File classification into pages APIs components and shared modules
- Snapshot persistence keyed by `repo_id` `branch` and `sha`

### Exit Criteria

- First graph snapshot builds successfully on test repo
- Build metrics are recorded like file count and duration
- Snapshot can be loaded back with no schema errors

## Phase 3: Incremental Graph Updates on Push

### Goal

Keep baseline graph fresh with minimal compute.

### Deliverables

- Push diff ingestion between old SHA and new SHA
- Recompute touched files only
- Update affected reverse dependency edges
- Publish new immutable snapshot for new SHA
- Fallback full rebuild path on incremental failure

### Exit Criteria

- Push to tracked branch creates a new valid snapshot
- Incremental update is faster than full rebuild on test repo
- Failure path rebuilds graph without manual intervention

## Phase 4: PR Impact Engine

### Goal

Compute direct and indirect impact from PR changes using baseline graph.

### Deliverables

- PR changed file and changed symbol extraction
- Patch graph for changed files
- Reverse traversal from changed symbols to entrypoints
- Classification into affected pages APIs components and shared modules
- Direct versus indirect impact tagging
- Impact level rules from `SPEC.md`

### Exit Criteria

- Engine returns stable output for same inputs
- Each affected item has at least one dependency path
- Missing evidence suppresses weak claims

## Phase 5: Evidence and LLM Report Generation

### Goal

Generate developer friendly output from deterministic evidence only.

### Deliverables

- Evidence JSON schema and validator
- Prompt template that consumes evidence only
- Report sections: affected why indirect impact verification evidence summary
- Confidence model based on evidence coverage and unresolved imports

### Exit Criteria

- No report claim appears without evidence path
- Low confidence cases show partial confidence message
- Output format matches target in `docs/PRODUCT.md`

## Phase 6: PR Delivery UX

### Goal

Deliver clear and update safe output inside GitHub PR.

### Deliverables

- Sticky comment upsert logic
- Optional check run status integration
- Clear status messages for indexing running failed complete
- Footer with analyzed `base_sha` and `head_sha`

### Exit Criteria

- One PR keeps one continuously updated report comment
- Re run on new commits updates same comment
- Users can understand analysis status quickly

## Phase 7: Reliability Hardening

### Goal

Handle real world event issues and failure modes.

### Deliverables

- Webhook retry and out of order event handling
- Snapshot reconciliation when missing `base_sha`
- Timeout and cancellation controls
- Observability for queue latency build duration and failure rates

### Exit Criteria

- Missed push event does not permanently break analysis
- PR analysis can recover to valid snapshot automatically
- Core flows pass reliability checklist in staging

## Phase 8: Hackathon Submission Readiness

### Goal

Package the project so judges can install run and verify quickly.

### Deliverables

- Final README with setup demo path and architecture
- Judge quickstart with expected output samples
- Demo video script under 3 minutes
- Codex usage notes and session references for submission

### Exit Criteria

- Fresh environment setup works end to end
- Demo runs clean with no manual fixes
- Submission assets satisfy Devpost requirements

## Suggested Execution Order

1. Phase 0 then Phase 1
2. Phase 2 then Phase 3
3. Phase 4 then Phase 5
4. Phase 6 then Phase 7
5. Phase 8 last

## Decision Gates Between Phases

- Gate A after Phase 1: app install and webhook flow is stable
- Gate B after Phase 3: graph freshness model works on tracked branch
- Gate C after Phase 5: report quality is trusted by manual review
- Gate D after Phase 7: reliability is enough for live demo

## Success Metrics for MVP

- PR report available in under 60 seconds for warm snapshots
- At least 90 percent of reported affected areas include valid dependency paths
- Zero hallucinated impact claims in acceptance test PRs
- End to end demo works on first run in clean environment

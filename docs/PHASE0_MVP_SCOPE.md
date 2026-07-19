# Phase 0 MVP Scope

## Objective

Ship a reliable GitHub App that answers change impact questions for pull requests on one tracked base branch.

## In Scope

- GitHub App installation on selected repositories
- One tracked base branch per repository
- Pull request events: `opened` `synchronize` and `reopened`
- Push events on tracked branch for baseline graph freshness
- Baseline graph snapshots keyed by branch commit SHA
- TypeScript and TSX analysis in Next.js repositories
- Deterministic evidence generation
- LLM explanation from deterministic evidence only
- Sticky PR comment with Change Impact Report

## Out of Scope

- Multi branch tracking in one repository
- Runtime tracing or production telemetry
- Test generation
- Security review and code quality review
- Language support beyond TypeScript and TSX
- Full business flow inference
- Dashboard UI for analytics

## Supported Repository Profile

- Next.js plus React plus TypeScript
- Small to medium repositories for hackathon demo reliability

## Product Behavior Rules

- No impact claim without dependency evidence
- If evidence is weak return insufficient evidence and make no impact claim
- If path resolution fails show unresolved imports in evidence
- Deterministic facts come first. LLM text comes second.

## Primary User Journey

1. User installs app on repository.
2. User selects one tracked base branch.
3. App indexes tracked branch and stores baseline snapshot.
4. Developer opens or updates PR into tracked branch.
5. App analyzes PR diff against baseline snapshot.
6. App posts or updates Change Impact Report comment.

## Phase 0 Decisions Locked

- Single tracked branch model is accepted
- Deterministic before AI principle is accepted
- Non goals listed above are excluded from MVP

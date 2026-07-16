# Phase 0 Success Metrics

## Purpose

Define measurable outcomes for MVP readiness and hackathon demo reliability.

## Core Product Metrics

- Report latency on warm snapshot: p50 under 20 seconds and p95 under 60 seconds
- Report latency on cold snapshot: under 5 minutes for target demo repositories
- Deterministic evidence coverage: at least 90 percent of affected items include dependency path evidence
- Hallucinated impact claims: 0 in acceptance scenarios
- PR comment update reliability: 99 percent successful comment upserts in test runs

## Graph Freshness Metrics

- Snapshot availability for PR base SHA: at least 95 percent in test runs
- Incremental push update success rate: at least 95 percent
- Automatic fallback rebuild success after incremental failure: 100 percent in test runs

## Output Quality Metrics

- Direct vs indirect labeling consistency: 100 percent on acceptance scenarios
- Impact level rule consistency with `SPEC.md`: 100 percent on acceptance scenarios
- Partial confidence behavior when evidence is weak: 100 percent in forced failure test

## Operational Metrics

- Duplicate webhook events that create duplicate jobs: 0
- Queue to processing start time in normal load: under 10 seconds
- Fatal job failure rate after retry policy: under 2 percent

## Demo Readiness Metrics

- End to end flow success in clean environment: 3 out of 3 runs
- Judge setup time with quickstart: under 10 minutes
- Demo script runtime: under 3 minutes

## Acceptance Threshold

Phase 0 is accepted when metric definitions are approved and targets are feasible for MVP scope.

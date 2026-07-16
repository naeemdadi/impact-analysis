# Phase 0 Risk Register

## Purpose

Track top risks for MVP delivery and define practical mitigations before implementation.

## Risk 1: Webhook Delivery Gaps

- **Risk:** Out of order or delayed webhook events can create stale snapshots.
- **Impact:** PR analysis may run on wrong baseline.
- **Mitigation:** Use SHA keyed snapshots and idempotent jobs. Reconcile snapshot existence at PR analysis time.
- **Owner:** Platform pipeline

## Risk 2: Import Resolution Failures

- **Risk:** Path aliases and monorepo layouts can break dependency resolution.
- **Impact:** Missing impact paths and weak report quality.
- **Mitigation:** Parse `tsconfig` paths and surface unresolved imports in evidence with partial confidence mode.
- **Owner:** Graph engine

## Risk 3: Large Repo Performance

- **Risk:** Full baseline build can exceed acceptable latency.
- **Impact:** Slow first use and poor demo reliability.
- **Mitigation:** Set repository size guidance and optimize with incremental updates after first build.
- **Owner:** Graph engine

## Risk 4: Over Scope During Hackathon

- **Risk:** Adding extra features reduces delivery reliability.
- **Impact:** Incomplete core flow by deadline.
- **Mitigation:** Enforce locked MVP scope and defer optional features to post hackathon backlog.
- **Owner:** Product scope

## Risk 5: Weak Trust in LLM Text

- **Risk:** Generated explanation can exceed evidence.
- **Impact:** Users lose trust in report.
- **Mitigation:** Prompt from evidence only and block claims without dependency paths.
- **Owner:** Report engine

## Risk 6: Comment Noise in PR

- **Risk:** Repeated comments reduce usability.
- **Impact:** Bad user experience for reviewers.
- **Mitigation:** Sticky comment upsert by app specific marker.
- **Owner:** GitHub integration

## Risk 7: Missing Demo Stability

- **Risk:** End to end demo fails due to setup variance.
- **Impact:** Poor judging outcome.
- **Mitigation:** Keep one reference repository and run clean environment rehearsal before submission.
- **Owner:** Demo readiness

## Risk 8: Dependency on External LLM Availability

- **Risk:** Temporary LLM failure blocks full report rendering.
- **Impact:** Missing explanation section.
- **Mitigation:** Always produce deterministic evidence section. Add graceful fallback message for unavailable LLM step.
- **Owner:** Report engine

## Residual Risk Policy

If a risk cannot be fully mitigated in MVP we accept it only when:

- deterministic evidence remains correct
- user facing output clearly communicates confidence and limitations

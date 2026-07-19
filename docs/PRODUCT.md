We do **not** review code, generate code, or replace QA.

We answer one bounded question:

> What should I verify before merging, and what evidence connects this change to it?

## Report contract

- The dependency graph proves reachability.
- Technical roles prioritize that reachability.
- AI may summarize supplied PR hunks and phrase suggestions for already-proven routes.
- The report never says a regression exists or claims a workflow is exhaustive.

## Example sticky comment

```md
## Change Impact Report

### What changed

- Updates coupon calculation handling in the supplied pricing code.

### Primary verification

1. **/checkout**
   - Apply and remove a coupon, then verify the displayed total updates.
   - Why: `src/lib/coupon.ts` → `src/app/checkout/page.tsx`

2. **API /api/refunds**
   - Verify a refund request still returns the expected calculated amount.
   - Why: `src/lib/coupon.ts` → `src/app/api/refunds/route.ts`

### Technical impact

- Technical-only because changed `src/lib/analytics.ts` is classified as analytics; its reachability to `/checkout` is retained as evidence.

### Technical evidence

- Changed symbols: `calculateDiscount` in `src/lib/coupon.ts`
- 0 unresolved imports

Analyzed base `base-sha` → head `head-sha`
```

When AI assistance is disabled or semantic context is unavailable, the same report structure is rendered with deterministic changed-file/symbol summaries and generic route verification wording. It never invents a scenario.

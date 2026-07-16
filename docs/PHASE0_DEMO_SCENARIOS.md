# Phase 0 Demo Scenarios

## Purpose

Define realistic PR cases that prove the product value and reliability.

## Repository Profile for Demo

- Next.js plus React plus TypeScript repository
- One tracked branch: `main`
- Seeded with pages APIs components and shared services

## Scenario 1: Shared Service Change with Broad Impact

### PR Summary

Modify `DiscountCalculator` and `CouponService` logic used by checkout refund and subscription flows.

### Expected Report Signals

- Impact Level: High
- Affected includes multiple pages and API routes
- Indirect impact includes unmodified refund or subscription paths
- Evidence includes dependency chains from changed symbols to entrypoints

### Why It Matters

Proves core value proposition: detect cross area impact from shared module changes.

## Scenario 2: Route Component Only Change

### PR Summary

Update one route page component UI logic without touching shared services.

### Expected Report Signals

- Impact Level: Medium
- Affected set centered on route and local children
- Limited or no indirect impact
- Verification list focused on route specific behaviors

### Why It Matters

Shows precision and avoids over reporting.

## Scenario 3: Local Component Refactor

### PR Summary

Refactor a local presentational component used by one page only.

### Expected Report Signals

- Impact Level: Low
- Affected scope remains narrow
- No unrelated pages or APIs in result
- Evidence shows short dependency path

### Why It Matters

Shows trustworthiness for low impact changes and low false positives.

## Scenario Acceptance Checklist

- Report appears as sticky PR comment
- Report references correct base and head SHAs
- Every affected area includes dependency evidence
- Direct and indirect labels are correct for scenario
- Output format matches `docs/PRODUCT.md`

## Demo Script Outline

1. Install app and set tracked branch.
2. Show initial baseline index status.
3. Open Scenario 1 PR and show generated report.
4. Open Scenario 2 or 3 PR and compare impact level and affected scope.
5. Close with evidence driven trust message.

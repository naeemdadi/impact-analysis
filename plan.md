# Change Intelligence

## Problem

AI coding tools have dramatically increased developer productivity, but they've introduced a new problem.

Developers can now generate large pull requests in minutes, making it increasingly difficult to understand the full impact of a change before merging.

Today's code review tools primarily answer:

* Is the code correct?
* Is the code secure?
* Does it follow best practices?

They rarely answer:

> **What parts of my application could this change affect?**

As a result, developers spend significant time manually searching through the codebase, tracing dependencies, and guessing what should be regression tested.

---

# Vision

Build an AI-powered **Change Intelligence** tool that helps developers understand the impact of a code change before merging.

Instead of reviewing code quality, it reviews **change impact**.

---

# Goal

Given a Pull Request, answer four simple questions:

1. **What changed?**
2. **What parts of the application are affected?**
3. **Why are they affected?**
4. **What should I verify before merging?**

---

# What the tool does

When a Pull Request is opened, the tool analyzes the codebase and produces a **Change Impact Report**.

The report identifies:

* Affected pages/routes
* Affected API endpoints
* Affected React components
* Affected shared modules/services

It also explains:

* Why those areas are impacted
* Which changes have indirect effects
* Which user scenarios should be manually verified

---

# Core Principles

## 1. Evidence First

Every recommendation must be backed by evidence.

The tool should never say something without being able to explain why.

---

## 2. Deterministic Before AI

AI should never discover facts.

AI should explain facts.

Static analysis determines what is affected.

AI converts that information into a developer-friendly report.

---

## 3. Trust Over Intelligence

The goal is not to impress developers with AI.

The goal is to make developers trust the report.

If something cannot be determined reliably, the tool should avoid making that recommendation.

---

# Non Goals

The project is **not** trying to:

* Replace code review
* Replace QA
* Generate Playwright tests
* Automatically understand every business flow
* Predict every possible bug
* Replace existing AI review tools

---

# What makes it different

Existing AI review tools focus on the **quality of the changed code**.

This project focuses on the **impact of the changed code**.

Instead of saying:

> This function could be simplified.

It says:

> This shared module is used by three routes and two APIs. These areas should be verified before merging.

---

# Success Criteria

A successful report should allow a developer to answer:

* Which parts of my application should I look at?
* Why are those parts affected?
* What should I manually verify?
* Which impacts are direct vs indirect?

without manually exploring the codebase.

---

# MVP Scope

Support:

* Next.js
* React
* TypeScript

Analyze:

* Pages
* API Routes
* Components
* Shared Modules
* Dependency relationships

Generate:

* Change Impact Report
* Explanation
* Suggested manual verification

---

# Long-term Vision

As AI writes more code, developers will spend less time writing code and more time validating it.

This project aims to become the layer that provides **confidence before merge**, helping developers understand the real-world impact of a change before it reaches production.

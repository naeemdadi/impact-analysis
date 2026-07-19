import assert from "node:assert/strict";
import test from "node:test";

import { classifyJobError, JobTimeoutError, maxJobAttempts, retryDelayMs, runWithDeadline } from "../src/queue/reliability.js";
import { classifyTechnicalRole } from "../src/graph/baseline-graph-builder.js";
import { assessImpact } from "../src/impact/impact-assessment.js";

test("retry policy is bounded and uses the documented backoff", () => {
  assert.equal(maxJobAttempts, 3);
  assert.equal(retryDelayMs(1), 30_000);
  assert.equal(retryDelayMs(2), 120_000);
  assert.equal(classifyJobError({ status: 429 }), "transient");
  assert.equal(classifyJobError({ status: 503 }), "transient");
  assert.equal(classifyJobError({ status: 403 }), "permanent");
});

test("technical roles suppress analytics while promoting application logic", () => {
  assert.equal(classifyTechnicalRole("src/hooks/use-analytics.ts", "shared_module", "capture(event)").technicalRole, "analytics");
  assert.equal(classifyTechnicalRole("src/lib/pricing.ts", "shared_module", "").technicalRole, "business_logic");
  const assessment = assessImpact({ status: "ready", repoId: 1, pullRequestNumber: 1, baseSha: "a", headSha: "b", impactLevel: "high", changedFiles: [], changedSymbols: [], unresolvedImportCount: 0, insufficientReason: null, affectedItems: [
    { path: "src/app/page.tsx", kind: "page", impact: "indirect", dependencyPath: ["src/hooks/use-analytics.ts", "src/app/page.tsx"] },
    { path: "src/app/checkout/page.tsx", kind: "page", impact: "indirect", dependencyPath: ["src/lib/pricing.ts", "src/app/checkout/page.tsx"] },
  ] });
  assert.deepEqual(assessment.items.map((item) => [item.path, item.tier]), [["src/app/checkout/page.tsx", "primary"], ["src/app/page.tsx", "technical_only"]]);
});

test("deadline aborts an operation with a typed timeout", async () => {
  await assert.rejects(
    runWithDeadline(5, async () => new Promise<void>(() => undefined)),
    JobTimeoutError,
  );
});

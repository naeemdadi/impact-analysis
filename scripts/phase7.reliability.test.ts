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
  assert.equal(classifyTechnicalRole("src/components/seller/seller-page-client.tsx", "component", "capture(event)").technicalRole, "presentation");
  assert.equal(classifyTechnicalRole("src/lib/pricing.ts", "shared_module", "").technicalRole, "application");
  const assessment = assessImpact({ status: "ready", repoId: 1, pullRequestNumber: 1, baseSha: "a", headSha: "b", impactLevel: "high", changedFiles: [], changedSymbols: [], unresolvedImportCount: 0, insufficientReason: null, affectedItems: [
    { path: "src/app/page.tsx", kind: "page", impact: "indirect", dependencyPath: ["src/hooks/use-analytics.ts", "src/app/page.tsx"] },
    { path: "src/app/checkout/page.tsx", kind: "page", impact: "indirect", dependencyPath: ["src/lib/pricing.ts", "src/app/checkout/page.tsx"] },
  ] }, { baseGraph: { files: [], symbols: [], imports: [] }, headGraph: { files: [
    { path: "src/hooks/use-analytics.ts", blobSha: "a", kind: "shared_module", classificationReason: "fixture", technicalRole: "analytics", technicalRoleReason: "fixture", technicalRoleStrength: "strong" },
    { path: "src/lib/pricing.ts", blobSha: "b", kind: "shared_module", classificationReason: "fixture", technicalRole: "application", technicalRoleReason: "fixture", technicalRoleStrength: "strong" },
  ], symbols: [], imports: [] } });
  assert.deepEqual(assessment.items.map((item) => [item.path, item.tier]), [["src/app/checkout/page.tsx", "primary"], ["src/app/page.tsx", "technical_only"]]);
});

test("assessment retains supporting component paths when a direct route change wins visible priority", () => {
  const assessment = assessImpact({
    status: "ready",
    repoId: 1,
    pullRequestNumber: 1,
    baseSha: "a",
    headSha: "b",
    impactLevel: "low",
    changedFiles: [],
    changedSymbols: [],
    unresolvedImportCount: 0,
    insufficientReason: null,
    affectedItems: [
      { path: "src/app/upload/page.tsx", kind: "page", impact: "direct", dependencyPath: ["src/app/upload/page.tsx"] },
      { path: "src/app/upload/page.tsx", kind: "page", impact: "indirect", dependencyPath: ["src/components/FileUpload.tsx", "src/app/upload/page.tsx"] },
    ],
  }, {
    baseGraph: { files: [], symbols: [], imports: [] },
    headGraph: {
      files: [
        { path: "src/app/upload/page.tsx", blobSha: "page", kind: "page", classificationReason: "fixture", technicalRole: "presentation", technicalRoleReason: "fixture", technicalRoleStrength: "strong" },
        { path: "src/components/FileUpload.tsx", blobSha: "upload", kind: "component", classificationReason: "fixture", technicalRole: "presentation", technicalRoleReason: "fixture", technicalRoleStrength: "strong" },
      ],
      symbols: [],
      imports: [],
    },
  });
  assert.equal(assessment.items.length, 1);
  assert.equal(assessment.items[0]?.changedSeedPath, "src/app/upload/page.tsx");
  assert.deepEqual(assessment.items[0]?.supportingPaths?.map((path) => path.changedSeedPath), ["src/app/upload/page.tsx", "src/components/FileUpload.tsx"]);
  assert.deepEqual(assessment.items[0]?.supportingPaths?.map((path) => path.tier), ["primary", "secondary"]);
});

test("deadline aborts an operation with a typed timeout", async () => {
  await assert.rejects(
    runWithDeadline(5, async () => new Promise<void>(() => undefined)),
    JobTimeoutError,
  );
});

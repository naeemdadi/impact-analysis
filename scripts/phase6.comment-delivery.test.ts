import assert from "node:assert/strict";
import test from "node:test";

import { commentMarker, renderPrCommentBody } from "../src/delivery/pr-comment-body.js";

const marker = commentMarker(101, 9);
const identity = { baseSha: "base-sha", headSha: "head-sha" };

test("ready comment preserves persisted report and includes auditable identity", () => {
  const body = renderPrCommentBody({ marker, analysis: { ...identity, status: "ready" }, markdown: "## Impact Analysis\n\nBefore merging, verify:\n\n- Checkout" });
  assert.match(body, /Before merging, verify/);
  assert.match(body, /Base: `base-sha`/);
  assert.match(body, /Head: `head-sha`/);
  assert.match(body, /<!-- impact-analysis:repo=101:pr=9 -->/);
});

test("non-ready states make no impact claims", () => {
  const running = renderPrCommentBody({ marker, analysis: { ...identity, status: "building" }, markdown: null });
  const insufficient = renderPrCommentBody({ marker, analysis: { ...identity, status: "insufficient_evidence" }, markdown: null });
  const failed = renderPrCommentBody({ marker, analysis: { ...identity, status: "failed" }, markdown: null });
  assert.match(running, /Analysis is running/);
  assert.match(insufficient, /without impact claims/);
  assert.match(failed, /no impact claims were made/);
  assert.doesNotMatch(failed, /internal error/i);
});

test("a ready analysis cannot be delivered without its persisted report", () => {
  assert.throws(() => renderPrCommentBody({ marker, analysis: { ...identity, status: "ready" }, markdown: null }));
});

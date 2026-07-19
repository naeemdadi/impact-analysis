import assert from "node:assert/strict";
import test from "node:test";

import { positionalArgs, positiveIntegerArg } from "./cli-args.js";

test("normalizes pnpm's forwarded argument separator", () => {
  assert.deepEqual(positionalArgs(["node", "script", "--", "1107982447", "2"]), ["1107982447", "2"]);
  assert.deepEqual(positionalArgs(["node", "script", "1107982447", "2"]), ["1107982447", "2"]);
});

test("rejects invalid numeric CLI input before a database query", () => {
  assert.equal(positiveIntegerArg("1107982447", "repoId"), 1107982447);
  assert.throws(() => positiveIntegerArg("--", "repoId"), /repoId must be a positive integer/);
  assert.throws(() => positiveIntegerArg("1.5", "repoId"), /repoId must be a positive integer/);
});

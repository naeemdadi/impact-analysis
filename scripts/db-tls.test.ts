import assert from "node:assert/strict";
import test from "node:test";

import { assertDatabaseTls, databaseUrlHasTls } from "../src/storage/db-tls.js";

test("production requires a TLS-enabled DATABASE_URL while dev accepts plaintext", () => {
  const plain = "postgresql://user:pass@localhost:5432/db";
  const tls = "postgresql://user:pass@host:5432/db?sslmode=require";

  assert.equal(databaseUrlHasTls(plain), false);
  assert.equal(databaseUrlHasTls(tls), true);
  assert.equal(databaseUrlHasTls("postgresql://u:p@h/db?sslmode=verify-full"), true);
  assert.equal(databaseUrlHasTls("postgresql://u:p@h/db?sslmode=prefer"), false);
  assert.equal(databaseUrlHasTls("postgresql://u:p@h/db?ssl=true"), true);
  assert.equal(databaseUrlHasTls("not a url"), false);
  // no-verify still encrypts, so it counts as TLS-enabled for self-signed certs.
  assert.equal(databaseUrlHasTls("postgresql://u:p@h/db?sslmode=no-verify"), true);
  assert.equal(databaseUrlHasTls("postgresql://u:p@h/db?ssl=no-verify"), true);

  // Dev (no NODE_ENV) accepts a plaintext URL.
  assert.doesNotThrow(() => assertDatabaseTls(plain, undefined));
  // Production rejects plaintext but accepts a TLS URL.
  assert.throws(() => assertDatabaseTls(plain, "production"), /must enable TLS/);
  assert.doesNotThrow(() => assertDatabaseTls(tls, "production"));
  assert.doesNotThrow(() => assertDatabaseTls("postgresql://u:p@h/db?sslmode=no-verify", "production"));
});

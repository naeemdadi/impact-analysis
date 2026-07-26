// Kept pure so the production TLS check is testable without opening a pool.
// no-verify still encrypts the connection; it only skips certificate
// validation, which managed Postgres with self-signed certs often needs.
const TLS_SSLMODES = new Set(["require", "no-verify", "verify-ca", "verify-full"]);

export function databaseUrlHasTls(url: string): boolean {
  const params = safeSearchParams(url);
  if (!params) return false;
  const sslmode = params.get("sslmode");
  if (sslmode) return TLS_SSLMODES.has(sslmode);
  const ssl = params.get("ssl");
  return ssl === "true" || ssl === "1" || ssl === "require" || ssl === "no-verify";
}

export function assertDatabaseTls(url: string, nodeEnv: string | undefined): void {
  if (nodeEnv === "production" && !databaseUrlHasTls(url)) {
    throw new Error("DATABASE_URL must enable TLS in production (set sslmode=require, verify-ca, verify-full, or no-verify for self-signed certs)");
  }
}

function safeSearchParams(url: string): URLSearchParams | null {
  try {
    return new URL(url).searchParams;
  } catch {
    return null;
  }
}

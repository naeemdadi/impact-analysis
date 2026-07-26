// Kept pure so the production TLS check is testable without opening a pool.
const TLS_SSLMODES = new Set(["require", "verify-ca", "verify-full"]);

export function databaseUrlHasTls(url: string): boolean {
  const params = safeSearchParams(url);
  if (!params) return false;
  const sslmode = params.get("sslmode");
  if (sslmode) return TLS_SSLMODES.has(sslmode);
  const ssl = params.get("ssl");
  return ssl === "true" || ssl === "1" || ssl === "require";
}

export function assertDatabaseTls(url: string, nodeEnv: string | undefined): void {
  if (nodeEnv === "production" && !databaseUrlHasTls(url)) {
    throw new Error("DATABASE_URL must enable TLS in production (set sslmode=require, verify-ca, or verify-full)");
  }
}

function safeSearchParams(url: string): URLSearchParams | null {
  try {
    return new URL(url).searchParams;
  } catch {
    return null;
  }
}

export type JobErrorKind = "transient" | "permanent" | "timeout" | "cancelled" | "worker_lost";

export const maxJobAttempts = 3;

export function retryDelayMs(attempt: number): number {
  return attempt <= 1 ? 30_000 : 120_000;
}

export function classifyJobError(error: unknown): JobErrorKind {
  if (error instanceof JobTimeoutError) return "timeout";
  if (error instanceof JobCancelledError) return "cancelled";
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : null;
  if (status === 429 || (status !== null && status >= 500)) return "transient";
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(code)) return "transient";
  const message = error instanceof Error ? error.message : "";
  if (/network|connection|socket|database.*(unavailable|timeout)|timeout/i.test(message)) return "transient";
  return "permanent";
}

export class JobTimeoutError extends Error {
  constructor() { super("job deadline exceeded"); }
}
export class JobCancelledError extends Error {
  constructor() { super("job cancelled"); }
}

export async function runWithDeadline<T>(timeoutMs: number, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      action(controller.signal),
      new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new JobTimeoutError()), { once: true })),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function timeoutForJob(jobType: string): number {
  if (jobType === "installation.sync" || jobType === "branch.reconcile") return 8 * 60_000;
  if (jobType === "branch.push" || jobType === "pull_request.analyze") return 5 * 60_000;
  return 30_000;
}

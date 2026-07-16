import crypto from "node:crypto";

interface IdempotencyInput {
  deliveryId: string;
  eventName: string;
  eventAction?: string;
  repoId?: number;
  commitSha?: string;
  pullRequestNumber?: number;
}

export function createIdempotencyKey(input: IdempotencyInput): string {
  const base = [
    input.deliveryId,
    input.eventName,
    input.eventAction ?? "",
    String(input.repoId ?? ""),
    input.commitSha ?? "",
    String(input.pullRequestNumber ?? ""),
  ].join(":");

  return crypto.createHash("sha256").update(base).digest("hex");
}

export function createPayloadHash(rawBody: string): string {
  return crypto.createHash("sha256").update(rawBody).digest("hex");
}

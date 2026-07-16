export type JobType = "installation.sync" | "branch.push" | "pull_request.analyze";

export interface EnqueueRequest {
  idempotencyKey: string;
  deliveryId: string;
  eventName: string;
  eventAction?: string;
  repoId?: number;
  payloadSha256: string;
  jobType: JobType;
  jobPayload: Record<string, unknown>;
}

export interface EnqueueResult {
  inserted: boolean;
  idempotencyKey: string;
}

/**
 * A safe classification for output-stage failures. Provider request failures
 * retain their HTTP status and are classified separately from model output.
 */
export class SemanticAnalysisOutputError extends Error {
  constructor(
    readonly kind: "empty_output" | "malformed_json" | "schema_validation" | "evidence_validation",
    readonly diagnostic: string | null = null,
  ) {
    super(kind);
    this.name = "SemanticAnalysisOutputError";
  }
}

export interface SemanticFailure {
  category: string;
  persistedReason: string;
  notice: string;
  providerStatus: number | null;
  providerCode: string | null;
  providerType: string | null;
  providerDiagnostic: string | null;
}

/** Converts provider and output failures into safe persisted/user-visible text. */
export function classifySemanticFailure(error: unknown): SemanticFailure {
  if (error instanceof SemanticAnalysisOutputError) {
    const outputFailures = {
      empty_output: { persistedReason: "OpenAI returned no structured guidance", notice: "OpenAI returned no structured guidance; semantic checks were not generated." },
      malformed_json: { persistedReason: "OpenAI returned malformed structured guidance", notice: "OpenAI returned malformed structured guidance; semantic checks were not generated." },
      schema_validation: { persistedReason: "OpenAI response did not match the required report format", notice: "OpenAI guidance did not match the required report format." },
      evidence_validation: { persistedReason: "OpenAI guidance could not be tied to supplied evidence", notice: "OpenAI guidance could not be tied to the supplied evidence." },
    } as const;
    const base = outputFailures[error.kind];
    const diagnostic = error.diagnostic;
    return {
      category: error.kind,
      persistedReason: diagnostic ? `${base.persistedReason} (${diagnostic})` : base.persistedReason,
      notice: base.notice,
      providerStatus: null,
      providerCode: null,
      providerType: null,
      providerDiagnostic: diagnostic,
    };
  }

  const provider = readProviderFailure(error);
  const { status } = provider;
  const message = provider.message.toLowerCase();
  if (/openai_api_key\s+is\s+not\s+configured/.test(message)) {
    return failure("configuration", "OpenAI API key is not configured", "OpenAI API key is not configured; semantic checks were not generated.", provider);
  }
  if (status === 401 || status === 403 || /api[ _-]?key|authentication|unauthorized|forbidden/.test(message)) {
    return failure("authentication", "OpenAI authentication failed", "OpenAI authentication failed. Check the configured API key.", provider);
  }
  if (status === 429 || /rate limit/.test(message)) {
    return failure("rate_limited", "OpenAI rate limit reached", "OpenAI is rate-limited; semantic checks were not generated.", provider);
  }
  if ((status !== null && status >= 500) || /network|connection|timeout|unavailable/.test(message)) {
    return failure("provider_unavailable", "OpenAI service unavailable", "OpenAI is temporarily unavailable; semantic checks were not generated.", provider);
  }
  if (status === 400) {
    return failure("provider_request_rejected", "OpenAI rejected the semantic-analysis request", "OpenAI rejected the semantic-analysis request; semantic checks were not generated.", provider);
  }
  if (status === 404) {
    return failure("model_unavailable", "Configured OpenAI model is unavailable", "The configured OpenAI model is unavailable; semantic checks were not generated.", provider);
  }
  return failure("unknown", "OpenAI semantic analysis failed", "OpenAI semantic analysis failed; semantic checks were not generated.", provider);
}

interface ProviderFailure {
  status: number | null;
  code: string | null;
  type: string | null;
  message: string;
  diagnostic: string | null;
}

function failure(category: string, summary: string, notice: string, provider: ProviderFailure): SemanticFailure {
  const details = [
    provider.status === null ? null : `HTTP ${provider.status}`,
    provider.code ? `code ${provider.code}` : null,
    provider.type ? `type ${provider.type}` : null,
    provider.diagnostic,
  ].filter((value): value is string => value !== null);
  return {
    category,
    persistedReason: details.length ? `${summary} (${details.join("; ")})` : summary,
    notice,
    providerStatus: provider.status,
    providerCode: provider.code,
    providerType: provider.type,
    providerDiagnostic: provider.diagnostic,
  };
}

/**
 * Provider errors can be retained only when they describe a request/schema
 * issue. This deliberately excludes arbitrary response text, credentials, and
 * any wording that could contain submitted source context.
 */
function readProviderFailure(error: unknown): ProviderFailure {
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
  const status = typeof record.status === "number" ? record.status : null;
  const code = safeToken(record.code);
  const type = safeToken(record.type);
  const message = typeof record.message === "string" ? record.message : error instanceof Error ? error.message : "";
  return { status, code, type, message, diagnostic: safeProviderDiagnostic(status, message) };
}

function safeToken(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9_.-]{1,100}$/i.test(value) ? value : null;
}

function safeProviderDiagnostic(status: number | null, message: string): string | null {
  if (status === null || ![400, 404, 422].includes(status)) return null;
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 400) return null;
  if (/(?:api[ _-]?key|authorization|bearer|secret|password|\bsk-[a-z0-9_-]+)/i.test(normalized)) return null;
  if (!/(?:schema|json|structured|response[_ -]?format|model|parameter|unsupported|invalid request|invalid value)/i.test(normalized)) return null;
  return normalized;
}

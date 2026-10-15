/**
 * Fel och nedbrytning (R5 — appen får aldrig krascha).
 *
 * Alla fel som uppstår i modellagret blir `ProviderError` med en av `ErrorCode` ur
 * @nexus/protocol. host kan då skriva `RpcResponse.error` utan att någon rå
 * `TypeError` / `DOMException` läcker ut till transporten.
 */

import { ErrorCode, type ErrorCodeValue, type ModelSource } from "@nexus/protocol";

/** Finare klassificering än ErrorCode — behövs för retry- och fallback-beslut. */
export type ProviderErrorClass =
  | "rate_limited"
  | "unauthorized"
  | "not_found"
  | "bad_request"
  | "server"
  | "network"
  | "timeout"
  | "parse"
  | "unsupported"
  | "no_model"
  | "internal";

/** Ett ensamt försök i en fallback-kedja. Den som säger *varför* vi flyttade modell. */
export interface FallbackAttempt {
  readonly providerId: string;
  readonly model: string;
  readonly ok: boolean;
  readonly tookMs: number;
  readonly attempts: number;
  readonly httpStatus?: number;
  readonly code?: ErrorCodeValue;
  readonly errorClass?: ProviderErrorClass;
  readonly message?: string;
  /** Mänsklig förklaring till UI:t, t.ex. "429 rate limit — byter till kedjans nästa modell". */
  readonly reason?: string;
  readonly source: ModelSource;
}

export interface ProviderErrorInit {
  readonly message: string;
  readonly errorClass: ProviderErrorClass;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly source?: ModelSource;
  readonly providerId?: string;
  readonly model?: string;
  readonly cause?: unknown;
  readonly attempts?: FallbackAttempt[];
}

/** Mappning från fin klass till det protokollfel UI:t faktiskt känner igen. */
const CODE_BY_CLASS: Record<ProviderErrorClass, ErrorCodeValue> = {
  rate_limited: ErrorCode.RateLimited,
  unauthorized: ErrorCode.Internal,
  not_found: ErrorCode.NoModelAvailable,
  bad_request: ErrorCode.BadRequest,
  server: ErrorCode.Internal,
  network: ErrorCode.NoModelAvailable,
  timeout: ErrorCode.NoModelAvailable,
  parse: ErrorCode.Internal,
  unsupported: ErrorCode.BadRequest,
  no_model: ErrorCode.NoModelAvailable,
  internal: ErrorCode.Internal,
};

export class ProviderError extends Error {
  readonly code: ErrorCodeValue;
  readonly errorClass: ProviderErrorClass;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly source: ModelSource;
  readonly providerId?: string;
  readonly model?: string;
  override readonly cause?: unknown;
  /** Försökslogg för hela kedjan — bara satt när felet kommer från registret. */
  readonly attempts?: FallbackAttempt[];

  constructor(init: ProviderErrorInit) {
    super(init.message);
    this.name = "ProviderError";
    this.errorClass = init.errorClass;
    this.code = CODE_BY_CLASS[init.errorClass];
    this.httpStatus = init.httpStatus;
    this.retryAfterMs = init.retryAfterMs;
    this.source = init.source ?? "none";
    this.providerId = init.providerId;
    this.model = init.model;
    this.cause = init.cause;
    this.attempts = init.attempts;
  }

  /** Formatering host använder när felet ska bli ett RpcResponse.error. */
  toRpcError(): { code: ErrorCodeValue; message: string; data: Record<string, unknown> } {
    const data: Record<string, unknown> = {
      errorClass: this.errorClass,
      source: this.source,
    };
    if (this.httpStatus !== undefined) data.httpStatus = this.httpStatus;
    if (this.retryAfterMs !== undefined) data.retryAfterMs = this.retryAfterMs;
    if (this.providerId !== undefined) data.providerId = this.providerId;
    if (this.model !== undefined) data.model = this.model;
    if (this.attempts !== undefined && this.attempts.length > 0) data.attempts = this.attempts;
    return { code: this.code, message: this.message, data };
  }

  /** UI-meddelandet — aldrig ett stack trace, aldrig en nyckel. */
  userMessage(): string {
    switch (this.errorClass) {
      case "rate_limited":
        return "Molntjänsten är begränsad just nu (429). Försöker en annan modell i kedjan.";
      case "unauthorized":
        return "API-nyckeln är fel eller saknas. Kontrollera inställningarna.";
      case "timeout":
        return "Modellen svarade inte i tid.";
      case "network":
        return "Ingen kontakt med modelltjänsten — den kan vara avstängd.";
      case "no_model":
      case "not_found":
        return "Ingen tillgänglig modell för den här uppgiften.";
      case "unsupported":
        return "Leverantören stöder inte den här uppgiften.";
      case "parse":
        return "Modellsvaret kunde inte tolkas.";
      case "bad_request":
        return "Begäran till modellen var ogiltig.";
      case "server":
        return "Modelltjänsten gav ett internt fel.";
      case "internal":
        return "Något gick fel i modellagret.";
      default:
        return "Något gick fel i modellagret.";
    }
  }
}

/** HTTP-status → klass. 429 och 5xx är det enda som får oss backa och försöka igen. */
export function errorClassFromStatus(status: number): ProviderErrorClass {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404 || status === 405) return "not_found";
  if (status === 400 || status === 409 || status === 422) return "bad_request";
  if (status >= 500) return "server";
  return "internal";
}

export function isRetryableErrorClass(errorClass: ProviderErrorClass): boolean {
  return errorClass === "rate_limited" || errorClass === "server" || errorClass === "network" || errorClass === "timeout";
}

export function isRateLimited(err: unknown): boolean {
  return err instanceof ProviderError && err.errorClass === "rate_limited";
}

export function isRetryableError(err: unknown): boolean {
  return err instanceof ProviderError && isRetryableErrorClass(err.errorClass);
}

/**
 * Normaliserar vad som helst från `fetch`/JSON till en ProviderError.
 * AbortSignaler och `TypeError: Failed to fetch` är de vanliga "offline"-felen och
 * ska aldrig kastas vidare råa — de blir NoModelAvailable enligt R5.
 */
export function toProviderError(
  err: unknown,
  ctx: { message: string; source?: ModelSource; providerId?: string; model?: string },
): ProviderError {
  if (err instanceof ProviderError) {
    if (ctx.providerId !== undefined && err.providerId === undefined) {
      return new ProviderError({
        message: err.message,
        errorClass: err.errorClass,
        httpStatus: err.httpStatus,
        retryAfterMs: err.retryAfterMs,
        source: err.source === "none" ? (ctx.source ?? "none") : err.source,
        providerId: ctx.providerId,
        model: err.model ?? ctx.model,
        cause: err.cause,
        attempts: err.attempts,
      });
    }
    return err;
  }
  const name = typeof err === "object" && err !== null ? (err as { name?: string }).name : undefined;
  if (name === "AbortError") {
    return new ProviderError({
      message: `${ctx.message}: avbröts av signal`,
      errorClass: "timeout",
      source: ctx.source ?? "none",
      providerId: ctx.providerId,
      model: ctx.model,
      cause: err,
    });
  }
  const text = err instanceof Error ? err.message : String(err);
  const lowered = text.toLowerCase();
  if (lowered.includes("json")) {
    return new ProviderError({
      message: `${ctx.message}: svaret kunde inte tolkas (${truncate(text)})`,
      errorClass: "parse",
      source: ctx.source ?? "none",
      providerId: ctx.providerId,
      model: ctx.model,
      cause: err,
    });
  }
  if (lowered.includes("timeout") || lowered.includes("aborted") || lowered.includes("etimedout")) {
    return new ProviderError({
      message: `${ctx.message}: svar utom tid`,
      errorClass: "timeout",
      source: ctx.source ?? "none",
      providerId: ctx.providerId,
      model: ctx.model,
      cause: err,
    });
  }
  return new ProviderError({
    message: `${ctx.message}: ${truncate(text)}`,
    errorClass: "network",
    source: ctx.source ?? "none",
    providerId: ctx.providerId,
    model: ctx.model,
    cause: err,
  });
}

export function truncate(text: string, max = 240): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

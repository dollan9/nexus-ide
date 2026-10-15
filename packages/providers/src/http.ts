/**
 * HTTP-lagret för alla adapters: timeout, backoff med jitter, `Retry-After`,
 * status-mappning till `ErrorCode`, och hemlighetsmaskerad loggning.
 *
 * Det här är den enda platsen som får göra om ett anrop *inom samma modell*.
 * Fallback mellan *olika modeller* sköts av ProviderRegistry.
 *
 * Tids- och slumpfunktioner är injecterade så backoff kan testas deterministiskt med
 * fake timers, utan att ett enda verkligt millisekund behöver väntas.
 */

import type { ModelSource } from "@nexus/protocol";
import {
  errorClassFromStatus,
  isRetryableErrorClass,
  ProviderError,
  toProviderError,
  truncate,
  type ProviderErrorClass,
} from "./errors";
import type { FetchLike, RequestInitLike, ResponseLike, TimerFn } from "./internal-types";
import type { ProviderLogger } from "./logging";
import { maskSecrets } from "./secrets";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly factor: number;
  /** Ska `Retry-After` från servern bestämma väntetid? (Ja — annars misshandlar vi servern.) */
  readonly respectRetryAfter: boolean;
  /**
   * true  : 429 kastas direkt uppåt så att registret byter modell (rätt för chat/agent).
   * false : 429 behandlas som retrybart inom samma modell (probe, katalog, embeddings).
   */
  readonly throwOnRateLimit: boolean;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 8_000,
  factor: 2,
  respectRetryAfter: true,
  throwOnRateLimit: true,
};

/** Snabb policy för probe() och kataloganrop: UI får inte blockeras i åtta sekunder. */
export const FAST_RETRY: RetryPolicy = {
  maxAttempts: 2,
  initialDelayMs: 25,
  maxDelayMs: 150,
  factor: 2,
  respectRetryAfter: true,
  throwOnRateLimit: false,
};

/** Ingen retry — för strömmar, där ett omförsök skulle duplicera tokens. */
export const NO_RETRY: RetryPolicy = {
  maxAttempts: 1,
  initialDelayMs: 0,
  maxDelayMs: 0,
  factor: 1,
  respectRetryAfter: false,
  throwOnRateLimit: true,
};

export const DEFAULT_TIMEOUT_MS = 120_000;

export interface HttpDeps {
  readonly fetchImpl: FetchLike;
  readonly logger: ProviderLogger;
  readonly timer: TimerFn;
  readonly timeoutMs: number;
  readonly retry: RetryPolicy;
  readonly providerId: string;
  readonly source: ModelSource;
}

export interface HttpRequestSpec {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly model?: string;
  readonly context?: string;
}

export interface RetryTiming {
  readonly attempt: number;
  readonly exponentialMs: number;
  readonly delayMs: number;
  readonly fromRetryAfter: boolean;
}

/**
 * `Retry-After` får anges som sekunder eller som HTTP-date. Vi hanterar båda och
 * ignorerar värdet om det inte går att tolka — hellre än att vänta godtyckligt.
 */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return seconds <= 0 ? 0 : Math.round(seconds * 1000);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  const delta = date - Date.now();
  return delta <= 0 ? 0 : Math.round(delta);
}

/**
 * Exponentiell backoff med jitter. Jittern är *nedåtriktad* (0,75–1,0 av väntetiden) så
 * att den aldrig förlänger en `Retry-After`, och så att en injecterad `random` ger
 * reproducerbara tal i tester.
 */
export function computeBackoff(
  attempt: number,
  policy: RetryPolicy,
  retryAfterMs: number | undefined,
  random: () => number = Math.random,
): RetryTiming {
  const base = policy.initialDelayMs * Math.pow(policy.factor, Math.max(0, attempt - 1));
  const capped = Math.min(policy.maxDelayMs, base);
  const jittered = Math.round(capped * (0.75 + 0.25 * clamp01(random())));
  if (policy.respectRetryAfter && retryAfterMs !== undefined) {
    const delay = Math.max(jittered, retryAfterMs);
    return { attempt, exponentialMs: jittered, delayMs: delay, fromRetryAfter: delay >= retryAfterMs };
  }
  return { attempt, exponentialMs: jittered, delayMs: jittered, fromRetryAfter: false };
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export async function sleep(ms: number, timer: TimerFn): Promise<void> {
  await timer(Math.max(0, Math.round(ms)));
}

/**
 * Kör en HTTP-förfrågan genom retry-policy. Lyckat = 2xx; kroppen är oläst för anroparen.
 */
export async function httpRequest(spec: HttpRequestSpec, deps: HttpDeps): Promise<ResponseLike> {
  const context = spec.context ?? `${spec.method} ${pathOf(spec.url)}`;
  const headers: Record<string, string> = { accept: "application/json", ...(spec.headers ?? {}) };
  const body = spec.body === undefined ? undefined : JSON.stringify(spec.body);
  if (body !== undefined) headers["content-type"] = "application/json";

  let lastError: ProviderError | undefined;

  for (let attempt = 1; attempt <= deps.retry.maxAttempts; attempt++) {
    let failure: ProviderError | undefined;
    let response: ResponseLike | undefined;
    const started = Date.now();
    const { signal, dispose } = createCallSignal(spec.signal, deps.timeoutMs);
    deps.logger.request(spec.method, spec.url, headers, spec.body);
    try {
      const init: RequestInitLike = { method: spec.method, headers, signal };
      if (body !== undefined) init.body = body;
      const res = await deps.fetchImpl(spec.url, init);
      const took = Date.now() - started;
      if (res.ok) {
        dispose();
        deps.logger.response(spec.method, spec.url, res.status, took);
        return res;
      }
      failure = await errorFromResponse(res, { context, deps, model: spec.model });
      deps.logger.response(spec.method, spec.url, res.status, took, { error: failure.message });
    } catch (err) {
      failure = err instanceof ProviderError
        ? err
        : toProviderError(err, {
            message: context,
            source: deps.source,
            providerId: deps.providerId,
            model: spec.model,
          });
    } finally {
      dispose();
    }

    if (failure === undefined) {
      throw new ProviderError({
        message: `${context}: okänt fel efter försök ${attempt}`,
        errorClass: "internal",
        source: deps.source,
        providerId: deps.providerId,
        model: spec.model,
      });
    }
    lastError = failure;

    const mustGiveUp =
      attempt >= deps.retry.maxAttempts ||
      !isRetryableErrorClass(failure.errorClass) ||
      (failure.errorClass === "rate_limited" && deps.retry.throwOnRateLimit);
    if (mustGiveUp) throw failure;

    const timing = computeBackoff(attempt, deps.retry, failure.retryAfterMs);
    deps.logger.warn(
      `${context}: ${failure.errorClass} (försök ${attempt}/${deps.retry.maxAttempts}) väntar ${timing.delayMs}ms`,
      {
        attempt,
        delayMs: timing.delayMs,
        exponentialMs: timing.exponentialMs,
        fromRetryAfter: timing.fromRetryAfter,
        httpStatus: failure.httpStatus,
        model: spec.model,
        providerId: deps.providerId,
      },
    );
    await sleep(timing.delayMs, deps.timer);
  }

  throw (
    lastError ??
    new ProviderError({
      message: `${context}: ingen modell svarade`,
      errorClass: "no_model",
      source: deps.source,
      providerId: deps.providerId,
      model: spec.model,
    })
  );
}

/** JSON-hjälp som alltid ger ren ProviderError vid trasig body (R5). */
export async function requestJson<T>(spec: HttpRequestSpec, deps: HttpDeps): Promise<T> {
  const res = await httpRequest(spec, deps);
  const label = spec.context ?? spec.url;
  const text = await readText(res, label);
  if (text.trim().length === 0) {
    throw new ProviderError({
      message: `${label}: tomt svar från leverantören`,
      errorClass: "parse",
      source: deps.source,
      providerId: deps.providerId,
      model: spec.model,
    });
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new ProviderError({
      message: `${label}: svaret var inte giltig JSON (${truncate(maskSecrets(text), 120)})`,
      errorClass: "parse",
      source: deps.source,
      providerId: deps.providerId,
      model: spec.model,
      cause: err,
    });
  }
}

/**
 * Öppnar en ström (SSE eller NDJSON). Ingen retry här. Timeouten gäller bara tills headren
 * kommit — därefter lever strömmen under anroparens egen signal.
 */
export async function openStream(spec: HttpRequestSpec, deps: HttpDeps): Promise<ResponseLike> {
  const context = spec.context ?? `stream ${pathOf(spec.url)}`;
  const headers: Record<string, string> = { accept: "text/event-stream", ...(spec.headers ?? {}) };
  const body = spec.body === undefined ? undefined : JSON.stringify(spec.body);
  if (body !== undefined) headers["content-type"] = "application/json";
  const { signal, dispose } = createCallSignal(spec.signal, deps.timeoutMs);
  deps.logger.request(spec.method, spec.url, headers, spec.body);
  const started = Date.now();
  try {
    const init: RequestInitLike = { method: spec.method, headers, signal };
    if (body !== undefined) init.body = body;
    const res = await deps.fetchImpl(spec.url, init);
    const took = Date.now() - started;
    if (!res.ok) {
      const failure = await errorFromResponse(res, { context, deps, model: spec.model });
      deps.logger.response(spec.method, spec.url, res.status, took, { error: failure.message });
      throw failure;
    }
    deps.logger.response(spec.method, spec.url, res.status, took, { stream: true });
    return res;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw toProviderError(err, {
      message: context,
      source: deps.source,
      providerId: deps.providerId,
      model: spec.model,
    });
  } finally {
    // Headren är lästa — timeouten ska inte döda själva strömmen.
    dispose();
  }
}

interface ErrorContext {
  readonly context: string;
  readonly deps: HttpDeps;
  readonly model?: string;
}

async function errorFromResponse(res: ResponseLike, ctx: ErrorContext): Promise<ProviderError> {
  const { context, deps, model } = ctx;
  const detail = await readText(res, context);
  const errorClass: ProviderErrorClass = errorClassFromStatus(res.status);
  const retryAfterMs = deps.retry.respectRetryAfter ? parseRetryAfter(res.headers.get("retry-after")) : undefined;
  const serverMessage = extractServerMessage(detail);
  return new ProviderError({
    message: `${context}: HTTP ${res.status}${serverMessage.length > 0 ? ` — ${serverMessage}` : ""}`,
    errorClass,
    httpStatus: res.status,
    retryAfterMs,
    source: deps.source,
    providerId: deps.providerId,
    model,
  });
}

function extractServerMessage(detail: string): string {
  if (detail.length === 0) return "";
  try {
    const parsed: unknown = JSON.parse(detail);
    if (parsed !== null && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const nested = obj["error"];
      if (typeof nested === "string") return truncate(maskSecrets(nested), 160);
      if (nested !== null && typeof nested === "object") {
        const message = (nested as Record<string, unknown>)["message"];
        if (typeof message === "string") return truncate(maskSecrets(message), 160);
      }
      const flat = obj["message"] ?? obj["detail"];
      if (typeof flat === "string") return truncate(maskSecrets(flat), 160);
    }
  } catch {
    // Inte JSON — vi använder den råa texten ändå.
  }
  return truncate(maskSecrets(detail.replace(/\s+/g, " ")), 160);
}

async function readText(res: ResponseLike, context: string): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    throw toProviderError(err, { message: `${context}: kroppen kunde inte läsas`, source: "none" });
  }
}

/**
 * Kombinerar anroparens signal med en timeout per anrop. `dispose()` nollar timern så en
 * långlivad ström inte dör av headren-timeouten.
 */
export function createCallSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onExternalAbort = (): void => {
    controller.abort(new ProviderError({ message: "anropet avbröts av signal", errorClass: "timeout" }));
  };
  if (external !== undefined) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener("abort", onExternalAbort);
  }
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      controller.abort(
        new ProviderError({ message: `anropet tog längre än ${timeoutMs}ms`, errorClass: "timeout" }),
      );
    }, timeoutMs);
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      if (external !== undefined) external.removeEventListener("abort", onExternalAbort);
    },
  };
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Test-hjälp — transport-dockor för enhetstester i @nexus/providers.
 *
 * Vi använder två vägar, medvetet:
 *   1. Insprutad `fetch` (den här filen) när determinism behövs: chunk-splits mitt i
 *      en rad, svar i förutbestämd ordning, stream som hänger sig och avbryts.
 *   2. Riktig loopback-HTTP via mock-model-server när transporten är själva testobjektet.
 * Ingen test går ut på internet, och ingen test påstår att en riktig modell svarat.
 */

import type {
  BodyReaderLike,
  FetchLike,
  HeadersLike,
  ReaderLike,
  RequestInitLike,
  ResponseLike,
  TimerFn,
} from "../src/internal-types";
import type { ProviderContext } from "../src/provider";
import { MemoryLogger, ProviderLogger, type NexusLogSink } from "../src/logging";

export interface FakeCall {
  readonly url: string;
  readonly init: RequestInitLike | undefined;
  readonly body: Record<string, unknown> | undefined;
  /** Inspelad med Date.now() — fake timers gör att gapet bli asserterbart. */
  readonly at: number;
}

export interface FakeTransport {
  fetch: FetchLike;
  calls: FakeCall[];
  readonly logger: MemoryLogger;
  readonly log: ProviderLogger;
}

export interface ResponseSpec {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly chunks?: readonly string[];
}

function headersOf(entries: Record<string, string>): HeadersLike {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) lower[key.toLowerCase()] = value;
  return {
    get(name: string): string | null {
      const value = lower[name.toLowerCase()];
      return value === undefined ? null : value;
    },
  };
}

export function encodeChunks(chunks: readonly string[]): Uint8Array[] {
  const encoder = new TextEncoder();
  return chunks.map((chunk) => encoder.encode(chunk));
}

function makeTransport(name: string, fetchImpl: FetchLike): FakeTransport {
  const logger = new MemoryLogger();
  return { fetch: fetchImpl, calls: [], logger, log: new ProviderLogger(logger, { modul: name }) };
}

function parseBody(body: string | undefined): Record<string, unknown> | undefined {
  if (body === undefined) return undefined;
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { raw: body };
  }
}

/** Läser en array av sträng-chunks som en HTTP-kropp, med valfri hängning på slutet. */
function bodyFromChunks(chunks: readonly Uint8Array[], hang: boolean, signal: AbortSignal | undefined): BodyReaderLike {
  let index = 0;
  let cancelled = false;
  const reader: ReaderLike = {
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      if (cancelled) return { done: true };
      if (index >= chunks.length) {
        if (hang && signal !== undefined) {
          await new Promise<void>((resolve, reject) => {
            const abort = (): void => reject(new Error("streamen avbröts av signal"));
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          });
        }
        return { done: true };
      }
      const value = chunks[index];
      index += 1;
      return { done: false, value };
    },
    cancel(): Promise<unknown> {
      cancelled = true;
      index = chunks.length;
      return Promise.resolve();
    },
    releaseLock(): void {
      return undefined;
    },
  };
  return {
    getReader: () => reader,
    cancel(): Promise<unknown> {
      cancelled = true;
      return Promise.resolve();
    },
  };
}

export function fakeResponse(opts: {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  chunks?: readonly string[];
  hangAfter?: boolean;
  signal?: AbortSignal;
}): ResponseLike {
  const status = opts.status ?? 200;
  const texts = opts.chunks ?? (opts.body === undefined ? [] : [opts.body]);
  const text = texts.join("");
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headersOf(opts.headers ?? { "content-type": "application/json" }),
    async text(): Promise<string> {
      return text;
    },
    async json(): Promise<unknown> {
      return JSON.parse(text) as Record<string, unknown>;
    },
    body: bodyFromChunks(encodeChunks(texts), opts.hangAfter === true, opts.signal),
  };
}

/** Ett enda förutbestämt svar på alla anrop — för payload-form-tester. */
export function staticTransport(payload: unknown, extra: { status?: number; headers?: Record<string, string> } = {}): FakeTransport {
  return sequenceTransport([
    {
      status: extra.status ?? 200,
      headers: extra.headers ?? { "content-type": "application/json" },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    },
  ]);
}

/** Förutbestämda svar i ordning; sista posten upprepas om fler anrop kommer. */
export function sequenceTransport(responses: readonly ResponseSpec[], _sink?: NexusLogSink): FakeTransport {
  const transport = makeTransport("providers:test", async () => fakeResponse({}));
  let index = 0;
  transport.fetch = async (url: string, init?: RequestInitLike): Promise<ResponseLike> => {
    transport.calls.push({ url, init, body: parseBody(init?.body), at: Date.now() });
    const spec = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    return fakeResponse({ ...spec, signal: init?.signal ?? undefined });
  };
  return transport;
}

/**
 * Ström-transport: levererar chunkarna exakt som de är skrivna (så en SSE-rad kan
 * delas mitt i JSON-dokumentet) och kan hänga efter sista chunk för timeout-tester.
 */
export function streamingTransport(chunks: readonly string[], opts: { hangAfter?: boolean; status?: number } = {}): FakeTransport {
  const transport = makeTransport("providers:test-stream", async () => fakeResponse({}));
  transport.fetch = async (url: string, init?: RequestInitLike): Promise<ResponseLike> => {
    transport.calls.push({ url, init, body: parseBody(init?.body), at: Date.now() });
    return fakeResponse({
      status: opts.status ?? 200,
      headers: { "content-type": "text/event-stream" },
      chunks,
      hangAfter: opts.hangAfter,
      signal: init?.signal ?? undefined,
    });
  };
  return transport;
}

/**
 * Transport som går på plattformens riktiga fetch, men presenterad som FakeTransport.
 * Används bara mot mock-model-server på 127.0.0.1 — aldrig ut på internet.
 */
export function httpTransport(): FakeTransport {
  const transport = makeTransport("providers:test-http", async () => fakeResponse({ status: 500, body: "{}" }));
  transport.fetch = async (url: string, init?: RequestInitLike): Promise<ResponseLike> => {
    transport.calls.push({ url, init, body: parseBody(init?.body), at: Date.now() });
    const native = await fetch(url, {
      method: init?.method ?? "GET",
      headers: init?.headers,
      body: init?.body,
      signal: init?.signal,
    });
    return {
      ok: native.ok,
      status: native.status,
      headers: { get: (name: string) => native.headers.get(name) },
      text: () => native.text(),
      json: () => native.json() as Promise<unknown>,
      body: native.body as unknown as BodyReaderLike | null,
    };
  };
  return transport;
}

export const realTimer: TimerFn = (ms: number) =>
  new Promise<unknown>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Inspelad timer: samlar väntetiderna så backoff kan assertas utan verklig klocka. */
export function recordingTimer(): { timer: TimerFn; waits: number[] } {
  const waits: number[] = [];
  const timer: TimerFn = async (ms: number) => {
    waits.push(ms);
    return Promise.resolve();
  };
  return { timer, waits };
}

export function makeContext(transport: FakeTransport, extra: Partial<ProviderContext> = {}): ProviderContext {
  const single = { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, factor: 2, respectRetryAfter: true, throwOnRateLimit: true };
  return {
    fetchImpl: transport.fetch,
    logSink: transport.logger,
    timer: extra.timer ?? realTimer,
    random: extra.random ?? (() => 0.5),
    secrets: extra.secrets ?? { read: () => undefined },
    timeoutMs: extra.timeoutMs ?? 5_000,
    retry: extra.retry ?? single,
    streamRetry: extra.streamRetry ?? single,
  };
}

// ---------------------------------------------------------------------------
// Den delade HTTP-dockan
// ---------------------------------------------------------------------------

export interface MockRequestRecord {
  method: string;
  path: string;
  search: string;
  body: Record<string, unknown> | undefined;
  headers: {
    authorization: string | null;
    "x-api-key": string | null;
    "x-goog-api-key": string | null;
    "content-type": string | null;
    anthropic_version: string | null;
  };
  at: number;
}

export interface MockModelServer {
  readonly url: string;
  readonly baseUrl: string;
  readonly port: number;
  readonly requests: MockRequestRecord[];
  readonly mode: string;
  setMode(mode: string): string;
  setScripted(replies: string[] | string): void;
  setChunkDelay(ms: number): void;
  reset(): void;
  close(): Promise<void>;
}

export interface MockOptions {
  readonly port?: number;
  readonly mode?: string;
  readonly scriptResponse?: string | string[];
  readonly failFirst?: number;
  readonly chunkDelayMs?: number;
  readonly embeddingDimensions?: number;
  readonly retryAfterSeconds?: number;
}

/**
 * Dockan är en .mjs-fil för att andra packages (CJS-byggda) ska kunna använda den
 * utan transpilering — därför dynamic import här, inifrån en async funktion.
 */
export async function startMock(options: MockOptions = {}): Promise<MockModelServer> {
  const href = new URL("./fixtures/mock-model-server.mjs", import.meta.url).href;
  const mod = (await import(href)) as {
    startMockModelServer: (opts?: Record<string, unknown>) => Promise<MockModelServer>;
  };
  return mod.startMockModelServer(options as Record<string, unknown>);
}

export function requestsTo(server: MockModelServer, path: string): MockRequestRecord[] {
  return server.requests.filter((record) => record.path === path);
}

export async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of iterable) out.push(value);
  return out;
}

export function l2Norm(vector: readonly number[]): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

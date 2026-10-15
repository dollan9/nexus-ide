/**
 * Ström-parsers: Server-Sent Events (OpenAI/Anthropic/Google) och NDJSON (Ollama).
 *
 * Det här är stället där de flesta buggar i modell-lager bor, så reglerna är:
 *   1. En chunk får aldrig antas innehålla en hel rad — vi buffrar och återupptar.
 *   2. En rad får aldrig antas innehålla hela JSON-dokumentet — multi-line `data:` är
 *      lagligt i SSE och flera servrar skapar det.
 * 3. `[DONE]` är en signal, inte data.
 *  4. Avbrott (signal, stream-fel) ska stänga läsaren — annor läcker minnet i host.
 */

import { ProviderError, toProviderError } from "./errors";
import type { BodyReaderLike, ResponseLike } from "./internal-types";

export interface SseEvent {
  readonly event?: string;
  readonly data: string;
}

/** SSE-konstanten som OpenAI-kompatibla servrar (våra mock-server inkluderade) sänder. */
export const SSE_DONE = "[DONE]";

export class SseDecoder {
  private pending = "";
  private dataLines: string[] = [];
  private eventName: string | undefined;

  /** Mata in textfragment i den ordning de anländer. Returnerar färdiga events. */
  push(chunk: string): SseEvent[] {
    const events: SseEvent[] = [];
    this.pending = normalizeNewlines(this.pending + chunk);
    let index = this.pending.indexOf("\n");
    while (index >= 0) {
      const line = this.pending.slice(0, index);
      this.pending = this.pending.slice(index + 1);
      this.consumeLine(line, events);
      index = this.pending.indexOf("\n");
    }
    return events;
  }

  /** Avslutar strömmen: sista raden kan ha saknat n, och sista eventet kan sakna blankrad. */
  flush(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.pending.length > 0) {
      this.consumeLine(this.pending, events);
      this.pending = "";
    }
    this.closeFrame(events);
    return events;
  }

  private consumeLine(line: string, events: SseEvent[]): void {
    if (line.length === 0) {
      this.closeFrame(events);
      return;
    }
    if (line.startsWith(":")) return; // SSE-kommentar / keep-alive
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      this.dataLines.push(value);
      return;
    }
    if (field === "event") {
      this.eventName = value;
      return;
    }
    // id / retry och okända felt ignorerar vi medvetet.
  }

  private closeFrame(events: SseEvent[]): void {
    if (this.dataLines.length === 0 && this.eventName === undefined) return;
    const data = this.dataLines.join("\n");
    const event: SseEvent = this.eventName === undefined ? { data } : { event: this.eventName, data };
    this.dataLines = [];
    this.eventName = undefined;
    events.push(event);
  }
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Läsare som ger SSE-events i ankomstordning. Kastas omedelbart om en `data:`-rad är
 * skadad — felaktig JSON från en leverantör är inte något vi tiger om.
 */
export async function* readSse(
  res: ResponseLike,
  opts: { signal?: AbortSignal; context?: string } = {},
): AsyncGenerator<SseEvent> {
  const decoder = new SseDecoder();
  const context = opts.context ?? "SSE-ström";
  for await (const text of readTextChunks(res.body, opts.signal, context)) {
    for (const event of decoder.push(text)) yield event;
  }
  for (const event of decoder.flush()) yield event;
}

/** NDJSON (Ollama): en JSON-object per rad, sista raden kan vara tom. */
export async function* readNdjson(
  res: ResponseLike,
  opts: { signal?: AbortSignal; context?: string } = {},
): AsyncGenerator<Record<string, unknown>> {
  const context = opts.context ?? "NDJSON-ström";
  let pending = "";
  for await (const text of readTextChunks(res.body, opts.signal, context)) {
    pending = normalizeNewlines(pending + text);
    let index = pending.indexOf("\n");
    while (index >= 0) {
      const line = pending.slice(0, index).trim();
      pending = pending.slice(index + 1);
      if (line.length > 0) yield parseLine(line, context);
      index = pending.indexOf("\n");
    }
  }
  const tail = pending.trim();
  if (tail.length > 0) yield parseLine(tail, context);
}

function parseLine(line: string, context: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(line);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ProviderError({ message: `${context}: förväntade ett JSON-objekt per rad`, errorClass: "parse" });
    }
    return value as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError({
      message: `${context}: raden kunde inte tolkas som JSON (${firstChars(line)})`,
      errorClass: "parse",
      cause: err,
    });
  }
}

/**
 * Gemensam chunk-läsare. Vi läser via ReadableStreamReader direkt i stället för
 * `for await (const x of res.body)`, eftersom `res.body` kan vara `null` hos vissa
 * fetch-implementationer och vi alltid måste släppa läsaren.
 */
async function* readTextChunks(
  body: BodyReaderLike | null | undefined,
  signal: AbortSignal | undefined,
  context: string,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  if (body === null || body === undefined) {
    throw new ProviderError({ message: `${context}: leverantören skickade ingen kropp`, errorClass: "network" });
  }
  const reader = body.getReader();
  const abort = (): void => {
    void Promise.resolve(reader.cancel(new ProviderError({ message: `${context}: avbruten av signal`, errorClass: "timeout" }))).catch(() => undefined);
  };
  if (signal !== undefined) {
    if (signal.aborted) {
      abort();
      throw new ProviderError({ message: `${context}: avbruten innan läsning`, errorClass: "timeout" });
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  try {
    for (;;) {
      const outcome = await reader.read();
      if (outcome.done === true) {
        const rest = decoder.decode();
        if (rest.length > 0) yield rest;
        return;
      }
      const value = outcome.value;
      if (value === undefined) continue;
      yield decoder.decode(value as Uint8Array, { stream: true });
    }
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (signal?.aborted === true) {
      throw new ProviderError({ message: `${context}: avbruten av signal`, errorClass: "timeout", cause: err });
    }
    throw toProviderError(err, { message: `${context}: strömmen avbröts`, source: "none" });
  } finally {
    if (signal !== undefined) signal.removeEventListener("abort", abort);
    try {
      reader.releaseLock();
    } catch {
      // Alltid låst eller redan avslutad — inte ett verkligt fel.
    }
  }
}

function firstChars(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ");
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

/**
 * Vakt. En ström som inte levererar något inom timeouten är ett hang, och host får
 * aldrig hångas (R5). Headren-timeouten i http.ts stannar när strömmen är öppnad —
 * den här vaktar därefter: ingen data på N millisekunder är ett timeout-fel.
 */
export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  opts: { timeoutMs: number; context: string; onTimeout?: () => void },
): AsyncGenerator<T> {
  if (!(opts.timeoutMs > 0)) {
    yield* source;
    return;
  }
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pending = iterator.next();
      // Hångande promise från race får aldrig bli en orbad rejection.
      void Promise.resolve(pending).catch(() => undefined);
      const timeout = new Promise<"timeout">((resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new ProviderError({
              message: `${opts.context}: ingen data på ${opts.timeoutMs}ms`,
              errorClass: "timeout",
            }),
          );
        }, opts.timeoutMs);
      });
      try {
        const next = await Promise.race([pending, timeout]);
        if (next === "timeout") {
          // Vi åter aldrig den hängande read(): aborta istället så källan stängs.
          opts.onTimeout?.();
          throw new ProviderError({
            message: `${opts.context}: ingen data på ${opts.timeoutMs}ms`,
            errorClass: "timeout",
          });
        }
        if (next.done === true) return;
        const value = next.value as T;
        yield value;
      } catch (err) {
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
        throw err;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  } finally {
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
}

/**
 * Slår ihop flera AbortSignaler till en. Strömmar har nämligen två oberoende anledningar
 * att dö: användaren avbryter, eller att idle-timeout slår till.
 */
export function mergeSignals(...signals: readonly (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
  dispose: () => void;
} {
  const controller = new AbortController();
  const listeners: { signal: AbortSignal; handler: () => void }[] = [];
  for (const signal of signals) {
    if (signal === undefined) continue;
    const handler = (): void => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    if (signal.aborted) handler();
    else {
      signal.addEventListener("abort", handler);
      listeners.push({ signal, handler });
    }
  }
  return {
    signal: controller.signal,
    abort: (reason?: unknown) => {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    dispose: () => {
      for (const { signal, handler } of listeners) signal.removeEventListener("abort", handler);
      listeners.length = 0;
    },
  };
}

/**
 * Avkodar en SSE-ström till `data:`-payloader och stoppar vid `[DONE]`.
 * Returnerar textbitar; anroparen bestämmer hur de fogas.
 */
export async function* streamDataPayloads(
  res: ResponseLike,
  opts: { signal?: AbortSignal; context?: string } = {},
): AsyncGenerator<string> {
  for await (const event of readSse(res, opts)) {
    if (event.data.trim() === SSE_DONE) return;
    if (event.data.length === 0) continue;
    yield event.data;
  }
}

/**
 * Reassemblering av segment till text, oberoende av adapter.
 * `extract` fårreturnera `undefined` för events som inte bär text (roles, usage, etc).
 */
export async function joinStream(
  payloads: AsyncIterable<string>,
  extract: (json: Record<string, unknown>) => string | undefined,
  opts: { onEvent?: (json: Record<string, unknown>) => void; context?: string } = {},
): Promise<string> {
  const parts: string[] = [];
  for await (const payload of payloads) {
    let json: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("förväntade ett JSON-objekt");
      }
      json = parsed as Record<string, unknown>;
    } catch (err) {
      throw new ProviderError({
        message: `${opts.context ?? "ström"}: event payload kunde inte tolkas (${firstChars(payload)})`,
        errorClass: "parse",
        cause: err,
      });
    }
    opts.onEvent?.(json);
    const text = extract(json);
    if (text !== undefined && text.length > 0) parts.push(text);
  }
  return parts.join("");
}

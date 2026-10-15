/**
 * ai-client.ts — AiServiceClient (FAS 5/6/3.5).
 *
 * HTTP-klient for Python-tjansten (/health, /transcribe, /speak, /analyze, /ocr,
 * /embed, /rag/index, /rag/query, /rag/status) med timeout, JSON + base64-nyttjing.
 * Nar tjansten ar nere ger den ett rent AiServiceOffline-fel (alltid fangbart),
 * aldrig en raa krasch (R5). health() kastar aldrig — den returnerar en probe.
 */

import { ErrorCode, type OcrBlock, type RagChunk, type RagStatus, type ServiceProbe, type SpeakResult, type TranscriptResult, type VisionResult } from "@nexus/protocol";
import type { Logger } from "./logger";

export class AiServiceError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = "AiServiceError";
    this.code = code;
  }
}

export class AiServiceClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger?: Logger;

  constructor(opts: { baseUrl: string; timeoutMs?: number; logger?: Logger }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 20000;
    this.logger = opts.logger;
  }

  private async json<T>(pathName: string, body?: unknown, method: "GET" | "POST" = "POST"): Promise<T> {
    const url = `${this.baseUrl}${pathName}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        signal: controller.signal,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = `ai-service svarar inte på ${url}: ${e instanceof Error ? e.message : String(e)}`;
      this.logger?.warn("AiService offline", { fas: "5", url, error: msg });
      throw new AiServiceError(msg, ErrorCode.AiServiceOffline);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new AiServiceError(`ai-service ${pathName} → HTTP ${res.status}`, res.status === 429 ? ErrorCode.RateLimited : ErrorCode.Internal);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new AiServiceError(`ai-service ${pathName} returnerade ogiltig JSON`, ErrorCode.Internal);
    }
  }

  /** Aldrig ett kast — ger en probe med ok:false nar tjansten ar nere. */
  async health(): Promise<ServiceProbe> {
    const started = Date.now();
    const url = `${this.baseUrl}/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        return { ok: false, baseUrl: this.baseUrl, latencyMs: Date.now() - started, error: `HTTP ${res.status}` };
      }
      const data = (await res.json()) as Partial<ServiceProbe> & { engines?: ServiceProbe["engines"] };
      return {
        ok: true,
        baseUrl: this.baseUrl,
        latencyMs: Date.now() - started,
        version: typeof data.version === "string" ? data.version : undefined,
        engines: data.engines,
      };
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, baseUrl: this.baseUrl, latencyMs: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async transcribe(a: { audioBase64: string; format?: string; language?: string }): Promise<TranscriptResult> {
    return this.json<TranscriptResult>("/transcribe", a);
  }

  async speak(t: string, voice?: string): Promise<SpeakResult> {
    return this.json<SpeakResult>("/speak", { text: t, voice });
  }

  async analyze(a: { imageBase64: string; prompt?: string }): Promise<VisionResult> {
    return this.json<VisionResult>("/analyze", a);
  }

  async ocr(a: { imageBase64: string }): Promise<{ text: string; blocks: OcrBlock[]; engine: string }> {
    return this.json<{ text: string; blocks: OcrBlock[]; engine: string }>("/ocr", a);
  }

  async embed(chunks: string[]): Promise<number[][]> {
    const res = await this.json<{ embeddings?: number[][] }>("/embed", { chunks });
    if (!Array.isArray(res.embeddings)) {
      throw new AiServiceError("ai-service /embed returnerade ingen embeddings-lista", ErrorCode.Internal);
    }
    return res.embeddings;
  }

  async indexCode(a: { root: string }): Promise<{ files: number; chunks: number; engine: string }> {
    return this.json<{ files: number; chunks: number; engine: string }>("/rag/index", a);
  }

  async query(a: { query: string; k?: number }): Promise<RagChunk[]> {
    const res = await this.json<{ chunks?: RagChunk[] }>("/rag/query", a);
    return Array.isArray(res.chunks) ? res.chunks : [];
  }

  async status(): Promise<RagStatus> {
    return this.json<RagStatus>("/rag/status", undefined, "GET");
  }
}

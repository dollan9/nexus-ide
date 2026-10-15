/**
 * StubProvider — den medgivna test-dockan i modellagret.
 *
 * Den här klassen är *inte* en fejkad modell som låter som en riktig: den är en
 * öppen test-docka som alltid rapporterar `source: "stub"` (CONVENTIONS §Äkthet i
 * tester) och som spelar in varje anrop så att andra packages tester kan asserta på
 * vad som faktiskt skickades.
 *
 * Användning utanför paketet: host, core, voice och vision bygger registry mot denna
 * i stället för att uppfinna egna dockor — det håller bevis-kolumnen konsistent.
 */

import type { CompletionRequest, CompletionResult, ModelEntry } from "@nexus/protocol";
import type {
  CatalogModel,
  ChatRequest,
  ChatResult,
  EmbeddingsRequest,
  EmbeddingsResult,
  VisionAnswer,
  VisionRequest,
} from "../internal-types";
import { BaseProvider, type ProviderOptions } from "../provider";
import { normalizeVector } from "../util";

export interface StubProviderOptions extends Partial<ProviderOptions> {
  readonly id?: string;
  readonly label?: string;
  readonly reply?: string;
  readonly replies?: string[];
  readonly model?: string;
  readonly models?: string[];
  readonly dimensions?: number;
  readonly capabilities?: ProviderOptions["capabilities"];
  /** Ska stubben kasta? Används för negativa tester av fallback-kedjor. */
  readonly failWith?: Error;
}

export interface StubCallLog {
  chat: ChatRequest[];
  stream: ChatRequest[];
  complete: CompletionRequest[];
  embeddings: EmbeddingsRequest[];
  vision: VisionRequest[];
  listModels: number;
}

export class StubProvider extends BaseProvider {
  readonly calls: StubCallLog = {
    chat: [],
    stream: [],
    complete: [],
    embeddings: [],
    vision: [],
    listModels: 0,
  };

  private readonly reply: string;
  private readonly replies: string[];
  private cursor = 0;
  private readonly dimensions: number;
  private readonly failWith?: Error;

  constructor(options: StubProviderOptions = {}) {
    super({
      id: options.id ?? "stub",
      label: options.label ?? "Stub-modell (test-docka)",
      kind: options.kind ?? "custom",
      baseUrl: options.baseUrl ?? "http://127.0.0.1:9/stub",
      model: options.model ?? "stub/echo-1",
      models: options.models ?? ["stub/echo-1"],
      capabilities: options.capabilities ?? ["chat", "stream", "tools", "complete", "fim", "embeddings", "vision"],
      sourceOverride: "stub",
      enabled: options.enabled ?? true,
      context: options.context,
    });
    this.reply = options.reply ?? "stub-svar: ingen riktig modell är inkopplad";
    this.replies = options.replies ?? [];
    this.dimensions = options.dimensions ?? 8;
    this.failWith = options.failWith;
  }

  protected authHeaders(): Record<string, string> {
    return {};
  }

  async listModels(): Promise<ModelEntry[]> {
    this.calls.listModels += 1;
    const list = (this.configuredModels().length > 0 ? this.configuredModels() : ["stub/echo-1"]).map((id) => this.entry(id));
    this.setModelCache(list);
    return list;
  }

  async catalog(): Promise<CatalogModel[]> {
    return this.configuredModels().map((id) => ({ id, displayName: `${id} (stub)` }));
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    this.calls.chat.push(req);
    if (this.failWith !== undefined) throw this.failWith;
    const started = Date.now();
    const model = this.modelOr(req.model);
    return {
      text: this.nextReply(req),
      model,
      providerId: this.id,
      kind: this.kind,
      source: "stub",
      latencyMs: Date.now() - started,
      toolCalls: [],
      finishReason: "stop",
      degraded: "stub",
    };
  }

  async *stream(req: ChatRequest): AsyncIterable<string> {
    this.calls.stream.push(req);
    if (this.failWith !== undefined) throw this.failWith;
    const text = this.nextReply(req);
    for (const word of text.split(" ")) {
      yield `${word} `;
    }
  }

  protected async completeViaCompletionsEndpoint(req: CompletionRequest, model?: string): Promise<CompletionResult> {
    this.calls.complete.push(req);
    if (this.failWith !== undefined) throw this.failWith;
    const started = Date.now();
    // dockan återspeplar bara svansen på prefixet — det är nog för att testa
    // att requestBody-formen (prefix/suffix/stop) går rätt väg genom lagret.
    const tail = req.prefix.slice(-24);
    return this.buildCompletionResult(`\n${tail}`, this.modelOr(model), started);
  }

  protected async embeddingsImpl(req: EmbeddingsRequest): Promise<EmbeddingsResult> {
    this.calls.embeddings.push(req);
    if (this.failWith !== undefined) throw this.failWith;
    const started = Date.now();
    const vectors = req.texts.map((text, index) => normalizeVector(deterministicVector(text, this.dimensions, index)));
    return {
      vectors,
      model: this.modelOr(req.model),
      providerId: this.id,
      source: "stub",
      latencyMs: Date.now() - started,
      dimensions: this.dimensions,
    };
  }

  protected async visionImpl(req: VisionRequest): Promise<VisionAnswer> {
    this.calls.vision.push(req);
    if (this.failWith !== undefined) throw this.failWith;
    const started = Date.now();
    return {
      text: "stub-beskrivning: test-docka, ingen riktig VLM svarade",
      engine: "stub",
      model: this.modelOr(req.model),
      providerId: this.id,
      source: "stub",
      confidence: 0,
      tookMs: Date.now() - started,
      note: "StubProvider: sätt en riktig vision-modell i Settings → Models för äkta analys.",
    };
  }

  protected async ping(): Promise<{ model?: string; sample?: string; httpStatus?: number }> {
    if (this.failWith !== undefined) throw this.failWith;
    return { model: this.modelOr(undefined), sample: this.reply, httpStatus: 200 };
  }

  private nextReply(req: ChatRequest): string {
    if (this.replies.length > 0) {
      const canned = this.replies[this.cursor % this.replies.length] ?? this.reply;
      this.cursor += 1;
      return canned;
    }
    const last = [...req.messages].reverse().find((turn) => turn.role === "user");
    return last === undefined ? this.reply : `${this.reply} — mottog ${last.content.length} tecken`;
  }
}

/** Deterministisk "embedding" från textens bokstäver — ingen slump, testbar. */
function deterministicVector(text: string, dimensions: number, index: number): number[] {
  const vector: number[] = [];
  for (let i = 0; i < dimensions; i++) {
    let acc = (index + 1) * 7 + i * 13;
    for (let c = 0; c < text.length; c++) acc = (acc * 31 + text.charCodeAt(c)) % 9973;
    vector.push((acc % 997) / 997 + 0.01);
  }
  return vector;
}

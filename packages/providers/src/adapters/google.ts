/**
 * GoogleProvider — generativelanguage `:generateContent` / `:streamGenerateContent?alt=sse`.
 *
 * Två saker som är lätta att göra fel här:
 *   1. Nyckeln ska i headern `x-goog-api-key`, inte i URL:en — en query-nyckel hamnar i
 *      access-loggar överallt, och R2 säger att nycklar aldrig får läcka.
 *   2. Delar heter `inlineData`/`inline_data` beroende på JSON-variant; vi skickar
 *      camelCase (det dokumenterade API-formatet) och tål båda i svaret.
 *   3. embeddings heter `embedContent` (singular) och ger `{ embedding: { values } }`.
 */

import type { CompletionRequest, CompletionResult, ModelEntry } from "@nexus/protocol";
import { ProviderError } from "../errors";
import { FAST_RETRY, NO_RETRY, openStream } from "../http";
import type { ChatRequest, ChatResult, EmbeddingsRequest, EmbeddingsResult, ToolDefinition, VisionAnswer, VisionRequest } from "../internal-types";
import { BaseProvider, joinUrl, type ProviderOptions } from "../provider";
import { readSse, mergeSignals, SSE_DONE, withIdleTimeout } from "../sse";
import { arrayOf, normalizeVectors, numberAt, recordOf, stringAt } from "../util";

export const GOOGLE_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export class GoogleProvider extends BaseProvider {
  constructor(options: ProviderOptions) {
    super({
      ...options,
      capabilities: options.capabilities ?? ["chat", "stream", "tools", "embeddings", "vision"],
    });
  }

  protected authHeaders(): Record<string, string> {
    const key = this.readKey();
    if (key === undefined) return {};
    return { "x-goog-api-key": key };
  }

  private modelPath(model: string, verb: string): string {
    const clean = model.startsWith("models/") ? model.slice("models/".length) : model;
    return `${joinUrl(this.baseUrl, `/models/${encodeURIComponent(clean)}:${verb}`)}`;
  }

  async listModels(): Promise<ModelEntry[]> {
    const configured = this.configuredModels().map((id) => this.entry(id));
    if (!this.hasKey) {
      if (configured.length === 0) {
        throw new ProviderError({
          message: `${this.label}: ingen API-nyckel och ingen konfigurerad modell — sätt GOOGLE_API_KEY.`,
          errorClass: "no_model",
          source: this.source,
          providerId: this.id,
        });
      }
      this.logger.warn("google:ingen nyckel — listar konfigurerade modeller utan katalog");
      return configured;
    }
    try {
      const doc = await this.json<unknown>({ method: "GET", url: joinUrl(this.baseUrl, "/models"), context: "google modellista" }, { retry: FAST_RETRY });
      const records = arrayOf(recordOf(doc)?.["models"]);
      const list: ModelEntry[] = [];
      for (const item of records) {
        const record = recordOf(item);
        const name = stringAt(record, "name");
        if (name === undefined) continue;
        const methods = arrayOf(record?.["supportedGenerationMethods"]);
        const id = name.startsWith("models/") ? name.slice("models/".length) : name;
        const contextLength = numberAt(record, "inputTokenLimit");
        const isEmbedding = methods.some((m) => m === "embedContent" || m === "embedContents");
        const built = this.entry(id, { displayName: stringAt(record, "displayName"), contextLength });
        list.push({
          ...built,
          capabilities: isEmbedding ? ["embeddings"] : built.capabilities,
        });
      }
      if (list.length === 0) {
        this.setModelCache(configured);
        return configured;
      }
      this.setModelCache(list);
      return list;
    } catch (err) {
      if (err instanceof ProviderError && configured.length > 0) {
        this.logger.warn(`${err.message} — använder konfigurerade modeller`, { providerId: this.id });
        return configured;
      }
      throw err;
    }
  }

  async chat(input: ChatRequest): Promise<ChatResult> {
    this.requireCapability("chat");
    const req = this.withCapabilities(input);
    const model = this.modelOr(req.model);
    const started = this.logChatStart(model, req);
    const doc = await this.json<unknown>({
      method: "POST",
      url: this.modelPath(model, "generateContent"),
      body: buildGoogleBody(req),
      model,
      signal: req.signal,
      context: `google chat ${model}`,
    });
    return readGoogleResponse(doc, model, this.id, this.kind, this.source, started, req);
  }

  async *stream(input: ChatRequest): AsyncIterable<string> {
    this.requireCapability("stream");
    const req = this.withCapabilities(input);
    const model = this.modelOr(req.model);
    const res = await openStream(
      {
        method: "POST",
        url: `${this.modelPath(model, "streamGenerateContent")}?alt=sse`,
        headers: { ...this.authHeaders(), ...this.extraHeaders },
        body: buildGoogleBody(req),
        model,
        signal: req.signal,
        context: `google stream ${model}`,
      },
      this.httpDeps({ retry: NO_RETRY }),
    );
    const guard = mergeSignals(req.signal);
    const events = withIdleTimeout(readSse(res, { signal: guard.signal, context: `google stream ${model}` }), {
      timeoutMs: this.timeoutMs,
      context: `google stream ${model}`,
      onTimeout: () => guard.abort(new Error("ingen data inom timeouten")),
    });
    for await (const event of events) {
      const data = event.data.trim();
      if (data.length === 0) continue;
      // Vissa gateways (och vår test-docka) signaliserar slut med [DONE].
      if (data === SSE_DONE) return;
      let json: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(data);
        const obj = recordOf(parsed);
        if (obj === undefined) throw new Error("förväntade objekt");
        json = obj;
      } catch (err) {
        throw new ProviderError({
          message: `google stream ${model}: event kunde inte tolkas`,
          errorClass: "parse",
          source: this.source,
          providerId: this.id,
          model,
          cause: err,
        });
      }
      const piece = extractGoogleText(json);
      if (piece !== undefined && piece.length > 0) yield piece;
    }
  }

  protected async completeViaCompletionsEndpoint(req: CompletionRequest, model?: string): Promise<CompletionResult> {
    const active = this.modelOr(model);
    throw new ProviderError({
      message: `${this.label} (${active}) har ingen fill-in-the-middle; autocomplete går mot en lokal FIM-modell`,
      errorClass: "unsupported",
      source: this.source,
      providerId: this.id,
      model: active,
    });
  }

  protected async embeddingsImpl(req: EmbeddingsRequest): Promise<EmbeddingsResult> {
    const started = Date.now();
    const model = this.modelOr(req.model);
    const vectors: number[][] = [];
    for (const text of req.texts) {
      const doc = await this.json<unknown>({
        method: "POST",
        url: this.modelPath(model, "embedContent"),
        body: { content: { parts: [{ text }] } },
        model,
        context: `google embedContent ${model}`,
        signal: req.signal,
      });
      const embedding = recordOf(recordOf(doc)?.["embedding"]);
      const values = embedding?.["values"];
      if (!Array.isArray(values)) {
        throw new ProviderError({
          message: `google embedContent: svaret saknade vektorvärden för ${model}`,
          errorClass: "parse",
          source: this.source,
          providerId: this.id,
          model,
        });
      }
      vectors.push(values.filter((n): n is number => typeof n === "number"));
    }
    const normalized = normalizeVectors(vectors);
    return {
      vectors: normalized,
      model,
      providerId: this.id,
      source: this.source,
      latencyMs: Date.now() - started,
      dimensions: normalized[0]?.length ?? 0,
    };
  }

  protected async visionImpl(req: VisionRequest): Promise<VisionAnswer> {
    const started = Date.now();
    const result = await this.chat({
      model: req.model,
      messages: [
        {
          role: "user",
          content: req.prompt ?? "Beskriv bilden. Om det finns text i bilden, skriv ut den ord för ord.",
          images: [{ dataBase64: req.imageBase64, mime: req.mime ?? "image/png" }],
        },
      ],
      temperature: 0,
      maxTokens: 512,
      signal: req.signal,
    });
    return {
      text: result.text,
      engine: this.isLocal ? "vlm-local" : "vlm-cloud",
      model: result.model,
      providerId: this.id,
      source: result.source,
      confidence: result.text.trim().length === 0 ? 0 : 0.85,
      tookMs: Date.now() - started,
    };
  }

  protected async ping(): Promise<{ model?: string; sample?: string; httpStatus?: number }> {
    const model = this.modelOr(undefined);
    const doc = await this.json<unknown>(
      {
        method: "POST",
        url: this.modelPath(model, "generateContent"),
        body: { contents: [{ role: "user", parts: [{ text: "svara med ett ord: ok" }] }], generationConfig: { maxOutputTokens: 4 } },
        model,
        context: `google probe ${model}`,
      },
      { retry: FAST_RETRY },
    );
    return { model, sample: extractGoogleText(recordOf(doc) ?? {}), httpStatus: 200 };
  }
}

export interface GooglePart {
  readonly text?: string;
  readonly inlineData?: { mimeType: string; data: string };
  readonly functionCall?: { id?: string; name: string; args: Record<string, unknown> };
  readonly functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}

/**
 * Bygger `/generateContent`-payloaden: `contents` med `parts`, `systemInstruction`
 * och `tools[].functionDeclarations`. Separat exportad för payload-tester.
 */
export function buildGoogleBody(req: ChatRequest): Record<string, unknown> {
  const contents: { role: string; parts: GooglePart[] }[] = [];
  const systemParts: string[] = [];

  for (const turn of req.messages) {
    if (turn.role === "system") {
      if (turn.content.length > 0) systemParts.push(turn.content);
      continue;
    }
    const parts: GooglePart[] = [];
    if (turn.content.length > 0 && turn.role !== "tool") parts.push({ text: turn.content });
    for (const image of turn.images ?? []) {
      parts.push({ inlineData: { mimeType: image.mime, data: image.dataBase64 } });
    }
    for (const call of turn.toolCalls ?? []) {
      parts.push({
        functionCall: {
          id: call.callId,
          name: call.name,
          args: toArgsRecord(call.args, call.rawArgs),
        },
      });
    }
    if (turn.role === "tool") {
      parts.push({
        functionResponse: {
          id: turn.toolCallId,
          name: turn.toolName ?? turn.toolCallId ?? "tool",
          response: { content: turn.content },
        },
      });
    }
    if (parts.length === 0) parts.push({ text: turn.content });
    contents.push({ role: mapGoogleRole(turn.role), parts });
  }

  if (req.contextChunks !== undefined && req.contextChunks.length > 0) {
    systemParts.push(
      `Kontext från arbetsytan (RAG):\n${req.contextChunks.map((chunk) => `${chunk.path}:${chunk.startLine}: ${chunk.text.slice(0, 400)}`).join("\n")}`,
    );
  }

  const body: Record<string, unknown> = { contents };
  const generationConfig: Record<string, unknown> = {};
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.maxTokens !== undefined) generationConfig.maxOutputTokens = req.maxTokens;
  if (req.topP !== undefined) generationConfig.topP = req.topP;
  if (req.stop !== undefined && req.stop.length > 0) generationConfig.stopSequences = req.stop;
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
  if (systemParts.length > 0) body.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };
  const tools = mapGoogleTools(req.tools);
  if (tools !== undefined) body.tools = tools;
  return body;
}

/** Google räknar tokens i sina egna fält — översätt till protokollets TokenUsage. */
function mapGoogleUsage(value: unknown): ChatResult["usage"] {
  const meta = recordOf(value);
  if (meta === undefined) return undefined;
  const prompt = numberAt(meta, "promptTokenCount") ?? 0;
  const completion = numberAt(meta, "candidatesTokenCount") ?? 0;
  const total = numberAt(meta, "totalTokenCount") ?? prompt + completion;
  if (prompt === 0 && completion === 0 && total === 0) return undefined;
  return { prompt, completion, total };
}

function mapGoogleTools(tools: ToolDefinition[] | undefined): Record<string, unknown>[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    },
  ];
}

function mapGoogleRole(role: string): string {
  // Gemini använder "user"/"model"; tool-svar returneras som "user" med functionResponse.
  if (role === "assistant") return "model";
  if (role === "tool") return "user";
  return "user";
}

function toArgsRecord(args: unknown, rawArgs: string): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      const parsed: unknown = JSON.parse(args);
      return recordOf(parsed) ?? { value: args };
    } catch {
      return { value: rawArgs };
    }
  }
  return recordOf(args) ?? {};
}

/** Text ur ett generateContent-svar eller ett stream-segment (tål både camelCase och snake_case). */
export function extractGoogleText(json: Record<string, unknown>): string | undefined {
  const candidates = arrayOf(json["candidates"]);
  const chunks: string[] = [];
  for (const item of candidates) {
    const candidate = recordOf(item);
    const content = recordOf(candidate?.["content"]);
    for (const part of arrayOf(content?.["parts"])) {
      const obj = recordOf(part);
      const text = stringAt(obj, "text");
      if (text !== undefined) chunks.push(text);
    }
  }
  return chunks.join("");
}

export function readGoogleResponse(
  doc: unknown,
  model: string,
  providerId: string,
  kind: ChatResult["kind"],
  source: ChatResult["source"],
  started: number,
  req: ChatRequest,
): ChatResult {
  const root = recordOf(doc) ?? {};
  const candidates = arrayOf(root["candidates"]);
  const first = recordOf(candidates[0]);
  const content = recordOf(first?.["content"]);
  const parts = arrayOf(content?.["parts"]);
  const textParts: string[] = [];
  const toolCalls: ChatResult["toolCalls"] = [];
  for (const item of parts) {
    const part = recordOf(item);
    const text = stringAt(part, "text");
    if (text !== undefined) textParts.push(text);
    const call = recordOf(part?.["functionCall"]) ?? recordOf(part?.["function_call"]);
    if (call !== undefined) {
      const args = call["args"] ?? call["arguments"];
      toolCalls.push({
        callId: stringAt(call, "id") ?? stringAt(call, "name") ?? model,
        name: stringAt(call, "name") ?? model,
        args: args ?? {},
        rawArgs: JSON.stringify(args ?? {}),
      });
    }
  }
  return {
    text: textParts.join(""),
    model: stringAt(root, "modelVersion") ?? model,
    providerId,
    kind,
    source,
    latencyMs: Date.now() - started,
    toolCalls,
    finishReason: stringAt(first, "finishReason"),
    usage: mapGoogleUsage(root["usageMetadata"]),
    degraded: req.metadata?.["degraded"],
  };
}

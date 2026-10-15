/**
 * AnthropicProvider — `/v1/messages` med x-api-key + anthropic-version.
 *
 * Anthropic skiljer sig från OpenAI på tre punkter som är lätta att bygga fel:
 *   1. `system` är ett toppnivafält, inte ett message.
 *   2. `max_tokens` är obligatoriskt.
 *   3. streaming är `content_block_delta`-events, inte `choices[].delta`.
 * Verktyg svarar som `tool_use` / `tool_result` blocks.
 */

import type { CompletionRequest, CompletionResult, ModelEntry } from "@nexus/protocol";
import { ProviderError } from "../errors";
import { FAST_RETRY, NO_RETRY, openStream } from "../http";
import type { ChatRequest, ChatResult, EmbeddingsRequest, EmbeddingsResult, VisionAnswer, VisionRequest } from "../internal-types";
import { BaseProvider, joinUrl, type ProviderOptions } from "../provider";
import { readSse, mergeSignals, withIdleTimeout } from "../sse";
import { arrayOf, mapUsage, numberAt, recordOf, stringAt } from "../util";

export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

export class AnthropicProvider extends BaseProvider {
  constructor(options: ProviderOptions) {
    super({
      ...options,
      baseUrl: options.baseUrl.length > 0 ? options.baseUrl : ANTHROPIC_DEFAULT_BASE_URL,
      capabilities: options.capabilities ?? ["chat", "stream", "tools", "vision"],
    });
  }

  protected authHeaders(): Record<string, string> {
    const key = this.readKey();
    const headers: Record<string, string> = { "anthropic-version": ANTHROPIC_VERSION };
    if (key !== undefined) headers["x-api-key"] = key;
    return headers;
  }

  /** Accepterar både `https://api.anthropic.com` och `.../v1` som baseUrl. */
  private resource(path: string): string {
    const base = this.baseUrl.endsWith("/v1") ? this.baseUrl : joinUrl(this.baseUrl, "/v1");
    return `${base}${path}`;
  }

  async listModels(): Promise<ModelEntry[]> {
    const configured = this.configuredModels().map((id) => this.entry(id));
    if (!this.hasKey) {
      if (configured.length === 0) {
        throw new ProviderError({
          message: `${this.label}: ingen API-nyckel och ingen konfigurerad modell — sätt ANTHROPIC_API_KEY.`,
          errorClass: "no_model",
          source: this.source,
          providerId: this.id,
        });
      }
      this.logger.warn("anthropic:ingen nyckel — listar konfigurerade modeller utan katalog");
      return configured;
    }
    try {
      const doc = await this.json<unknown>({ method: "GET", url: this.resource("/models"), context: "anthropic modellista" }, { retry: FAST_RETRY });
      const records = arrayOf(recordOf(doc)?.["data"]);
      const list: ModelEntry[] = [];
      for (const item of records) {
        const record = recordOf(item);
        const name = stringAt(record, "id") ?? stringAt(record, "name");
        if (name === undefined) continue;
        list.push(this.entry(name, { displayName: stringAt(record, "display_name"), contextLength: numberAt(record, "context_length") }));
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
      url: this.resource("/messages"),
      body: buildAnthropicBody(req, model, false),
      model,
      signal: req.signal,
      context: `anthropic chat ${model}`,
    });
    return this.readResponse(doc, model, started);
  }

  private readResponse(doc: unknown, model: string, started: number): ChatResult {
    const root = recordOf(doc) ?? {};
    const parts = arrayOf(root["content"]);
    const text: string[] = [];
    const toolCalls: ChatResult["toolCalls"] = [];
    for (const part of parts) {
      const block = recordOf(part);
      const type = stringAt(block, "type");
      if (type === "text") {
        const value = stringAt(block, "text");
        if (value !== undefined) text.push(value);
      } else if (type === "tool_use") {
        const id = stringAt(block, "id") ?? stringAt(block, "name") ?? model;
        const name = stringAt(block, "name") ?? id;
        const input = block?.["input"];
        toolCalls.push({ callId: id, name, args: input ?? {}, rawArgs: JSON.stringify(input ?? {}) });
      }
    }
    return {
      text: text.join(""),
      model: stringAt(root, "model") ?? model,
      providerId: this.id,
      kind: this.kind,
      source: this.source,
      latencyMs: Date.now() - started,
      toolCalls,
      finishReason: stringAt(root, "stop_reason"),
      usage: mapUsage(root["usage"]),
    };
  }

  async *stream(input: ChatRequest): AsyncIterable<string> {
    this.requireCapability("stream");
    const req = this.withCapabilities(input);
    const model = this.modelOr(req.model);
    const res = await openStream(
      {
        method: "POST",
        url: this.resource("/messages"),
        headers: { ...this.authHeaders(), ...this.extraHeaders },
        body: buildAnthropicBody(req, model, true),
        model,
        signal: req.signal,
        context: `anthropic stream ${model}`,
      },
      this.httpDeps({ retry: NO_RETRY }),
    );
    const guard = mergeSignals(req.signal);
    const events = withIdleTimeout(readSse(res, { signal: guard.signal, context: `anthropic stream ${model}` }), {
      timeoutMs: this.timeoutMs,
      context: `anthropic stream ${model}`,
      onTimeout: () => guard.abort(new Error("ingen data inom timeouten")),
    });
    for await (const event of events) {
      if (event.data.trim().length === 0) continue;
      let json: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(event.data);
        const obj = recordOf(parsed);
        if (obj === undefined) throw new Error("förväntade objekt");
        json = obj;
      } catch (err) {
        throw new ProviderError({
          message: `anthropic stream ${model}: SSE-event kunde inte tolkas`,
          errorClass: "parse",
          source: this.source,
          providerId: this.id,
          model,
          cause: err,
        });
      }
      const type = stringAt(json, "type") ?? event.event;
      if (type === "content_block_delta") {
        const delta = recordOf(json["delta"]);
        if (stringAt(delta, "type") === "text_delta") {
          const piece = stringAt(delta, "text");
          if (piece !== undefined && piece.length > 0) yield piece;
        }
        continue;
      }
      if (type === "message_stop") return;
      if (type === "error") {
        const error = recordOf(json["error"]);
        throw new ProviderError({
          message: `anthropic stream: ${stringAt(error, "message") ?? "okänt serverfel"}`,
          errorClass: "server",
          source: this.source,
          providerId: this.id,
          model,
        });
      }
    }
  }

  protected async completeViaCompletionsEndpoint(req: CompletionRequest, model?: string): Promise<CompletionResult> {
    // Anthropic har ingen completion/FIM-endpoint alls. Vi säger det rakt ut i stället
    // för att efterlikna något — registret rullar vidare till nästa modell i kedjan.
    const active = this.modelOr(model);
    throw new ProviderError({
      message: `${this.label} (${active}) har ingen fill-in-the-middle; autocomplete måste gå mot en lokal modell`,
      errorClass: "unsupported",
      source: this.source,
      providerId: this.id,
      model: active,
    });
  }

  protected async embeddingsImpl(req: EmbeddingsRequest): Promise<EmbeddingsResult> {
    throw new ProviderError({
      message: `${this.label} har inga embeddings — välj Ollama (nomic-embed-text) eller Google för RAG`,
      errorClass: "unsupported",
      source: this.source,
      providerId: this.id,
      model: req.model,
    });
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
      maxTokens: 512,
      temperature: 0,
      signal: req.signal,
    });
    return {
      text: result.text,
      engine: "vlm-cloud",
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
        url: this.resource("/messages"),
        body: { model, max_tokens: 1, messages: [{ role: "user", content: "ok" }] },
        model,
        context: `anthropic probe ${model}`,
      },
      { retry: FAST_RETRY },
    );
    const root = recordOf(doc) ?? {};
    const first = recordOf(arrayOf(root["content"])[0]);
    return { model, sample: stringAt(first, "text") ?? "(tomt svar)", httpStatus: 200 };
  }
}

/**
 * Kroppsbygget. Ren funktion så payload-formen kan testas utan nätverk — det är här
 * `system`, `max_tokens` och block-formaterna måste vara ex rätt.
 */
export function buildAnthropicBody(req: ChatRequest, model: string, stream: boolean): Record<string, unknown> {
  const systemParts: string[] = [];
  const messages: Record<string, unknown>[] = [];

  for (const turn of req.messages) {
    if (turn.role === "system") {
      if (turn.content.length > 0) systemParts.push(turn.content);
      continue;
    }
    if (turn.role === "tool") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: turn.toolCallId ?? turn.toolName ?? "",
            content: turn.content,
          },
        ],
      });
      continue;
    }
    const blocks: Record<string, unknown>[] = [];
    if (turn.content.length > 0) blocks.push({ type: "text", text: turn.content });
    for (const image of turn.images ?? []) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: image.mime, data: image.dataBase64 },
      });
    }
    for (const call of turn.toolCalls ?? []) {
      blocks.push({
        type: "tool_use",
        id: call.callId,
        name: call.name,
        input: typeof call.args === "string" ? safeParse(call.args) : call.args,
      });
    }
    messages.push({ role: turn.role, content: blocks.length > 0 ? blocks : turn.content });
  }

  if (req.contextChunks !== undefined && req.contextChunks.length > 0) {
    systemParts.push(
      `Kontext från arbetsytan (RAG):\n${req.contextChunks.map((chunk) => `${chunk.path}:${chunk.startLine}: ${chunk.text.slice(0, 400)}`).join("\n")}`,
    );
  }

  const maxTokens = req.maxTokens ?? 1024;
  const body: Record<string, unknown> = { model, max_tokens: maxTokens, messages };
  if (systemParts.length > 0) body.system = systemParts.join("\n\n");
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.stop !== undefined && req.stop.length > 0) body.stop_sequences = req.stop;
  if (stream) body.stream = true;
  if (req.tools !== undefined && req.tools.length > 0) {
    body.tools = req.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }
  return body;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { raw: value };
  }
}

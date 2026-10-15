/**
 * OpenAiCompatibleProvider — en adapter som räcker för hela OpenAI-dialektens värld.
 *
 * Täckning (FAS 3.2): NVIDIA NIM (https://integrate.api.nvidia.com/v1), OpenAI,
 * OpenRouter, Groq, Mistral, vLLM (127.0.0.1:8000/v1), LM Studio (:1234/v1),
 * llama.cpp server (:8080/v1) och helt egna endpoints användaren klistrar in.
 *
 * Det enda som skiljer dessa åt är baseUrl, nyckelnamn och vilka endpoints som finns,
 * så den här klassen parameteriseras — ärvar inte ärver.
 */

import type { CompletionRequest, CompletionResult, ModelEntry } from "@nexus/protocol";
import { ProviderError, toProviderError } from "../errors";
import { buildFimBody, trimFimCompletion } from "../fim";
import { FAST_RETRY, NO_RETRY, openStream } from "../http";
import type {
  CatalogModel,
  ChatRequest,
  ChatResult,
  ChatTurn,
  EmbeddingsRequest,
  EmbeddingsResult,
  ImagePart,
  ToolDefinition,
  VisionAnswer,
  VisionRequest,
} from "../internal-types";
import { BaseProvider, joinUrl } from "../provider";
import { mergeSignals, readSse, SSE_DONE, withIdleTimeout } from "../sse";
import { classifySource } from "../source";
import {
  arrayOf,
  cutAtStop,
  dataUrl,
  estimateVramMb,
  extractModelIds,
  extractModelRecords,
  flattenContent,
  mapUsage,
  normalizeVectors,
  numberAt,
  parseToolCalls,
  recordOf,
  stringAt,
} from "../util";

/** Chat-meddelanden i OpenAI-dialekt: sträng eller content parts för bilder. */
export function buildChatBody(req: ChatRequest, model: string, stream: boolean): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  const context = renderContextChunks(req);
  if (context.length > 0) messages.push({ role: "system", content: context });

  for (const turn of req.messages) {
    if (turn.role === "assistant" && turn.toolCalls !== undefined && turn.toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: turn.content,
        tool_calls: turn.toolCalls.map((call) => ({
          id: call.callId,
          type: "function",
          function: { name: call.name, arguments: call.rawArgs.length > 0 ? call.rawArgs : "{}" },
        })),
      });
      continue;
    }
    if (turn.role === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: turn.toolCallId ?? turn.toolName ?? "",
        content: turn.content,
      });
      continue;
    }
    if (turn.images !== undefined && turn.images.length > 0) {
      const parts: Record<string, unknown>[] = [];
      if (turn.content.length > 0) parts.push({ type: "text", text: turn.content });
      for (const image of turn.images) parts.push({ type: "image_url", image_url: { url: dataUrl(image.dataBase64, image.mime) } });
      messages.push({ role: turn.role, content: parts });
      continue;
    }
    messages.push({ role: turn.role, content: turn.content });
  }

  const body: Record<string, unknown> = { model, messages, stream };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.stop !== undefined && req.stop.length > 0) body.stop = req.stop;
  const tools = mapTools(req.tools);
  if (tools !== undefined) {
    body.tools = tools;
    body.tool_choice = req.toolChoice ?? "auto";
    // NVIDIA NIM och äldre vLLM kräver detta för att inte tyst ignorera verktyg.
    body.parallel_tool_calls = false;
  }
  if (stream) body.stream_options = { include_usage: true };
  return body;
}

function mapTools(tools: ToolDefinition[] | undefined): Record<string, unknown>[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

function renderContextChunks(req: ChatRequest): string {
  if (req.contextChunks === undefined || req.contextChunks.length === 0) return "";
  const lines = req.contextChunks.map(
    (chunk) => `${chunk.path}:${chunk.startLine}-${chunk.endLine}: ${chunk.text.slice(0, 400)}`,
  );
  return `Kontext från arbetsytan (RAG). Använd den men citera inte onödigt:\n${lines.join("\n")}`;
}

export class OpenAiCompatibleProvider extends BaseProvider {
  protected authHeaders(): Record<string, string> {
    const key = this.readKey();
    if (key === undefined) return {};
    return { authorization: `Bearer ${key}` };
  }

  // --- Modeller -----------------------------------------------------------

  async listModels(): Promise<ModelEntry[]> {
    const entries = new Map<string, ModelEntry>();
    for (const id of this.configuredModels()) {
      const known = this.catalogEntries().find((m) => m.id === id);
      entries.set(id, this.entry(id, { displayName: known?.displayName, contextLength: known?.contextLength }));
    }

    let remote: string[] = [];
    try {
      const doc = await this.json<unknown>(
        { method: "GET", url: joinUrl(this.baseUrl, "/models"), context: "modellista" },
        { retry: FAST_RETRY },
      );
      remote = extractModelIds(doc);
      for (const record of extractModelRecords(doc)) {
        const id = stringAt(record, "id") ?? stringAt(record, "name");
        if (id === undefined) continue;
        const contextLength = numberAt(record, "context_length") ?? numberAt(record, "max_context_length");
        const sizeBytes = numberAt(record, "size");
        const displayName = stringAt(record, "name") ?? stringAt(record, "display_name");
        entries.set(id, this.entry(id, { displayName, contextLength, sizeBytes, vramEstimateMb: estimateVramMb(sizeBytes) }));
      }
    } catch (err) {
      const failure = toProviderError(err, {
        message: `${this.label}: modellistan kunde inte hämtas`,
        source: this.source,
        providerId: this.id,
      });
      // Nedbrytning: konfigurerade modeller räcker vidare — appen ska inte krascha (R5).
      this.logger.warn(`${failure.message} — använder konfigurerade modeller`, {
        providerId: this.id,
        errorClass: failure.errorClass,
        configured: this.configuredModels().length,
      });
    }

    if (entries.size === 0 && remote.length === 0) {
      throw new ProviderError({
        message: `${this.label}: har inga modeller. Lägg till en modell i Settings → Models.`,
        errorClass: "no_model",
        source: this.source,
        providerId: this.id,
      });
    }

    const list = [...entries.values()];
    this.setModelCache(list);
    return list;
  }

  /** NVIDIA-style katalog (alla modeller som finns hos leverantören, även opullade). */
  async catalog(): Promise<CatalogModel[]> {
    const doc = await this.json<unknown>(
      { method: "GET", url: joinUrl(this.baseUrl, "/models"), context: "modellkatalog" },
      { retry: FAST_RETRY },
    );
    return extractModelRecords(doc).map((record) => {
      const id = stringAt(record, "id") ?? stringAt(record, "name") ?? "";
      return {
        id,
        displayName: stringAt(record, "name") ?? stringAt(record, "display_name"),
        contextLength: numberAt(record, "context_length"),
      };
    }).filter((model) => model.id.length > 0);
  }

  // --- Chat ---------------------------------------------------------------

  async chat(input: ChatRequest): Promise<ChatResult> {
    this.requireCapability("chat");
    const req = this.withCapabilities(input);
    const model = this.modelOr(req.model);
    const started = this.logChatStart(model, req);
    const body = buildChatBody(req, model, false);
    const doc = await this.json<unknown>(
      { method: "POST", url: joinUrl(this.baseUrl, "/chat/completions"), body, model, signal: req.signal, context: `chat ${model}` },
    );
    return this.readChatResponse(doc, model, started, req);
  }

  private readChatResponse(doc: unknown, model: string, started: number, req: ChatRequest): ChatResult {
    const root = recordOf(doc) ?? {};
    const choices = arrayOf(root["choices"]);
    const first = recordOf(choices[0]);
    if (first === undefined) {
      throw new ProviderError({
        message: `${this.label}: svaret innehöll inget val (choices var tomt)`,
        errorClass: "parse",
        source: this.source,
        providerId: this.id,
        model,
      });
    }
    const message = recordOf(first["message"]);
    const fromMessage = message === undefined ? "" : flattenContent(message["content"]);
    const text = fromMessage.length > 0 ? fromMessage : flattenContent(first["text"]);
    const toolCalls = parseToolCalls(message?.["tool_calls"]);
    return {
      text,
      model: stringAt(root, "model") ?? model,
      providerId: this.id,
      kind: this.kind,
      source: this.source,
      latencyMs: Date.now() - started,
      toolCalls,
      finishReason: stringAt(first, "finish_reason"),
      usage: mapUsage(root["usage"]),
      degraded: req.metadata?.["degraded"],
    };
  }

  async *stream(input: ChatRequest): AsyncIterable<string> {
    this.requireCapability("stream");
    const req = this.withCapabilities(input);
    const model = this.modelOr(req.model);
    const body = buildChatBody(req, model, true);
    const res = await openStream(
      {
        method: "POST",
        url: joinUrl(this.baseUrl, "/chat/completions"),
        headers: { ...this.authHeaders(), ...this.extraHeaders },
        body,
        model,
        signal: req.signal,
        context: `stream ${model}`,
      },
      this.httpDeps({ retry: NO_RETRY }),
    );
    const guard = mergeSignals(req.signal);
    const events = withIdleTimeout(readSse(res, { signal: guard.signal, context: `stream ${model}` }), {
      timeoutMs: this.timeoutMs,
      context: `stream ${model}`,
      onTimeout: () => guard.abort(new Error("idle timeout")),
    });
    for await (const event of events) {
      const data = event.data.trim();
      if (data === SSE_DONE) return;
      if (data.length === 0) continue;
      const json = this.parseStreamEvent(data, model);
      const piece = extractDelta(json);
      if (piece !== undefined && piece.length > 0) yield piece;
    }
  }

  private parseStreamEvent(data: string, model: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(data);
      const obj = recordOf(parsed);
      if (obj === undefined) throw new Error("förväntade ett JSON-objekt");
      return obj;
    } catch (err) {
      throw new ProviderError({
        message: `${this.label}: SSE-event i stream ${model} kunde inte tolkas`,
        errorClass: "parse",
        source: this.source,
        providerId: this.id,
        model,
        cause: err,
      });
    }
  }

  // --- Autocomplete (FIM) -------------------------------------------------

  protected async completeViaCompletionsEndpoint(req: CompletionRequest, model?: string): Promise<CompletionResult> {
    const active = this.modelOr(model);
    const started = Date.now();
    const fim = buildFimBody(req);
    // `fim_prompt`/`fim_suffix` används av LM Studio och vissa llama.cpp-byggen som
    // har egen chat-mall; `prompt`+`stop` är den portabla vägen.
    const body: Record<string, unknown> = {
      model: active,
      prompt: fim.prompt,
      max_tokens: fim.maxTokens,
      temperature: 0,
      stop: fim.stops,
      stream: false,
      fim_prompt: req.prefix,
      fim_suffix: req.suffix,
    };
    const doc = await this.json<unknown>(
      { method: "POST", url: joinUrl(this.baseUrl, "/completions"), body, model: active, context: `fim ${active}` },
    );
    const root = recordOf(doc) ?? {};
    const first = recordOf(arrayOf(root["choices"])[0]);
    const raw = flattenContent(first?.["text"]);
    const text = trimFimCompletion(cutAtStop(raw, fim.stops), fim.stops);
    return this.buildCompletionResult(text, stringAt(root, "model") ?? active, started);
  }

  // --- Embeddings ---------------------------------------------------------

  protected async embeddingsImpl(req: EmbeddingsRequest): Promise<EmbeddingsResult> {
    const started = Date.now();
    const model = this.modelOr(req.model);
    const body: Record<string, unknown> = { model, input: req.texts };
    const doc = await this.json<unknown>(
      { method: "POST", url: joinUrl(this.baseUrl, "/embeddings"), body, model, signal: req.signal, context: `embeddings ${model}` },
    );
    const root = recordOf(doc) ?? {};
    const data = arrayOf(root["data"]);
    const vectors: number[][] = [];
    for (const item of data) {
      const obj = recordOf(item);
      const vector = obj?.["embedding"];
      if (Array.isArray(vector)) vectors.push(vector.filter((n): n is number => typeof n === "number"));
    }
    if (vectors.length === 0) {
      throw new ProviderError({
        message: `${this.label}: embeddings-svaret innehöll inga vektorer`,
        errorClass: "parse",
        source: this.source,
        providerId: this.id,
        model,
      });
    }
    const normalized = normalizeVectors(vectors);
    return {
      vectors: normalized,
      model: stringAt(root, "model") ?? model,
      providerId: this.id,
      source: this.source,
      latencyMs: Date.now() - started,
      dimensions: normalized[0]?.length ?? 0,
    };
  }

  // --- Vision -------------------------------------------------------------

  protected async visionImpl(req: VisionRequest): Promise<VisionAnswer> {
    const started = Date.now();
    const image: ImagePart = { dataBase64: req.imageBase64, mime: req.mime ?? "image/png" };
    const turn: ChatTurn = {
      role: "user",
      content: req.prompt ?? "Beskriv bilden. Om det finns text i bilden, skriv ut den ord för ord.",
      images: [image],
    };
    const result = await this.chat({
      model: req.model,
      messages: [turn],
      maxTokens: 512,
      temperature: 0,
      signal: req.signal,
    });
    const engine = classifySource(this.baseUrl) === "local" ? "vlm-local" : "vlm-cloud";
    return {
      text: result.text,
      engine,
      model: result.model,
      providerId: this.id,
      source: result.source,
      confidence: result.text.trim().length === 0 ? 0 : 0.8,
      tookMs: Date.now() - started,
    };
  }

  // --- Probe --------------------------------------------------------------

  protected async ping(): Promise<{ model?: string; sample?: string; httpStatus?: number }> {
    const models = await this.listModels();
    const model = models[0]?.id ?? this.preferredModel;
    if (model === undefined) {
      throw new ProviderError({
        message: `${this.label}: katalogen svarade men innehåller ingen modell`,
        errorClass: "no_model",
        source: this.source,
        providerId: this.id,
      });
    }
    // Utan nyckel mot ett moln stoppar vi här: katalog är publik, chat är det inte.
    if (!this.isLocal && !this.hasKey) {
      return { model, sample: `katalog: ${models.length} modeller (ingen nyckel — chat testas inte)`, httpStatus: 200 };
    }
    if (!this.capabilities.includes("chat")) return { model, sample: `katalog: ${models.length} modeller`, httpStatus: 200 };
    const res = await this.json<unknown>(
      {
        method: "POST",
        url: joinUrl(this.baseUrl, "/chat/completions"),
        body: buildChatBody({ messages: [{ role: "user", content: "svara med ett ord: ok" }], maxTokens: 4, temperature: 0 }, model, false),
        model,
        context: `probe ${model}`,
      },
      { retry: FAST_RETRY },
    );
    const root = recordOf(res) ?? {};
    const first = recordOf(arrayOf(root["choices"])[0]);
    const message = recordOf(first?.["message"]);
    return { model, sample: flattenContent(message?.["content"]), httpStatus: 200 };
  }

}

/** Streaming-delta i OpenAI-dialekten (chat och, för vissa servrar, raw text). */
function extractDelta(json: Record<string, unknown>): string | undefined {
  const choices = arrayOf(json["choices"]);
  const first = recordOf(choices[0]);
  if (first === undefined) {
    const text = json["text"];
    return typeof text === "string" ? text : undefined;
  }
  const delta = recordOf(first["delta"]);
  const content = delta?.["content"];
  if (typeof content === "string") return content;
  const message = recordOf(first["message"]);
  const messageContent = message?.["content"];
  if (typeof messageContent === "string") return messageContent;
  const firstText = first["text"];
  return typeof firstText === "string" ? firstText : undefined;
}

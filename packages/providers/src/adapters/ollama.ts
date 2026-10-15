/**
 * OllamaProvider — nativ Ollama-API, inte OpenAI-översättningen.
 *
 * Vi pratar rakt mot /api/tags, /api/chat, /api/generate, /api/embeddings och /api/pull
 * eftersom FIM-vägen (`raw:true` med `prompt` + `suffix`) bara finns i den nativa API:t,
 * och eftersom pull-progress är det som gör FAS 3.2 (h) möjlig.
 *
 * Ollama är lokalt. Alltid. `source` blir "local" när servern svarar, och test-dockor
 * sätter explicit "stub".
 */

import type { CompletionRequest, CompletionResult, ModelEntry } from "@nexus/protocol";
import { ProviderError, toProviderError } from "../errors";
import { buildFimBody, trimFimCompletion } from "../fim";
import { FAST_RETRY, NO_RETRY, openStream } from "../http";
import type {
  ChatRequest,
  ChatResult,
  ChatTurn,
  EmbeddingsRequest,
  EmbeddingsResult,
  ModelPullOutcome,
  PullProgressCallback,
  ToolCall,
  ToolDefinition,
  VisionAnswer,
  VisionRequest,
} from "../internal-types";
import { BaseProvider, joinUrl, type ProviderOptions } from "../provider";
import { readNdjson, mergeSignals, withIdleTimeout } from "../sse";
import { arrayOf, estimateVramMb, flattenContent, mapUsage, normalizeVector, numberAt, recordOf, stringAt } from "../util";

/** Ollama skickar `arguments` som ett objekt, inte som en JSON-sträng. */
export function parseOllamaToolCalls(value: unknown): ToolCall[] {
  return arrayOf(value).flatMap((item): ToolCall[] => {
    const call = recordOf(item);
    const fn = recordOf(call?.["function"]);
    const name = stringAt(fn, "name") ?? stringAt(call, "name");
    if (call === undefined || name === undefined) return [];
    const args = fn?.["arguments"];
    if (args !== undefined && typeof args !== "string") {
      return [{ callId: stringAt(call, "id") ?? name, name, args, rawArgs: safeStringify(args) }];
    }
    const raw = typeof args === "string" ? args : "";
    let parsed: unknown = {};
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        parsed = { raw };
      }
    }
    return [{ callId: stringAt(call, "id") ?? name, name, args: parsed, rawArgs: raw }];
  });
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

export class OllamaProvider extends BaseProvider {
  constructor(options: ProviderOptions) {
    super({
      ...options,
      capabilities: options.capabilities ?? ["chat", "stream", "tools", "complete", "fim", "embeddings", "vision"],
    });
  }

  /** Ollama har inga nycklar — lokalt nät, ingen autentisering. */
  protected authHeaders(): Record<string, string> {
    return {};
  }

  // --- Modeller -----------------------------------------------------------

  async listModels(): Promise<ModelEntry[]> {
    const doc = await this.json<unknown>({
      method: "GET",
      url: joinUrl(this.baseUrl, "/api/tags"),
      context: "ollama modellista",
    }, { retry: FAST_RETRY });
    const root = recordOf(doc) ?? {};
    const models = arrayOf(root["models"]);
    const list: ModelEntry[] = [];
    for (const item of models) {
      const model = recordOf(item);
      const name = stringAt(model, "model") ?? stringAt(model, "name");
      if (name === undefined) continue;
      const details = recordOf(model?.["details"]);
      const sizeBytes = numberAt(model, "size");
      const parameterSize = stringAt(details, "parameter_size");
      list.push(
        this.entry(name, {
          displayName: `${name}${parameterSize !== undefined ? ` (${parameterSize})` : ""}`,
          sizeBytes,
          vramEstimateMb: estimateVramMb(sizeBytes),
          contextLength: numberAt(recordOf(model?.["parameters"]), "num_ctx"),
          loaded: booleanLoaded(model),
        }),
      );
    }
    if (list.length === 0) {
      const fallback = this.configuredModels();
      if (fallback.length === 0) {
        throw new ProviderError({
          message: `${this.label}: Ollama svarade men har inga modeller hämtade (kör ollama pull).`,
          errorClass: "no_model",
          source: this.source,
          providerId: this.id,
        });
      }
      const entries = fallback.map((name) => this.entry(name));
      this.setModelCache(entries);
      return entries;
    }
    this.setModelCache(list);
    return list;
  }

  // --- Chat ---------------------------------------------------------------

  async chat(input: ChatRequest): Promise<ChatResult> {
    this.requireCapability("chat");
    const req = this.withCapabilities(input);
    const model = this.modelOr(req.model);
    const started = this.logChatStart(model, req);
    const body = buildOllamaChatBody(req, model, false);
    const doc = await this.json<unknown>({
      method: "POST",
      url: joinUrl(this.baseUrl, "/api/chat"),
      body,
      model,
      signal: req.signal,
      context: `ollama chat ${model}`,
    });
    const root = recordOf(doc) ?? {};
    const message = recordOf(root["message"]);
    const text = flattenContent(message?.["content"]);
    const toolCalls = parseOllamaToolCalls(message?.["tool_calls"]);
    return {
      text,
      model: stringAt(root, "model") ?? model,
      providerId: this.id,
      kind: this.kind,
      source: this.source,
      latencyMs: Date.now() - started,
      toolCalls,
      finishReason: stringAt(root, "done_reason"),
      usage: usageFromOllama(root),
    };
  }

  async *stream(input: ChatRequest): AsyncIterable<string> {
    this.requireCapability("stream");
    const req = this.withCapabilities(input);
    const model = this.modelOr(req.model);
    const body = buildOllamaChatBody(req, model, true);
    const res = await openStream(
      {
        method: "POST",
        url: joinUrl(this.baseUrl, "/api/chat"),
        headers: this.extraHeaders,
        body,
        model,
        signal: req.signal,
        context: `ollama stream ${model}`,
      },
      this.httpDeps({ retry: NO_RETRY }),
    );
    const guard = mergeSignals(req.signal);
    const lines = withIdleTimeout(readNdjson(res, { signal: guard.signal, context: `ollama stream ${model}` }), {
      timeoutMs: this.timeoutMs,
      context: `ollama stream ${model}`,
      onTimeout: () => guard.abort(new Error("ingen data inom timeouten")),
    });
    for await (const line of lines) {
      const message = recordOf(line["message"]);
      const piece = stringAt(message, "content");
      if (piece !== undefined && piece.length > 0) yield piece;
      if (line["done"] === true) {
        this.logger.debug(`ollama stream klar för ${model}`, { providerId: this.id, source: this.source });
        return;
      }
    }
  }

  // --- Autocomplete: nativ FIM ---------------------------------------------

  /**
   * `/api/generate` med `raw:true` är den enda Ollama-vägen som inte applicerar chat-mallen,
   * vilket är exakt vad FIM behöver: `prompt` = prefix, `suffix` = texten efter cursor.
   */
  protected async completeViaCompletionsEndpoint(req: CompletionRequest, model?: string): Promise<CompletionResult> {
    this.requireCapability("fim");
    const active = this.modelOr(model);
    const started = Date.now();
    const fim = buildFimBody(req);
    const body: Record<string, unknown> = {
      model: active,
      raw: true,
      stream: false,
      prompt: req.prefix,
      suffix: req.suffix,
      options: {
        temperature: 0,
        num_predict: fim.maxTokens,
        stop: fim.stops,
      },
    };
    const doc = await this.json<unknown>({
      method: "POST",
      url: joinUrl(this.baseUrl, "/api/generate"),
      body,
      model: active,
      context: `ollama fim ${active}`,
    });
    const root = recordOf(doc) ?? {};
    const raw = stringAt(root, "response") ?? "";
    const text = trimFimCompletion(raw, fim.stops);
    return this.buildCompletionResult(text, stringAt(root, "model") ?? active, started);
  }

  // --- Embeddings ----------------------------------------------------------

  protected async embeddingsImpl(req: EmbeddingsRequest): Promise<EmbeddingsResult> {
    const started = Date.now();
    const model = this.modelOr(req.model);
    const vectors: number[][] = [];
    // Ollamas /api/embeddings tar en text per anrop. Vi kör dem i sin ordning så
    // räckvidden (en CPU/GPU-bunden server) inte överbelastas av parallella anrop.
    for (const text of req.texts) {
      const doc = await this.json<unknown>({
        method: "POST",
        url: joinUrl(this.baseUrl, "/api/embeddings"),
        body: { model, prompt: text },
        model,
        context: `ollama embeddings ${model}`,
        signal: req.signal,
      });
      const root = recordOf(doc) ?? {};
      const embedding = root["embedding"];
      if (!Array.isArray(embedding)) {
        throw new ProviderError({
          message: `ollama embeddings: svaret saknade vektor för ${model}`,
          errorClass: "parse",
          source: this.source,
          providerId: this.id,
          model,
        });
      }
      vectors.push(embedding.filter((n): n is number => typeof n === "number"));
    }
    const normalized = normalizeVectorBatch(vectors);
    return {
      vectors: normalized,
      model,
      providerId: this.id,
      source: this.source,
      latencyMs: Date.now() - started,
      dimensions: normalized[0]?.length ?? 0,
    };
  }

  // --- Vision --------------------------------------------------------------

  protected async visionImpl(req: VisionRequest): Promise<VisionAnswer> {
    const started = Date.now();
    const turn: ChatTurn = {
      role: "user",
      content: req.prompt ?? "Beskriv bilden. Om det finns text i bilden, skriv ut den ord för ord.",
      images: [{ dataBase64: stripDataUrl(req.imageBase64), mime: req.mime ?? "image/png" }],
    };
    const result = await this.chat({ model: req.model, messages: [turn], signal: req.signal, temperature: 0 });
    return {
      text: result.text,
      engine: this.isLocal ? "vlm-local" : "vlm-cloud",
      model: result.model,
      providerId: this.id,
      source: result.source,
      confidence: result.text.trim().length === 0 ? 0 : 0.75,
      tookMs: Date.now() - started,
    };
  }

  // --- Pull med progress (FAS 3.2 h, event model/pull_progress) -------------

  async pull(ref: string, onProgress?: PullProgressCallback): Promise<ModelPullOutcome> {
    const started = Date.now();
    try {
      const res = await openStream(
        {
          method: "POST",
          url: joinUrl(this.baseUrl, "/api/pull"),
          headers: this.extraHeaders,
          body: { name: ref, stream: true, insecure: false },
          context: `ollama pull ${ref}`,
        },
        this.httpDeps({ retry: NO_RETRY }),
      );
      let status = "starting";
      let lastPercent = 0;
      let totalBytes: number | undefined;
      const pullGuard = mergeSignals();
      const lines = withIdleTimeout(readNdjson(res, { context: `ollama pull ${ref}` }), {
        timeoutMs: this.timeoutMs,
        context: `ollama pull ${ref}`,
        onTimeout: () => pullGuard.abort(new Error("pull avbröts: ingen progress")),
      });
      for await (const line of lines) {
        const nextStatus = stringAt(line, "status") ?? status;
        const completed = numberAt(line, "completed");
        const total = numberAt(line, "total");
        totalBytes = total ?? totalBytes;
        if (completed !== undefined && total !== undefined && total > 0) {
          lastPercent = Math.min(100, Math.round((completed / total) * 100));
        } else if (nextStatus.toLowerCase().includes("success")) {
          lastPercent = 100;
        }
        status = nextStatus;
        const payload = { percent: lastPercent, status, totalBytes };
        onProgress?.(payload);
        this.logger.debug(`pull ${ref}: ${status} ${lastPercent}%`, { ref, ...payload, providerId: this.id });
      }
      return {
        ref,
        ok: true,
        message: `${ref} är klar (status ${status}) på ${Date.now() - started}ms`,
        bytes: totalBytes,
      };
    } catch (err) {
      const failure = toProviderError(err, {
        message: `ollama pull av ${ref} misslyckades`,
        source: this.source,
        providerId: this.id,
        model: ref,
      });
      this.logger.error(failure.message, { ref, errorClass: failure.errorClass, code: failure.code });
      return { ref, ok: false, message: failure.userMessage() };
    }
  }

  // --- Probe ---------------------------------------------------------------

  protected async ping(): Promise<{ model?: string; sample?: string; httpStatus?: number }> {
    const doc = await this.json<unknown>({
      method: "GET",
      url: joinUrl(this.baseUrl, "/api/tags"),
      context: "ollama tags",
    }, { retry: FAST_RETRY });
    const root = recordOf(doc) ?? {};
    const models = arrayOf(root["models"]);
    const first = recordOf(models[0]);
    const name = stringAt(first, "model") ?? stringAt(first, "name");
    if (models.length === 0 || name === undefined) {
      return { sample: "Ollama svarar men har inga modeller hämtade", httpStatus: 200 };
    }
    return { model: name, sample: `${models.length} modeller, senaste: ${name}`, httpStatus: 200 };
  }
}

/**
 * Kroppbygget för /api/chat. Bilddelar skickas som `images:[base64]` — Ollama tar
 * alltså inte data-URL:er, bara rå base64.
 */
export function buildOllamaChatBody(req: ChatRequest, model: string, stream: boolean): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (req.contextChunks !== undefined && req.contextChunks.length > 0) {
    messages.push({
      role: "system",
      content: req.contextChunks.map((chunk) => `${chunk.path}:${chunk.startLine}: ${chunk.text.slice(0, 400)}`).join("\n"),
    });
  }
  for (const turn of req.messages) {
    if (turn.role === "assistant" && turn.toolCalls !== undefined && turn.toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: turn.content,
        tool_calls: turn.toolCalls.map((call) => ({
          id: call.callId,
          type: "function",
          function: { name: call.name, arguments: typeof call.args === "string" ? call.args : call.args },
        })),
      });
      continue;
    }
    const message: Record<string, unknown> = { role: turn.role, content: turn.content };
    if (turn.images !== undefined && turn.images.length > 0) {
      message.images = turn.images.map((image) => stripDataUrl(image.dataBase64));
    }
    if (turn.role === "tool") {
      const callId = turn.toolCallId;
      if (callId !== undefined) message.tool_call_id = callId;
      if (turn.toolName !== undefined) message.tool_name = turn.toolName;
    }
    messages.push(message);
  }

  const body: Record<string, unknown> = { model, messages, stream };
  const options: Record<string, unknown> = {};
  if (req.temperature !== undefined) options.temperature = req.temperature;
  if (req.maxTokens !== undefined) options.num_predict = req.maxTokens;
  if (req.topP !== undefined) options.top_p = req.topP;
  if (req.stop !== undefined && req.stop.length > 0) options.stop = req.stop;
  if (Object.keys(options).length > 0) body.options = options;
  const tools = mapOllamaTools(req.tools);
  if (tools !== undefined) {
    body.tools = tools;
    if (req.toolChoice !== undefined && req.toolChoice !== "auto") body.tool_choice = req.toolChoice;
  }
  return body;
}

function mapOllamaTools(tools: ToolDefinition[] | undefined): Record<string, unknown>[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

function usageFromOllama(root: Record<string, unknown>): ChatResult["usage"] {
  const prompt = numberAt(root, "prompt_eval_count") ?? 0;
  const completion = numberAt(root, "eval_count") ?? 0;
  if (prompt === 0 && completion === 0) return undefined;
  return mapUsage({ prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion });
}

function booleanLoaded(model: Record<string, unknown> | undefined): boolean {
  const expiresAt = stringAt(model, "expires_at");
  if (expiresAt !== undefined) return expiresAt.length > 0 && expiresAt !== "0001-01-01T00:00:00Z";
  return false;
}

function stripDataUrl(value: string): string {
  const comma = value.indexOf(",");
  return value.startsWith("data:") && comma > 0 ? value.slice(comma + 1) : value;
}

function normalizeVectorBatch(vectors: readonly number[][]): number[][] {
  return vectors.map(normalizeVector);
}

/**
 * gateway.ts — ModelGateway: den enda platsen där protocol möter modellagret.
 *
 * Varför den behövs:
 *   1. @nexus/core beskriver sitt provider-beroende som den strukturella typen
 *      `NexusProviderRegistry` (chat + isModelAvailable) medan @nexus/providers
 *      levererar `ProviderRegistry` med callForRole/streamForRole. Gateway ar
 *      den enda adaptern mellan de två — core och providers rörs inte (R: filäga).
 *   2. AgentKernel bygger ALDRIG MCP-verktyg självt (den anropar bara
 *      buildCoreTools). SPEC FAS 4.4 kravet "alla tools från alla servrar in i
 *      agent-loopen" uppfylls därför här: gateway lägger till de namespacade
 *      MCP-verktygen i schema, exekverar anrop på namnrymdsformen
 *      `<serverId>__<tool>`, skriver resultatet i kärnans egen meddelandelista
 *      och frågar modellen igen. Kärnan ser bara sina karnoverktyg — allt
 *      andra arbete är already done när den får sitt svar.
 *   3. Roll-fallback (agent → chat → reasoning) hanteras här sa att en
 *      workspace med bara en inkopplad modell faktiskt kan kora en agent,
 *      och degraderingen loggas med sitt verkliga varfor.
 *
 * Sandhet: varje svar bar `source` fran leverantoren (local | cloud | stub | none)
 * — gateway hittar pa aldrig ut att en stub vore en riktig modell.
 */

import { randomUUID } from "node:crypto";
import {
  splitMcpToolName,
  type ChatRole,
  type CompletionRequest,
  type CompletionResult,
  type EventName,
  type JsonSchema,
  type McpToolInfo,
  type McpToolResult,
  type ModelRole,
  type ModelSource,
} from "@nexus/protocol";
import {
  ProviderError,
  type ChatRequest,
  type ChatResult,
  type ChatTurn,
  type ProviderRegistry,
  type ToolDefinition,
} from "@nexus/providers";
import type { Logger } from "@nexus/core";
import type {
  NexusProviderRegistry,
  ProviderChatMessage,
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderChatToolCall,
  ProviderToolSchema,
} from "@nexus/core";

/** Message-loggen kärnan hall i — den ar mutable pa trotsighets varde och vi need det. */
type LiveMessages = ProviderChatMessage[];

export interface McpToolBridge {
  listTools(): McpToolInfo[];
  callTool(qualifiedName: string, args: unknown): Promise<McpToolResult>;
}

export interface ModelGatewayOptions {
  readonly registry: ProviderRegistry;
  readonly logger: Logger;
  /** MCP-verktyg till agent-loopen (FAS 4.4). Utelämnas → agenten fär bara karnoverktyg. */
  readonly mcp?: McpToolBridge;
  /** Event-kanal for agent/tool_call och agent/tool_result fran MCP-bryggan. */
  readonly emit?: (name: EventName, payload: unknown) => void;
  /** Läser aktuell runId fran AgentToolContext (sätts av AgentKernel fore verktygen). */
  readonly currentRunId?: () => string | undefined;
  /** Max varv bryggan far kora MCP-anrop inom ett enskilt chat-anrop. */
  readonly maxBridgeRounds?: number;
}

const ROLE_FALLBACK: Record<ModelRole, ModelRole[]> = {
  chat: ["chat", "reasoning", "agent"],
  agent: ["agent", "chat", "reasoning"],
  reasoning: ["reasoning", "chat", "agent"],
  autocomplete: ["autocomplete"],
  embeddings: ["embeddings"],
  vision: ["vision"],
};

const CHAT_ROLES: ModelRole[] = ["chat", "agent", "reasoning"];

/**
 * callForRole har per-roll-overlader: chat/agent/reasoning tar en ChatRequest,
 * medan autocomplete/embeddings/vision har helt andra payloads. Nar vi har en
 * upploskt `target.role` (vidig ModelRole) men faktiskt ska skicka en chatt-begaran,
 * MASTE vi snava ner rollen till det chatt-familjen tillater. Returnerar null nar
 * rollen inte ar en chatt-roll — anroparen hanterar det som ett arligt inga-modell-fel
 * for den rollen, aldrig en tyst cast.
 */
function toChatRole(role: ModelRole): "chat" | "agent" | "reasoning" | null {
  if (role === "chat") return "chat";
  if (role === "agent") return "agent";
  if (role === "reasoning") return "reasoning";
  return null;
}

export class ModelGateway implements NexusProviderRegistry {
  private readonly registry: ProviderRegistry;
  private readonly logger: Logger;
  private readonly mcp: McpToolBridge | undefined;
  private readonly emit: ((name: EventName, payload: unknown) => void) | undefined;
  private readonly currentRunId: (() => string | undefined) | undefined;
  private readonly maxBridgeRounds: number;

  constructor(options: ModelGatewayOptions) {
    this.registry = options.registry;
    this.logger = options.logger;
    this.mcp = options.mcp;
    this.emit = options.emit;
    this.currentRunId = options.currentRunId;
    this.maxBridgeRounds = options.maxBridgeRounds ?? 4;
  }

  get providerRegistry(): ProviderRegistry {
    return this.registry;
  }

  /** Vilken roll kan besvara en uppgift just nu? Forsta tilldelade som inte ar null. */
  resolveRole(preferred: ModelRole): { role: ModelRole; source: ModelSource; providerId: string; model: string } | null {
    for (const role of ROLE_FALLBACK[preferred] ?? [preferred]) {
      const resolved = this.registry.resolve(role);
      if (resolved !== null) {
        if (role !== preferred) {
          this.logger.info(`roll ${preferred} ar inte tilldelad — usar ${role} som fallback`, {
            fas: "3.4",
            preferred,
            used: role,
            source: resolved.source,
          });
        }
        return { role, source: resolved.source, providerId: resolved.providerId, model: resolved.model };
      }
    }
    return null;
  }

  isModelAvailable(role: ModelRole): boolean {
    return this.resolveRole(role) !== null;
  }

  /**
   * Verktygssamtal for AgentKernel. Inkluderar MCP-bryggan: om modellen svarar
   * med namnrymds­verktyg exekverar vi dem, skriver turerna i kärnans eget
   * meddelandelager och ber igen — utan att kärnan behover veta av nagot.
   */
  async chat(req: ProviderChatRequest): Promise<ProviderChatResponse> {
    const target = this.resolveRole(req.role);
    if (target === null) {
      return {
        ok: false,
        text: "",
        toolCalls: [],
        model: "",
        providerId: "none",
        source: "none",
        finishReason: "error",
        error: `Ingen modell är tilldelad rollen ${req.role} (eller dess fallback). Välj en i Settings → Models.`,
      };
    }

    const mcpTools = this.mcpSchemas();
    const tools = [...req.tools, ...mcpTools];
    let messages: LiveMessages = req.messages;
    let last: ChatResult | undefined;
    let degraded: string | undefined = target.role === req.role ? undefined : `fallback-roll ${target.role}`;

    // Upplöst roll för en chatt-begäran måste faktiskt vara en chatt-roll —
    // callForRole begär exakt den snävare typen för ChatRequest-overladden.
    const chatRole = toChatRole(target.role);
    if (chatRole === null) {
      return {
        ok: false,
        text: "",
        toolCalls: [],
        model: target.model,
        providerId: target.providerId,
        source: "none",
        finishReason: "error",
        error: `Rollen ${target.role} kan inte besvara en chatt-begäran. Till dela en chatt-, agent- eller reasoning-modell i Settings → Models.`,
      };
    }

    for (let round = 0; round <= this.maxBridgeRounds; round += 1) {
      const chatRequest: ChatRequest = {
        messages: toTurns(messages),
        tools: tools.length > 0 ? tools : undefined,
        signal: req.signal,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
      };
      try {
        last = await this.registry.callForRole(chatRole, chatRequest);
      } catch (err) {
        const failure = err instanceof ProviderError ? err : undefined;
        if (failure !== undefined && failure.errorClass === "no_model") {
          return {
            ok: false,
            text: "",
            toolCalls: [],
            model: target.model,
            providerId: target.providerId,
            source: failure.source ?? "none",
            finishReason: "error",
            error: failure.userMessage(),
          };
        }
        throw err;
      }

      const mcpCalls = last.toolCalls.filter((call) => splitMcpToolName(call.name).serverId.length > 0);
      const coreCalls = last.toolCalls.filter((call) => splitMcpToolName(call.name).serverId.length === 0);
      if (mcpCalls.length === 0) break;

      // Skriv in MCP-turerna i kernans histik i kronologisk ordning: kernan
      // addera sin egen assistant-turn forst NAR vi returnerar, sa det som ligger
      // till nu hamnarfore det — precis som det faktiskt hände.
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: mcpCalls.map((call) => ({ id: call.callId, name: call.name, args: call.args })),
      });
      for (const call of mcpCalls) {
        const result = await this.runMcpTool(call.name, call.args, req.signal);
        messages.push({ role: "tool", content: result.ok ? result.text : `${result.error ?? "fel"}\n${result.text}`, toolCallId: call.callId, name: call.name });
      }
      if (coreCalls.length === 0 && last.text.trim().length === 0) {
        degraded = degraded ?? "mcp-bryge";
        continue; // Fortsatt slingan — modellen har ännu inte gett ett slutvärde.
      }
      // Blandat svar: vi returnerar kärnans verktyg, MCP-arbetet är redan klart.
      return toResponse({ ...last, toolCalls: coreCalls });
    }

    if (last === undefined) {
      return {
        ok: false,
        text: "",
        toolCalls: [],
        model: target.model,
        providerId: target.providerId,
        source: "none",
        finishReason: "error",
        error: "MCP-bryggan nådde sin gräns utan att modellen svarade.",
      };
    }
    if (degraded !== undefined) {
      this.logger.debug(`agent-svar via ${degraded}`, { fas: "7.1", providerId: last.providerId, source: last.source });
    }
    return toResponse(last);
  }

  /**
   * Plana textfrager (chat.send, inline-edit, review, test-generator) med
   * rolling av fallback-rollen. Returnerar ChatResult for att anroparen ska
   * kunna lasa bade text och kilpa (source/degraded) — aldrig bara strangen.
   */
  async ask(opts: {
    role: ModelRole;
    messages: ChatTurn[];
    signal?: AbortSignal;
    temperature?: number;
    maxTokens?: number;
    tools?: ToolDefinition[];
    contextChunks?: ChatRequest["contextChunks"];
  }): Promise<ChatResult> {
    const target = this.resolveRole(opts.role);
    if (target === null) {
      throw new ProviderError({
        message: `Ingen modell är tilldelad rollen ${opts.role}. Öppna Settings → Models och välj en modell (lokal Ollama eller en API-nyckel).`,
        errorClass: "no_model",
        source: "none",
      });
    }
    // Samma snavning som chat()-vagen: en plan textfragar kan bara ga till en
    // chatt-roll. Ar den upplösta rollen nagon annan, ar det ett arligt inga-modell-fel.
    const chatRole = toChatRole(target.role);
    if (chatRole === null) {
      throw new ProviderError({
        message: `Rollen ${target.role} kan inte besvara en chatt-begäran. Tilldela en chatt-, agent- eller reasoning-modell i Settings → Models.`,
        errorClass: "no_model",
        source: "none",
      });
    }
    return this.registry.callForRole(chatRole, {
      messages: opts.messages,
      ...(opts.tools !== undefined && opts.tools.length > 0 ? { tools: opts.tools } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.contextChunks !== undefined ? { contextChunks: opts.contextChunks } : {}),
    });
  }

  /**
  Streaming for chat.send. Fallback sker fore forsta token i registret; efter
   * att strommen oppnats avbryts den aldrig — da ar det anvandarens tur.
   */
  stream(opts: { role: ModelRole; messages: ChatTurn[]; signal?: AbortSignal; contextChunks?: ChatRequest["contextChunks"] }): AsyncGenerator<string> {
    const target = this.resolveRole(opts.role) ?? { role: opts.role };
    const request: ChatRequest = {
      messages: opts.messages,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.contextChunks !== undefined ? { contextChunks: opts.contextChunks } : {}),
    };
    return this.registry.streamForRole(target.role, request);
  }

  /** Senaste utfallsrapporten for en roll — kllan till chat/done:s modell/providerId. */
  report(role: ModelRole): { providerId: string; model: string; source: ModelSource; ok: boolean; degraded?: string } | null {
    const value = this.registry.lastReport(role);
    if (value === undefined) return null;
    return { providerId: value.providerId, model: value.model, source: value.source, ok: value.ok, ...(value.degraded !== undefined ? { degraded: value.degraded } : {}) };
  }

  /**
   * Rå FIM-completion (FAS 7.6). Returnerar CompletionResult med sann `source` —
   * den är enda giltiga bevisnivån i hela monorepon.
   */
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const resolved = this.registry.resolve("autocomplete");
    if (resolved === null) throw this.noModel("autocomplete");
    return this.registry.callForRole("autocomplete", req);
  }

  /** Embeddings for RAG — kastar om ingen embeddings-roll finns. */
  async embed(texts: string[]): Promise<{ vectors: number[][]; model: string; source: ModelSource }> {
    const resolved = this.registry.resolve("embeddings");
    if (resolved === null) {
      throw new ProviderError({ message: "Ingen modell är tilldelad rollen embeddings.", errorClass: "no_model", source: "none" });
    }
    const result = await this.registry.callForRole("embeddings", texts);
    return { vectors: result.vectors, model: `${result.providerId}/${result.model}`, source: result.source };
  }

  private noModel(role: ModelRole): ProviderError {
    return new ProviderError({ message: `Ingen modell är tilldelad rollen ${role}.`, errorClass: "no_model", source: "none" });
  }

  private mcpSchemas(): ProviderToolSchema[] {
    if (this.mcp === undefined) return [];
    let tools: McpToolInfo[] = [];
    try {
      tools = this.mcp.listTools();
    } catch (err) {
      this.logger.warn("MCP: verktygslistan kunde inte hämtas till agenten", { fas: "4.4", error: String(err) });
      return [];
    }
    return tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema as JsonSchema }));
  }

  private async runMcpTool(qualifiedName: string, args: unknown, signal?: AbortSignal): Promise<McpToolResult> {
    const runId = this.currentRunId?.() ?? "mcp-bryga";
    const callId = randomUUID();
    this.emit?.("agent/tool_call", { runId, callId, tool: qualifiedName, args });
    if (signal?.aborted) {
      const aborted: McpToolResult = { ok: false, text: "", tookMs: 0, error: "Avbruten innan MCP-anropet." };
      this.emit?.("agent/tool_result", { runId, callId, tool: qualifiedName, ok: false, output: aborted.error ?? "", tookMs: 0 });
      return aborted;
    }
    if (this.mcp === undefined) {
      const missing: McpToolResult = { ok: false, text: "", tookMs: 0, error: "MCP-laget är inte kopplat." };
      this.emit?.("agent/tool_result", { runId, callId, tool: qualifiedName, ok: false, output: missing.error ?? "", tookMs: 0 });
      return missing;
    }
    const result = await this.mcp.callTool(qualifiedName, args);
    this.emit?.("agent/tool_result", { runId, callId, tool: qualifiedName, ok: result.ok, output: result.text.slice(0, 8000), tookMs: result.tookMs });
    return result;
  }
}

// ---------------------------------------------------------------------------
// Mapping helper (enda stallet protocol-typer omvandlas till provider-typer)
// ---------------------------------------------------------------------------

function toTurns(messages: readonly ProviderChatMessage[]): ChatTurn[] {
  return messages.map((message) => ({
    role: message.role as ChatRole,
    content: message.content,
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    ...(message.name !== undefined ? { toolName: message.name } : {}),
    ...(message.toolCalls !== undefined && message.toolCalls.length > 0
      ? { toolCalls: message.toolCalls.map((call) => ({ callId: call.id, name: call.name, args: call.args, rawArgs: safeArgs(call.args) })) }
      : {}),
  }));
}

function safeArgs(args: unknown): string {
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "{}";
  }
}

function toFinishReason(result: ChatResult): "stop" | "tool_calls" | "length" | "aborted" | "error" {
  if (result.toolCalls.length > 0) return "tool_calls";
  if (result.finishReason === "length") return "length";
  if (result.finishReason === "aborted") return "aborted";
  if (result.finishReason === "error") return "error";
  return "stop";
}

function toResponse(result: ChatResult): ProviderChatResponse & { degradedTo?: string } {
  const toolCalls: ProviderChatToolCall[] = result.toolCalls.map((call) => ({ id: call.callId, name: call.name, args: call.args }));
  return {
    ok: true,
    text: result.text,
    toolCalls,
    model: result.model,
    providerId: result.providerId,
    source: result.source,
    finishReason: toFinishReason(result),
    ...(result.degraded === undefined ? {} : { degradedTo: result.degraded }),
  };
}

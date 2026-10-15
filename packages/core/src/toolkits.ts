/**
 * toolkits.ts — strukturella gränssnitt för paket som byggs parallellt
 * (@nexus/voice, @nexus/vision, @nexus/rag och @nexus/providers).
 *
 * Vi KODAR MOT EN MINIMAL STRUKTURELL FORM så att @nexus/core typkontrolleras och
 * testas även innan de paketen är byggda. Tacksämhet (structural typing) gör att den
 * riktiga implementationen kan passa så snart den exponerar samma metoder.
 *
 * AVVIKELSE: API.md skriver `providers: import("@nexus/providers").ProviderRegistry`.
 * Eftersom @nexus/providers ännu inte har nagra exporterade typet (bara PLACEHOLDER)
 * och testerna inte far importera dess kompilerade output, deklareras en strukturell
 * `NexusProviderRegistry` har. Fallnamnet `providers` pa AgentToolContext ar kvar.
 */

import type {
  AgentMode,
  CaptureResult,
  CaptureTarget,
  ChatRole,
  EventName,
  JsonSchema,
  ModelRole,
  ModelSource,
  RagChunk,
  TranscriptResult,
  VisionResult,
} from "@nexus/protocol";
import type { Logger } from "./logger";
import type { WorkspaceService } from "./workspace";
import type { CheckpointManager } from "./checkpoints";
import type { TerminalManager } from "./terminal";
import type { ApprovalBroker } from "./approvals";

/** Röstverktyg — konsumeras av `transcribe`-verktyget. */
export interface VoiceToolkit {
  transcribe(a: { audioBase64?: string; filePath?: string; format?: string; language?: string }): Promise<TranscriptResult>;
}

/** Visionverktyg — konsumeras av `screenshot_analyze`-verktyget. */
export interface VisionToolkit {
  capture?(target?: CaptureTarget, path?: string): Promise<CaptureResult>;
  analyze(a: { imageBase64?: string; prompt?: string; target?: CaptureTarget; path?: string }): Promise<VisionResult>;
}

/** RAG-verktyg — konsumeras av `rag_search`-verktyget. */
export interface RagToolkit {
  search(query: string, k?: number): Promise<RagChunk[]>;
}

/** MCP-verktygsinfo (speglar @nexus/mcp-client; deklarerad lokalt for att slippa importcykel). */
export interface McpToolInfo {
  readonly name: string;
  readonly serverId: string;
  readonly localName: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly readOnly: boolean;
}

export interface McpToolResult {
  readonly ok: boolean;
  readonly text: string;
  readonly structured?: unknown;
  readonly images?: string[];
  readonly tookMs: number;
  readonly error?: string;
}

// ---------------- Provider-avkroksform for verktygssamtal ----------------

export interface ProviderToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
}

export interface ProviderChatToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

export interface ProviderChatMessage {
  readonly role: ChatRole;
  readonly content: string;
  readonly toolCallId?: string;
  readonly name?: string;
  readonly toolCalls?: ProviderChatToolCall[];
}

export interface ProviderChatRequest {
  readonly role: ModelRole;
  readonly messages: ProviderChatMessage[];
  readonly tools: ProviderToolSchema[];
  readonly signal?: AbortSignal;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface ProviderChatResponse {
  readonly ok: boolean;
  readonly text: string;
  readonly toolCalls: ProviderChatToolCall[];
  readonly model: string;
  readonly providerId: string;
  readonly source: ModelSource;
  readonly finishReason: "stop" | "tool_calls" | "length" | "aborted" | "error";
  readonly error?: string;
}

/** Strukturell standrd for den riktiga provider-registret. */
export interface NexusProviderRegistry {
  chat(req: ProviderChatRequest): Promise<ProviderChatResponse>;
  isModelAvailable?(role: ModelRole): boolean;
}

export interface AgentToolContext {
  workspace: WorkspaceService;
  checkpoints: CheckpointManager;
  terminals: TerminalManager;
  approvals: ApprovalBroker;
  providers: NexusProviderRegistry;
  mcp:
    | {
        listTools(): Promise<McpToolInfo[]>;
        callTool(name: string, args: unknown): Promise<McpToolResult>;
      }
    | null;
  voice?: VoiceToolkit;
  vision?: VisionToolkit;
  rag?: RagToolkit;
  logger: Logger;
  emit: (e: EventName, p: unknown) => void;
  mode: AgentMode;
  signal: AbortSignal;
  /** Kopt runId satts av AgentKernel fore verktygen byggs; anvands for godkännande. */
  runId?: string;
}

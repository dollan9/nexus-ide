/**
 * Intern Typer — typerna modellagret behöver *utöver* @nexus/protocol.
 *
 * Protocol-paketet är det enda stället transporttyper får leva. Det som bor här är
 * kontrakten *inuti* host: vad en provider tar emot när agenten vill prata med en modell,
 * och hur aggregerat svar ser ut. Allt som åker ut över IPC/WS konverteras i @nexus/host.
 */

import type {
  ModelSource,
  ProviderCapability,
  ProviderKind,
  RagChunk,
} from "@nexus/protocol";

// ---------------------------------------------------------------------------
// fetch-abstraktion
// ---------------------------------------------------------------------------

/**
 * Minimal yta av `fetch` som vi faktiskt använder.
 *
 * Vi skriver mot den här istället för den globala typen eftersom TypeScript strict med
 * `lib: ["DOM"]` annars tvingar oss att casta varje anrop, och för att testerna ska kunna
 * injicera en falsk transport utan att nätverk alls används.
 */
export interface RequestInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface ReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<unknown> | void;
  releaseLock(): void;
}

export interface BodyReaderLike {
  readonly locked?: boolean;
  getReader(): ReaderLike;
  cancel(reason?: unknown): Promise<unknown> | void;
}

export interface HeadersLike {
  get(name: string): string | null;
}

export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: HeadersLike;
  text(): Promise<string>;
  json(): Promise<unknown>;
  readonly body?: BodyReaderLike | null;
}

export type FetchLike = (input: string, init?: RequestInitLike) => Promise<ResponseLike>;

// ---------------------------------------------------------------------------
// Tids- och slumpfunktioner (behövs för deterministiska backoff-tester)
// ---------------------------------------------------------------------------

export type TimerFn = (ms: number) => Promise<unknown>;
export type RandomFn = () => number;

// ---------------------------------------------------------------------------
// Verktyg (tool calling)
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

export interface ToolCall {
  readonly callId: string;
  readonly name: string;
  /** Redan parsad JSON om kroppen är giltig, annars raw-strängen. */
  readonly args: unknown;
  readonly rawArgs: string;
}

export interface ToolResultTurn {
  readonly callId: string;
  readonly name: string;
  readonly content: string;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export type ChatTurnRole = "system" | "user" | "assistant" | "tool";

export interface ImagePart {
  readonly dataBase64: string;
  readonly mime: string;
  readonly name?: string;
}

export interface ChatTurn {
  readonly role: ChatTurnRole;
  readonly content: string;
  /** Endast för role:"tool" — quale verktygssvar detta tillhör. */
  readonly toolCallId?: string;
  readonly toolName?: string;
  /** För role:"assistant" i en verktygs-slinga: de anrop modellen redan gjort. */
  readonly toolCalls?: ToolCall[];
  readonly images?: ImagePart[];
}

export interface ChatRequest {
  readonly model?: string;
  readonly messages: ChatTurn[];
  readonly tools?: ToolDefinition[];
  readonly toolChoice?: "auto" | "none" | "required";
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly topP?: number;
  readonly stop?: string[];
  readonly signal?: AbortSignal;
  /** Extra prompt-del som sätts sist (RAG-kontext, ögon-rapport, etc). */
  readonly contextChunks?: RagChunk[];
  readonly metadata?: Record<string, string>;
}

export interface TokenUsage {
  readonly prompt: number;
  readonly completion: number;
  readonly total: number;
}

export interface ChatResult {
  readonly text: string;
  readonly model: string;
  readonly providerId: string;
  readonly kind: ProviderKind;
  readonly source: ModelSource;
  readonly latencyMs: number;
  readonly toolCalls: ToolCall[];
  readonly finishReason?: string;
  readonly usage?: TokenUsage;
  /** Ifall svaret kommer från en medveten test-adapter eller verklig infrastruktur. */
  readonly degraded?: string;
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export interface EmbeddingsRequest {
  readonly texts: string[];
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export interface EmbeddingsResult {
  readonly vectors: number[][];
  readonly model: string;
  readonly providerId: string;
  readonly source: ModelSource;
  readonly latencyMs: number;
  readonly dimensions: number;
}

// ---------------------------------------------------------------------------
// Vision
// ---------------------------------------------------------------------------

export type VisionEngine = "vlm-local" | "vlm-cloud" | "ocr" | "stub";

export interface VisionRequest {
  readonly imageBase64: string;
  readonly mime?: string;
  readonly prompt?: string;
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export interface VisionAnswer {
  readonly text: string;
  readonly engine: VisionEngine;
  readonly model: string;
  readonly providerId: string;
  readonly source: ModelSource;
  readonly confidence: number;
  readonly tookMs: number;
  readonly note?: string;
}

// ---------------------------------------------------------------------------
// Komplettings-/modellhjälpare
// ---------------------------------------------------------------------------

/** En nedladdningsbar modell som *inte* finns lokalt ännu (NVIDIA-katalog, hf-lista). */
export interface CatalogModel {
  readonly id: string;
  readonly displayName?: string;
  readonly contextLength?: number;
  readonly capabilities?: ProviderCapability[];
}

export type PullProgressCallback = (event: { percent: number; status: string; totalBytes?: number }) => void;

export interface ModelPullOutcome {
  readonly ref: string;
  readonly ok: boolean;
  readonly message: string;
  readonly bytes?: number;
}

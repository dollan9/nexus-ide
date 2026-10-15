/**
 * @nexus/protocol — NEXUS-IDE:s enda kommunikationskontrakt.
 *
 * Detta paket är den Sanna Källan för allt som går mellan renderer (React/Monaco) och host
 * (Node-processen som äger agentkärnan, providers, MCP, röst och vision).
 *
 * Varför ett separat kontraktspaket: host körs i två transportlägen med exakt samma ram —
 *   1) Electron IPC (ipcMain.handle → dispatch) i skrivbordsappen
 *   2) WebSocket ws://127.0.0.1:7946/ws i webbläsarläge och i e2e-testerna
 * Transport är en detalj; affärslogiken är densamma. Därför kan Playwright testa hela kedjan
 * UI → host → provider/MCP/ai-service utan att styra ett Electron-fönster.
 *
 * Konventioner (gäller hela monorepon, se CONVENTIONS.md):
 *   - TypeScript strict, kommentarer på svenska.
 *   - Packages byggs till CommonJS (module: CommonJS) och saknar runtime-beroenden.
 *   - Ingen hårdkodad nyckel någonsin: hemligheter lämnas ALDRIG ut ur host som värden, bara som {name, isSet}.
 *   - Alla nya metoder/events läggs till HÄR först, sedan implementeras båda sidor.
 */

/** Protokollversion — host och renderer loggar mismatch istället för att tyst misslyckas. */
export const PROTOCOL_VERSION = "1.0.0";

/** Standardport för WS-bron (browser-läge + e2e). Alltid loopback. */
export const HOST_DEFAULT_PORT = 7946;

/** Standardport för Python-ai-service (röst/vision/OCR/RAG). */
export const AI_SERVICE_DEFAULT_PORT = 7955;

// =====================================================================
// 1. Ram: requests, responses, events
// =====================================================================

export type RpcId = number | string;

export interface RpcRequest<M extends MethodName = MethodName> {
  readonly jsonrpc: "2.0";
  readonly id: RpcId;
  readonly method: M;
  readonly params: ParamsOf<M>;
}

export interface RpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface RpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: RpcId;
  readonly result?: unknown;
  readonly error?: RpcError;
  readonly protocolVersion: string;
}

export interface EventFrame<E extends EventName = EventName> {
  readonly type: "event";
  readonly name: E;
  readonly payload: PayloadOf<E>;
  readonly ts: number;
}

/** Felkoder som UI:t känner igen och renderar som egna tillstånd. */
export const ErrorCode = {
  BadRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  /** Användaren sa nej till en åtgärd (godkännandeflödet). */
  ApprovalDenied: -32001,
  /** Ingen modell kan nås — varken lokal eller moln. Appen får aldrig krascha. */
  NoModelAvailable: -32002,
  /** ai-service (Python) svarar inte; röst/vision är offline. */
  AiServiceOffline: -32003,
  /** MCP-servern är ansluten men verktyget finns inte. */
  ToolNotFound: -32004,
  RateLimited: -32005,
  CheckpointNotFound: -32006,
} as const;
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

// =====================================================================
// 2. Domänetyper
// =====================================================================

/** Vilken uppgift en modell är tilldelad. Roll-fördelning = FAS 3.4. */
export type ModelRole =
  | "chat"
  | "agent"
  | "autocomplete"
  | "embeddings"
  | "vision"
  | "reasoning";

export const ALL_MODEL_ROLES: ModelRole[] = [
  "chat",
  "agent",
  "autocomplete",
  "embeddings",
  "vision",
  "reasoning",
];

/** UI:lägen enligt FAS 7.5. */
export type AgentMode = "ask" | "agent" | "debug" | "voice" | "eyes";

/** Godkännandestrategi för terminal/scratch (FAS 7.2). */
export type ApprovalMode = "ask" | "allowlist" | "auto";

export type ProviderKind =
  | "nvidia"
  | "openai"
  | "anthropic"
  | "google"
  | "openrouter"
  | "groq"
  | "mistral"
  | "ollama"
  | "vllm"
  | "lmstudio"
  | "llamacpp"
  | "custom";

/** Sandhet: en provider vet inte om nyckeln är satt — det gör config-lagret. */
export interface ProviderInfo {
  readonly id: string;
  readonly label: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly isLocal: boolean;
  readonly hasKey: boolean;
  readonly keyEnvName?: string;
  readonly enabled: boolean;
  readonly builtin: boolean;
  readonly models: string[];
  readonly capabilities: ProviderCapability[];
  readonly lastProbe?: ProbeResult;
}

export type ProviderCapability =
  | "chat"
  | "stream"
  | "tools"
  | "complete"
  | "fim"
  | "embeddings"
  | "vision";

/** Ifall en ny provider läggs till via UI (FAS 3.2 f) — sparas i .env + config, aldrig i koden. */
export interface ProviderConfigInput {
  readonly id?: string;
  readonly label: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly apiKey?: string; // skickas ALDRIG tillbaka; skrivs till .env-nyckelnamn
  readonly apiKeyEnvName?: string;
  readonly model?: string;
  readonly models?: string[];
  readonly capabilities?: ProviderCapability[];
  readonly enabled?: boolean;
}

export interface ProbeResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly model?: string;
  readonly sample?: string;
  readonly httpStatus?: number;
  /** "real" = riktig modell svarade, "stub" = lokal test-server, "none" = ingen. Alvaret i RESULT.md. */
  readonly source?: ModelSource;
  readonly error?: string;
}

export type ModelSource = "local" | "cloud" | "stub" | "none";

export interface ModelEntry {
  readonly id: string;
  readonly ref: string;
  readonly providerId: string;
  readonly providerLabel: string;
  readonly source: ModelSource;
  readonly displayName?: string;
  readonly contextLength?: number;
  readonly sizeBytes?: number;
  readonly vramEstimateMb?: number;
  readonly loaded?: boolean;
  readonly capabilities: ProviderCapability[];
  readonly roles: ModelRole[];
}

export interface RoleAssignment {
  readonly role: ModelRole;
  readonly providerId: string;
  readonly model: string;
  readonly fallbackChain: string[];
  readonly source: ModelSource;
}

export interface VramInfo {
  readonly gpuName: string;
  readonly totalMb: number;
  readonly usedMb: number;
  readonly freeMb: number;
  readonly driverVersion?: string;
  readonly source: "nvidia-smi" | "wmi" | "unavailable";
}

export interface ServiceProbe {
  readonly ok: boolean;
  readonly baseUrl: string;
  readonly latencyMs?: number;
  readonly version?: string;
  readonly engines?: Partial<Record<"stt" | "tts" | "vlm" | "ocr", string>>;
  readonly error?: string;
}

// --- Filer, träd, editor ---------------------------------------------

export interface FsNode {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "dir";
  readonly size?: number;
  readonly children?: FsNode[];
}

export interface FsFile {
  readonly path: string;
  readonly content: string;
  readonly language: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly truncated?: boolean;
}

export interface SearchHit {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly preview: string;
  readonly match: string;
}

export interface SearchOptions {
  readonly isRegex?: boolean;
  readonly isCaseSensitive?: boolean;
  readonly wholeWord?: boolean;
  readonly includeGlob?: string;
  readonly excludeGlob?: string;
  readonly maxResults?: number;
}

export interface SearchResponse {
  readonly query: string;
  readonly tookMs: number;
  readonly numFiles: number;
  readonly numMatches: number;
  readonly hits: SearchHit[];
  readonly truncated: boolean;
  readonly engine: "ripgrep" | "js-fallback";
}

export interface WriteResult {
  readonly path: string;
  readonly bytes: number;
  readonly created: boolean;
  readonly checkpointId?: string;
  readonly unchanged: boolean;
}

/** SEARCH/REPLACE-block (FAS 7.3) — tillämpas med exakt → trimmad → fuzzy-match. */
export interface SearchReplacePatch {
  readonly search: string;
  readonly replace: string;
  readonly occurrences?: number;
}

export interface SelectionRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: string[];
}

export interface FileDiff {
  readonly path: string;
  readonly unified: string;
  readonly hunks: DiffHunk[];
  readonly added: number;
  readonly removed: number;
}

// --- Checkpoints (FAS 7.2) -------------------------------------------

export interface Checkpoint {
  readonly id: string;
  readonly label: string;
  readonly source: "agent" | "user" | "ai-edit" | "terminal";
  readonly createdAt: number;
  readonly files: string[];
  readonly shadowCommit: string;
  readonly stats: { readonly added: number; readonly removed: number };
}

// --- MCP (FAS 4) ------------------------------------------------------

export type McpTransport = "stdio" | "sse" | "http";

export interface McpServerConfig {
  readonly id: string;
  readonly label?: string;
  readonly transport: McpTransport;
  readonly command?: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly enabled: boolean;
  readonly builtin?: boolean;
}

export type McpServerStatus = "connected" | "stopped" | "error" | "starting";

export interface McpServerInfo {
  readonly id: string;
  readonly label: string;
  readonly transport: McpTransport;
  readonly status: McpServerStatus;
  readonly error?: string;
  readonly tools: string[];
  readonly resources: string[];
  readonly prompts: string[];
  readonly startedAt?: number;
}

/** Namespace: "<serverId>__<toolName>" — kollisioner är omöjliga flera servrar emellan. */
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

/** Minimal JSON Schema-typ — vi validerar inte fullt ut, bara tillräckligt för UI + args. */
export interface JsonSchema {
  readonly type?: string;
  readonly properties?: Record<string, JsonSchema & { description?: string }>;
  readonly required?: string[];
  readonly items?: JsonSchema;
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly [extra: string]: unknown;
}

// --- Chat, agent, tool-loop (FAS 7) ----------------------------------

export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: ChatRole;
  readonly text: string;
  readonly createdAt: number;
  readonly model?: string;
  readonly providerId?: string;
  readonly attachments?: Attachment[];
  readonly contextUsed?: RagChunk[];
  readonly toolCalls?: ToolCallRecord[];
  readonly streaming?: boolean;
}

export interface Attachment {
  readonly kind: "image" | "file" | "text";
  readonly name: string;
  readonly dataBase64?: string;
  readonly path?: string;
  readonly text?: string;
  readonly mime?: string;
}

export interface SessionInfo {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
  readonly mode: AgentMode;
}

export interface AgentStep {
  readonly index: number;
  readonly title: string;
  readonly status: "pending" | "running" | "done" | "failed" | "skipped";
  readonly detail?: string;
  readonly tool?: string;
}

export interface ToolCallRecord {
  readonly callId: string;
  readonly tool: string;
  readonly args: unknown;
  readonly ok: boolean;
  readonly output: string;
  readonly tookMs: number;
  readonly approval?: "allowed" | "denied" | "auto";
}

export interface ApprovalRequest {
  readonly id: string;
  readonly runId: string;
  readonly kind: "terminal" | "write" | "mcp-tool" | "delete";
  readonly title: string;
  readonly command?: string;
  readonly paths?: string[];
  readonly args?: unknown;
  readonly risk: "low" | "medium" | "high";
  readonly createdAt: number;
}

export interface AgentRunResult {
  readonly runId: string;
  readonly ok: boolean;
  readonly summary: string;
  readonly filesChanged: string[];
  readonly steps: AgentStep[];
  readonly toolCalls: ToolCallRecord[];
  readonly checkpoints: Checkpoint[];
  readonly tookMs: number;
}

export interface ReviewFinding {
  readonly severity: "blocker" | "major" | "minor" | "nit";
  readonly file: string;
  readonly line?: number;
  readonly title: string;
  readonly detail: string;
  readonly suggestion?: string;
}

export interface ReviewResult {
  readonly scope: string;
  readonly findings: ReviewFinding[];
  readonly summary: string;
  readonly model: string;
  readonly tookMs: number;
}

// --- Autocomplete / inline edit --------------------------------------

export interface CompletionRequest {
  readonly prefix: string;
  readonly suffix: string;
  readonly path: string;
  readonly language: string;
  readonly position: { readonly line: number; readonly column: number };
  readonly maxTokens?: number;
  readonly trimUntil?: string;
}

export interface CompletionResult {
  readonly text: string;
  readonly model: string;
  readonly providerId: string;
  readonly latencyMs: number;
  readonly source: ModelSource;
  readonly cached: boolean;
  readonly skipped?: "debounce" | "disabled" | "no-model" | "low-memory";
}

// --- Röst (FAS 5) -----------------------------------------------------

export interface TranscriptResult {
  readonly text: string;
  readonly language: string;
  readonly durationMs: number;
  readonly model: string;
  readonly engine: string;
  readonly latencyMs: number;
  readonly segments?: readonly { readonly from: number; readonly to: number; readonly text: string }[];
}

export interface SpeakResult {
  readonly audioBase64?: string;
  readonly url?: string;
  readonly format: "wav" | "mp3" | "ogg";
  readonly engine: string;
  readonly voice: string;
  readonly bytes: number;
  readonly latencyMs: number;
}

export interface VoiceStatus {
  readonly micAvailable: boolean;
  readonly devices: readonly { readonly id: string; readonly label: string; readonly default: boolean }[];
  readonly recordPermission: "granted" | "denied" | "prompt";
  readonly aiService: ServiceProbe;
  readonly speakResponses: boolean;
}

// --- Vision (FAS 6) ---------------------------------------------------

export type CaptureTarget = "screen" | "window" | "editor" | "file";

export interface CaptureResult {
  readonly pngBase64: string;
  readonly width: number;
  readonly height: number;
  readonly displayId?: string;
  readonly target: CaptureTarget;
  readonly ts: number;
  readonly bytes: number;
}

export interface OcrBlock {
  readonly text: string;
  readonly confidence: number;
  readonly box: readonly [number, number, number, number];
}

export interface VisionResult {
  readonly text: string;
  readonly engine: "vlm-local" | "vlm-cloud" | "ocr" | "stub";
  readonly model: string;
  readonly confidence: number;
  readonly tookMs: number;
  readonly blocks?: OcrBlock[];
  readonly note?: string;
}

// --- RAG (FAS 3.5) ----------------------------------------------------

export interface RagChunk {
  readonly id: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly score: number;
  readonly symbol?: string;
}

export interface RagStatus {
  readonly engine: "chroma" | "jsonl-fallback" | "none";
  readonly indexedFiles: number;
  readonly chunks: number;
  readonly embeddingsModel: string;
  readonly lastIndexedAt?: number;
  readonly indexing: boolean;
  readonly error?: string;
}

// --- Inställningar, teman, kommandon ----------------------------------

export interface NexusSettings {
  readonly theme: "dark" | "light" | "nexus-midnight";
  readonly fontSize: number;
  readonly workspaceRoot: string;
  readonly agentMode: AgentMode;
  readonly approvalMode: ApprovalMode;
  readonly allowlist: string[];
  readonly maxAgentSteps: number;
  readonly autocompleteEnabled: boolean;
  readonly autocompleteDebounceMs: number;
  readonly speakResponses: boolean;
  readonly voiceLanguage: string;
  readonly whisperModel: string;
  readonly eyesAutoVerify: boolean;
  readonly ragEnabled: boolean;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly keybindings: Record<string, string>;
  readonly roles: Record<ModelRole, { providerId: string; model: string } | null>;
}

export interface SecretKeyInfo {
  readonly name: string;
  readonly isSet: boolean;
  readonly source: "env" | "dotenv" | "config";
  /** Aldrig det faktiska värdet. Aldrig. */
  readonly masked?: "****";
}

export interface CommandDescriptor {
  readonly id: string;
  readonly title: string;
  readonly shortcut?: string;
  readonly group: string;
  readonly when?: "editor" | "terminal" | "always";
}

export interface HostHealth {
  readonly version: string;
  readonly protocolVersion: string;
  readonly uptimeMs: number;
  readonly platform: NodeJS.Platform;
  readonly workspaceRoot: string;
  readonly aiService: ServiceProbe;
  readonly providers: ProviderInfo[];
  readonly roles: RoleAssignment[];
  readonly mcp: { readonly servers: McpServerInfo[]; readonly activeTools: number };
  readonly agent: { readonly mode: AgentMode; readonly approval: ApprovalMode; readonly running: boolean };
  readonly checkpoints: number;
  readonly rag: RagStatus;
  readonly vram: VramInfo | null;
  readonly modelReady: Record<ModelRole, boolean>;
  readonly timestamp: number;
}

// =====================================================================
// 3. Metodtabellen — signaturerna för host
// =====================================================================

export interface MethodTable {
  // Livscykel
  "host.health": { params: Record<string, never>; result: HostHealth };
  "host.info": { params: Record<string, never>; result: { version: string; protocolVersion: string; startedAt: number; pid: number } };
  "host.ping": { params: { echo?: string }; result: { pong: string; ts: number } };

  // FAS 2 — filer/editor
  "fs.listTree": { params: { root?: string; depth?: number }; result: FsNode[] };
  "fs.read": { params: { path: string; maxBytes?: number }; result: FsFile };
  "fs.write": { params: { path: string; content: string; source?: Checkpoint["source"]; label?: string }; result: WriteResult };
  "fs.createNode": { params: { path: string; kind: "file" | "dir" }; result: WriteResult };
  "fs.rename": { params: { from: string; to: string }; result: WriteResult };
  "fs.delete": { params: { path: string }; result: { ok: boolean; approvalId?: string } };
  "fs.search": { params: { query: string; opts?: SearchOptions }; result: SearchResponse };
  "fs.replaceInFiles": { params: { find: string; replace: string; opts?: SearchOptions }; result: { files: string[]; matches: number; checkpointId?: string } };
  "fs.languageOf": { params: { path: string }; result: { language: string } };
  "fs.recent": { params: Record<string, never>; result: FsFile[] };

  // FAS 2 — integrerad terminal
  "terminal.open": { params: { cwd?: string; cols?: number; rows?: number }; result: { termId: string; pid: number; shell: string } };
  "terminal.input": { params: { termId: string; data: string }; result: { ok: boolean } };
  "terminal.resize": { params: { termId: string; cols: number; rows: number }; result: { ok: boolean } };
  "terminal.close": { params: { termId: string }; result: { ok: boolean } };

  // FAS 3 — modellager
  "provider.list": { params: Record<string, never>; result: ProviderInfo[] };
  "provider.upsert": { params: { config: ProviderConfigInput }; result: ProviderInfo };
  "provider.remove": { params: { id: string }; result: { ok: boolean } };
  "provider.test": { params: { id: string; model?: string }; result: ProbeResult };
  "provider.setRole": { params: { role: ModelRole; providerId: string; model: string; fallbackChain?: string[] }; result: RoleAssignment };
  "provider.roles": { params: Record<string, never>; result: RoleAssignment[] };
  "model.list": { params: { scope?: "all" | "local" | "cloud" }; result: ModelEntry[] };
  "model.pull": { params: { ref: string }; result: { ok: boolean; message: string } };
  "model.vram": { params: Record<string, never>; result: VramInfo | null };

  // FAS 3.5 — RAG
  "rag.index": { params: { root?: string; force?: boolean }; result: { files: number; chunks: number; tookMs: number; engine: RagStatus["engine"] } };
  "rag.search": { params: { query: string; k?: number }; result: RagChunk[] };
  "rag.status": { params: Record<string, never>; result: RagStatus };

  // FAS 4 — MCP
  "mcp.servers.list": { params: Record<string, never>; result: McpServerInfo[] };
  "mcp.servers.upsert": { params: { server: McpServerConfig }; result: McpServerInfo };
  "mcp.servers.remove": { params: { id: string }; result: { ok: boolean } };
  "mcp.servers.start": { params: { id: string }; result: McpServerInfo };
  "mcp.servers.stop": { params: { id: string }; result: { ok: boolean } };
  "mcp.servers.reload": { params: Record<string, never>; result: { servers: McpServerInfo[]; activeTools: number } };
  "mcp.tools.list": { params: Record<string, never>; result: McpToolInfo[] };
  "mcp.tools.call": { params: { name: string; args: unknown }; result: McpToolResult };

  // FAS 7 — chat + agent
  "chat.sessions": { params: Record<string, never>; result: SessionInfo[] };
  "chat.newSession": { params: { title?: string; mode?: AgentMode }; result: SessionInfo };
  "chat.history": { params: { sessionId: string }; result: ChatMessage[] };
  "chat.send": { params: { sessionId: string; text: string; mode?: AgentMode; attachments?: Attachment[]; useRag?: boolean }; result: { messageId: string } };
  "chat.cancel": { params: { sessionId: string }; result: { ok: boolean } };
  "agent.run": { params: { goal: string; mode?: AgentMode; paths?: string[]; maxSteps?: number }; result: { runId: string } };
  "agent.interrupt": { params: { runId: string }; result: { ok: boolean } };
  "agent.approve": { params: { requestId: string; decision: "allow" | "deny" | "always" }; result: { ok: boolean } };
  "agent.pending": { params: Record<string, never>; result: ApprovalRequest[] };
  "agent.lastRun": { params: { runId: string }; result: AgentRunResult | null };
  "review.code": { params: { path?: string; scope?: string }; result: ReviewResult };
  "tests.generate": { params: { path: string }; result: { files: WriteResult[]; summary: string } };
  "refactor.apply": { params: { path: string; instruction: string }; result: { diffs: FileDiff[]; applied: boolean } };

  // FAS 7.6/7.7 — autocomplete + inline edit
  "completion.fim": { params: CompletionRequest; result: CompletionResult };
  "completion.configure": { params: { enabled?: boolean; debounceMs?: number }; result: { enabled: boolean; debounceMs: number } };
  "edit.inline": { params: { path: string; selection: SelectionRange; instruction: string }; result: { diffs: FileDiff[]; patches: SearchReplacePatch[]; model: string; latencyMs: number } };
  "edit.apply": { params: { path: string; patches: SearchReplacePatch[] }; result: WriteResult };

  // FAS 7.2 — checkpoints
  "checkpoint.list": { params: { limit?: number }; result: Checkpoint[] };
  "checkpoint.create": { params: { label: string; source?: Checkpoint["source"] }; result: Checkpoint };
  "checkpoint.rollback": { params: { id: string }; result: { restored: string[]; checkpoint: Checkpoint } };
  "checkpoint.diff": { params: { id: string }; result: FileDiff[] };

  // FAS 5 — öron
  "voice.status": { params: Record<string, never>; result: VoiceStatus };
  "voice.transcribe": { params: { audioBase64: string; format?: string; language?: string }; result: TranscriptResult };
  "voice.speak": { params: { text: string; voice?: string }; result: SpeakResult };
  "voice.startRecord": { params: { mode?: "hold" | "toggle" }; result: { streamId: string } };
  "voice.stopRecord": { params: { streamId: string }; result: TranscriptResult };

  // FAS 6 — ögon
  "vision.capture": { params: { target?: CaptureTarget; path?: string }; result: CaptureResult };
  "vision.analyze": { params: { imageBase64?: string; prompt?: string; target?: CaptureTarget }; result: VisionResult };
  "vision.ocr": { params: { imageBase64?: string; target?: CaptureTarget }; result: { text: string; blocks: OcrBlock[]; engine: string; tookMs: number } };

  // Inställningar, tema, kommandopalett, minne
  "settings.get": { params: Record<string, never>; result: NexusSettings };
  "settings.set": { params: { patch: Partial<NexusSettings> }; result: NexusSettings };
  "settings.secrets": { params: Record<string, never>; result: SecretKeyInfo[] };
  "settings.setSecret": { params: { name: string; value: string }; result: { ok: boolean; name: string } };
  "palette.commands": { params: Record<string, never>; result: CommandDescriptor[] };
  "memory.log": { params: { text: string; kind?: "decision" | "note" | "result" }; result: { id: string; path: string } };
  "memory.recent": { params: { limit?: number }; result: { id: string; text: string; kind: string; at: number }[] };
  "log.tail": { params: { lines?: number }; result: { path: string; lines: string[] } };
}

export type MethodName = keyof MethodTable;
export type ParamsOf<M extends MethodName> = MethodTable[M]["params"];
export type ResultOf<M extends MethodName> = MethodTable[M]["result"];

// =====================================================================
// 4. Eventtabellen — host → renderer (streaming)
// =====================================================================

export interface EventTable {
  "host/ready": { port: number; workspaceRoot: string; protocolVersion: string };
  "host/log": { level: "debug" | "info" | "warn" | "error"; message: string };
  "host/health": HostHealth;
  "fs/changed": { path: string; change: "add" | "change" | "unlink" };

  "terminal/output": { termId: string; data: string };
  "terminal/exit": { termId: string; exitCode: number | null };

  "chat/token": { sessionId: string; messageId: string; text: string };
  "chat/done": { sessionId: string; messageId: string; fullText: string; model: string; providerId: string; source: ModelSource; usage?: { prompt: number; completion: number } };
  "chat/error": { sessionId: string; messageId: string; message: string; code: ErrorCodeValue };

  "agent/plan": { runId: string; steps: AgentStep[] };
  "agent/step": { runId: string; index: number; status: AgentStep["status"]; detail?: string };
  "agent/token": { runId: string; text: string };
  "agent/thought": { runId: string; text: string };
  "agent/tool_call": { runId: string; callId: string; tool: string; args: unknown };
  "agent/tool_result": { runId: string; callId: string; tool: string; ok: boolean; output: string; tookMs: number };
  "agent/approval_required": { approval: ApprovalRequest };
  "agent/checkpoint": { checkpoint: Checkpoint };
  "agent/diff": { runId: string; diffs: FileDiff[] };
  "agent/done": AgentRunResult;
  "agent/error": { runId: string; message: string; code?: ErrorCodeValue };

  "mcp/changed": { servers: McpServerInfo[]; activeTools: number };
  "mcp/log": { serverId: string; line: string };

  "model/changed": { roles: RoleAssignment[] };
  "model/pull_progress": { ref: string; percent: number; status: string; totalBytes?: number };

  "voice/partial": { streamId: string; text: string; final: boolean };
  "voice/level": { streamId: string; rms: number };
  "voice/state": { recording: boolean; streamId?: string };

  "vision/result": { result: VisionResult };
  "rag/progress": { filesDone: number; total: number; chunks: number; phase: "scan" | "embed" | "store" | "done" };
  "settings/changed": NexusSettings;
}

export type EventName = keyof EventTable;
export type PayloadOf<E extends EventName> = EventTable[E];

// =====================================================================
// 5. Hjälpfunktioner som båda sidor använder
// =====================================================================

export function makeRequest<M extends MethodName>(id: RpcId, method: M, params: ParamsOf<M>): RpcRequest<M> {
  return { jsonrpc: "2.0", id, method, params };
}

export function makeResult(id: RpcId, result: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, result, protocolVersion: PROTOCOL_VERSION };
}

export function makeError(id: RpcId, code: ErrorCodeValue, message: string, data?: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data }, protocolVersion: PROTOCOL_VERSION };
}

export function makeEvent<E extends EventName>(name: E, payload: PayloadOf<E>): EventFrame<E> {
  return { type: "event", name, payload, ts: Date.now() };
}

export function isRpcRequest(value: unknown): value is RpcRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
    typeof (value as { method?: unknown }).method === "string"
  );
}

export function isEventFrame(value: unknown): value is EventFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "event" &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

/** Namespace för MCP-verktyg: alltid serverId__toolName. */
export function mcpToolName(serverId: string, tool: string): string {
  return `${serverId}__${tool}`;
}

export function splitMcpToolName(qualified: string): { serverId: string; localName: string } {
  const at = qualified.indexOf("__");
  if (at < 0) return { serverId: "", localName: qualified };
  return { serverId: qualified.slice(0, at), localName: qualified.slice(at + 2) };
}

/** Verktygsnamnen som kärnan alltid har, oavsett MCP (FAS 7.1). */
export const CORE_TOOLS = [
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "search_regex",
  "run_terminal",
  "git_op",
  "web_fetch",
  "screenshot_analyze",
  "transcribe",
  "add_checkpoint",
  "rollback",
  "rag_search",
  "suggest_next_step",
] as const;
export type CoreTool = (typeof CORE_TOOLS)[number];

export function isMethodName(value: string): value is MethodName {
  return Object.prototype.hasOwnProperty.call(methodSet, value);
}

/** Körs en gång; ger O(1)-validering i host. */
const methodSet: Record<string, true> = (() => {
  const names = [
    "host.health", "host.info", "host.ping",
    "fs.listTree", "fs.read", "fs.write", "fs.createNode", "fs.rename", "fs.delete",
    "fs.search", "fs.replaceInFiles", "fs.languageOf", "fs.recent",
    "terminal.open", "terminal.input", "terminal.resize", "terminal.close",
    "provider.list", "provider.upsert", "provider.remove", "provider.test",
    "provider.setRole", "provider.roles", "model.list", "model.pull", "model.vram",
    "rag.index", "rag.search", "rag.status",
    "mcp.servers.list", "mcp.servers.upsert", "mcp.servers.remove", "mcp.servers.start",
    "mcp.servers.stop", "mcp.servers.reload", "mcp.tools.list", "mcp.tools.call",
    "chat.sessions", "chat.newSession", "chat.history", "chat.send", "chat.cancel",
    "agent.run", "agent.interrupt", "agent.approve", "agent.pending", "agent.lastRun",
    "review.code", "tests.generate", "refactor.apply",
    "completion.fim", "completion.configure", "edit.inline", "edit.apply",
    "checkpoint.list", "checkpoint.create", "checkpoint.rollback", "checkpoint.diff",
    "voice.status", "voice.transcribe", "voice.speak", "voice.startRecord", "voice.stopRecord",
    "vision.capture", "vision.analyze", "vision.ocr",
    "settings.get", "settings.set", "settings.secrets", "settings.setSecret",
    "palette.commands", "memory.log", "memory.recent", "log.tail",
  ];
  const out: Record<string, true> = {};
  for (const n of names) out[n] = true;
  return out;
})();

export const ALL_METHOD_NAMES: MethodName[] = Object.keys(methodSet) as MethodName[];

/** Abstraktionen renderer pratar mot — samma oavsett IPC eller WebSocket. */
export interface HostBridge {
  request<M extends MethodName>(method: M, params: ParamsOf<M>, timeoutMs?: number): Promise<ResultOf<M>>;
  on<E extends EventName>(name: E, handler: (payload: PayloadOf<E>) => void): () => void;
  readonly transport: "electron-ipc" | "websocket" | "in-process";
  readonly connected: boolean;
}

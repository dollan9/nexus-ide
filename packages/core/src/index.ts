/**
 * @nexus/core — publik yta enligt packages/core/API.md.
 *
 * Agentkarna: ReAct/tool-loop, planering, minne, checkpoints, sok/replace, config,
 * logger, terminal, approvals, ai-service-klient och kommandopalett.
 */

// 1. Logger
export { createLogger, type Logger } from "./logger";

// 2. Config + hemligheter
export { ConfigStore, defaultSettings, parseEnv, setEnvValue, type NexusConfig } from "./config";

// 3. Workspace-filer
export { WorkspaceService, isInsideRoot } from "./workspace";

// 4. Checkpoints (skugg-git)
export { CheckpointManager } from "./checkpoints";

// 5. SEARCH/REPLACE
export {
  applyPatches,
  unifiedDiff,
  splitDiffToHunks,
  applyPatchSet,
  type MatchKind,
  type PatchFileInput,
  type PatchFileResult,
} from "./patches";

// 6. Terminal
export { TerminalManager } from "./terminal";

// 7. Godkännande
export { ApprovalBroker } from "./approvals";

// 8. Agentkärna + verktyg
export { buildCoreTools, attachMcpTools, type AgentTool } from "./tools";
export { AgentKernel } from "./agent";
export type {
  AgentToolContext,
  VoiceToolkit,
  VisionToolkit,
  RagToolkit,
  NexusProviderRegistry,
  McpToolInfo,
  McpToolResult,
  ProviderChatMessage,
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderChatToolCall,
  ProviderToolSchema,
} from "./toolkits";

// 9. Minne
export { MemoryLog } from "./memory";

// 10. Kommandopalett
export { defaultCommands } from "./commands";

// 11. ai-service-klient
export { AiServiceClient, AiServiceError } from "./ai-client";

// 12. RAG-kodbasminne (P0 — host binds här, testen importerar direkt under /rag för detaljer)
export {
  RagService,
  type RagServiceOptions,
  type RagIndexOptions,
  type RagIndexResult,
  type RagDiagnostics,
  type RagProgressPayload,
  type RagPhase,
} from "./rag/indexer";
export {
  LocalHashEmbedder,
  ProviderEmbedder,
  AiServiceEmbedder,
  EmbedderCascade,
  buildEmbedderChain,
  cosineSimilarity,
  Bm25Scorer,
  tokenize,
  LOCAL_HASH_DIMENSION,
  type Embedder,
  type EmbedderKind,
  type EmbeddingsRegistry,
  type EmbedAttempt,
  type AiServiceEmbeddingsClient,
} from "./rag/embedder";
export {
  JsonlVectorStore,
  ChromaIndex,
  contentHash,
  type StoredChunk,
  type QueryHit,
  type StoreStats,
  type ChromaBridge,
  type ChromaReport,
} from "./rag/store";
export {
  formatContextBlock,
  buildChatContextFromChunks,
  contextUsedFromChunks,
  dedupeChunks,
  trimChunkText,
  DEFAULT_CONTEXT_MAX_BYTES,
  type FormattedContext,
  type ContextOptions,
} from "./rag/context";

// Paketets identitet (behalls for skcaffolds kompatibilitet).
export const PACKAGE_NAME = "@nexus/core";

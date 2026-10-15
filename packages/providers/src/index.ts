/**
 * @nexus/providers — det enhetliga modellagret (FAS 3.1 + FAS 3.2).
 *
 * Vad som bor här och varför:
 *   Provider            — kontraktet alla modeller uppfyller (chat/stream/FIM/embeddings/vision/probe).
 *   ProviderRegistry    — flera modeller samtidigt, roll-fördelning och fallback-kedjor.
 *   adapters/*          — OpenAI-kompatibelt (NVIDIA/OpenAI/OpenRouter/Groq/Mistral/vLLM/
 *                         LM Studio/llama.cpp/custom), Ollama nativt, Anthropic, Google.
 *   http/sse            — timeout, backoff med jitter, Retry-After, SSE- och NDJSON-parsers.
 *   secrets/logging     — R2: ingen nyckel når någonsin loggen.
 *   source              — ModelSource-sanning: "local" | "cloud" | "stub" | "none".
 *
 * Kontrakt med resten av monorepon: host bygger ett registry, core och voice/vision
 * anropar `callForRole`, och allt som returnerar modellavtryck bär `source`.
 * Paketet har inga runtime-beroenden utöver @nexus/protocol (platforms fetch räcker).
 */

export const PACKAGE_NAME = "@nexus/providers";

// Domänkontrakt och intern typer för hela modellagret.
export * from "./internal-types";
export * from "./provider";
export * from "./registry";
export * from "./errors";
export * from "./http";
export * from "./sse";
export * from "./source";
export * from "./secrets";
export * from "./logging";
export * from "./fim";
export * from "./util";

// Adapters — var och en i sin egen fil (FAS 3.1).
export { OpenAiCompatibleProvider, buildChatBody } from "./adapters/openai-compatible";
export { OllamaProvider, buildOllamaChatBody, parseOllamaToolCalls } from "./adapters/ollama";
export { AnthropicProvider, buildAnthropicBody, ANTHROPIC_VERSION, ANTHROPIC_DEFAULT_BASE_URL } from "./adapters/anthropic";
export { GoogleProvider, buildGoogleBody, extractGoogleText, GOOGLE_DEFAULT_BASE_URL } from "./adapters/google";
export { StubProvider, type StubProviderOptions, type StubCallLog } from "./adapters/stub";

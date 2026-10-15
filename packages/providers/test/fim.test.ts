/**
 * Autocomplete / fill-in-the-middle (FAS 7.6).
 *
 * Kropps-formen är det som avgör om en lokal FIM-modell faktiskt fortsätter koden på
 * rätt ställe: prefix och suffix måste separeras, och stopp-sekvenserna måste vara de
 * markörer modellen själv genererar. Testen går mot mock-model-server (riktig HTTP) och
 * mot en insprutad transport (exakt requestBody), aldrig mot en riktig modell.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  DEFAULT_FIM_MARKERS,
  FIM_MIDDLE_TOKEN,
  FIM_PREFIX_TOKEN,
  FIM_SUFFIX_TOKEN,
  OllamaProvider,
  OpenAiCompatibleProvider,
  ProviderError,
  buildFimBody,
  trimFimCompletion,
} from "../src/index";
import {
  httpTransport,
  makeContext,
  realTimer,
  requestsTo,
  sequenceTransport,
  startMock,
  type MockModelServer,
} from "./helpers";
import { ErrorCode, type CompletionRequest } from "@nexus/protocol";

const REQ: CompletionRequest = {
  prefix: "function add(a: number, b: number) {\n  return ",
  suffix: "\n}\n\nconsole.log(add(1, 2));\n",
  path: "src/math.ts",
  language: "typescript",
  position: { line: 2, column: 10 },
  maxTokens: 64,
  trimUntil: "\n\n",
};

describe("buildFimBody — ren form", () => {
  it("lägger prefix och suffix runt mitmarkören och kräver rätt stoppsekvenser", () => {
    const fim = buildFimBody(REQ);
    expect(fim.prompt).toContain(FIM_PREFIX_TOKEN);
    expect(fim.prompt).toContain(REQ.prefix);
    expect(fim.prompt).toContain(FIM_MIDDLE_TOKEN);
    expect(fim.prompt).toContain(REQ.suffix);
    expect(fim.suffix).toBe(REQ.suffix);
    expect(fim.stops).toContain(FIM_MIDDLE_TOKEN);
    expect(fim.stops).toContain(FIM_SUFFIX_TOKEN);
    expect(fim.stops).toContain(REQ.trimUntil);
    expect(fim.maxTokens).toBe(64);
    // Inga dubbletter i stopp-listan — servrar klagar på det.
    expect(new Set(fim.stops).size).toBe(fim.stops.length);
  });

  it("klipper svar vid första stoppsekvens och tar bort läckta markörer", () => {
    const fim = buildFimBody(REQ);
    const raw = `a + b;${FIM_SUFFIX_TOKEN}\n}\n\nskräp`;
    expect(trimFimCompletion(raw, fim.stops)).toBe("a + b;");
    expect(trimFimCompletion(`${DEFAULT_FIM_MARKERS.middle}x`, fim.stops)).toBe("");
  });
});

describe("Ollama FIM — /api/generate med raw:true", () => {
  let server: MockModelServer;

  beforeAll(async () => {
    server = await startMock({ mode: "echo" });
  });

  afterAll(async () => {
    await server.close();
  });

  it("skickar prompt + suffix separat, raw:true och stopp-sekvenser", async () => {
    const provider = new OllamaProvider({
      id: "mock-ollama-fim",
      label: "Mock Ollama FIM (stub)",
      kind: "ollama",
      baseUrl: server.url,
      model: "stub/qwen2.5-coder:1.5b",
      sourceOverride: "stub",
      context: makeContext(httpTransport(), { timeoutMs: 10_000, timer: realTimer }),
    });
    const result = await provider.complete(REQ);
    const body = requestsTo(server, "/api/generate").at(-1)?.body;
    expect(body?.["raw"]).toBe(true);
    expect(body?.["stream"]).toBe(false);
    expect(body?.["prompt"]).toBe(REQ.prefix);
    expect(body?.["suffix"]).toBe(REQ.suffix);
    const options = body?.["options"] as Record<string, unknown>;
    expect(options.temperature).toBe(0);
    expect(options.num_predict).toBe(64);
    const stops = options.stop as string[];
    expect(stops).toContain(FIM_MIDDLE_TOKEN);
    expect(stops).toContain(FIM_SUFFIX_TOKEN);
    expect(stops).toContain(REQ.trimUntil);
    expect(result.providerId).toBe("mock-ollama-fim");
    expect(result.source).toBe("stub");
    expect(result.text).toContain("return stub");
    expect(result.cached).toBe(false);
  });
});

describe("OpenAI-kompatibel FIM — /v1/completions", () => {
  it("prompten innehåller båda markörerna och fim-fälten skickas med", async () => {
    const transport = sequenceTransport([
      { body: JSON.stringify({ model: "stub/mock-chat-1", choices: [{ index: 0, text: `a + b;${FIM_SUFFIX_TOKEN}\mer mer`, finish_reason: "stop" }] }) },
    ]);
    const provider = new OpenAiCompatibleProvider({
      id: "fim-compat",
      label: "FIM compat (stub)",
      kind: "vllm",
      baseUrl: "http://127.0.0.1:8000/v1",
      model: "stub/mock-chat-1",
      sourceOverride: "stub",
      context: makeContext(transport),
    });
    const result = await provider.complete(REQ, "stub/mock-chat-1");
    const body = transport.calls[0]?.body;
    expect(body?.["prompt"]).toBe(`${FIM_PREFIX_TOKEN}${REQ.prefix}${FIM_MIDDLE_TOKEN}${REQ.suffix}`);
    expect(body?.["fim_prompt"]).toBe(REQ.prefix);
    expect(body?.["fim_suffix"]).toBe(REQ.suffix);
    expect(body?.["stop"]).toContain(FIM_SUFFIX_TOKEN);
    expect(body?.["max_tokens"]).toBe(64);
    expect(result.text).toBe("a + b;");
    expect(result.model).toBe("stub/mock-chat-1");
  });
});

describe("Negativa fall — autocomplete degraderar korrekt", () => {
  it("Anthropic har ingen FIM och säger det som unsupported, inte som en tyst sträng", async () => {
    const transport = sequenceTransport([{ body: "{}" }]);
    const provider = new AnthropicProvider({
      id: "claude-nofim",
      label: "Claude utan FIM",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test-123",
      model: "claude-test",
      context: makeContext(transport),
    });
    const failure = await provider.complete(REQ).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderError);
    const error = failure as ProviderError;
    expect(error.errorClass).toBe("unsupported");
    expect(transport.calls).toHaveLength(0);
  });

  it("leverantör utan complete-capability ger BadRequest-kod och inget nätverk", async () => {
    const transport = sequenceTransport([{ body: "{}" }]);
    const provider = new OpenAiCompatibleProvider({
      id: "no-complete",
      label: "Utan complete",
      kind: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test-123",
      model: "gpt-test",
      capabilities: ["chat", "stream"],
      context: makeContext(transport),
    });
    const failure = await provider.complete(REQ).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).code).toBe(ErrorCode.BadRequest);
    expect(transport.calls).toHaveLength(0);
  });

  it("ingen modell vald blir NoModelAvailable, aldrig ett tomt svar", async () => {
    const transport = sequenceTransport([{ body: "{}" }]);
    const provider = new OllamaProvider({
      id: "empty-ollama",
      label: "Tom Ollama",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      sourceOverride: "stub",
      context: makeContext(transport),
    });
    const failure = await provider.complete(REQ).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).code).toBe(ErrorCode.NoModelAvailable);
  });
});

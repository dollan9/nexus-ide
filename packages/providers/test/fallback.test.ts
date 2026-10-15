/**
 * Fallback-kedja per roll (FAS 3.2 e): 429 och 5xx flyttar ansvaret till nästa modell
 * och *varför* dokumenteras så UI:t kan visa det. Ingen test påstår riktig modell.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ErrorCode } from "@nexus/protocol";
import {
  OpenAiCompatibleProvider,
  OllamaProvider,
  ProviderError,
  ProviderRegistry,
  StubProvider,
  DEFAULT_RETRY,
  MemoryLogger,
} from "../src/index";
import { httpTransport, makeContext, startMock, type MockModelServer } from "./helpers";

let limited: MockModelServer;
let healthy: MockModelServer;

function stubOpenAi(id: string, baseUrl: string, _logger: MemoryLogger, model = "stub/mock-chat-1"): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    id,
    label: `${id} (test-docka)`,
    kind: "custom",
    baseUrl,
    model,
    sourceOverride: "stub",
    // throwOnRateLimit: true låter registret göra modell-bytet, inte HTTP-lagret.
    retry: DEFAULT_RETRY,
    context: makeContext(httpTransport(), { timeoutMs: 10_000, retry: DEFAULT_RETRY }),
  });
}

beforeAll(async () => {
  limited = await startMock({ mode: "ratelimit", failFirst: 999 });
  healthy = await startMock({ mode: "echo" });
});

afterAll(async () => {
  await limited.close();
  await healthy.close();
});

describe("Fallback-kedja vid 429", () => {
  it("hoppar över en begränsad modell och dokumenterar anledningen", async () => {
    const logger = new MemoryLogger();
    const registry = new ProviderRegistry({ logSink: logger });
    registry.register(stubOpenAi("cloud-limited", limited.baseUrl, logger));
    registry.register(stubOpenAi("local-healthy", healthy.baseUrl, logger));
    registry.setRole("chat", "cloud-limited", "stub/mock-chat-1", ["local-healthy/stub/mock-chat-1"]);

    const result = await registry.callForRole("chat", { messages: [{ role: "user", content: "hej" }] });
    expect(result.providerId).toBe("local-healthy");
    expect(result.source).toBe("stub");
    expect(result.text).toContain("stub-svar till: hej");

    const report = registry.lastReport("chat");
    expect(report?.ok).toBe(true);
    expect(report?.attempts).toHaveLength(2);
    const first = report?.attempts[0];
    expect(first?.ok).toBe(false);
    expect(first?.errorClass).toBe("rate_limited");
    expect(first?.code).toBe(ErrorCode.RateLimited);
    expect(first?.httpStatus).toBe(429);
    expect(first?.reason).toContain("429");
    expect(first?.reason).toContain("byter till nästa modell");
    expect(report?.attempts[1]?.reason).toContain("senare länk");
    expect(report?.degraded).toBe("fallback");
    expect(logger.lines().some((line) => line.includes("rate_limited"))).toBe(true);
  });

  it("kedja med bara modellnamn (utan provider-prefix) löser mot samma leverantör", async () => {
    const registry = new ProviderRegistry({ logSink: new MemoryLogger() });
    registry.register(stubOpenAi("multi", healthy.baseUrl, new MemoryLogger()));
    registry.setRole("agent", "multi", "stub/mock-chat-1", ["stub/mock-reason-1"]);
    const resolved = registry.resolve("agent");
    expect(resolved?.chain).toEqual(["multi/stub/mock-chat-1", "multi/stub/mock-reason-1"]);
    const result = await registry.callForRole("agent", { messages: [{ role: "user", content: "x" }] });
    expect(result.model).toBe("stub/mock-chat-1");
    const sent = healthy.requests.filter((r) => r.path === "/v1/chat/completions").at(-1);
    expect(sent?.body?.["model"]).toBe("stub/mock-chat-1");
  });

  it("5xx på firsta länken kastas vidare till nästa, utan att logga en rå feltext", async () => {
    const broken = await startMock({ mode: "error" });
    try {
      const logger = new MemoryLogger();
      const registry = new ProviderRegistry({ logSink: logger });
      registry.register(stubOpenAi("broken", broken.baseUrl, logger));
      registry.register(stubOpenAi("working", healthy.baseUrl, logger));
      registry.setRole("reasoning", "broken", "stub/mock-chat-1", ["working/stub/mock-chat-1"]);
      const result = await registry.callForRole("reasoning", { messages: [{ role: "user", content: "x" }] });
      expect(result.providerId).toBe("working");
      const attempts = registry.lastReport("reasoning")?.attempts ?? [];
      expect(attempts[0]?.errorClass).toBe("server");
      expect(attempts[0]?.code).toBe(ErrorCode.Internal);
    } finally {
      await broken.close();
    }
  });
});

describe("Fallback för autocomplete (FIM)", () => {
  it("moln utan FIM ger viken till den lokala FIM-modellen", async () => {
    const logger = new MemoryLogger();
    const registry = new ProviderRegistry({ logSink: logger });
    const noFim = new OpenAiCompatibleProvider({
      id: "cloud-nofim",
      label: "Moln utan FIM (stub)",
      kind: "openai",
      baseUrl: healthy.baseUrl,
      model: "stub/mock-chat-1",
      capabilities: ["chat", "stream", "embeddings"],
      sourceOverride: "stub",
      context: makeContext(httpTransport(), { retry: DEFAULT_RETRY }),
    });
    const localFim = new OllamaProvider({
      id: "ollama-fim",
      label: "Ollama FIM (stub)",
      kind: "ollama",
      baseUrl: healthy.url,
      model: "stub/qwen2.5-coder:1.5b",
      sourceOverride: "stub",
      context: makeContext(httpTransport(), { retry: DEFAULT_RETRY }),
    });
    registry.register(noFim);
    registry.register(localFim);
    registry.setRole("autocomplete", "cloud-nofim", "stub/mock-chat-1", ["ollama-fim/stub/qwen2.5-coder:1.5b"]);

    const result = await registry.callForRole("autocomplete", {
      prefix: "function f() {\n  return ",
      suffix: "\n}",
      path: "a.ts",
      language: "typescript",
      position: { line: 1, column: 3 },
    });
    expect(result.providerId).toBe("ollama-fim");
    expect(result.source).toBe("stub");
    const attempts = registry.lastReport("autocomplete")?.attempts ?? [];
    expect(attempts[0]?.errorClass).toBe("unsupported");
    expect(attempts[0]?.ok).toBe(false);
  });

  it("stub-adapter som kastar flyttar ansvaret vidare i kedjan", async () => {
    const registry = new ProviderRegistry({ logSink: new MemoryLogger() });
    const brokenStub = new StubProvider({ id: "broken-stub", failWith: new Error("dockan är trasig"), context: makeContext(httpTransport()) });
    const good = new StubProvider({ id: "good-stub", reply: "stub OK", context: makeContext(httpTransport()) });
    registry.register(brokenStub);
    registry.register(good);
    registry.setRole("vision", "broken-stub", "stub/echo-1", ["good-stub/stub/echo-1"]);
    const answer = await registry.callForRole("vision", { imageBase64: "AAAA", mime: "image/png" });
    expect(answer.providerId).toBe("good-stub");
    expect(answer.engine).toBe("stub");
    expect(answer.source).toBe("stub");
    const attempts = registry.lastReport("vision")?.attempts ?? [];
    expect(attempts[0]?.message).toContain("dockan är trasig");
  });
});

describe("Sista utvägen och total frånvaro", () => {
  it("host kan ange en reserve-docka — appen får svar med ärlig stub-source", async () => {
    const closed = await startMock({});
    const port = closed.port;
    await closed.close();
    const registry = new ProviderRegistry({ lastResort: new StubProvider({ id: "reserve", reply: "reserve-docka svarar", context: makeContext(httpTransport()) }) });
    registry.register(stubOpenAi("död", `http://127.0.0.1:${port}/v1`, new MemoryLogger()));
    registry.setRole("chat", "död", "stub/mock-chat-1");
    const result = await registry.callForRole("chat", { messages: [{ role: "user", content: "x" }] });
    expect(result.providerId).toBe("reserve");
    expect(result.source).toBe("stub");
    expect(result.degraded).toBe("stub");
    const attempts = registry.lastReport("chat")?.attempts ?? [];
    expect(attempts[0]?.ok).toBe(false);
    expect(attempts.at(-1)?.reason).toContain("test-docka");
  });

  it("NEGATIVT: ingen modell i kedjan nårs → NoModelAvailable med full försökslogg", async () => {
    const deadA = await startMock({});
    const deadB = await startMock({});
    const urlA = `http://127.0.0.1:${deadA.port}/v1`;
    const urlB = `http://127.0.0.1:${deadB.port}/v1`;
    await deadA.close();
    await deadB.close();

    const registry = new ProviderRegistry({ logSink: new MemoryLogger() });
    registry.register(stubOpenAi("dead-a", urlA, new MemoryLogger()));
    registry.register(stubOpenAi("dead-b", urlB, new MemoryLogger()));
    registry.setRole("embeddings", "dead-a", "stub/mock-embed-1", ["dead-b/stub/mock-embed-1"]);

    const failure = await registry
      .callForRole("embeddings", { texts: ["a", "b"] })
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderError);
    const error = failure as ProviderError;
    expect(error.code).toBe(ErrorCode.NoModelAvailable);
    expect(error.errorClass).toBe("no_model");
    expect(error.attempts).toHaveLength(2);
    expect(error.attempts?.map((a) => a.providerId)).toEqual(["dead-a", "dead-b"]);
    expect(error.userMessage()).toContain("Ingen tillgänglig modell");
  });

  it("NEGATIVT: roll utan tilldelning ger NoModelAvailable innan något nätverk", async () => {
    const registry = new ProviderRegistry();
    const failure = await registry.callForRole("chat", { messages: [{ role: "user", content: "x" }] }).catch((err: unknown) => err);
    expect((failure as ProviderError).code).toBe(ErrorCode.NoModelAvailable);
    expect((failure as ProviderError).message).toContain("Ingen modell är tilldelad");
  });

  it("NEGATIVT: en avstängd leverantör väljs bort ur kedjan", async () => {
    const registry = new ProviderRegistry({ logSink: new MemoryLogger() });
    const disabled = stubOpenAi("avstängd", healthy.baseUrl, new MemoryLogger());
    registry.register(disabled);
    registry.setRole("chat", "avstängd", "stub/mock-chat-1");
    disabled.setEnabled(false);
    expect(registry.byRole("chat")).toBeNull();
    expect(registry.resolve("chat")).toBeNull();
    const failure = await registry.callForRole("chat", { messages: [{ role: "user", content: "x" }] }).catch((err: unknown) => err);
    expect((failure as ProviderError).code).toBe(ErrorCode.NoModelAvailable);
  });
});

afterEach(() => {
  // Ingen permanent bakgrundstjänst får lämna igång: alla dockor stängs i afterAll ovan.
});

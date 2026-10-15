/**
 * ModelSource-sanning (CONVENTIONS §Äkthet i tester) och classifySource.
 *
 * `classifySource` är den enda platsen som avgör local vs cloud. Testet går mot
 * mock-model-server för de fall där en riktig HTTP-provider faktiskt pratar, och mot
 * insprutad transport annars — aldrig riktigt nätverk.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  OpenAiCompatibleProvider,
  OllamaProvider,
  ProviderError,
  StubProvider,
  classifySource,
  hostOf,
  isLocalBaseUrl,
  sourceForResponse,
} from "../src/index";
import { httpTransport, makeContext, startMock, type MockModelServer } from "./helpers";

let localServer: MockModelServer;

beforeAll(async () => {
  localServer = await startMock({ mode: "echo" });
});

afterAll(async () => {
  await localServer.close();
});

describe("classifySource — URL-typer vi faktiskt konfigurerar", () => {
  it("klassar loopback och privat nät som local", () => {
    expect(classifySource("http://127.0.0.1:11434")).toBe("local");
    expect(classifySource("http://localhost:1234/v1")).toBe("local");
    expect(classifySource("http://[::1]:8080/v1")).toBe("local");
    expect(classifySource("http://192.168.1.50:8000/v1")).toBe("local");
    expect(classifySource("http://10.0.0.9:11434")).toBe("local");
    expect(classifySource("http://172.16.0.4/v1")).toBe("local");
    expect(classifySource("127.0.0.1:11434")).toBe("local"); // utan schema, som i .env
    expect(classifySource("http://host.docker.internal:11434")).toBe("local");
    expect(isLocalBaseUrl("http://192.168.0.12:1234/v1")).toBe(true);
  });

  it("klassar allt utomhus som cloud", () => {
    expect(classifySource("https://integrate.api.nvidia.com/v1")).toBe("cloud");
    expect(classifySource("https://api.openai.com/v1")).toBe("cloud");
    expect(classifySource("https://openrouter.ai/api/v1")).toBe("cloud");
    expect(classifySource("https://api.groq.com/openai/v1")).toBe("cloud");
    expect(classifySource("https://api.anthropic.com")).toBe("cloud");
    expect(classifySource("http://172.32.0.1/v1")).toBe("cloud");
  });

  it("NEGATIVT: tom eller skadad baseUrl blir cloud (säkrast), inte local", () => {
    expect(classifySource("")).toBe("cloud");
    expect(classifySource("   ")).toBe("cloud");
    expect(classifySource("inte en url alls")).toBe("cloud");
    expect(hostOf("https://api.openai.com/v1")).toBe("api.openai.com");
    expect(hostOf("127.0.0.1:11434")).toBe("127.0.0.1");
    expect(hostOf("")).toBe("");
  });

  it("sourceForResponse ljuger aldrig för en test-docka", () => {
    expect(sourceForResponse("http://127.0.0.1:11434", "stub")).toBe("stub");
    expect(sourceForResponse("https://api.openai.com/v1", "cloud")).toBe("cloud");
    expect(sourceForResponse("https://api.openai.com/v1")).toBe("cloud");
    expect(sourceForResponse("http://127.0.0.1:1/v1")).toBe("local");
  });
});

describe("Provider-källa speglar verkligheten", () => {
  it("Ollama på loopback är local och har ingen nyckel", () => {
    const provider = new OllamaProvider({
      id: "ollama-source",
      label: "Ollama",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen2.5-coder:1.5b",
      context: makeContext(httpTransport()),
    });
    expect(provider.isLocal).toBe(true);
    expect(provider.source).toBe("local");
    expect(provider.hasKey).toBe(false);
  });

  it("molnadapter med nyckel är cloud", () => {
    const provider = new OpenAiCompatibleProvider({
      id: "nim-source",
      label: "NVIDIA NIM",
      kind: "nvidia",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: "nvapi-test-123456",
      model: "moonshotai/kimi-k2-instruct",
      context: makeContext(httpTransport()),
    });
    expect(provider.isLocal).toBe(false);
    expect(provider.source).toBe("cloud");
    expect(provider.hasKey).toBe(true);
  });

  it("docka mot mock-model-server rapporterar stub, aldrig local/cloud", async () => {
    const stubbed = new OpenAiCompatibleProvider({
      id: "docka-stub",
      label: "Mock-docka (stub)",
      kind: "custom",
      baseUrl: localServer.baseUrl,
      model: "stub/mock-chat-1",
      sourceOverride: "stub",
      context: makeContext(httpTransport(), { timeoutMs: 10_000 }),
    });
    const realLocal = new OpenAiCompatibleProvider({
      id: "docka-local",
      label: "Lokalt server-liknande",
      kind: "custom",
      baseUrl: localServer.baseUrl,
      model: "stub/mock-chat-1",
      context: makeContext(httpTransport(), { timeoutMs: 10_000 }),
    });
    const stubResult = await stubbed.chat({ messages: [{ role: "user", content: "x" }] });
    const localResult = await realLocal.chat({ messages: [{ role: "user", content: "x" }] });
    expect(stubResult.source).toBe("stub");
    // Utan sourceOverride är det en *loopback-server* — ärligt "local", men det är
    // fortfarande dockan som svarar, därför heter både id och modell "stub/…".
    expect(localResult.source).toBe("local");
    expect(stubResult.model.startsWith("stub/")).toBe(true);
    const stubProvider = new StubProvider({ id: "stubb", context: makeContext(httpTransport()) });
    expect(stubProvider.source).toBe("stub");
    const vision = await stubProvider.vision({ imageBase64: "AA" });
    expect(vision.engine).toBe("stub");
    expect(vision.source).toBe("stub");
  });

  it("ModelEntry bär samma källa som sin provider", async () => {
    const provider = new OllamaProvider({
      id: "ollama-entries",
      label: "Ollama docka",
      kind: "ollama",
      baseUrl: localServer.url,
      model: "stub/qwen2.5-coder:1.5b",
      sourceOverride: "stub",
      context: makeContext(httpTransport(), { timeoutMs: 10_000 }),
    });
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.source === "stub")).toBe(true);
    expect(models[0]?.ref).toBe(`ollama-entries/${models[0]?.id}`);
    expect(models.some((m) => (m.sizeBytes ?? 0) > 0)).toBe(true);
    expect(models.some((m) => (m.vramEstimateMb ?? 0) > 0)).toBe(true);
  });
});

describe("Negativt — offline och trasig JSON", () => {
  it("server som svarar med trasig JSON ger ProviderError parse, inte en krasch", async () => {
    const broken = await startMock({ mode: "malformed" });
    try {
      const provider = new OpenAiCompatibleProvider({
        id: "broken-json",
        label: "Trasig JSON-docka",
        kind: "custom",
        baseUrl: broken.baseUrl,
        model: "stub/mock-chat-1",
        sourceOverride: "stub",
        context: makeContext(httpTransport(), { timeoutMs: 5_000 }),
      });
      const failure = await provider.chat({ messages: [{ role: "user", content: "x" }] }).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(ProviderError);
      const error = failure as ProviderError;
      expect(error.errorClass).toBe("parse");
      expect(error.message).toContain("inte giltig JSON");
    } finally {
      await broken.close();
    }
  });

  it("offline leverantör klassar sin probe som none", async () => {
    const closed = await startMock({});
    const url = closed.baseUrl;
    await closed.close();
    const provider = new OpenAiCompatibleProvider({
      id: "offline",
      label: "Offline moln-lik",
      kind: "custom",
      baseUrl: url,
      model: "stub/mock-chat-1",
      context: makeContext(httpTransport(), { timeoutMs: 2_000 }),
    });
    const probe = await provider.probe();
    expect(probe.ok).toBe(false);
    expect(probe.source).toBe("none");
    expect(probe.error).toBeDefined();
  });

  it("moln utan nyckel probes inte alls mot nätet (negativt, ingen networkanrop)", async () => {
    const transport = httpTransport();
    const provider = new AnthropicProvider({
      id: "nokey",
      label: "Anthropic utan nyckel",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude-test",
      context: makeContext(transport),
    });
    expect(provider.hasKey).toBe(false);
    const probe = await provider.probe();
    expect(probe.ok).toBe(false);
    expect(probe.source).toBe("none");
    expect(probe.error).toContain("ingen API-nyckel satt");
    expect(transport.calls).toHaveLength(0);
  });
});

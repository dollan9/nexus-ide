/**
 * probe() — "är modellen verkligen tillgänglig?" (FAS 3.2 d, provider.test).
 *
 * ProbeResult är det som UI:s Test-knapp och HostHealth.modelReady vilar på, så den
 * måste vara ärlig: ingen nätverkskontakt ⇒ ok:false och source:"none", aldrig en
 * gissning. Negativa fall i den här filen: offline server, 429, trasig JSON, avstängd
 * leverantör och moln utan nyckel.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorCode } from "@nexus/protocol";
import {
  AnthropicProvider,
  OpenAiCompatibleProvider,
  OllamaProvider,
  ProviderError,
  ProviderRegistry,
  StubProvider,
  MemoryLogger,
} from "../src/index";
import { httpTransport, makeContext, sequenceTransport, startMock, type MockModelServer } from "./helpers";

let server: MockModelServer;

beforeAll(async () => {
  server = await startMock({ mode: "echo" });
});

afterAll(async () => {
  await server.close();
});

describe("probe mot en levande docka", () => {
  it("OpenAI-kompatibel: katalog + litet chat-anrop, source stub", async () => {
    const provider = new OpenAiCompatibleProvider({
      id: "probe-openai",
      label: "Probe docka",
      kind: "custom",
      baseUrl: server.baseUrl,
      model: "stub/mock-chat-1",
      sourceOverride: "stub",
      context: makeContext(httpTransport(), { timeoutMs: 10_000 }),
    });
    const probe = await provider.probe();
    expect(probe.ok).toBe(true);
    expect(probe.source).toBe("stub");
    expect(probe.model).toBe("stub/mock-chat-1");
    expect(probe.sample).toBeTruthy();
    expect(probe.latencyMs).toBeGreaterThanOrEqual(0);
    expect(probe.httpStatus).toBe(200);
    // Inför första probe finns ingen probe-data alls — UI:t kan inte visa en gissning.
    expect(new OpenAiCompatibleProvider({
      id: "probe-fresh",
      label: "Ny docka",
      kind: "custom",
      baseUrl: server.baseUrl,
      model: "stub/mock-chat-1",
      sourceOverride: "stub",
      context: makeContext(httpTransport()),
    }).toInfo().lastProbe).toBeUndefined();
    expect(provider.toInfo().lastProbe?.ok).toBe(true);
    expect(provider.toInfo().lastProbe?.source).toBe("stub");
  });

  it("Ollama: /api/tags räcker för att säga att lokalen lever", async () => {
    const provider = new OllamaProvider({
      id: "probe-ollama",
      label: "Probe Ollama",
      kind: "ollama",
      baseUrl: server.url,
      model: "stub/qwen2.5-coder:1.5b",
      sourceOverride: "stub",
      context: makeContext(httpTransport(), { timeoutMs: 10_000 }),
    });
    const probe = await provider.probe();
    expect(probe.ok).toBe(true);
    expect(probe.model).toBe("stub/qwen2.5-coder:1.5b");
    expect(probe.sample).toContain("modeller");
    expect(probe.source).toBe("stub");
  });

  it("StubProvider är alltid ärlig: ok men source stub", async () => {
    const stub = new StubProvider({ id: "probe-stub", context: makeContext(httpTransport()) });
    const probe = await stub.probe();
    expect(probe.ok).toBe(true);
    expect(probe.source).toBe("stub");
    expect(probe.sample).toContain("ingen riktig modell");
  });

  it("registry + provider.test-liknande flöde: probeResult följer med ProviderInfo", async () => {
    const registry = new ProviderRegistry({ logSink: new MemoryLogger() });
    registry.register(
      new OpenAiCompatibleProvider({
        id: "registry-probe",
        label: "Registry probe docka",
        kind: "openai",
        baseUrl: server.baseUrl,
        model: "stub/mock-chat-1",
        sourceOverride: "stub",
        context: makeContext(httpTransport(), { timeoutMs: 10_000 }),
      }),
    );
    const provider = registry.get("registry-probe");
    expect(provider).toBeDefined();
    const probe = await provider?.probe();
    expect(probe?.ok).toBe(true);
    expect(registry.list()[0]?.lastProbe?.ok).toBe(true);
  });
});

describe("Negativa probe-fall — appen får aldrig lura sig själv", () => {
  it("offline server (ingen lyssnare) ger ok:false med NoModelAvailable i loggen", async () => {
    const dead = await startMock({});
    const baseUrl = dead.baseUrl;
    await dead.close();
    const provider = new OpenAiCompatibleProvider({
      id: "probe-dead",
      label: "Offline docka",
      kind: "custom",
      baseUrl,
      model: "stub/mock-chat-1",
      sourceOverride: "stub",
      context: makeContext(httpTransport(), { timeoutMs: 1_000 }),
    });
    const probe = await provider.probe();
    expect(probe.ok).toBe(false);
    expect(probe.source).toBe("none");
    expect(probe.error).toBeDefined();
    expect(probe.latencyMs).toBeLessThan(5_000);
    // Felet som loggas bär rätt ErrorCode (host gör RpcResponse.error av den).
    // Felet som hamnar i loggen bär rätt ErrorCode (host gör RpcResponse.error av den).
    const mapped = new ProviderError({ message: "probe", errorClass: "network" });
    expect(mapped.code).toBe(ErrorCode.NoModelAvailable);
    const info = provider.toInfo();
    expect(info.lastProbe?.ok).toBe(false);
    expect(info.lastProbe?.source).toBe("none");
  });

  it("429 under probe ger ok:false med httpStatus 429 (ingen tyst framgång)", async () => {
    const limited = await startMock({ mode: "ratelimit", failFirst: 999, retryAfterSeconds: 1 });
    try {
      const provider = new OpenAiCompatibleProvider({
        id: "probe-429",
        label: "Rate limited docka",
        kind: "custom",
        baseUrl: limited.baseUrl,
        model: "stub/mock-chat-1",
        sourceOverride: "stub",
        context: makeContext(httpTransport(), { timeoutMs: 5_000 }),
      });
      const probe = await provider.probe();
      expect(probe.ok).toBe(false);
      expect(probe.httpStatus).toBe(429);
      expect(probe.source).toBe("none");
      expect(probe.error).toContain("429");
    } finally {
      await limited.close();
    }
  });

  it("malformed JSON fr\u00e5n servern ger probe-ok-false, inte en krasch", async () => {
    const broken = await startMock({ mode: "malformed" });
    try {
      const provider = new OpenAiCompatibleProvider({
        id: "probe-malformed",
        label: "Trasig JSON docka",
        kind: "custom",
        baseUrl: broken.baseUrl,
        model: "stub/mock-chat-1",
        sourceOverride: "stub",
        context: makeContext(httpTransport(), { timeoutMs: 5_000 }),
      });
      const probe = await provider.probe();
      expect(probe.ok).toBe(false);
      expect(probe.source).toBe("none");
      expect(probe.error).toContain("giltig JSON");
    } finally {
      await broken.close();
    }
  });

  it("avstängd leverantör probe:as aldrig", async () => {
    const provider = new OpenAiCompatibleProvider({
      id: "probe-disabled",
      label: "Avstängd docka",
      kind: "custom",
      baseUrl: server.baseUrl,
      model: "stub/mock-chat-1",
      enabled: false,
      sourceOverride: "stub",
      context: makeContext(httpTransport(), { timeoutMs: 5_000 }),
    });
    const probe = await provider.probe();
    expect(probe.ok).toBe(false);
    expect(probe.error).toContain("avst\u00e4ngd");
    expect(probe.source).toBe("none");
  });

  it("moln utan nyckel: probe svarar direkt utan att ringa ut", async () => {
    const transport = httpTransport();
    const provider = new AnthropicProvider({
      id: "probe-nokey",
      label: "Utan nyckel",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKeyEnvName: "ANTHROPIC_API_KEY",
      model: "claude-test",
      context: makeContext(transport),
    });
    const probe = await provider.probe();
    expect(probe.ok).toBe(false);
    expect(probe.source).toBe("none");
    expect(probe.error).toContain("ANTHROPIC_API_KEY");
    expect(transport.calls).toHaveLength(0);
  });

  it("NVIDIA-lik katalog utan nyckel: probe bekräftar katalog, lovar inte chat", async () => {
    // Moln-baseUrl + ingen nyckel: endast /models hämtas (insprutad transport, inget nätverk).
    const transport = sequenceTransport([
      { body: JSON.stringify({ data: [{ id: "moonshotai/kimi-k2-instruct" }, { id: "meta/llama-3.1-8b-instruct" }] }) },
    ]);
    const provider = new OpenAiCompatibleProvider({
      id: "probe-nim-public",
      label: "NIM publik katalog (docka)",
      kind: "nvidia",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      model: "moonshotai/kimi-k2-instruct",
      catalogWithoutKey: true,
      sourceOverride: "stub",
      context: makeContext(transport, { timeoutMs: 10_000 }),
    });
    const probe = await provider.probe();
    expect(probe.ok).toBe(true);
    expect(probe.source).toBe("stub");
    expect(probe.sample).toContain("katalog");
    expect(probe.sample).toContain("ingen nyckel");
    expect(provider.hasKey).toBe(false);
    expect(provider.isLocal).toBe(false);
    // bara ett anrop: katalogen. Chat-provet uteblir som det ska.
    expect(transport.calls).toHaveLength(1);
  });
});

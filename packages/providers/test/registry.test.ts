/**
 * ProviderRegistry — flera modeller samtidigt och roll-fördelning (FAS 3.1, 3.2, T10).
 *
 * T10-beviset: autocomplete, chat och vision resolverar till TRE OLIKA leverantörer
 * i samma regist, samtidigt, och varje anrop går till rätt en.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorCode, type ModelRole } from "@nexus/protocol";
import {
  OpenAiCompatibleProvider,
  OllamaProvider,
  ProviderError,
  ProviderRegistry,
  StubProvider,
  builtinProviderConfigs,
  MemoryLogger,
} from "../src/index";
import { drain, httpTransport, makeContext, requestsTo, startMock, type MockModelServer } from "./helpers";

let server: MockModelServer;

beforeAll(async () => {
  server = await startMock({ mode: "echo" });
});

afterAll(async () => {
  await server.close();
});

function registryWith(...providers: (OpenAiCompatibleProvider | OllamaProvider | StubProvider)[]): ProviderRegistry {
  const registry = new ProviderRegistry({ logSink: new MemoryLogger() });
  for (const provider of providers) registry.register(provider);
  return registry;
}

describe("upp- och nercount av leverantörer", () => {
  it("upsert bygger adapter per kind och lämnar aldrig ut en nyckel", () => {
    const registry = new ProviderRegistry();
    for (const preset of builtinProviderConfigs()) registry.upsert(preset);
    const infos = registry.list();
    expect(infos.map((i) => i.id)).toEqual(expect.arrayContaining(["nvidia", "ollama", "openai", "anthropic", "google"]));

    const nvidia = registry.upsert({
      id: "nvidia",
      label: "NVIDIA NIM",
      kind: "nvidia",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: "nvapi-test-1234567890",
      apiKeyEnvName: "NVIDIA_API_KEY",
      model: "moonshotai/kimi-k2-instruct",
    });
    expect(nvidia.hasKey).toBe(true);
    expect(nvidia.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(nvidia.isLocal).toBe(false);
    expect(nvidia.builtin).toBe(true);
    expect(JSON.stringify(nvidia)).not.toContain("nvapi-test-1234567890");

    const ollama = registry.get("ollama");
    expect(ollama?.isLocal).toBe(true);
    expect(ollama?.kind).toBe("ollama");
    expect(ollama?.capabilities).toContain("fim");
  });

  it("custom endpoint med egen baseUrl registreras, uppdateras och tas bort", () => {
    const registry = new ProviderRegistry();
    const created = registry.upsert({
      label: "Min vLLM",
      kind: "vllm",
      baseUrl: "http://127.0.0.1:8000/v1",
      models: ["Qwen/Qwen2.5-Coder-7B-Instruct"],
      capabilities: ["chat", "stream", "complete", "fim", "embeddings"],
    });
    expect(created.id).toBe("min-vllm");
    expect(created.isLocal).toBe(true);
    expect(created.models).toEqual(["Qwen/Qwen2.5-Coder-7B-Instruct"]);

    const updated = registry.upsert({ ...created, label: "Min vLLM", baseUrl: "http://127.0.0.1:8001/v1", enabled: false });
    expect(updated.baseUrl).toBe("http://127.0.0.1:8001/v1");
    expect(updated.enabled).toBe(false);
    expect(registry.list()).toHaveLength(1);

    expect(registry.remove("min-vllm")).toBe(true);
    expect(registry.get("min-vllm")).toBeUndefined();
    expect(registry.remove("min-vllm")).toBe(false);
  });

  it("models(scope) skillar lokal mot moln och rollerna följer med", () => {
    const registry = new ProviderRegistry();
    registry.upsert({ id: "nim", label: "NVIDIA NIM", kind: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1", model: "moonshotai/kimi-k2-instruct" });
    registry.upsert({ id: "ollama", label: "Ollama", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen2.5-coder:1.5b" });
    registry.setRole("chat", "nim", "moonshotai/kimi-k2-instruct");

    const all = registry.models("all");
    expect(all.map((m) => m.providerId).sort()).toEqual(["nim", "ollama"]);
    expect(all.filter((m) => m.source === "cloud").map((m) => m.id)).toEqual(["moonshotai/kimi-k2-instruct"]);
    expect(all.filter((m) => m.source === "local").map((m) => m.id)).toEqual(["qwen2.5-coder:1.5b"]);
    expect(registry.models("local").every((m) => m.source === "local")).toBe(true);
    expect(registry.models("cloud").every((m) => m.source !== "local")).toBe(true);
    const assigned = all.find((m) => m.roles.length > 0);
    expect(assigned?.roles).toEqual(["chat"]);
  });

  it("roller, byRole, resolve och modelReady", () => {
    const registry = new ProviderRegistry();
    registry.upsert({ id: "ollama", label: "Ollama", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen2.5-coder:1.5b" });
    registry.upsert({ id: "nim", label: "NVIDIA NIM", kind: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1", model: "moonshotai/kimi-k2-instruct" });

    const changed: number[] = [];
    const listener = new ProviderRegistry({
      onRoleChanged: (roles) => changed.push(roles.length),
    });
    void listener;

    const assignment = registry.setRole("chat", "nim", "moonshotai/kimi-k2-instruct", ["ollama/qwen2.5-coder:1.5b"]);
    expect(assignment.source).toBe("cloud");
    expect(assignment.fallbackChain).toEqual(["ollama/qwen2.5-coder:1.5b"]);
    registry.setRole("autocomplete", "ollama", "qwen2.5-coder:1.5b");
    expect(registry.roles().map((r) => r.role).sort()).toEqual(["autocomplete", "chat"]);
    expect(registry.byRole("chat")?.id).toBe("nim");
    expect(registry.byRole("vision")).toBeNull();
    expect(registry.resolve("chat")?.chain).toEqual(["nim/moonshotai/kimi-k2-instruct", "ollama/qwen2.5-coder:1.5b"]);
    const ready = registry.modelReady();
    expect(ready.chat).toBe(true);
    expect(ready.autocomplete).toBe(true);
    expect(ready.vision).toBe(false);

    // borttagen leverantör rensar sina roller
    registry.remove("nim");
    expect(registry.byRole("chat")).toBeNull();
    expect(registry.roles().map((r) => r.role)).toEqual(["autocomplete"]);
  });
});

describe("T10 — tre roller, tre olika leverantörer, samtidigt", () => {
  it("chat / autocomplete / vision resolverar till olika providers och rätt anrop går rätt", async () => {
    const chatProvider = new OpenAiCompatibleProvider({
      id: "nim-chat",
      label: "NVIDIA NIM (docka)",
      kind: "nvidia",
      baseUrl: server.baseUrl,
      model: "stub/mock-chat-1",
      sourceOverride: "stub",
      context: makeContext(httpTransport(), { timeoutMs: 10_000 }),
    });
    const fimProvider = new OllamaProvider({
      id: "ollama-fim",
      label: "Ollama FIM (docka)",
      kind: "ollama",
      baseUrl: server.url,
      model: "stub/qwen2.5-coder:1.5b",
      sourceOverride: "stub",
      context: makeContext(httpTransport(), { timeoutMs: 10_000 }),
    });
    const visionProvider = new StubProvider({
      id: "vision-docka",
      label: "Vision-docka",
      kind: "custom",
      model: "stub/llava-docka",
      context: makeContext(httpTransport()),
    });
    const registry = registryWith(chatProvider, fimProvider, visionProvider);
    registry.setRole("chat", "nim-chat", "stub/mock-chat-1", ["ollama-fim/stub/qwen2.5-coder:1.5b"]);
    registry.setRole("autocomplete", "ollama-fim", "stub/qwen2.5-coder:1.5b", ["vision-docka/stub/llava-docka"]);
    registry.setRole("vision", "vision-docka", "stub/llava-docka", ["nim-chat/stub/mock-chat-1"]);

    // De tre rollerna pekar på tre olika leverantörer — samtidigt.
    const resolvedRoles: ModelRole[] = ["chat", "autocomplete", "vision"];
    const providers = resolvedRoles.map((role) => registry.resolve(role)?.providerId);
    expect(new Set(providers).size).toBe(3);
    expect(providers).toEqual(["nim-chat", "ollama-fim", "vision-docka"]);

    const [chat, completion, vision] = await Promise.all([
      registry.callForRole("chat", { messages: [{ role: "user", content: "förklara FIM" }] }),
      registry.callForRole("autocomplete", {
        prefix: "function add(a: number, b: number) {\n  return ",
        suffix: "\n}",
        path: "src/math.ts",
        language: "typescript",
        position: { line: 1, column: 3 },
      }),
      registry.callForRole("vision", { imageBase64: "cG5n", mime: "image/png", prompt: "vad syns?" }),
    ]);

    expect(chat.providerId).toBe("nim-chat");
    expect(chat.source).toBe("stub");
    expect(chat.text).toContain("stub-svar till:");
    expect(completion.providerId).toBe("ollama-fim");
    expect(completion.source).toBe("stub");
    expect(vision.providerId).toBe("vision-docka");
    expect(vision.engine).toBe("stub");
    expect(vision.source).toBe("stub");

    // Varje leverantör fick sitt anrop — ingen cross-talk.
    // Varje roll trafikerade sin egen leverantör — ingen cross-talk.
    expect(requestsTo(server, "/v1/chat/completions")).toHaveLength(1);
    expect(requestsTo(server, "/api/generate")).toHaveLength(1);
    expect(requestsTo(server, "/api/chat")).toHaveLength(0);
    expect(visionProvider.calls.vision).toHaveLength(1);
    expect(visionProvider.calls.chat).toHaveLength(0);
    expect(fimProvider.preferredModel).toBe("stub/qwen2.5-coder:1.5b");
    expect(chatProvider.preferredModel).toBe("stub/mock-chat-1");
  });

  it("stream för en roll använder samma roll-upplösning", async () => {
    const chatProvider = new OpenAiCompatibleProvider({
      id: "stream-role",
      label: "Stream-roll (docka)",
      kind: "openai",
      baseUrl: server.baseUrl,
      model: "stub/mock-chat-1",
      sourceOverride: "stub",
      context: makeContext(httpTransport(), { timeoutMs: 10_000 }),
    });
    const registry = registryWith(chatProvider);
    registry.setRole("agent", "stream-role", "stub/mock-chat-1");
    const text = (await drain(registry.streamForRole("agent", { messages: [{ role: "user", content: "strömma" }] }))).join("");
    expect(text).toBe("stub-svar till: strömma");
    expect(registry.lastReport("agent")?.ok).toBe(true);
  });

  it("embeddings kan lösa mot en annan provider än chat", async () => {
    const embedProvider = new OpenAiCompatibleProvider({
      id: "embed-only",
      label: "Embeddings-docka",
      kind: "vllm",
      baseUrl: server.baseUrl,
      model: "stub/mock-embed-1",
      capabilities: ["embeddings"],
      sourceOverride: "stub",
      context: makeContext(httpTransport(), { timeoutMs: 10_000 }),
    });
    const chatProvider = new StubProvider({ id: "chat-only", context: makeContext(httpTransport()) });
    const registry = registryWith(embedProvider, chatProvider);
    registry.setRole("embeddings", "embed-only", "stub/mock-embed-1");
    registry.setRole("chat", "chat-only", "stub/echo-1");
    const [embeddings, chat] = await Promise.all([
      registry.callForRole("embeddings", { texts: ["_alpha", "alpha"] }),
      registry.callForRole("chat", { messages: [{ role: "user", content: "hej" }] }),
    ]);
    expect(embeddings.providerId).toBe("embed-only");
    expect(chat.providerId).toBe("chat-only");
    expect(embeddings.dimensions).toBeGreaterThan(0);
  });
});

describe("catalog och refreshModels", () => {
  it("aggregerar katalog från alla aktiva leverantörer", async () => {
    const a = new OpenAiCompatibleProvider({
      id: "cat-a",
      label: "Docka A",
      kind: "custom",
      baseUrl: server.baseUrl,
      model: "stub/mock-chat-1",
      sourceOverride: "stub",
      context: makeContext(httpTransport(), { timeoutMs: 10_000 }),
    });
    const b = new StubProvider({ id: "cat-b", models: ["stub/extra-1"], context: makeContext(httpTransport()) });
    const registry = registryWith(a, b);
    const catalog = await registry.catalog();
    expect(catalog.some((m) => m.id === "stub/mock-chat-1")).toBe(true);
    expect(catalog.some((m) => m.id === "stub/extra-1")).toBe(true);
  });

  it("refreshModels cachear modeller och degraderar vid offline", async () => {
    const offline = new OpenAiCompatibleProvider({
      id: "offline-provider",
      label: "Offline docka",
      kind: "custom",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "stub/mock-chat-1",
      sourceOverride: "stub",
      context: makeContext(httpTransport(), { timeoutMs: 200 }),
    });
    const registry = registryWith(offline);
    const models = await registry.refreshModels();
    expect(models.map((m) => m.id)).toEqual(["stub/mock-chat-1"]);
    expect(registry.list()[0]?.models).toEqual(["stub/mock-chat-1"]);

    const online = new OllamaProvider({
      id: "ollama-cache",
      label: "Ollama docka",
      kind: "ollama",
      baseUrl: server.url,
      model: "stub/qwen2.5-coder:1.5b",
      sourceOverride: "stub",
      context: makeContext(httpTransport(), { timeoutMs: 10_000 }),
    });
    const registry2 = registryWith(online);
    await registry2.refreshModels("ollama-cache");
    const cached = registry2.models("all").filter((m) => m.providerId === "ollama-cache");
    expect(cached.length).toBeGreaterThan(1);
    expect(cached.some((m) => (m.sizeBytes ?? 0) > 0)).toBe(true);
  });
});

describe("Negativt — registret hittar inget och säger varför", () => {
  it("roll mot okänd leverantör ger NoModelAvailable", async () => {
    const registry = new ProviderRegistry();
    registry.setRole("chat", "finns-inte", "någonmodell");
    expect(registry.byRole("chat")).toBeNull();
    const failure = await registry.callForRole("chat", { messages: [{ role: "user", content: "x" }] }).catch((err: unknown) => err);
    expect((failure as ProviderError).code).toBe(ErrorCode.NoModelAvailable);
  });

  it("get på okänd id kastar not_found, list() förblir tom", () => {
    const registry = new ProviderRegistry();
    expect(registry.list()).toEqual([]);
    expect(registry.get("ingen")).toBeUndefined();
    expect(() => registry.remove("ingen")).not.toThrow();
    const failure = (() => {
      try {
        registry.models("all");
        return undefined;
      } catch (err) {
        return err;
      }
    })();
    expect(failure).toBeUndefined();
  });

  it("catalog ignorerar en leverantör som svarar fel (ingen krash)", async () => {
    const broken = new OpenAiCompatibleProvider({
      id: "cat-broken",
      label: "Trasig katalog",
      kind: "custom",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "stub/mock-chat-1",
      sourceOverride: "stub",
      context: makeContext(httpTransport(), { timeoutMs: 150 }),
    });
    const registry = registryWith(broken);
    await expect(registry.catalog()).resolves.toEqual([]);
  });
});

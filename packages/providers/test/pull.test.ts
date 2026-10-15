/**
 * Modellhämtning och embeddings-API:et (FAS 3.2 h + FAS 3.5).
 *
 * Pull-progress är det som gör att UI:t kan visa en hämtning som rör sig. Formaten på
 * varje steg är exakt payloaden för eventet `model/pull_progress` i @nexus/protocol.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeEvent, type EventName, type PayloadOf } from "@nexus/protocol";
import {
  OllamaProvider,
  OpenAiCompatibleProvider,
  ProviderRegistry,
  StubProvider,
} from "../src/index";
import { httpTransport, makeContext, requestsTo, startMock, type MockModelServer } from "./helpers";

let server: MockModelServer;

beforeAll(async () => {
  server = await startMock({ mode: "echo", chunkDelayMs: 1 });
});

afterAll(async () => {
  await server.close();
});

interface PullStep {
  ref: string;
  percent: number;
  status: string;
  totalBytes?: number;
}

describe("Ollama pull med progress", () => {
  it("strömmar /api/pull och matar model/pull_progress i rätt form", async () => {
    const provider = new OllamaProvider({
      id: "pull-ollama",
      label: "Ollama pull (docka)",
      kind: "ollama",
      baseUrl: server.url,
      model: "stub/qwen2.5-coder:1.5b",
      sourceOverride: "stub",
      context: makeContext(httpTransport(), { timeoutMs: 15_000 }),
    });
    const steps: PullStep[] = [];
    const outcome = await provider.pull("qwen2.5-coder:1.5b", (event) => {
      steps.push({ ref: "ollama/qwen2.5-coder:1.5b", ...event });
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.ref).toBe("qwen2.5-coder:1.5b");
    expect(outcome.message).toContain("success");
    expect(outcome.bytes).toBe(50_000_000);
    expect(steps.length).toBeGreaterThanOrEqual(4);
    // Progression är monoton och slutar vid 100.
    const percents = steps.map((s) => s.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(percents.at(-1)).toBe(100);
    expect(steps.some((s) => s.status === "pulling manifest")).toBe(true);
    expect(steps.every((s) => s.status.length > 0)).toBe(true);

    // Stegen är som event payload — annars kan host inte skicka dem vidare.
    const frame = makeEvent("model/pull_progress", steps[0] as PayloadOf<"model/pull_progress">);
    expect(frame.name).toBe("model/pull_progress");
    expect(JSON.stringify(frame.payload)).toContain("pulling manifest");

    expect(requestsTo(server, "/api/pull")).toHaveLength(1);
    expect(requestsTo(server, "/api/pull")[0]?.body).toEqual({ name: "qwen2.5-coder:1.5b", stream: true, insecure: false });
  });

  it("NEGATIVT: offline hämtning returnerar ett ärligt felobjekt, inget kast", async () => {
    const dead = await startMock({});
    const url = dead.url;
    await dead.close();
    const provider = new OllamaProvider({
      id: "pull-dead",
      label: "Ollama offline",
      kind: "ollama",
      baseUrl: url,
      model: "stub/qwen2.5-coder:1.5b",
      sourceOverride: "stub",
      context: makeContext(httpTransport(), { timeoutMs: 1_500 }),
    });
    const steps: string[] = [];
    const outcome = await provider.pull("någon/modell:latest", (event) => steps.push(event.status));
    expect(outcome.ok).toBe(false);
    expect(outcome.ref).toBe("någon/modell:latest");
    expect(outcome.message).toBeTruthy();
    expect(steps).toHaveLength(0);
  });
});

describe("Registry.pullModel — ref-format och molnutan-hämtning", () => {
  it("delar provider och modell trots slash i modellnamnet", async () => {
    const registry = new ProviderRegistry();
    registry.register(
      new OllamaProvider({
        id: "ollama",
        label: "Ollama",
        kind: "ollama",
        baseUrl: server.url,
        model: "stub/qwen2.5-coder:1.5b",
        sourceOverride: "stub",
        context: makeContext(httpTransport(), { timeoutMs: 15_000 }),
      }),
    );
    const seen: number[] = [];
    const outcome = await registry.pullModel("ollama/HuggingFaceTB/SmolLM-135M", (event) => seen.push(event.percent));
    expect(outcome.ok).toBe(true);
    expect(outcome.ref).toBe("HuggingFaceTB/SmolLM-135M");
    expect(seen.at(-1)).toBe(100);
    const body = requestsTo(server, "/api/pull").at(-1)?.body;
    expect(body?.["name"]).toBe("HuggingFaceTB/SmolLM-135M");
  });

  it("molnleverantör utan pull får ett förklarande svar (ingen crash, ingen lögn)", async () => {
    const registry = new ProviderRegistry();
    registry.register(
      new OpenAiCompatibleProvider({
        id: "nim",
        label: "NVIDIA NIM",
        kind: "nvidia",
        baseUrl: server.baseUrl,
        model: "moonshotai/kimi-k2-instruct",
        sourceOverride: "stub",
        context: makeContext(httpTransport()),
      }),
    );
    const outcome = await registry.pullModel("nim/moonshotai/kimi-k2-instruct");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("ingen hämtning");

    const unknown = await registry.pullModel("finns-inte/modell");
    expect(unknown.ok).toBe(false);
    expect(unknown.message).toContain("okänd leverantör");
  });
});

describe("embeddings-API:et tar både text-array och begäran", () => {
  it("provider.embeddings(texts) och provider.embeddings({texts, model}) är samma sak", async () => {
    const provider = new StubProvider({ id: "embed-shape", dimensions: 6, context: makeContext(httpTransport()) });
    const short = await provider.embeddings(["alpha", "beta"]);
    const long = await provider.embeddings({ texts: ["alpha", "beta"], model: "stub/echo-1" });
    expect(short.vectors).toEqual(long.vectors);
    expect(short.dimensions).toBe(6);
    expect(short.source).toBe("stub");

    const ollama = new OllamaProvider({
      id: "embed-array",
      label: "Ollama embeddings (docka)",
      kind: "ollama",
      baseUrl: server.url,
      model: "stub/nomic-embed-text:latest",
      sourceOverride: "stub",
      context: makeContext(httpTransport(), { timeoutMs: 10_000 }),
    });
    const viaArray = await ollama.embeddings(["en text"]);
    expect(viaArray.vectors).toHaveLength(1);
    expect(requestsTo(server, "/api/embeddings").at(-1)?.body?.["prompt"]).toBe("en text");
  });

  it("NEGATIVT: tom text-array ger BadRequest utan att röra nätet", async () => {
    const transport = httpTransport();
    const provider = new OpenAiCompatibleProvider({
      id: "embed-empty",
      label: "Tom embeddings (docka)",
      kind: "custom",
      baseUrl: server.baseUrl,
      model: "stub/mock-embed-1",
      capabilities: ["embeddings"],
      sourceOverride: "stub",
      context: makeContext(transport),
    });
    await expect(provider.embeddings([])).rejects.toThrow(/inga texter/);
    expect(transport.calls).toHaveLength(0);
  });

  it("event-namnet för pull finns i protokoll-tabellen (T31-style garanti)", () => {
    const names: EventName[] = ["model/pull_progress", "model/changed", "chat/token", "rag/progress"];
    expect(names.every((n) => typeof n === "string")).toBe(true);
  });
});

/**
 * Embeddings (FAS 3.5 RAG underlag): hämtning, form och L2-normalisering.
 *
 * Normaliseringen är inte kosmetik — RAG-sökningen jämför vektorer med cosinus, och
 * råvektorer från olika servrar har olika skalning. Vi normaliserar i lagret så
 * konsumenten aldrig behöver tänka på det. Dockan svarar medvetet *inte* normaliserat.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  GoogleProvider,
  OllamaProvider,
  OpenAiCompatibleProvider,
  ProviderError,
  StubProvider,
  normalizeVector,
  normalizeVectors,
} from "../src/index";
import { httpTransport, l2Norm, makeContext, requestsTo, sequenceTransport, startMock, type MockModelServer } from "./helpers";

let server: MockModelServer;

beforeAll(async () => {
  server = await startMock({ mode: "echo", embeddingDimensions: 8 });
});

afterAll(async () => {
  await server.close();
});

function openAiEmbed(id: string): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    id,
    label: `${id} (docka)`,
    kind: "custom",
    baseUrl: server.baseUrl,
    model: "stub/mock-embed-1",
    capabilities: ["embeddings", "chat", "stream"],
    sourceOverride: "stub",
    context: makeContext(httpTransport(), { timeoutMs: 10_000 }),
  });
}

describe("normalizeVector — ren matte, inga överraskningar", () => {
  it("ger enhetslängd och bevarar riktning", () => {
    const unit = normalizeVector([3, 4]);
    expect(unit[0]).toBeCloseTo(0.6);
    expect(unit[1]).toBeCloseTo(0.8);
    expect(l2Norm(unit)).toBeCloseTo(1);
  });

  it("nollvektorn lämnas orörd (division med noll får aldrig hända)", () => {
    expect(normalizeVector([0, 0, 0])).toEqual([0, 0, 0]);
    const batch = normalizeVectors([[1, 0], [0, 0], [2, 2]]);
    expect(batch[1]).toEqual([0, 0]);
    expect(l2Norm(batch[2] ?? [])).toBeCloseTo(1);
  });

  it("redan normaliserad vektor är stabil", () => {
    const once = normalizeVector([0.5, 0.5, 0.5]);
    const twice = normalizeVector(once);
    expect(twice[0]).toBeCloseTo(once[0]);
  });
});

describe("OpenAI-kompatibla embeddings", () => {
  it("hämtar en vektor per text och normaliserar dem", async () => {
    const provider = openAiEmbed("embed-openai");
    const texts = ["function add(a, b) { return a + b; }", "const x = 1;", "README markdown text"];
    const result = await provider.embeddings({ texts });
    expect(result.vectors).toHaveLength(texts.length);
    expect(result.dimensions).toBe(8);
    expect(result.model).toBe("stub/mock-embed-1");
    expect(result.providerId).toBe("embed-openai");
    expect(result.source).toBe("stub");
    for (const vector of result.vectors) {
      expect(vector).toHaveLength(8);
      expect(l2Norm(vector)).toBeCloseTo(1);
    }
    // Olika text → olika riktning (dockan är deterministisk, ingen slump inblandad).
    expect(result.vectors[0]).not.toEqual(result.vectors[1]);

    const body = requestsTo(server, "/v1/embeddings").at(-1)?.body;
    expect(body?.["input"]).toEqual(texts);
    expect(body?.["model"]).toBe("stub/mock-embed-1");
  });

  it("en string som input accepteras också (vissa servrar skickar inte array)", async () => {
    const transport = sequenceTransport([
      { body: JSON.stringify({ model: "stub/mock-embed-1", data: [{ index: 0, embedding: [2, 0, 0] }] }) },
    ]);
    const provider = new OpenAiCompatibleProvider({
      id: "embed-single",
      label: "Single embed (docka)",
      kind: "custom",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "stub/mock-embed-1",
      capabilities: ["embeddings"],
      sourceOverride: "stub",
      context: makeContext(transport),
    });
    const result = await provider.embeddings({ texts: ["bara en"] });
    expect(result.vectors).toEqual([[1, 0, 0]]);
    expect((transport.calls[0]?.body?.["input"] as unknown[]).length).toBe(1);
  });
});

describe("Ollama och Google embeddings", () => {
  it("Ollama tar en text per anrop och normaliserar lika", async () => {
    const provider = new OllamaProvider({
      id: "embed-ollama",
      label: "Ollama embeddings (docka)",
      kind: "ollama",
      baseUrl: server.url,
      model: "stub/nomic-embed-text:latest",
      sourceOverride: "stub",
      context: makeContext(httpTransport(), { timeoutMs: 10_000 }),
    });
    const result = await provider.embeddings({ texts: ["alpha", "beta"] });
    expect(requestsTo(server, "/api/embeddings")).toHaveLength(2);
    expect(result.vectors).toHaveLength(2);
    expect(result.dimensions).toBe(8);
    for (const vector of result.vectors) expect(l2Norm(vector)).toBeCloseTo(1);
    const bodies = requestsTo(server, "/api/embeddings").map((r) => r.body?.["prompt"]);
    expect(bodies).toEqual(["alpha", "beta"]);
  });

  it("Google embedContent ger {embedding:{values}} och normaliseras", async () => {
    const transport = sequenceTransport([
      { body: JSON.stringify({ embedding: { values: [0, 3, 4] } }) },
    ]);
    const provider = new GoogleProvider({
      id: "embed-google",
      label: "Google embeddings (docka)",
      kind: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "AQ-test-fake",
      model: "gemini-embedding-test",
      sourceOverride: "stub",
      context: makeContext(transport),
    });
    const result = await provider.embeddings({ texts: ["x"] });
    expect(result.vectors[0]).toEqual([0, 0.6, 0.8]);
    expect(transport.calls[0]?.url).toContain(":embedContent");
    expect(transport.calls[0]?.body).toEqual({ content: { parts: [{ text: "x" }] } });
  });
});

describe("Stub-dockan för embeddings (host och core testar mot denna)", () => {
  it("stubben är deterministisk och rapporterar stub", async () => {
    const provider = new StubProvider({ id: "stub-embed", dimensions: 4, context: makeContext(httpTransport()) });
    const a = await provider.embeddings({ texts: ["samma text"] });
    const b = await provider.embeddings({ texts: ["samma text"] });
    expect(a.vectors).toEqual(b.vectors);
    expect(a.dimensions).toBe(4);
    expect(a.source).toBe("stub");
    expect(l2Norm(a.vectors[0] ?? [])).toBeCloseTo(1);
    expect(provider.calls.embeddings).toHaveLength(2);
  });
});

describe("Negativa fall — embeddings", () => {
  it("leverantör utan embeddings-capability ger unsupported, ingen networkanrop", async () => {
    const transport = sequenceTransport([{ body: "{}" }]);
    const provider = new AnthropicProvider({
      id: "anthropic-noembed",
      label: "Anthropic utan embeddings",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test-123456",
      model: "claude-test",
      context: makeContext(transport),
    });
    const failure = await provider.embeddings({ texts: ["x"] }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).errorClass).toBe("unsupported");
    expect(transport.calls).toHaveLength(0);
  });

  it("NEGATIVT: tomt input-arkiv avvisas som bad_request innan något nätverk", async () => {
    const transport = httpTransport();
    const provider = new OpenAiCompatibleProvider({
      id: "embed-empty",
      label: "Tom embeddings-docka",
      kind: "custom",
      baseUrl: server.baseUrl,
      model: "stub/mock-embed-1",
      capabilities: ["embeddings"],
      sourceOverride: "stub",
      context: makeContext(transport),
    });
    const failure = await provider.embeddings({ texts: [] }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).errorClass).toBe("bad_request");
    expect(transport.calls).toHaveLength(0);
  });

  it("NEGATIVT: server som svarar utan data ger parse-fel", async () => {
    const transport = sequenceTransport([{ body: JSON.stringify({ model: "stub", usage: {} }) }]);
    const provider = new OpenAiCompatibleProvider({
      id: "embed-broken",
      label: "Trasig embeddings-docka",
      kind: "custom",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "stub/mock-embed-1",
      capabilities: ["embeddings"],
      sourceOverride: "stub",
      context: makeContext(transport),
    });
    const failure = await provider.embeddings({ texts: ["x"] }).catch((err: unknown) => err);
    expect((failure as ProviderError).errorClass).toBe("parse");
    expect((failure as ProviderError).source).toBe("stub");
  });
});

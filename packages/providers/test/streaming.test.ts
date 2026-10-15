/**
 * Streaming: SSE-reassemblering över chunk-gränser, [DONE], NDJSON och avbrott.
 *
 * Negativa fall i den här filen: trasig JSON i ett SSE-event, och en stream som
 * hänger sig och måste avbrytas — inget av det får kasta råa fel upp till transporten.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OllamaProvider,
  OpenAiCompatibleProvider,
  ProviderError,
  SseDecoder,
  SSE_DONE,
  readSse,
  streamDataPayloads,
} from "../src/index";
import {
  drain,
  fakeResponse,
  httpTransport,
  makeContext,
  startMock,
  streamingTransport,
  type FakeTransport,
  type MockModelServer,
} from "./helpers";

function sseChunks(words: readonly string[]): string[] {
  const out: string[] = [];
  for (const [index, word] of words.entries()) {
    out.push(`data: ${JSON.stringify({ id: `c${index}`, model: "stub/mock-chat-1", choices: [{ index: 0, delta: { content: word } }] })}\n`);
    out.push("\n");
  }
  out.push(`data: ${JSON.stringify({ model: "stub/mock-chat-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  out.push(`data: ${SSE_DONE}\n\n`);
  // Skräp efter [DONE] får aldrig läsas in.
  out.push('data: {"choices":[{"delta":{"content":"EFTER DONE"}}]}\n\n');
  return out;
}

function stubProvider(transport: FakeTransport, id: string, extra: Parameters<typeof makeContext>[1] = {}): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    id,
    label: `${id} (test-docka)`,
    kind: "custom",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "stub/mock-chat-1",
    sourceOverride: "stub",
    context: makeContext(transport, extra),
  });
}

describe("SseDecoder — chunk-splits, multi-line och [DONE]", () => {
  it("buffrar en rad som delas mitt i JSON-dokumentet", () => {
    const decoder = new SseDecoder();
    expect(decoder.push('data: {"choices":[{"delta":{"cont')).toEqual([]);
    expect(decoder.push('ent":"hej"}}]}\n')).toEqual([]);
    const events = decoder.push("\n");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]?.data ?? "{}")).toEqual({ choices: [{ delta: { content: "hej" } }] });
  });

  it("fogar multi-line data-rader till ett JSON-dokument", () => {
    const decoder = new SseDecoder();
    const events = decoder.push('data: {"content":\ndata: "två rader"}\n\n');
    expect(events).toHaveLength(1);
    expect((JSON.parse(events[0]?.data ?? "{}") as { content: string }).content).toBe("två rader");
  });

  it("hopper över kommentarer och flush:ar sista eventet utan blankrad", () => {
    const decoder = new SseDecoder();
    expect(decoder.push(": keep-alive\r\ndata: {\"a\":1}\r\n")).toEqual([]);
    const flushed = decoder.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.data).toBe('{"a":1}');
  });

  it("readSse ger events i ordning och streamDataPayloads slutar vid [DONE]", async () => {
    const res = fakeResponse({ chunks: sseChunks(["alpha ", "beta "]), headers: { "content-type": "text/event-stream" } });
    const events = [];
    for await (const event of readSse(res, { context: "test" })) events.push(event);
    expect(events.length).toBeGreaterThanOrEqual(3);

    const payloads = await drain(streamDataPayloads(fakeResponse({ chunks: sseChunks(["x ", "y "]) })));
    expect(payloads).toHaveLength(3); // två content-chunks + stop-chunken, aldrig "EFTER DONE"
    const text = payloads
      .map((raw) => (JSON.parse(raw) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content ?? "")
      .join("");
    expect(text).toBe("x y ");
  });
});

describe("OpenAiCompatibleProvider.stream — över riktig loopback-HTTP", () => {
  let server: MockModelServer;

  beforeAll(async () => {
    server = await startMock({ mode: "slow", chunkDelayMs: 2 });
  });

  afterAll(async () => {
    await server.close();
  });

  it("reassemblerar token till exakt text och är ärlig mot source", async () => {
    const provider = new OpenAiCompatibleProvider({
      id: "mock-openai",
      label: "Mock OpenAI (stub)",
      kind: "openai",
      baseUrl: server.baseUrl,
      model: "stub/mock-chat-1",
      sourceOverride: "stub",
      context: makeContext(httpTransport(), { timeoutMs: 10_000 }),
    });
    const pieces = await drain(provider.stream({ messages: [{ role: "user", content: "hej världen" }] }));
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join("")).toBe("stub-svar till: hej världen");
    expect(provider.source).toBe("stub");
    expect(provider.isLocal).toBe(true);
    const last = server.requests.filter((r) => r.path === "/v1/chat/completions").at(-1);
    expect(last?.body?.["stream"]).toBe(true);
    expect(last?.body?.["model"]).toBe("stub/mock-chat-1");
  });

  it("lagrar inte bort tecken när transporten delar linjer udda", async () => {
    const raw = sseChunks(["en ", "två ", "tre "]).join("");
    const bits: string[] = [];
    for (let i = 0; i < raw.length; i += 7) bits.push(raw.slice(i, i + 7));
    const transport = streamingTransport(bits);
    const provider = stubProvider(transport, "split-sse");
    const text = (await drain(provider.stream({ messages: [{ role: "user", content: "x" }] }))).join("");
    expect(text).toBe("en två tre ");
    expect(transport.calls[0]?.url).toBe("http://127.0.0.1:1/v1/chat/completions");
  });
});

describe("OllamaProvider.stream — NDJSON över riktig loopback", () => {
  it("fogar rader till exakt samma text som dockan skrev", async () => {
    const server = await startMock({ mode: "slow", chunkDelayMs: 1 });
    try {
      const provider = new OllamaProvider({
        id: "mock-ollama",
        label: "Mock Ollama (stub)",
        kind: "ollama",
        baseUrl: server.url,
        model: "stub/qwen2.5-coder:1.5b",
        sourceOverride: "stub",
        context: makeContext(httpTransport(), { timeoutMs: 10_000 }),
      });
      const pieces = await drain(provider.stream({ messages: [{ role: "user", content: "hej" }] }));
      expect(pieces.join("")).toBe("stub-svar från dockan till hej");
      expect(provider.source).toBe("stub");
      expect(server.requests.some((r) => r.path === "/api/chat")).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe("Negativa fall — streaming får aldrig krascha", () => {
  it("trasig JSON i ett SSE-event ger ProviderError med klass parse", async () => {
    const transport = streamingTransport(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: {trasig\n\n"]);
    const provider = stubProvider(transport, "bad-sse");
    const failure = await drain(provider.stream({ messages: [{ role: "user", content: "x" }] })).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderError);
    const error = failure as ProviderError;
    expect(error.errorClass).toBe("parse");
    expect(error.message).toContain("kunde inte tolkas");
  });

  it("stream som hänger sig avbryts och blir timeout/network — aldrig en hård krasch", async () => {
    const transport = streamingTransport(['data: {"choices":[{"delta":{"content":"första"}}]}\n\n'], { hangAfter: true });
    const provider = stubProvider(transport, "hang-sse", { timeoutMs: 80 });
    const collected: string[] = [];
    let failure: unknown;
    const started = Date.now();
    try {
      for await (const piece of provider.stream({ messages: [{ role: "user", content: "x" }] })) {
        collected.push(piece);
      }
    } catch (err) {
      failure = err;
    }
    expect(collected).toEqual(["första"]);
    expect(failure).toBeInstanceOf(ProviderError);
    const error = failure as ProviderError;
    expect(["timeout", "network"]).toContain(error.errorClass);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("provider utan stream-capability ger tydligt unsupported-fel", async () => {
    const transport = streamingTransport([]);
    const provider = new OpenAiCompatibleProvider({
      id: "no-stream",
      label: "Utan stream",
      kind: "custom",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "stub/mock-chat-1",
      capabilities: ["chat"],
      sourceOverride: "stub",
      context: makeContext(transport),
    });
    const failure = await drain(provider.stream({ messages: [{ role: "user", content: "x" }] })).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).errorClass).toBe("unsupported");
    expect(transport.calls).toHaveLength(0);
  });
});

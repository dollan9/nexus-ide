/**
 * Payload-form för Anthropic och Google — de två diallekterna som inte är OpenAI.
 *
 * Allt körs mot en insprutad transport:RequestBody och URL är själva påståendet.
 * Ingen riktig API-nyckel används (`sk-ant-test-…` och `AQ-test-…` är uppenbart falska).
 */

import { describe, expect, it } from "vitest";
import { ErrorCode } from "@nexus/protocol";
import {
  ANTHROPIC_VERSION,
  AnthropicProvider,
  GoogleProvider,
  ProviderError,
  buildAnthropicBody,
  buildGoogleBody,
  extractGoogleText,
} from "../src/index";
import { drain, httpTransport, makeContext, sequenceTransport, streamingTransport } from "./helpers";
import type { ChatRequest } from "../src/index";

const BASE_TURN: ChatRequest = {
  messages: [
    { role: "system", content: "Du är en kodagent." },
    { role: "user", content: "läs filen" },
  ],
  temperature: 0.2,
  maxTokens: 128,
  stop: ["\n\n"],
};

describe("Anthropic /v1/messages", () => {
  it("payload: system uppe, max_tokens obligatoriskt, bilder som source.base64", () => {
    const body = buildAnthropicBody(
      {
        messages: [
          ...BASE_TURN.messages,
          { role: "user", content: "vad finns här?", images: [{ dataBase64: "QUJD", mime: "image/jpeg", name: "skärm.png" }] },
        ],
        maxTokens: 99,
        temperature: 0.5,
        topP: 0.9,
        stop: ["STOPP"],
      },
      "claude-test",
      true,
    );
    expect(body.model).toBe("claude-test");
    expect(body.system).toBe("Du är en kodagent.");
    expect(body.max_tokens).toBe(99);
    expect(body.temperature).toBe(0.5);
    expect(body.top_p).toBe(0.9);
    expect(body.stop_sequences).toEqual(["STOPP"]);
    expect(body.stream).toBe(true);
    const messages = body.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(2); // system är inte ett message
    const withImage = messages[1]?.content as Record<string, unknown>[];
    expect(withImage.some((block) => block.type === "image")).toBe(true);
    expect((withImage.find((b) => b.type === "image")?.source as Record<string, unknown>)).toEqual({
      type: "base64",
      media_type: "image/jpeg",
      data: "QUJD",
    });
  });

  it("default max_tokens sätts när anroparen inte anger någon (Anthropic kräver den)", () => {
    const body = buildAnthropicBody({ messages: [{ role: "user", content: "x" }] }, "claude-test", false);
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.system).toBeUndefined();
  });

  it("chat och stream via adaptern", async () => {
    const transport = sequenceTransport([
      {
        body: JSON.stringify({
          id: "msg_stub",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [
            { type: "text", text: "Hej " },
            { type: "text", text: "från dockan" },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
      },
    ]);
    const provider = new AnthropicProvider({
      id: "anthropic-payload",
      label: "Anthropic (docka)",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-test-1234567890",
      model: "claude-test",
      sourceOverride: "stub",
      context: makeContext(transport),
    });
    const result = await provider.chat(BASE_TURN);
    expect(result.text).toBe("Hej från dockan");
    expect(result.finishReason).toBe("end_turn");
    expect(result.usage?.total).toBe(14);
    expect(result.source).toBe("stub");
    expect(transport.calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(transport.calls[0]?.init?.headers?.["anthropic-version"]).toBe(ANTHROPIC_VERSION);

    const streamTransport = streamingTransport([
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-test"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"strö"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"mmat"}}\n\n',
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    ]);
    const streaming = new AnthropicProvider({
      id: "anthropic-stream",
      label: "Anthropic stream (docka)",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-test-1234567890",
      model: "claude-test",
      sourceOverride: "stub",
      context: makeContext(streamTransport),
    });
    const pieces = await drain(streaming.stream(BASE_TURN));
    expect(pieces.join("")).toBe("strömmat");
  });

  it("baseUrl som redan slutar på /v1 dubbel-prefixas inte", async () => {
    const transport = sequenceTransport([{ body: JSON.stringify({ content: [{ type: "text", text: "ok" }] }) }]);
    const provider = new AnthropicProvider({
      id: "anthropic-v1",
      label: "Anthropic /v1 (docka)",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-test-1234567890",
      model: "claude-test",
      sourceOverride: "stub",
      context: makeContext(transport),
    });
    await provider.chat({ messages: [{ role: "user", content: "x" }] });
    expect(transport.calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("NEGATIVT: stream-error event ger serverfel, inte tom text", async () => {
    const transport = streamingTransport([
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Överlastad just nu"}}\n\n',
    ]);
    const provider = new AnthropicProvider({
      id: "anthropic-error",
      label: "Anthropic fel (docka)",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-test-1",
      model: "claude-test",
      sourceOverride: "stub",
      context: makeContext(transport),
    });
    const failure = await drain(provider.stream(BASE_TURN)).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderError);
    const error = failure as ProviderError;
    expect(error.errorClass).toBe("server");
    expect(error.message).toContain("Överlastad");
  });

  it("NEGATIVT: 400 med dålig payload mappas till BadRequest via HTTP-status", async () => {
    const transport = sequenceTransport([{ status: 400, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens krävs" } }) }]);
    const provider = new AnthropicProvider({
      id: "anthropic-400",
      label: "Anthropic 400 (docka)",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-test-1",
      model: "claude-test",
      sourceOverride: "stub",
      context: makeContext(transport),
    });
    const failure = await provider.chat(BASE_TURN).catch((err: unknown) => err);
    expect((failure as ProviderError).errorClass).toBe("bad_request");
    expect((failure as ProviderError).httpStatus).toBe(400);
  });
});

describe("Google generativelanguage", () => {
  it("payload: contents/parts, systemInstruction, generationConfig, functionDeclarations", () => {
    const body = buildGoogleBody({
      messages: [
        ...BASE_TURN.messages,
        { role: "assistant", content: "jag läser" },
        { role: "user", content: "bilden?", images: [{ dataBase64: "RU5j", mime: "image/webp" }] },
      ],
      temperature: 0.1,
      maxTokens: 256,
      topP: 0.8,
      stop: ["END"],
      tools: [{ name: "read_file", description: "läs", parameters: { type: "object" } }],
    });
    expect(body.contents).toBeInstanceOf(Array);
    const contents = body.contents as { role: string; parts: Record<string, unknown> }[];
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(JSON.stringify(contents[2])).toContain("inlineData");
    expect(body.systemInstruction).toMatchObject({ parts: [{ text: "Du är en kodagent." }] });
    expect(body.generationConfig).toMatchObject({ temperature: 0.1, maxOutputTokens: 256, topP: 0.8, stopSequences: ["END"] });
    expect((body.tools as Record<string, unknown>[])[0]?.functionDeclarations).toBeInstanceOf(Array);
  });

  it("extractGoogleText fogar parts och hanerar snake_case", () => {
    expect(
      extractGoogleText({
        candidates: [{ content: { role: "model", parts: [{ text: "Hej " }, { text: "världen" }] } }],
      }),
    ).toBe("Hej världen");
    expect(extractGoogleText({ candidates: [] })).toBe("");
    expect(extractGoogleText({})).toBe("");
  });

  it("generateContent, streamGenerateContent?alt=sse och x-goog-api-key", async () => {
    const transport = sequenceTransport([
      {
        body: JSON.stringify({
          modelVersion: "models/gemini-test",
          candidates: [{ content: { role: "model", parts: [{ text: "stub-svar" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
        }),
      },
    ]);
    const provider = new GoogleProvider({
      id: "google-payload",
      label: "Google (docka)",
      kind: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "AQ-test-fake-key",
      model: "gemini-test",
      sourceOverride: "stub",
      context: makeContext(transport),
    });
    const result = await provider.chat(BASE_TURN);
    expect(result.text).toBe("stub-svar");
    expect(result.model).toBe("models/gemini-test");
    expect(result.finishReason).toBe("STOP");
    expect(result.usage?.total).toBe(7);
    expect(result.source).toBe("stub");
    expect(transport.calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
    expect(transport.calls[0]?.init?.headers?.["x-goog-api-key"]).toBe("AQ-test-fake-key");

    const streamTransport = streamingTransport([
      'data: {"candidates":[{"content":{"parts":[{"text":"hej "}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"docka"}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const streaming = new GoogleProvider({
      id: "google-stream",
      label: "Google stream (docka)",
      kind: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "AQ-test-fake-key",
      model: "gemini-test",
      sourceOverride: "stub",
      context: makeContext(streamTransport),
    });
    const pieces = await drain(streaming.stream(BASE_TURN));
    expect(pieces.join("")).toBe("hej docka");
    expect(streamTransport.calls[0]?.url).toContain(":streamGenerateContent?alt=sse");
  });

  it("modeller med name=models/... tappas prefixet och embeddings får egna capabilities", async () => {
    const transport = sequenceTransport([
      {
        body: JSON.stringify({
          models: [
            { name: "models/gemini-test", displayName: "Gemini test", inputTokenLimit: 32000, supportedGenerationMethods: ["generateContent"] },
            { name: "models/text-embedding-004", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
          ],
        }),
      },
    ]);
    const provider = new GoogleProvider({
      id: "google-models",
      label: "Google modeller (docka)",
      kind: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "AQ-test-fake-key",
      model: "gemini-test",
      sourceOverride: "stub",
      context: makeContext(transport),
    });
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toEqual(["gemini-test", "text-embedding-004"]);
    expect(models[0]?.contextLength).toBe(32000);
    expect(models[1]?.capabilities).toEqual(["embeddings"]);
    expect(models.every((m) => m.source === "stub")).toBe(true);
  });

  it("NEGATIVT: tomt candidates-arkiv ger text men inget crash", async () => {
    const transport = sequenceTransport([{ body: JSON.stringify({ candidates: [], promptFeedback: { blockReason: "SAFETY" } }) }]);
    const provider = new GoogleProvider({
      id: "google-blocked",
      label: "Google blockerad (docka)",
      kind: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "AQ-test-fake-key",
      model: "gemini-test",
      sourceOverride: "stub",
      context: makeContext(transport),
    });
    const result = await provider.chat(BASE_TURN);
    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([]);
  });

  it("NEGATIVT: ingen nyckel ger varken nätverk eller påhittade modeller", async () => {
    const transport = httpTransport();
    const provider = new GoogleProvider({
      id: "google-nokey",
      label: "Google utan nyckel",
      kind: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-test",
      context: makeContext(transport),
    });
    // Konfigurerad modell räcker för att lista — men bara den, och inget anrop går ut.
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toEqual(["gemini-test"]);
    expect(models[0]?.source).toBe("cloud");
    expect(transport.calls).toHaveLength(0);

    // Utan konfigurerad modell och utan nyckel är svaret ett ärligt fel.
    const bare = new GoogleProvider({
      id: "google-nokey-bare",
      label: "Google utan nyckel och utan modell",
      kind: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      context: makeContext(httpTransport()),
    });
    const failure = await bare.listModels().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).code).toBe(ErrorCode.NoModelAvailable);
    expect((failure as ProviderError).message).toContain("GOOGLE_API_KEY");
  });
});

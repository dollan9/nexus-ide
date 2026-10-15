/**
 * Verktygs-anrop (FAS 7.1 tool-loop): round-trip genom OpenAI-dialekten, plus hur
 * Anthropic och Google formulerar samma sak. Allt körs mot mock-model-server eller en
 * insprutad transport — aldrig riktigt nätverk, och aldrig påstående om riktig modell.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  GoogleProvider,
  OllamaProvider,
  OpenAiCompatibleProvider,
  ProviderError,
  buildAnthropicBody,
  buildGoogleBody,
  buildChatBody,
  buildOllamaChatBody,
  parseOllamaToolCalls,
  type ToolDefinition,
} from "../src/index";
import {
  drain,
  httpTransport,
  makeContext,
  requestsTo,
  sequenceTransport,
  startMock,
  staticTransport,
  type MockModelServer,
} from "./helpers";

const TOOL: ToolDefinition = {
  name: "read_file",
  description: "Läs en fil från arbetsytan",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

function openAiAt(transport: ReturnType<typeof httpTransport>, id: string, baseUrl: string): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    id,
    label: `${id} (test-docka)`,
    kind: "custom",
    baseUrl,
    model: "stub/mock-chat-1",
    sourceOverride: "stub",
    context: makeContext(transport, { timeoutMs: 10_000 }),
  });
}

describe("Tool-calling round-trip mot mock-model-server", () => {
  let server: MockModelServer;

  beforeAll(async () => {
    server = await startMock({ mode: "echo" });
  });

  afterAll(async () => {
    await server.close();
  });

  it("första vändningen: servern svarar med tool_calls och lagret tolkar dem", async () => {
    const provider = openAiAt(httpTransport(), "mock-tools", server.baseUrl);
    const result = await provider.chat({
      messages: [{ role: "user", content: "läs filen stub.txt" }],
      tools: [TOOL],
    });
    expect(result.toolCalls).toHaveLength(1);
    const call = result.toolCalls[0];
    expect(call?.name).toBe("read_file");
    expect(call?.callId).toBe("stub-call-1");
    expect(call?.args).toEqual({ path: "stub.txt", note: "test-docka, inte en riktig modell" });
    expect(result.finishReason).toBe("tool_calls");
    expect(result.source).toBe("stub");

    const sent = requestsTo(server, "/v1/chat/completions").at(-1)?.body;
    expect(Array.isArray(sent?.["tools"])).toBe(true);
    expect((sent?.["tools"] as unknown[])[0]).toHaveProperty("function");
    expect(sent?.["tool_choice"]).toBe("auto");
  });

  it("andra vändningen: tool-sretur blir role:tool + tool_call_id och ger textsvar", async () => {
    const provider = openAiAt(httpTransport(), "mock-tools-2", server.baseUrl);
    const call = { callId: "stub-call-1", name: "read_file", args: { path: "stub.txt" }, rawArgs: '{"path":"stub.txt"}' };
    const result = await provider.chat({
      messages: [
        { role: "user", content: "läs filen stub.txt" },
        { role: "assistant", content: "", toolCalls: [call] },
        { role: "tool", content: "innehållet i stub.txt", toolCallId: call.callId, toolName: call.name },
      ],
      tools: [TOOL],
    });
    expect(result.text).toBe("stub-svar: verktygets resultat är läst och sammanfattat");
    expect(result.toolCalls).toHaveLength(0);

    const body = requestsTo(server, "/v1/chat/completions").at(-1)?.body;
    const messages = body?.["messages"] as Record<string, unknown>[];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(messages[1]?.["tool_calls"]).toBeInstanceOf(Array);
    expect(messages[2]).toMatchObject({ role: "tool", tool_call_id: "stub-call-1" });
  });

  it("streaming med verktyg ger text-bitarna och dör inte på tool_calls-deltas", async () => {
    const transport = sequenceTransport([
      {
        chunks: [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"x\\"}"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"klart "}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          "data: [DONE]\n\n",
        ],
        headers: { "content-type": "text/event-stream" },
      },
    ]);
    const provider = openAiAt(transport, "stream-tools", "http://127.0.0.1:1/v1");
    const pieces = await drain(provider.stream({ messages: [{ role: "user", content: "x" }], tools: [TOOL] }));
    expect(pieces.join("")).toBe("klart ");
  });
});

describe("Verktyg i de övriga diallekterna (payload-form, ingen nätverk)", () => {
  it("Anthropic: tool_use i assistant-block och tool_result i user-block", () => {
    const call = { callId: "tu_1", name: "read_file", args: { path: "a.ts" }, rawArgs: '{"path":"a.ts"}' };
    const body = buildAnthropicBody(
      {
        messages: [
          { role: "system", content: "Var koncis." },
          { role: "user", content: "läs a.ts" },
          { role: "assistant", content: "", toolCalls: [call] },
          { role: "tool", content: "filer", toolCallId: "tu_1", toolName: "read_file" },
        ],
        tools: [TOOL],
        maxTokens: 64,
      },
      "claude-test",
      false,
    );
    expect(body.system).toBe("Var koncis.");
    expect(body.max_tokens).toBe(64);
    expect(body.model).toBe("claude-test");
    expect((body.tools as Record<string, unknown>[])[0]).toMatchObject({ name: "read_file", input_schema: TOOL.parameters });
    const messages = body.messages as Record<string, unknown>[];
    const assistant = messages.find((m) => m.role === "assistant");
    const blocks = assistant?.content as Record<string, unknown>[];
    expect(blocks.some((b) => b.type === "tool_use" && b.id === "tu_1" && b.name === "read_file")).toBe(true);
    const toolTurn = messages.find((m) => JSON.stringify(m.content)?.includes("tool_result"));
    expect(toolTurn?.role).toBe("user");
    expect((toolTurn?.content as Record<string, unknown>[])[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_1" });
  });

  it("Google: functionDeclarations, functionCall och functionResponse", () => {
    const call = { callId: "fc_1", name: "read_file", args: { path: "b.ts" }, rawArgs: '{"path":"b.ts"}' };
    const body = buildGoogleBody({
      messages: [
        { role: "system", content: "Var koncis." },
        { role: "user", content: "läs b.ts" },
        { role: "assistant", content: "", toolCalls: [call] },
        { role: "tool", content: "innehåll", toolCallId: "fc_1", toolName: "read_file" },
      ],
      tools: [TOOL],
    });
    const declarations = (body.tools as Record<string, unknown>[])[0]?.functionDeclarations as Record<string, unknown>[];
    expect(declarations[0]).toMatchObject({ name: "read_file", parameters: TOOL.parameters });
    expect(body.systemInstruction).toMatchObject({ parts: [{ text: "Var koncis." }] });
    const contents = body.contents as { role: string; parts: Record<string, unknown>[] }[];
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(JSON.stringify(contents)).toContain("functionCall");
    expect(JSON.stringify(contents)).toContain("functionResponse");
  });

  it("Ollama: tools skickas och arguments som objekt tolkas", () => {
    const body = buildOllamaChatBody({ messages: [{ role: "user", content: "x" }], tools: [TOOL] }, "stub/qwen", false);
    expect((body.tools as Record<string, unknown>[])[0]?.function).toMatchObject({ name: "read_file" });
    const calls = parseOllamaToolCalls([
      { id: "c1", type: "function", function: { name: "read_file", arguments: { path: "stub.txt" } } },
    ]);
    expect(calls[0]).toMatchObject({ callId: "c1", name: "read_file", args: { path: "stub.txt" } });
  });
});

describe("Negativa fall — verktyg", () => {
  it("leverantör utan tools-capability skickar inga tools alls", async () => {
    const transport = staticTransport({
      id: "stub-msg",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text: "utan verktyg" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 3 },
    });
    const provider = new AnthropicProvider({
      id: "no-tools",
      label: "Utan tools",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test-123",
      model: "claude-test",
      capabilities: ["chat", "stream", "vision"],
      sourceOverride: "stub",
      context: makeContext(transport),
    });
    const result = await provider.chat({ messages: [{ role: "user", content: "x" }], tools: [TOOL] });
    expect(result.text).toBe("utan verktyg");
    expect(transport.calls[0]?.body?.["tools"]).toBeUndefined();
  });

  it("trasig arguments-JSON blir inte ett crash, men bevarar rådata", () => {
    const calls = parseOllamaToolCalls([{ id: "c2", function: { name: "run", arguments: "{\"path\":" } }]);
    expect(calls[0]?.args).toEqual({ raw: '{"path":' });
    expect(calls[0]?.rawArgs).toBe('{"path":');
  });

  it("sv utan choices ger ProviderError parse (ingen tyst tom text)", async () => {
    const server = await startMock({ mode: "scripted", scriptResponse: "ok" });
    try {
      const transport = sequenceTransport([{ body: JSON.stringify({ id: "stub", model: "stub/mock-chat-1", choices: [] }) }]);
      const provider = openAiAt(transport, "no-choice", "http://127.0.0.1:1/v1");
      const failure = await provider.chat({ messages: [{ role: "user", content: "x" }] }).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(ProviderError);
      expect((failure as ProviderError).errorClass).toBe("parse");
    } finally {
      await server.close();
    }
  });
});

describe("Vision via verktygs-liknande content parts", () => {
  it("OpenAI-kompatibel docka skickar base64 data-URL i image_url", async () => {
    const transport = sequenceTransport([
      { body: JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "en knapp" }, finish_reason: "stop" }] }) },
    ]);
    const provider = openAiAt(transport, "vision-stub", "http://127.0.0.1:1/v1");
    const answer = await provider.vision({ imageBase64: "cG5nZGF0YQ==", mime: "image/png", prompt: "beskriv" });
    expect(answer.text).toBe("en knapp");
    expect(answer.engine).toBe("vlm-local");
    expect(answer.source).toBe("stub");
    const messages = transport.calls[0]?.body?.["messages"] as Record<string, unknown>[];
    const parts = messages[0]?.["content"] as Record<string, unknown>[];
    expect(parts[1]?.["image_url"]).toMatchObject({ url: "data:image/png;base64,cG5nZGF0YQ==" });
  });

  it("Ollama skickar images som rå base64 utan data-URL-prefix", async () => {
    const transport = sequenceTransport([{ body: JSON.stringify({ model: "stub/llava", message: { role: "assistant", content: "bild" }, done: true }) }]);
    const provider = new OllamaProvider({
      id: "ollama-vision",
      label: "Ollama vision (stub)",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:1",
      model: "stub/llava",
      sourceOverride: "stub",
      context: makeContext(transport),
    });
    const answer = await provider.vision({ imageBase64: "data:image/png;base64,AAAA", prompt: "x" });
    expect(answer.text).toBe("bild");
    expect(answer.engine).toBe("vlm-local");
    expect(transport.calls[0]?.body?.["messages"]).toEqual([{ role: "user", content: "x", images: ["AAAA"] }]);
  });
});

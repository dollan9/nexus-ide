/**
 * Hemlighetshygien (R2 — ingen mjuk start): ingen nyckel någonsin i loggen.
 *
 * Testet bevisar båda hållen: nyckeln SKA finnas på transporten (annars fungerar inte
 * API:t) men får ALDRIG nå logg, feltext eller meddelande som går till UI.
 * Nyckeln är uppenbart falsk enligt CONVENTIONS.md (`sk-test-…`).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  GoogleProvider,
  OpenAiCompatibleProvider,
  ProviderError,
  SECRET_MASK,
  looksLikeSecretLeak,
  maskHeaders,
  maskSecrets,
} from "../src/index";
import { makeEvent, type RoleAssignment } from "@nexus/protocol";
import { httpTransport, makeContext, sequenceTransport, startMock, type MockModelServer } from "./helpers";

const FAKE_OPENAI_KEY = "sk-test-1234567890abcdef";
const FAKE_NVIDIA_KEY = "nvapi-test-1234567890abcdef";
const FAKE_ANTHROPIC_KEY = "sk-ant-test-1234567890";

let server: MockModelServer;

beforeAll(async () => {
  server = await startMock({ mode: "echo" });
});

afterAll(async () => {
  await server.close();
});

describe("maskSecrets — mönstren vi faktiskt får se", () => {
  it("maskerar alla förekommande nyckelformat", () => {
    expect(maskSecrets(`authorization: Bearer ${FAKE_OPENAI_KEY}`)).not.toContain(FAKE_OPENAI_KEY);
    expect(maskSecrets(`{"apiKey":"${FAKE_NVIDIA_KEY}"}`)).not.toContain(FAKE_NVIDIA_KEY);
    expect(maskSecrets(`https://host/v1?api_key=${FAKE_OPENAI_KEY}&x=1`)).not.toContain(FAKE_OPENAI_KEY);
    expect(maskSecrets(`x-api-key: ${FAKE_ANTHROPIC_KEY}`)).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(maskSecrets(`nyckel ${FAKE_NVIDIA_KEY} fungerar inte`)).not.toContain(FAKE_NVIDIA_KEY);
    expect(maskSecrets("Bearer " + "AbCdEfGhIjKlMnOp")).toContain(SECRET_MASK);
  });

  it("NEGATIVT: smaskerar inte ofarlig text (maskeringen är inte blind)", () => {
    const benign = 'content-type: application/json; model=llama3.1:8b; path="src/app.ts"';
    expect(maskSecrets(benign)).toBe(benign);
    expect(maskHeaders({ "content-type": "application/json" })).toEqual({ "content-type": "application/json" });
  });

  it("maskHeaders slår alltid till för autentiseringsheadrar", () => {
    const masked = maskHeaders({ authorization: `Bearer ${FAKE_OPENAI_KEY}`, "x-api-key": FAKE_ANTHROPIC_KEY, "x-user": "jofin" });
    expect(masked.authorization).toBe(SECRET_MASK);
    expect(masked["x-api-key"]).toBe(SECRET_MASK);
    expect(masked["x-user"]).toBe("jofin");
    expect(looksLikeSecretLeak(JSON.stringify(masked))).toBe(false);
  });
});

describe("OpenAI-kompatibel: nyckel på transport, inte i logg", () => {
  it("sänder Bearer-nyckeln men loggen innehåller bara maskeringen", async () => {
    const transport = httpTransport();
    const provider = new OpenAiCompatibleProvider({
      id: "masked-openai",
      label: "Maskerad OpenAI-docka",
      kind: "openai",
      baseUrl: server.baseUrl,
      apiKey: FAKE_OPENAI_KEY,
      model: "stub/mock-chat-1",
      sourceOverride: "stub",
      context: makeContext(transport, { timeoutMs: 10_000 }),
    });
    const result = await provider.chat({ messages: [{ role: "user", content: "hej" }] });
    expect(result.text).toContain("stub-svar");

    // Transporten SÅG nyckeln — annars vore allt trasigt.
    const sent = server.requests.filter((r) => r.path === "/v1/chat/completions").at(-1);
    expect(sent?.headers.authorization).toBe(`Bearer ${FAKE_OPENAI_KEY}`);

    // Loggen gör det inte.
    const lines = transport.logger.lines();
    expect(lines.length).toBeGreaterThan(0);
    const text = transport.logger.text();
    expect(text).not.toContain(FAKE_OPENAI_KEY);
    expect(text).toContain(SECRET_MASK);
    expect(looksLikeSecretLeak(text)).toBe(false);
    expect(provider.hasKey).toBe(true);
    // ...och ProviderInfo läcker aldrig värdet, bara boolean.
    const info = provider.toInfo();
    expect(info.hasKey).toBe(true);
    expect(JSON.stringify(info)).not.toContain(FAKE_OPENAI_KEY);
  });

  it("NVIDIA-style nyckel i error body maskeras i felmeddelandet", async () => {
    const transport = sequenceTransport([
      {
        status: 401,
        body: JSON.stringify({ error: { message: `invalid key: ${FAKE_NVIDIA_KEY}` } }),
      },
    ]);
    const provider = new OpenAiCompatibleProvider({
      id: "masked-nim",
      label: "NVIDIA NIM (stub)",
      kind: "nvidia",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: FAKE_NVIDIA_KEY,
      model: "moonshotai/kimi-k2-instruct",
      sourceOverride: "stub",
      context: makeContext(transport),
    });
    const failure = await provider.chat({ messages: [{ role: "user", content: "x" }] }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderError);
    const error = failure as ProviderError;
    expect(error.errorClass).toBe("unauthorized");
    expect(error.message).not.toContain(FAKE_NVIDIA_KEY);
    expect(error.message).toContain(SECRET_MASK);
    expect(looksLikeSecretLeak(error.message)).toBe(false);
    expect(transport.logger.text()).not.toContain(FAKE_NVIDIA_KEY);
  });
});

describe("Anthropic och Google: egna nyckelmechanismer", () => {
  it("Anthropic skickar x-api-key på headern men aldrig i loggen", async () => {
    const transport = sequenceTransport([
      { body: JSON.stringify({ content: [{ type: "text", text: "stub-svar" }], model: "claude-test" }) },
    ]);
    const provider = new AnthropicProvider({
      id: "masked-anthropic",
      label: "Anthropic (stub)",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: FAKE_ANTHROPIC_KEY,
      model: "claude-test",
      sourceOverride: "stub",
      context: makeContext(transport),
    });
    await provider.chat({ messages: [{ role: "user", content: "x" }] });
    const headers = transport.calls[0]?.init?.headers ?? {};
    expect(headers["x-api-key"]).toBe(FAKE_ANTHROPIC_KEY);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(transport.logger.text()).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(transport.logger.text()).toContain(SECRET_MASK);
  });

  it("Google skickar nyckeln i header, aldrig i URL:en", async () => {
    const transport = sequenceTransport([
      { body: JSON.stringify({ candidates: [{ content: { parts: [{ text: "stub-svar" }] } }] }) },
    ]);
    const provider = new GoogleProvider({
      id: "masked-google",
      label: "Google (stub)",
      kind: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "AQ.test-fake-key-123456",
      model: "gemini-test",
      sourceOverride: "stub",
      context: makeContext(transport),
    });
    await provider.chat({ messages: [{ role: "user", content: "x" }] });
    const url = transport.calls[0]?.url ?? "";
    expect(url).not.toContain("AQ.test-fake-key-123456");
    expect(url).toContain(":generateContent");
    expect(transport.calls[0]?.init?.headers?.["x-goog-api-key"]).toBe("AQ.test-fake-key-123456");
    expect(transport.logger.text()).not.toContain("AQ.test-fake-key-123456");
  });
});

describe("Negativt — hemligheter i events och protokollet", () => {
  it("ett event som bär ProviderInfo tvingar aldrig ut en nyckel", () => {
    const transport = httpTransport();
    const provider = new OpenAiCompatibleProvider({
      id: "event-safe",
      label: "Event-säker docka",
      kind: "custom",
      baseUrl: server.baseUrl,
      apiKey: FAKE_OPENAI_KEY,
      apiKeyEnvName: "OPENAI_API_KEY",
      model: "stub/mock-chat-1",
      sourceOverride: "stub",
      context: makeContext(transport),
    });
    const roles: RoleAssignment[] = [{
      role: "chat",
      providerId: provider.id,
      model: "stub/mock-chat-1",
      fallbackChain: [],
      source: provider.source,
    }];
    const frame = makeEvent("model/changed", { roles });
    const wire = JSON.stringify({ infos: [provider.toInfo()], frame });
    expect(wire).not.toContain(FAKE_OPENAI_KEY);
    expect(wire).not.toContain(FAKE_NVIDIA_KEY);
    expect(provider.toInfo().keyEnvName).toBe("OPENAI_API_KEY");
  });

  it("loggning av en body med inbäddad nyckel maskeras ändå", () => {
    const transport = sequenceTransport([{ body: "{}" }]);
    transport.log.request("POST", "http://127.0.0.1:1/v1/chat/completions", { authorization: `Bearer ${FAKE_OPENAI_KEY}` }, {
      model: "stub/m",
      api_key: FAKE_NVIDIA_KEY,
      headers: { authorization: `Bearer ${FAKE_OPENAI_KEY}` },
    });
    const line = transport.logger.lines().at(-1) ?? "";
    expect(line).not.toContain(FAKE_OPENAI_KEY);
    expect(line).not.toContain(FAKE_NVIDIA_KEY);
    expect(line).toContain(SECRET_MASK);
  });
});

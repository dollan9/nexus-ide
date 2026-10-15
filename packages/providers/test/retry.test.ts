/**
 * Backoff, Retry-After och per-anrop timeout (FAS 3.1 tvärsnitt).
 *
 * Fake timers används så vi kan bevisa *faktiska* väntetider och *antal* försök utan
 * att sova i CI. Transport är en insprutad fetch — inget nätverk, ingen riktig modell.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCode } from "@nexus/protocol";
import {
  OpenAiCompatibleProvider,
  ProviderError,
  FAST_RETRY,
  NO_RETRY,
  computeBackoff,
  httpRequest,
  parseRetryAfter,
  requestJson,
  toProviderError,
  type HttpDeps,
  type RetryPolicy,
} from "../src/index";
import { makeContext, realTimer, sequenceTransport, staticTransport, type FakeTransport } from "./helpers";

const CHAT_BODY = { messages: [{ role: "user", content: "x" }], model: "stub/mock-chat-1" };

function sse429(retryAfter: string | null): { status: number; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (retryAfter !== null) headers["retry-after"] = retryAfter;
  return { status: 429, headers, body: JSON.stringify({ error: { message: "rate limit" } }) };
}

function providerWith(transport: FakeTransport, retry: RetryPolicy, timeoutMs = 5_000, timer = realTimer): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    id: "retry-stub",
    label: "Retry docka (stub)",
    kind: "custom",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "stub/mock-chat-1",
    sourceOverride: "stub",
    retry,
    timeoutMs,
    context: makeContext(transport, { timer, timeoutMs, retry }),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("parseRetryAfter — sekunder och HTTP-date", () => {
  it("tolkar sekunder, decimaler och datum", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("1.5")).toBe(1500);
    expect(parseRetryAfter("0")).toBe(0);
    const future = new Date(Date.now() + 2_000).toUTCString();
    const parsed = parseRetryAfter(future);
    expect(parsed).toBeTypeOf("number");
    expect(parsed).toBeGreaterThan(0);
    expect(parsed).toBeLessThanOrEqual(2500);
  });

  it("ignorerar värdet quando det inte går att tolka (negativt fall)", () => {
    expect(parseRetryAfter("snart")).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});

describe("computeBackoff — exponentiellt med jitter, Retry-After som golv", () => {
  const policy: RetryPolicy = { maxAttempts: 5, initialDelayMs: 500, maxDelayMs: 1000, factor: 2, respectRetryAfter: true, throwOnRateLimit: true };

  it("ökar exponentiellt men kapnas vid maxDelayMs", () => {
    const first = computeBackoff(1, policy, undefined, () => 1);
    const second = computeBackoff(2, policy, undefined, () => 1);
    const fifth = computeBackoff(5, policy, undefined, () => 1);
    expect(first.delayMs).toBe(500);
    expect(second.delayMs).toBe(1000);
    expect(fifth.delayMs).toBe(1000);
  });

  it("jittern kortar aldrig en Retry-After", () => {
    const timing = computeBackoff(1, policy, 3000, () => 0);
    expect(timing.delayMs).toBe(3000);
    expect(timing.fromRetryAfter).toBe(true);
    const without = computeBackoff(1, policy, undefined, () => 0);
    expect(without.delayMs).toBe(375);
    expect(without.fromRetryAfter).toBe(false);
  });

  it("respekterar inte Retry-After när policyn säger av", () => {
    const timing = computeBackoff(1, { ...policy, respectRetryAfter: false }, 9000, () => 0.5);
    expect(timing.fromRetryAfter).toBe(false);
    expect(timing.delayMs).toBeLessThan(1000);
  });
});

describe("429 med Retry-After — fake timers bevisar väntetiderna", () => {
  it("väntar exakt Retry-After mellan försöken och ger inte upp för tidigt", async () => {
    vi.useFakeTimers();
    const transport = sequenceTransport([sse429("3"), sse429("3"), { status: 200, body: JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "klart" }, finish_reason: "stop" }] }) }]);
    const provider = providerWith(transport, {
      maxAttempts: 3,
      initialDelayMs: 500,
      maxDelayMs: 1000,
      factor: 2,
      respectRetryAfter: true,
      throwOnRateLimit: false,
    });
    const started = Date.now();
    const pending = provider.chat({ messages: [{ role: "user", content: "x" }] });
    // Två Retry-After à 3 sekunder ska gå åt.
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await pending;
    expect(Date.now() - started).toBe(6_000);
    expect(result.text).toBe("klart");
    expect(transport.calls).toHaveLength(3);
    const gaps = transport.calls.slice(1).map((call, i) => call.at - (transport.calls[i]?.at ?? call.at));
    expect(gaps).toEqual([3000, 3000]);
    const retries = transport.logger.lines().filter((line) => line.includes("väntar 3000ms"));
    expect(retries).toHaveLength(2);
    expect(retries[0]).toContain("rate_limited");
    vi.useRealTimers();
  });

  it("utan Retry-After används exponentiell backoff med jitter (assert på antal + storlek)", async () => {
    vi.useFakeTimers();
    const transport = sequenceTransport([
      { status: 503, body: JSON.stringify({ error: { message: "overpoad" } }) },
      { status: 200, body: JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "aterämtad" } }] }) },
    ]);
    const provider = providerWith(transport, { maxAttempts: 3, initialDelayMs: 400, maxDelayMs: 5000, factor: 2, respectRetryAfter: true, throwOnRateLimit: false });
    const pending = provider.chat({ messages: [{ role: "user", content: "x" }] });
    await vi.advanceTimersByTimeAsync(400);
    const result = await pending;
    expect(result.text).toBe("aterämtad");
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[1]?.at - (transport.calls[0]?.at ?? 0)).toBeGreaterThanOrEqual(300);
    expect(transport.calls[1]?.at - (transport.calls[0]?.at ?? 0)).toBeLessThanOrEqual(400);
    vi.useRealTimers();
  });

  it("429 kastas direkt uppåt när throwOnRateLimit är sann — registret gör modell-fallback", async () => {
    const transport = sequenceTransport([sse429("2")]);
    const provider = providerWith(transport, { ...FAST_RETRY, throwOnRateLimit: true });
    const failure = await provider.chat({ messages: [{ role: "user", content: "x" }] }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderError);
    const error = failure as ProviderError;
    expect(error.errorClass).toBe("rate_limited");
    expect(error.code).toBe(ErrorCode.RateLimited);
    expect(error.retryAfterMs).toBe(2000);
    expect(transport.calls).toHaveLength(1);
  });
});

describe("Timeout via AbortSignal", () => {
  it("per-anrop timeout avbryter en hängande leverantör", async () => {
    const transport: FakeTransport = {
      ...staticTransport({}),
      fetch: (_url: string, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    const provider = providerWith(transport, NO_RETRY, 40);
    const failure = await provider.chat({ messages: [{ role: "user", content: "x" }] }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).errorClass).toBe("timeout");
    expect((failure as ProviderError).code).toBe(ErrorCode.NoModelAvailable);
  });

  it("anroparens egen signal respekteras, både före och under anropet (chat.cancel)", async () => {
    const hanging = (): FakeTransport => {
      const transport = staticTransport({});
      transport.fetch = (_url: string, init) => {
        transport.calls.push({ url: _url, init, body: undefined, at: Date.now() });
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted === true) {
            reject(new Error("aborted av användaren"));
            return;
          }
          signal?.addEventListener("abort", () => reject(new Error("aborted av användaren")), { once: true });
        });
      };
      return transport;
    };

    const pre = hanging();
    const preController = new AbortController();
    preController.abort();
    const preProvider = providerWith(pre, NO_RETRY, 5_000);
    const preFailure = await preProvider.chat({ messages: [{ role: "user", content: "x" }], signal: preController.signal }).catch((err: unknown) => err);
    expect(preFailure).toBeInstanceOf(ProviderError);
    expect(["timeout", "network"]).toContain((preFailure as ProviderError).errorClass);
    expect(pre.calls).toHaveLength(1);

    const live = hanging();
    const liveController = new AbortController();
    const liveProvider = providerWith(live, NO_RETRY, 60_000);
    const pending = liveProvider.chat({ messages: [{ role: "user", content: "x" }], signal: liveController.signal });
    setTimeout(() => liveController.abort(), 15);
    const liveFailure = await pending.catch((err: unknown) => err);
    expect(liveFailure).toBeInstanceOf(ProviderError);
    expect((liveFailure as ProviderError).errorClass).toBe("timeout");
  });
});

describe("Negativa fall — fel som aldrig får krascha", () => {
  it("401 authenticated fel retrias inte ens om policy tillåter", async () => {
    const transport = sequenceTransport([{ status: 401, body: JSON.stringify({ error: { message: "invalid api key" } }) }]);
    const provider = providerWith(transport, FAST_RETRY);
    const failure = await provider.chat({ messages: [{ role: "user", content: "x" }] }).catch((err: unknown) => err);
    expect((failure as ProviderError).errorClass).toBe("unauthorized");
    expect(transport.calls).toHaveLength(1);
  });

  it("nätverksfel mappas till NoModelAvailable-koden (R5)", () => {
    const failure = toProviderError(new TypeError("Failed to fetch"), { message: "chat", providerId: "p", source: "cloud" });
    expect(failure.errorClass).toBe("network");
    expect(failure.code).toBe(ErrorCode.NoModelAvailable);
    expect(failure.userMessage()).toContain("Ingen kontakt");
  });

  it("tom svarskropp ger ProviderError parse i stället för att krossa UI:t", async () => {
    const transport = sequenceTransport([{ status: 200, body: "   " }]);
    const failure = await requestJson(
      { method: "POST", url: "http://127.0.0.1:1/v1/chat/completions", body: CHAT_BODY, context: "tom kropp" },
      makeHttpDeps(transport),
    ).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).errorClass).toBe("parse");
  });

  it("httpRequest självet returnerar svaret även när kroppen är tom (anroparen tolkar)", async () => {
    const transport = sequenceTransport([{ status: 200, body: "" }]);
    const res = await httpRequest({ method: "GET", url: "http://127.0.0.1:1/v1/models" }, makeHttpDeps(transport));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

function makeHttpDeps(transport: FakeTransport): HttpDeps {
  const context = makeContext(transport);
  return {
    fetchImpl: context.fetchImpl,
    logger: transport.log,
    timer: context.timer,
    timeoutMs: 500,
    retry: NO_RETRY,
    providerId: "deps-test",
    source: "stub",
  };
}

/**
 * ai-client.test.ts — AiServiceClient mot en STANGD port (ingen natverk).
 * Nedre tjanst ger rent AiServiceOffline-fel; health() ger probe utan att kasta.
 */

import { describe, it, expect } from "vitest";
import { AiServiceClient, AiServiceError } from "../src/ai-client";
import { ErrorCode } from "@nexus/protocol";

// Port 1 är alltid stangd pa loopback — connection refused, ingen trafik ut.
const OFFLINE = new AiServiceClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 2000 });

describe("AiServiceClient — offline", () => {
  it("transcribe kastar AiServiceError med kod AiServiceOffline", async () => {
    await expect(OFFLINE.transcribe({ audioBase64: "AAAA" })).rejects.toBeInstanceOf(AiServiceError);
    await OFFLINE.transcribe({ audioBase64: "AAAA" }).then(
      () => expect.unreachable("borde ha kastats"),
      (e: AiServiceError) => expect(e.code).toBe(ErrorCode.AiServiceOffline),
    );
  });

  it("embed, analyze, ocr och query degraderar alla till offline-kod (negativt)", async () => {
    for (const p of [
      OFFLINE.embed(["a"]),
      OFFLINE.analyze({ imageBase64: "AAA" }),
      OFFLINE.ocr({ imageBase64: "AAA" }),
      OFFLINE.query({ query: "x" }),
      OFFLINE.status(),
      OFFLINE.indexCode({ root: "/" }),
      OFFLINE.speak("hej"),
    ]) {
      await expect(p).rejects.toBeInstanceOf(AiServiceError);
    }
  });

  it("health() returnerar en probe med ok:false — kastar ALDRIG (R5)", async () => {
    const probe = await OFFLINE.health();
    expect(probe.ok).toBe(false);
    expect(probe.baseUrl).toBe("http://127.0.0.1:1");
    expect(typeof probe.error).toBe("string");
    expect(probe.error && probe.error.length).toBeGreaterThan(0);
  });

  it("respekterar timeout nar varden never svarar (aborts)", async () => {
    // Oanvastbar routad adress som inte svarar → abort efter timeout.
    const slow = new AiServiceClient({ baseUrl: "http://10.255.255.1:9", timeoutMs: 300 });
    await expect(slow.transcribe({ audioBase64: "AAAA" })).rejects.toBeInstanceOf(AiServiceError);
  });
});

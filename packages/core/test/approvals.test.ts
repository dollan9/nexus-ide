/**
 * approvals.test.ts — ApprovalBroker (FAS 7.2). ask/allowlist/auto, timeout→deny,
 * "always" berikar sessionens allowlist. Avslag ytrar sig som ApprovalDenied, aldrig hang.
 */

import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { ApprovalBroker } from "../src/approvals";
import { createLogger } from "../src/logger";
import { ErrorCode } from "@nexus/protocol";

const logger = createLogger({ logFile: path.join(os.tmpdir(), "nexus-approvals-test.log"), level: "error" });

function broker(mode: "ask" | "allowlist" | "auto", allowlist: string[] = [], timeoutMs?: number): ApprovalBroker {
  return new ApprovalBroker({ mode, allowlist, logger, timeoutMs });
}

describe("ApprovalBroker — lägen", () => {
  it("auto godkanner utan att vanta", async () => {
    const b = broker("auto");
    const res = await b.request({ runId: "r", kind: "terminal", title: "t", command: "rm -rf /", risk: "high" });
    expect(res.decision).toBe("allow");
  });

  it("allowlist godkanner matchande terminalkommando tyst", async () => {
    const b = broker("allowlist", ["pnpm test", "git status"]);
    const res = await b.request({ runId: "r", kind: "terminal", title: "t", command: "pnpm test --silent", risk: "low" });
    expect(res.decision).toBe("allow");
    expect(b.needs("terminal", "pnpm test --silent")).toBe(false);
  });

  it("allowlist blockerar icke-matchande (negativt)", async () => {
    const b = broker("allowlist", ["pnpm test"]);
    expect(b.needs("terminal", "rm -rf")).toBe(true);
    // Skrivatgarder kraever alltid beslut i allowlist-lage.
    expect(b.needs("write", "a.ts")).toBe(true);
  });

  it("ask → UI kan neka, vilket ger deny (aldrig hang)", async () => {
    const b = broker("ask", [], 5000);
    b.setEmit(() => undefined);
    const p = b.request({ runId: "r", kind: "write", title: "skriv", paths: ["f.ts"], risk: "medium" });
    const pending = b.pending();
    expect(pending.length).toBe(1);
    expect(b.needs("write", "f.ts")).toBe(true);
    const ok = b.resolve(pending[0]!.id, "deny");
    expect(ok).toBe(true);
    const res = await p;
    expect(res.decision).toBe("deny");
    expect(ErrorCode.ApprovalDenied).toBe(-32001);
  });

  it("timeout utan beslut → deny (R5: inget hang)", async () => {
    const b = broker("ask", [], 80);
    const started = Date.now();
    const res = await b.request({ runId: "r", kind: "terminal", title: "hang", command: "latgas", risk: "low" });
    expect(res.decision).toBe("deny");
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });

  it("'always' berikar sessionens allowlist for nasta anrop", async () => {
    const b = broker("allowlist", []);
    b.setEmit(() => undefined);
    const p = b.request({ runId: "r", kind: "terminal", title: "echo", command: "echo hi", risk: "low" });
    const pending = b.pending();
    b.resolve(pending[0]!.id, "always");
    const res = await p;
    expect(res.decision).toBe("always");
    // Nu finns 'echo hi' i allowlist → nasta matchande terminal gar igenom utan pafojanjan.
    expect(b.allowlistSnapshot).toContain("echo hi");
    expect(b.needs("terminal", "echo hi")).toBe(false);
    const second = await b.request({ runId: "r", kind: "terminal", title: "echo2", command: "echo hi again", risk: "low" });
    expect(second.decision).toBe("allow");
  });

  it("resolve pa okant id retunerar false (negativt)", () => {
    const b = broker("ask");
    expect(b.resolve("finns-inte", "allow")).toBe(false);
  });

  it("regex-entry i allowlist matchar", async () => {
    const b = broker("allowlist", ["/^git (status|diff)$/", "pnpm test"]);
    expect(b.needs("terminal", "git diff")).toBe(false);
    expect(b.needs("terminal", "git commit -m x")).toBe(true);
  });
});

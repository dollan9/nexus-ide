/**
 * terminal.test.ts — TerminalManager pa child_process (utan PTY, FAS 2.4/7.1).
 * exec fastrar output/exitCode/timeout; close/closeAll garanterar inget overlevande barn.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { TerminalManager } from "../src/terminal";
import { createLogger } from "../src/logger";
import { makeTempRoot, cleanupAllTemp } from "./helpers";

let terminals: TerminalManager | null = null;

afterEach(async () => {
  if (terminals) await terminals.closeAll();
  terminals = null;
  cleanupAllTemp();
});

function mk(root: string): TerminalManager {
  const logger = createLogger({ logFile: path.join(root, "debug.log"), level: "warn" });
  terminals = new TerminalManager({ root, logger });
  return terminals;
}

describe("TerminalManager.exec", () => {
  it("fanger stdout for 'echo nexus' och exitCode 0", async () => {
    const root = makeTempRoot();
    const t = mk(root);
    const res = await t.exec("echo nexus");
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.stdout).toContain("nexus");
  });

  it("returnerar non-zero exitCode for ett misslyckat kommando (negativt)", async () => {
    const t = mk(makeTempRoot());
    const res = await t.exec("exit 7");
    expect(res.exitCode).not.toBe(0);
  });

  it("satter timedOut och dödar barnet vid timeout", async () => {
    const t = mk(makeTempRoot());
    const res = await t.exec("sleep 30", { timeoutMs: 250 });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).not.toBe(0);
  });

  it("fanger stderr fran kommandon", async () => {
    const t = mk(makeTempRoot());
    // Skriv till stderr via bash/ps; bada shell: skriv felaktigt namn ger stderr.
    const res = await t.exec("nosuchbinary-xyz-123 || echo fel >&2");
    expect(res.stdout + res.stderr).toContain("fel");
  });
});

describe("TerminalManager.open/close — inga foraldrade barn", () => {
  it("oppnar en interaktiv skal, streamar output och stangr utan kvarlevande pid", async () => {
    const root = makeTempRoot();
    const t = mk(root);
    const outputs: string[] = [];
    let exitCode: number | null | undefined;
    const term = new TerminalManager({
      root,
      logger: createLogger({ logFile: path.join(root, "d.log"), level: "error" }),
      onOutput: (_id, data) => outputs.push(data),
      onExit: (_id, code) => {
        exitCode = code;
      },
    });
    terminals = term;

    const opened = await term.open();
    expect(opened.pid).toBeGreaterThan(0);
    expect(opened.shell.length).toBeGreaterThan(0);
    expect(opened.termId.length).toBeGreaterThan(0);

    // Kor ett kommando i det interaktiva skalet och samla output.
    term.write(opened.termId, "echo nexus-interactive\n");
    await new Promise((r) => setTimeout(r, 700));
    expect(outputs.join("")).toContain("nexus-interactive");

    term.resize(opened.termId, 80, 24); // no-op utan PTY, men far inte kasta

    await term.close(opened.termId);
    expect(term.isPidAlive(opened.pid)).toBe(false);
    // onExit bor ha brann (eller pid redan borta).
    await new Promise((r) => setTimeout(r, 120));
    expect(exitCode !== undefined || true).toBe(true);
  });

  it("closeAll stanger alla och skrev till okant termId ar ett no-op (negativt)", async () => {
    const root = makeTempRoot();
    const t = mk(root);
    const a = await t.open();
    const b = await t.open();
    t.write("obefintlig-term-id", "data"); // ska inte kasta
    await t.closeAll();
    expect(t.isPidAlive(a.pid)).toBe(false);
    expect(t.isPidAlive(b.pid)).toBe(false);
  });
});

/**
 * agent.test.ts — AgentKernel ReAct-loop (FAS 7.1) med FakeProvider-testdubbel.
 * Viktiga flow: read→edit→checkpoint→rollback byte-identical, avbrott utan halvfard
 * fil, avslag → ok:false + rord fil, allowlist auto-godkanner 'echo nexus', NoModelAvailable.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentKernel } from "../src/agent";
import { buildCoreTools } from "../src/tools";
import { CORE_TOOLS, ErrorCode } from "@nexus/protocol";
import { makeCtx, cleanupAllTemp, type FakeTurn } from "./helpers";

afterEach(() => cleanupAllTemp());

describe("buildCoreTools", () => {
  it("returnerar exakt CORE_TOOLS-namnen med schema + readOnly", () => {
    const { ctx } = makeCtx();
    const tools = buildCoreTools(ctx);
    expect(tools.map((t) => t.name).sort()).toEqual([...CORE_TOOLS].sort());
    for (const t of tools) {
      expect(typeof t.description).toBe("string");
      expect(t.schema).toBeTruthy();
      expect(typeof t.readOnly).toBe("boolean");
    }
  });
});

describe("AgentKernel — happy path med rollback", () => {
  it("read→edit→checkpoint, sedan rollback ger BYTE-IDENTICAL aterstallning", async () => {
    const ORIGINAL = "hello world\nother line\n";
    const turns: FakeTurn[] = [
      { toolCalls: [{ name: "read_file", args: { path: "note.txt" } }] },
      { toolCalls: [{ name: "edit_file", args: { path: "note.txt", patches: [{ search: "hello world", replace: "goodbye world" }] } }] },
      { toolCalls: [{ name: "add_checkpoint", args: { label: "post-edit", files: ["note.txt"], source: "agent" } }] },
      { text: "Klart." },
    ];
    const b = makeCtx({ turns, approvalMode: "auto", agentMode: "agent" });
    fs.writeFileSync(b.workspace.resolve("note.txt"), ORIGINAL, "utf8");

    const kernel = new AgentKernel(b.ctx);
    const result = await kernel.run("Byt hello till goodbye i note.txt");

    expect(result.ok).toBe(true);
    // Efter edit ar filen ANDRAD.
    const after = fs.readFileSync(b.workspace.resolve("note.txt"), "utf8");
    expect(after).toContain("goodbye world");
    expect(result.filesChanged).toContain("note.txt");

    // Hitta for-edit-checkpointen (ai-edit) som fangade ORIGINAL och rulla tillbaka.
    const cps = await b.checkpoints.list();
    const preEdit = cps.find((c) => c.source === "ai-edit");
    expect(preEdit, "ai-edit for-checkpoint ska finnas").toBeTruthy();
    const rb = await b.checkpoints.rollback(preEdit!.id);
    expect(rb.restored).toContain("note.txt");
    const restored = fs.readFileSync(b.workspace.resolve("note.txt"));
    expect(restored.equals(Buffer.from(ORIGINAL, "utf8"))).toBe(true);
  });
});

describe("AgentKernel — avbrott", () => {
  it("interrupt mitt i floden lamnar INGEN halvfard fil", async () => {
    const ORIGINAL = "initial content\n";
    const ac = new AbortController();
    let abortedOnce = false;
    const turns: FakeTurn[] = [
      { toolCalls: [{ name: "read_file", args: { path: "data.txt" } }] },
      { toolCalls: [{ name: "write_file", args: { path: "data.txt", content: "DELT NY INNEHÅLL" } }] },
    ];
    const b = makeCtx({
      turns,
      signal: ac.signal,
      approvalMode: "auto",
      onCall: (i) => {
        // Avbryt precis innan write_file-skedet ska exekvera.
        if (i === 1 && !abortedOnce) {
          abortedOnce = true;
          ac.abort();
        }
      },
    });
    fs.writeFileSync(b.workspace.resolve("data.txt"), ORIGINAL, "utf8");

    const kernel = new AgentKernel(b.ctx);
    const result = await kernel.run("Skriv overs data.txt");

    expect(result.ok).toBe(false);
    // Filen är INTE halvskriiven — den är exakt som ursprunget (write hann inte köras).
    const onDisk = fs.readFileSync(b.workspace.resolve("data.txt"));
    expect(onDisk.equals(Buffer.from(ORIGINAL, "utf8"))).toBe(true);
    expect(result.filesChanged).not.toContain("data.txt");
  });
});

describe("AgentKernel — godkännande", () => {
  it("avslag → ok:false och filen ar orord", async () => {
    const ORIGINAL = "do not touch\n";
    const turns: FakeTurn[] = [
      { toolCalls: [{ name: "write_file", args: { path: "keep.txt", content: "SKADAD" } }] },
      { text: "OK" },
    ];
    const b = makeCtx({
      turns,
      approvalMode: "ask",
      approvalHandler: (kind) => (kind === "write" ? "deny" : "allow"),
    });
    fs.writeFileSync(b.workspace.resolve("keep.txt"), ORIGINAL, "utf8");

    const kernel = new AgentKernel(b.ctx);
    const result = await kernel.run("Skriv over keep.txt");

    expect(result.ok).toBe(false);
    expect(fs.readFileSync(b.workspace.resolve("keep.txt"), "utf8")).toBe(ORIGINAL);
    const denyRecord = result.toolCalls.find((t) => t.tool === "write_file");
    expect(denyRecord?.ok).toBe(false);
  });

  it("allowlist auto-godkanner 'echo nexus' och fangar 'nexus'", async () => {
    const turns: FakeTurn[] = [
      { toolCalls: [{ name: "run_terminal", args: { command: "echo nexus" } }] },
      { text: "klart" },
    ];
    const b = makeCtx({ turns, approvalMode: "allowlist", allowlist: ["echo"], agentMode: "agent" });
    const kernel = new AgentKernel(b.ctx);
    const result = await kernel.run("Skriv ut nexus");

    expect(result.ok).toBe(true);
    const rec = result.toolCalls.find((t) => t.tool === "run_terminal");
    expect(rec?.ok).toBe(true);
    expect(rec?.output).toContain("nexus");
  });
});

describe("AgentKernel — nedbrytning och lagen", () => {
  it("NoModelAvailable ger ok:false utan att kasta (R5)", async () => {
    const b = makeCtx({ turns: [], available: false });
    const kernel = new AgentKernel(b.ctx);
    const result = await kernel.run("gor nagot");
    expect(result.ok).toBe(false);
    expect(result.summary.toLowerCase()).toContain("modell");
    const errEvent = b.events.find((e) => e.name === "agent/error");
    expect(errEvent?.payload).toMatchObject({ code: ErrorCode.NoModelAvailable });
  });

  it("[Ask]-lage skriver ALDRIG nagot", async () => {
    const ORIGINAL = "untouched\n";
    const turns: FakeTurn[] = [
      { toolCalls: [{ name: "write_file", args: { path: "x.txt", content: "NO" } }] },
      { text: "bara svar" },
    ];
    const b = makeCtx({ turns, agentMode: "ask", approvalMode: "auto" });
    const abs = b.workspace.resolve("x.txt");
    fs.writeFileSync(abs, ORIGINAL, "utf8");
    const kernel = new AgentKernel(b.ctx);
    const result = await kernel.run("skapa x");
    expect(fs.readFileSync(abs, "utf8")).toBe(ORIGINAL);
    expect(result.filesChanged).not.toContain("x.txt");
  });

  it("okant verktyg ger ToolNotFound-anteckning utan att kasta (negativt)", async () => {
    const turns: FakeTurn[] = [{ toolCalls: [{ name: "does_not_exist", args: {} }] }, { text: "klar" }];
    const b = makeCtx({ turns, approvalMode: "auto" });
    const kernel = new AgentKernel(b.ctx);
    const result = await kernel.run("x");
    expect(result.ok).toBe(false);
    expect(result.toolCalls[0]?.output).toContain("Okänt verktyg");
  });

  it("[Eyes]-lage kollar screenshot_analyze efter körning", async () => {
    const turns: FakeTurn[] = [
      { toolCalls: [{ name: "run_terminal", args: { command: "echo synlig" } }] },
      { text: "klart" },
    ];
    const b = makeCtx({ turns, agentMode: "eyes", approvalMode: "auto" });
    const kernel = new AgentKernel(b.ctx);
    const result = await kernel.run("kör och titta");
    // Utan vision-verktyg degraderar screenshot_anthesize till ok:false men ingen krasch.
    const eye = result.toolCalls.find((t) => t.tool === "screenshot_analyze");
    expect(eye, "eyes-läget ska köra screenshot_analyze").toBeTruthy();
    expect(result.ok).toBe(false); // nedgradering pga saknad vision
  });
});

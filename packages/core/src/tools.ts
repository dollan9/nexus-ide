/**
 * tools.ts — buildCoreTools(ctx) returnerar riktiga AgentTool[] for exakt de
 * namn som finns i protocol:s CORE_TOOLS. Varje verktyg bar en JSON-schema for
 * sina argument, en readOnly-flagga och gar genom approvals/checkpoints dar det
 * ar tillampligt. web_fetch anvander global fetch med storlekstak + timeout.
 * git_op skalar till installerad git med argument-ARRAY (aldrig stranginterpolering).
 * mcp_* lags till av anroparen via attachMcpTools (namespace <serverId>__<tool>).
 */

import { spawn } from "node:child_process";
import { CORE_TOOLS, type AgentMode, type JsonSchema } from "@nexus/protocol";
import type { AgentToolContext, McpToolInfo, McpToolResult } from "./toolkits";

export interface AgentTool {
  name: string;
  description: string;
  schema: JsonSchema;
  readOnly: boolean;
  run(args: unknown): Promise<{ ok: boolean; output: string; structured?: unknown }>;
}

type ToolOutcome = { ok: boolean; output: string; structured?: unknown };

/** Tvingar okand input till en enkel nyckel/varde-post utan att kasta. */
function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args === "object" && args !== null) return args as Record<string, unknown>;
  return {};
}

function str(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return typeof v === "string" ? v : "";
}

function num(rec: Record<string, unknown>, key: string): number | undefined {
  const v = rec[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function strArray(rec: Record<string, unknown>, key: string): string[] {
  const v = rec[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") return [v];
  return [];
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Kancheck for om en git-underkommando ar skrivande (annars lasbar). */
function gitIsReadOnly(sub: string): boolean {
  return ["status", "diff", "log", "show", "branch", "blame", "ls-files", "remote"].includes(sub);
}

/** Kopt, begransad hamtning via global fetch. Ger aldrig en krasch (R5). */
async function fetchWithCap(url: string, maxBytes: number, timeoutMs: number): Promise<{ ok: boolean; status: number; body: string; truncated: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    const text = await res.text();
    const capped = text.length > maxBytes;
    return { ok: res.ok, status: res.status, body: capped ? text.slice(0, maxBytes) : text, truncated: capped };
  } catch (e) {
    return { ok: false, status: 0, body: `Hämtning misslyckades: ${errText(e)}`, truncated: false };
  } finally {
    clearTimeout(timer);
  }
}

function runGit(cwd: string, args: string[], timeoutMs = 30000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const child = spawn("git", args, { cwd, windowsVerbatimArguments: false, env: process.env });
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignorera */
        }
        resolve({ code: -1, stdout, stderr: stderr + "\n[timeout]" });
      }
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
      if (stdout.length > 5 * 1024 * 1024) stdout = stdout.slice(0, 5 * 1024 * 1024);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (e) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: errText(e) });
      }
    });
    child.on("close", (code) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ code: code ?? 0, stdout, stderr });
      }
    });
  });
}

// ---------------- De 14 karnoverktygen (CORE_TOOLS) ----------------

function buildReadFile(ctx: AgentToolContext): AgentTool {
  return {
    name: "read_file",
    description: "Läs en fil från workspacet. Returnerar innehåll, språk och om den trunkerats.",
    readOnly: true,
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relativ filpath inuti workspacet" },
        maxBytes: { type: "number", description: "Valfri övre gräns för lästa bytes" },
      },
      required: ["path"],
    },
    async run(args): Promise<ToolOutcome> {
      const rec = asRecord(args);
      const p = str(rec, "path");
      if (!p) return { ok: false, output: "Saknar 'path'." };
      try {
        const file = await ctx.workspace.read(p, num(rec, "maxBytes"));
        return {
          ok: true,
          output: file.content,
          structured: { path: file.path, language: file.language, size: file.size, truncated: file.truncated },
        };
      } catch (e) {
        return { ok: false, output: errText(e) };
      }
    },
  };
}

function buildWriteFile(ctx: AgentToolContext): AgentTool {
  return {
    name: "write_file",
    description: "Skriv ( eller overskriv ) en fil. Skapar en ai-edit-checkpoint av tidigare innehall innan den skriver.",
    readOnly: false,
    schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        label: { type: "string", description: "Valfri etikett for checkpointen" },
      },
      required: ["path", "content"],
    },
    async run(args): Promise<ToolOutcome> {
      const rec = asRecord(args);
      const p = str(rec, "path");
      const content = typeof rec.content === "string" ? rec.content : undefined;
      if (!p || content === undefined) return { ok: false, output: "Saknar 'path' eller 'content'." };
      if (ctx.mode === "ask") return { ok: false, output: "Frågeläge skriver inte några filer." };

      const approval = await ctx.approvals.request({
        runId: ctx.runId ?? "local",
        kind: "write",
        title: `Skriv fil: ${p}`,
        paths: [p],
        risk: "medium",
      });
      if (approval.decision === "deny") return { ok: false, output: "Godkännande nekades (ApprovalDenied). Filen är orörd." };

      // For-hands-tagning: checkpointpa befintligt innet innan overskrivning.
      let preCheckpointId: string | undefined;
      try {
        const before = await ctx.workspace.read(p);
        const cp = await ctx.checkpoints.create(str(rec, "label") || `före write ${p}`, [before.path], "ai-edit");
        preCheckpointId = cp.id;
        ctx.emit("agent/checkpoint", { checkpoint: cp });
      } catch {
        /* filen finns inte ännu — ingen för-checkpoint behövs */
      }

      const res = await ctx.workspace.write(p, content, { source: "ai-edit", label: str(rec, "label") });
      return {
        ok: true,
        output: `Skrev ${res.path} (${res.bytes} bytes${res.created ? ", ny fil" : ""}).`,
        structured: { ...res, preCheckpointId, approval: approval.decision },
      };
    },
  };
}

function buildEditFile(ctx: AgentToolContext): AgentTool {
  return {
    name: "edit_file",
    description: "Tillämpa SEARCH/REPLACE-patches pa en fil (exakt → trimmad → fuzzy). Skapar for-edit-checkpoint.",
    readOnly: false,
    schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        patches: {
          type: "array",
          description: "Lista av { search, replace, occurrences? }",
          items: {
            type: "object",
            properties: {
              search: { type: "string" },
              replace: { type: "string" },
              occurrences: { type: "number" },
            },
            required: ["search", "replace"],
          },
        },
      },
      required: ["path", "patches"],
    },
    async run(args): Promise<ToolOutcome> {
      const rec = asRecord(args);
      const p = str(rec, "path");
      const patchesRaw = rec.patches;
      if (!p || !Array.isArray(patchesRaw)) return { ok: false, output: "Saknar 'path' eller 'patches'." };
      if (ctx.mode === "ask") return { ok: false, output: "Frågeläge redigerar inte filer." };

      const approval = await ctx.approvals.request({
        runId: ctx.runId ?? "local",
        kind: "write",
        title: `Redigera fil: ${p}`,
        paths: [p],
        risk: "medium",
      });
      if (approval.decision === "deny") return { ok: false, output: "Godkännande nekades (ApprovalDenied). Filen är orörd." };

      const patches = patchesRaw.map((x) => {
        const o = asRecord(x);
        return { search: str(o, "search"), replace: str(o, "replace"), occurrences: num(o, "occurrences") };
      });

      let before;
      try {
        before = await ctx.workspace.read(p);
      } catch (e) {
        return { ok: false, output: errText(e) };
      }

      const { applyPatches, unifiedDiff } = await import("./patches");
      const result = applyPatches(before.content, patches);
      if (!result.ok) {
        return { ok: false, output: `Patch hittade ingen matchning: ${result.failures.join(" | ")}`, structured: { matched: result.matched } };
      }

      const cp = await ctx.checkpoints.create(`före edit ${p}`, [before.path], "ai-edit");
      ctx.emit("agent/checkpoint", { checkpoint: cp });

      await ctx.workspace.write(p, result.after, { source: "ai-edit", label: "edit_file" });
      const diff = unifiedDiff(before.path, before.content, result.after);
      ctx.emit("agent/diff", { runId: ctx.runId ?? "local", diffs: [diff] });
      return {
        ok: true,
        output: `Redigerade ${p} (${result.matched.join(",")}).`,
        structured: { path: p, matched: result.matched, checkpointId: cp.id, diff },
      };
    },
  };
}

function buildListDir(ctx: AgentToolContext): AgentTool {
  return {
    name: "list_dir",
    description: "Lista workspaceträd (filer + mappar) med ignore-regler.",
    readOnly: true,
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Valfri mapp; standard är rot" },
        depth: { type: "number" },
      },
    },
    async run(args): Promise<ToolOutcome> {
      const rec = asRecord(args);
      const p = str(rec, "path") || undefined;
      try {
        const nodes = await ctx.workspace.listTree(p, num(rec, "depth"));
        return { ok: true, output: JSON.stringify(nodes), structured: { nodes } };
      } catch (e) {
        return { ok: false, output: errText(e) };
      }
    },
  };
}

function buildSearchRegex(ctx: AgentToolContext): AgentTool {
  return {
    name: "search_regex",
    description: "Sök i workspacet (ripgrep eller JS-fallback). Samma SearchResponse-oavsett engine.",
    readOnly: true,
    schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        isRegex: { type: "boolean" },
        isCaseSensitive: { type: "boolean" },
        wholeWord: { type: "boolean" },
        includeGlob: { type: "string" },
        excludeGlob: { type: "string" },
        maxResults: { type: "number" },
      },
      required: ["query"],
    },
    async run(args): Promise<ToolOutcome> {
      const rec = asRecord(args);
      const query = str(rec, "query");
      if (!query) return { ok: false, output: "Saknar 'query'." };
      try {
        const res = await ctx.workspace.search(query, {
          isRegex: typeof rec.isRegex === "boolean" ? rec.isRegex : undefined,
          isCaseSensitive: typeof rec.isCaseSensitive === "boolean" ? rec.isCaseSensitive : undefined,
          wholeWord: typeof rec.wholeWord === "boolean" ? rec.wholeWord : undefined,
          includeGlob: str(rec, "includeGlob") || undefined,
          excludeGlob: str(rec, "excludeGlob") || undefined,
          maxResults: num(rec, "maxResults"),
        });
        return {
          ok: true,
          output: `${res.numMatches} träffar i ${res.numFiles} filer via ${res.engine}`,
          structured: res,
        };
      } catch (e) {
        return { ok: false, output: errText(e) };
      }
    },
  };
}

function buildRunTerminal(ctx: AgentToolContext): AgentTool {
  return {
    name: "run_terminal",
    description: "Kör ett kommando i den integrerade terminalen och fanga stdout/stderr/exitCode.",
    readOnly: false,
    schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["command"],
    },
    async run(args): Promise<ToolOutcome> {
      const rec = asRecord(args);
      const command = str(rec, "command");
      if (!command) return { ok: false, output: "Saknar 'command'." };

      const approval = await ctx.approvals.request({
        runId: ctx.runId ?? "local",
        kind: "terminal",
        title: `Kör: ${command}`,
        command,
        risk: "medium",
      });
      if (approval.decision === "deny") return { ok: false, output: "Godkännande nekades (ApprovalDenied). Kommandot kördes inte." };

      const res = await ctx.terminals.exec(command, {
        cwd: str(rec, "cwd") || undefined,
        timeoutMs: num(rec, "timeoutMs"),
      });
      const approvalTag = approval.decision === "always" ? "always" : approval.decision === "allow" ? "allowed" : "auto";
      return {
        ok: res.exitCode === 0 && !res.timedOut,
        output: `exit ${res.exitCode}${res.timedOut ? " (TIMEOUT)" : ""}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
        structured: { ...res, approval: approvalTag },
      };
    },
  };
}

function buildGitOp(ctx: AgentToolContext): AgentTool {
  return {
    name: "git_op",
    description: "Kor ett git-underkommando (t.ex. status, diff, add, commit). Anvander argument-array, aldrig shell-interpolering.",
    readOnly: false,
    schema: {
      type: "object",
      properties: {
        args: {
          type: "array",
          description: "Git-argument, t.ex. ['status'] eller ['commit','-m','meddelande']",
          items: { type: "string" },
        },
        cwd: { type: "string" },
      },
      required: ["args"],
    },
    async run(args): Promise<ToolOutcome> {
      const rec = asRecord(args);
      const gitArgs = strArray(rec, "args");
      if (gitArgs.length === 0) return { ok: false, output: "Saknar 'args'." };
      const readOnly = gitIsReadOnly(gitArgs[0] ?? "");

      if (!readOnly) {
        const approval = await ctx.approvals.request({
          runId: ctx.runId ?? "local",
          kind: "terminal",
          title: `git ${gitArgs.join(" ")}`,
          command: `git ${gitArgs.join(" ")}`,
          risk: "high",
        });
        if (approval.decision === "deny") return { ok: false, output: "Godkännande nekades (ApprovalDenied)." };
      }

      const res = await runGit(ctx.workspace.resolve(str(rec, "cwd") || "."), ["-c", "core.quotepath=false", ...gitArgs]);
      return {
        ok: res.code === 0,
        output: `exit ${res.code}\n${res.stdout}${res.stderr ? `\n[stderr]\n${res.stderr}` : ""}`,
        structured: { code: res.code, stdout: res.stdout, stderr: res.stderr, readOnly },
      };
    },
  };
}

function buildWebFetch(ctx: AgentToolContext): AgentTool {
  return {
    name: "web_fetch",
    description: "Hämta en URL med global fetch. Storlekstak + timeout; returnerar aldrig en krasch.",
    readOnly: true,
    schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        maxBytes: { type: "number" },
        timeoutMs: { type: "number" },
      },
      required: ["url"],
    },
    async run(args): Promise<ToolOutcome> {
      const rec = asRecord(args);
      const url = str(rec, "url");
      if (!/^https?:\/\//i.test(url)) return { ok: false, output: "Endast http(s)-URL:er stöds." };
      const res = await fetchWithCap(url, num(rec, "maxBytes") ?? 200_000, num(rec, "timeoutMs") ?? 15000);
      return { ok: res.ok, output: res.body, structured: { status: res.status, truncated: res.truncated } };
    },
  };
}

function buildScreenshotAnalyze(ctx: AgentToolContext): AgentTool {
  return {
    name: "screenshot_analyze",
    description: "Fanga och analysera skärmen/editorn (FAS 6.4). Krever vision-verktyg; degraderar annars värdigt.",
    readOnly: true,
    schema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["screen", "window", "editor", "file"] },
        prompt: { type: "string" },
        path: { type: "string" },
      },
    },
    async run(args): Promise<ToolOutcome> {
      const rec = asRecord(args);
      if (!ctx.vision) {
        return { ok: false, output: "Visionverktyg ej kopplat — skärmanalys är offline (degradering, ingen krasch)." };
      }
      try {
        const target = (str(rec, "target") || "screen") as "screen" | "window" | "editor" | "file";
        let imageBase64: string | undefined;
        if (target === "file") {
          const file = await ctx.workspace.read(str(rec, "path"));
          imageBase64 = Buffer.from(file.content, "utf8").toString("base64");
        } else if (ctx.vision.capture) {
          const cap = await ctx.vision.capture(target, str(rec, "path") || undefined);
          imageBase64 = cap.pngBase64;
        }
        const result = await ctx.vision.analyze({ imageBase64, prompt: str(rec, "prompt") || undefined, target });
        return { ok: true, output: result.text, structured: result };
      } catch (e) {
        return { ok: false, output: `Skärmanalys misslyckades: ${errText(e)}` };
      }
    },
  };
}

function buildTranscribe(ctx: AgentToolContext): AgentTool {
  return {
    name: "transcribe",
    description: "Transkribera ljud till text (FAS 5). Krever rostkverktyg; degraderar annars.",
    readOnly: true,
    schema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        audioBase64: { type: "string" },
        language: { type: "string" },
        format: { type: "string" },
      },
    },
    async run(args): Promise<ToolOutcome> {
      const rec = asRecord(args);
      if (!ctx.voice) {
        return { ok: false, output: "Rostverktyg ej kopplat — transkription ar offline (degradering, ingen krasch)." };
      }
      try {
        const result = await ctx.voice.transcribe({
          filePath: str(rec, "filePath") || undefined,
          audioBase64: str(rec, "audioBase64") || undefined,
          language: str(rec, "language") || undefined,
          format: str(rec, "format") || undefined,
        });
        return { ok: true, output: result.text, structured: result };
      } catch (e) {
        return { ok: false, output: `Transkription misslyckades: ${errText(e)}` };
      }
    },
  };
}

function buildAddCheckpoint(ctx: AgentToolContext): AgentTool {
  return {
    name: "add_checkpoint",
    description: "Skapa en checkpoint (skugg-git) for angivna filer sa att de kan aterskapas exakt.",
    readOnly: false,
    schema: {
      type: "object",
      properties: {
        label: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        source: { type: "string", enum: ["agent", "user", "ai-edit", "terminal"] },
      },
      required: ["label"],
    },
    async run(args): Promise<ToolOutcome> {
      const rec = asRecord(args);
      const label = str(rec, "label") || "checkpoint";
      const files = strArray(rec, "files");
      const source = (str(rec, "source") || "agent") as "agent" | "user" | "ai-edit" | "terminal";
      try {
        const targetFiles = files.length > 0 ? files : await ctx.checkpoints.currentFiles();
        const cp = await ctx.checkpoints.create(label, targetFiles, source);
        ctx.emit("agent/checkpoint", { checkpoint: cp });
        return { ok: true, output: `Checkpoint ${cp.id} skapad (${cp.files.length} filer).`, structured: cp };
      } catch (e) {
        return { ok: false, output: errText(e) };
      }
    },
  };
}

function buildRollback(ctx: AgentToolContext): AgentTool {
  return {
    name: "rollback",
    description: "Aterstall filer till en checkpoint (exakta bytes).",
    readOnly: false,
    schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    async run(args): Promise<ToolOutcome> {
      const rec = asRecord(args);
      const id = str(rec, "id");
      if (!id) return { ok: false, output: "Saknar 'id'." };
      const approval = await ctx.approvals.request({
        runId: ctx.runId ?? "local",
        kind: "write",
        title: `Rollback till checkpoint ${id}`,
        risk: "high",
      });
      if (approval.decision === "deny") return { ok: false, output: "Godkännande nekades (ApprovalDenied)." };
      try {
        const res = await ctx.checkpoints.rollback(id);
        return { ok: true, output: `Återställde ${res.restored.length} filer.`, structured: res };
      } catch (e) {
        return { ok: false, output: errText(e) };
      }
    },
  };
}

function buildRagSearch(ctx: AgentToolContext): AgentTool {
  return {
    name: "rag_search",
    description: "Sok kod-relaterad kontext via RAG. Krever rag-verktyg; degraderar annars tomt.",
    readOnly: true,
    schema: {
      type: "object",
      properties: { query: { type: "string" }, k: { type: "number" } },
      required: ["query"],
    },
    async run(args): Promise<ToolOutcome> {
      const rec = asRecord(args);
      const query = str(rec, "query");
      if (!query) return { ok: false, output: "Saknar 'query'." };
      if (!ctx.rag) return { ok: true, output: "RAG ej kopplat — tomt resultat (degradering, ingen krasch).", structured: { chunks: [] } };
      try {
        const chunks = await ctx.rag.search(query, num(rec, "k"));
        return { ok: true, output: chunks.map((c) => `${c.path}:${c.startLine} ${c.text}`).join("\n"), structured: { chunks } };
      } catch (e) {
        return { ok: false, output: errText(e) };
      }
    },
  };
}

function buildSuggestNextStep(ctx: AgentToolContext): AgentTool {
  return {
    name: "suggest_next_step",
    description: "Ge ett radjie for nasta steg baserat pa lage (mode + nyliga verktyg). Ingen modell kravs.",
    readOnly: true,
    schema: {
      type: "object",
      properties: {
        goal: { type: "string" },
        context: { type: "string" },
      },
    },
    async run(args): Promise<ToolOutcome> {
      const rec = asRecord(args);
      const goal = str(rec, "goal");
      const mode: AgentMode = ctx.mode;
      const hint = suggestFor(mode, goal);
      return { ok: true, output: hint, structured: { mode, goal } };
    },
  };
}

function suggestFor(mode: AgentMode, goal: string): string {
  switch (mode) {
    case "debug":
      return "Debug: 1) reproducera felet med minsta möjliga exempel, 2) formulera en hypotes, 3) instrumentera med loggar/brytpunkter, 4) tillämpa en riktad fix, 5) verifiera med test. Lappa aldrig bara symptomen.";
    case "ask":
      return "Fråga: besvara målet utan att skriva några filer. Använd read_file/search_regex för att samla fakta.";
    case "eyes":
      return "Ögon: kör det aktuella steget, kör sedan screenshot_analyze och beskriv vad som visas innan du går vidare.";
    case "voice":
      return "Röst: transkribera ljudet och använd texten som mål.";
    default:
      return `Agent: nästa steg för «${goal || "uppgiften"}» — läs relevanta filer, gör en riktad ändring med edit_file, ta en checkpoint och verifiera.`;
  }
}

/** Bygg de 14 karnoverktygen i exakt CORE_TOOLS ordning. */
export function buildCoreTools(ctx: AgentToolContext): AgentTool[] {
  const builders: Record<string, (c: AgentToolContext) => AgentTool> = {
    read_file: buildReadFile,
    write_file: buildWriteFile,
    edit_file: buildEditFile,
    list_dir: buildListDir,
    search_regex: buildSearchRegex,
    run_terminal: buildRunTerminal,
    git_op: buildGitOp,
    web_fetch: buildWebFetch,
    screenshot_analyze: buildScreenshotAnalyze,
    transcribe: buildTranscribe,
    add_checkpoint: buildAddCheckpoint,
    rollback: buildRollback,
    rag_search: buildRagSearch,
    suggest_next_step: buildSuggestNextStep,
  };
  const tools: AgentTool[] = [];
  for (const name of CORE_TOOLS) {
    const builder = builders[name];
    if (builder) tools.push(builder(ctx));
  }
  return tools;
}

/**
 * Lagg till MCP-verktyg fran @nexus/mcp-client pa anroparens vgnar.
 * Namespace hall sig: <serverId>__<tool>. Async eftersom listTools ar ett lonfte.
 */
export async function attachMcpTools(
  ctx: AgentToolContext,
  listTools: () => Promise<McpToolInfo[]>,
  callTool: (name: string, args: unknown) => Promise<McpToolResult>,
): Promise<AgentTool[]> {
  let infos: McpToolInfo[] = [];
  try {
    infos = await listTools();
  } catch (e) {
    ctx.logger.warn("Kunde inte lista MCP-verktyg", { fas: "4", error: errText(e) });
    return [];
  }
  const tools: AgentTool[] = [];
  // For varje verktyg byggs ett tunt AgentTool som delegar till callTool.
  for (const info of infos) {
    tools.push(makeMcpTool(ctx, info, callTool));
  }
  return tools;
}

function makeMcpTool(
  ctx: AgentToolContext,
  info: McpToolInfo,
  callTool: (name: string, args: unknown) => Promise<McpToolResult>,
): AgentTool {
  const qualified = `${info.serverId}__${info.localName}`;
  return {
    name: qualified,
    description: info.description,
    readOnly: info.readOnly,
    schema: info.inputSchema,
    async run(args): Promise<ToolOutcome> {
      if (!info.readOnly) {
        const approval = await ctx.approvals.request({
          runId: ctx.runId ?? "local",
          kind: "mcp-tool",
          title: `MCP ${qualified}`,
          args,
          risk: "medium",
        });
        if (approval.decision === "deny") return { ok: false, output: "Godkännande nekades (ApprovalDenied)." };
      }
      try {
        const res = await callTool(qualified, args);
        return { ok: res.ok, output: res.text, structured: res };
      } catch (e) {
        return { ok: false, output: errText(e) };
      }
    },
  };
}

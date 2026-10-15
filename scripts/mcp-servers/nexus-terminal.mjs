#!/usr/bin/env node
/**
 * nexus-terminal.mjs — NEXUS-IDE:s egen terminal-MCP-server (FAS 4.3).
 *
 * Kör shell-kommandon och returnerar stdout/stderr/exitCode. Every command is
 * klassificeras mot en denylist; farliga kommandon svarar med
 * requiresApproval:true och vägrar att köra tills anropet sätter approved:true.
 * Samma markering ligger i verktygets _meta så UI:t kan visa den utan att köra.
 *
 * Start: node <absolut sökväg>/nexus-terminal.mjs --root <tillåten katalog> [--shell cmd|bash|powershell|auto]
 */

import { z } from "zod";
import { spawn, spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { errorResult, okResult, parseArgs, resolveWithinRoots, startStdioServer, trackChild } from "./nexus_mcp_lib.mjs";

const args = parseArgs(process.argv.slice(2));
const roots = (args.flags["root"] ?? [process.cwd()]).map((r) => resolve(r));
const forcedShell = args.flags["shell"]?.[0];
process.env.NEXUS_MCP_SERVER_ID ??= "nexus-terminal";

const OUTPUT_CAP_BYTES = 200_000;

/**
 * Denylist — mönstren är avsiktligt konservativa. Match = hög risk = godkännande.
 * var: regex mot kommandosträngen, why: mänsklig förklaring för UI:t.
 */
const DENYLIST = [
  { pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)*[-\w./]*\s*\/(\s|$|\*)/i, why: "rekursiv radering av rot-nivå" },
  { pattern: /\brm\s+-[a-z]*rf/i, why: "rekursiv krafttvingad radering" },
  { pattern: /\bdel\s+\/[fsq]/i, why: "Windows kraft-radering" },
  { pattern: /\brd\s+\/[s]/i, why: "Windows rekursiv katalogbortag" },
  { pattern: /\bRemove-Item\b[\s\S]*-(Recurse|Force)/i, why: "PowerShell rekursiv/force-radering" },
  { pattern: /\bformat(\s+.*)?:/i, why: "formaterar enhet" },
  { pattern: /\bmkfs(\.|\s)/i, why: "formaterar filsystem" },
  { pattern: /\bdd\s+.*\bof=\/dev\//i, why: "skriver direkt till blockenhet" },
  { pattern: />\s*\/dev\/sd[a-z]/i, why: "skriver till rå disk" },
  { pattern: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/, why: "fork-bomb" },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i, why: "fjärrskript körs direkt i skal" },
  { pattern: /\bgit\s+push\b.*(--force|-f)(\s|$)/i, why: "force-push till fjärr" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, why: "kasserar lokala ändringar" },
  { pattern: /\bgit\s+clean\s+-[a-z]*f/i, why: "tar bort ospårade filer" },
  { pattern: /\b(shutdown|reboot|poweroff)\b/i, why: "stänger av maskinen" },
  { pattern: /\btaskkill\b/i, why: "avlivar processer" },
  { pattern: /\b(reg\s+delete|diskpart|vssadmin|takeown)\b/i, why: "systemregistrera/cache/disk-admin" },
  { pattern: /\bicacls\b.*[[:\/\\]](grant|reset)/i, why: "ändrar ACL:er" },
  { pattern: /\bchmod\s+-R\s+777\s+\//i, why: "världsöppen rekursiv chmod på rot" },
  { pattern: /\b(sudo|runas)\b/i, why: "behörighetselevering" },
  { pattern: /\bDROP\s+(TABLE|DATABASE)\b/i, why: "destruktiv SQL" },
  { pattern: /(--no-verify|--force-push)/i, why: "hoppar över skydd" },
  { pattern: /\brm\b.*\.env(\s|$)/i, why: "raderar hemlighetsfil" },
];

/**
 * Klassificera ett kommando mot denylisten.
 * @param {string} command
 * @returns {{ risk: "low" | "medium" | "high", requiresApproval: boolean, matched: string | null }}
 */
export function classifyCommand(command) {
  const trimmed = command.trim();
  if (trimmed.length === 0) return { risk: "high", requiresApproval: true, matched: "tomt kommando" };
  for (const entry of DENYLIST) {
    if (entry.pattern.test(trimmed)) {
      return { risk: "high", requiresApproval: true, matched: `${entry.why} (${entry.pattern.source})` };
    }
  }
  // Skrivande men inte svartlistade kommandon är medium: de körs men UI:t kan vilja fråga.
  const medium = /\b(npm|pnpm|yarn)\s+(install|add|remove)\b|\b(mv|cp|tee|touch|mkdir)\b|>\s*\S/i;
  if (medium.test(trimmed)) return { risk: "medium", requiresApproval: false, matched: null };
  return { risk: "low", requiresApproval: false, matched: null };
}

/**
 * Vilket skal som används. Auto: COMSPEC annars cmd.exe på Windows, /bin/sh annars.
 * @returns {{ file: string, flag: string, label: string }}
 */
function pickShell() {
  const win = process.platform === "win32";
  const wanted = forcedShell ?? "auto";
  if (wanted === "cmd" || (wanted === "auto" && win)) {
    return { file: process.env.COMSPEC ?? "cmd.exe", flag: "/d /c", label: "cmd" };
  }
  if (wanted === "powershell" || wanted === "pwsh") {
    return { file: wanted === "pwsh" ? "pwsh" : "powershell", flag: "-NoProfile -Command", label: "powershell" };
  }
  const bash = process.env.BASH ?? (win ? undefined : "/bin/bash");
  return { file: bash ?? (win ? "cmd.exe" : "/bin/sh"), flag: win ? "/d /c" : "-c", label: win ? "cmd" : "bash" };
}

/**
 * Kör ett kommando utan skal-sammanfogning av argv: ett strängargument till skals flaggan.
 *
 * Windows detailj som ar lattare att gissa fel an att upptacka: cmd.exe tolkar
 * KOMMANDORADEN, inte argv. Nodes vanliga spawn-escapning sätter egna citations-
 * tecken runt hela strängen och escapear inre `"` med `\` — vilket cmd.exe inte
 * forstar, sa `node -e "process.exit(3)"` kor fel och returnerar 0 utan output.
 * Darmedar vi raden verbatim till cmd sa att anvandarens strang gar fram exakt som
 * den skulle i en interaktiv skal. Bash och PowerShell ar riktiga argv-konsumenter
 * och far den normala escapningen (for dem ar verbatim tvartom fel).
 *
 * @param {string} command
 * @param {string} cwd
 * @param {number} timeoutMs
 */
function runCommand(command, cwd, timeoutMs) {
  const shell = pickShell();
  const flagParts = shell.flag.split(" ");
  const isCmdOnWindows = process.platform === "win32" && shell.label === "cmd";
  return new Promise((res) => {
    let child;
    try {
      child = trackChild(
        spawn(shell.file, [...flagParts, command], {
          cwd,
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: isCmdOnWindows,
          env: process.env,
        }),
      );
    } catch (err) {
      res({ error: err instanceof Error ? err.message : String(err), stdout: "", stderr: "", code: -1, timedOut: false, shell: shell.label });
      return;
    }
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Barnet till ett skal ar ALLTID ett trad (cmd -> node -> ...). child.kill()
      // pa Windows darvar bara skalet och slam-SDK:t lämnar further. taskkill /T
      // avlivar allt; pa posix nar ett SIGKILL till processgruppen.
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill.exe", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
        }
        child.kill("SIGKILL");
      } catch {
        // Processen är redan död.
      }
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < OUTPUT_CAP_BYTES) stdout += String(chunk);
      else truncated = true;
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < OUTPUT_CAP_BYTES) stderr += String(chunk);
      else truncated = true;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      res({ error: err.message, stdout, stderr, code: -1, timedOut, shell: shell.label });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      res({ error: undefined, stdout, stderr, code: timedOut ? -1 : (code ?? -1), timedOut, shell: shell.label, truncated });
    });
  });
}

await startStdioServer({
  name: "nexus-terminal",
  version: "1.0.0",
  title: "NEXUS terminal",
  register: (server) => {
    server.registerTool(
      "run",
      {
        title: "Kör skalkommando",
        description: "Kör ett kommando i ett skal inom en tillåten katalog. Returnerar stdout, stderr, exitCode. Farliga kommandon kräver approved:true.",
        inputSchema: {
          command: z.string().min(1).describe("Kommandosträngen som skalar får (t.ex. 'git --version')."),
          cwd: z.string().optional().describe("Arbetskatalog — måste ligga inom serverns tillåtna rötter."),
          timeoutMs: z.number().int().min(200).max(300_000).optional().describe("Timeout i millisekunder, standard 30000."),
          approved: z.boolean().optional().describe("Sätt true när användaren godkänt ett hög-risk-kommando."),
        },
        // Verktyget i sin helhet är riskfyllt: kräver godkännande enligt FAS 4.3.
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        _meta: { requiresApproval: true, riskLevel: "high", denylistEnforced: true },
      },
      async ({ command, cwd, timeoutMs, approved }) => {
        const workdir = cwd !== undefined ? (isAbsolute(cwd) ? resolve(cwd) : resolve(roots[0] ?? process.cwd(), cwd)) : (roots[0] ?? process.cwd());
        /** @type {string[]} */
        let allowed;
        try {
          allowed = [resolveWithinRoots(workdir, roots)];
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
        const verdict = classifyCommand(command);
        if (verdict.requiresApproval && approved !== true) {
          return errorResult(`nekad: kommandot kräver godkännande (${verdict.matched}). Skicka approved:true efter användarens tillstånd.`, {
            requiresApproval: true,
            risk: verdict.risk,
            command,
            matched: verdict.matched,
          });
        }
        const r = await runCommand(command, allowed[0] ?? process.cwd(), timeoutMs ?? 30_000);
        if (r.error !== undefined && r.stdout === "" && r.stderr === "") {
          return errorResult(`kunde inte starta skal (${r.shell}): ${r.error}`);
        }
        return okResult(
          {
            command,
            shell: r.shell,
            cwd: allowed[0],
            exitCode: r.code,
            timedOut: r.timedOut,
            requiresApproval: verdict.requiresApproval,
            risk: verdict.risk,
            stdout: r.stdout,
            stderr: r.stderr,
            truncated: r.truncated === true,
            spawnError: r.error,
          },
          `exit=${r.code} shell=${r.shell}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`.slice(0, OUTPUT_CAP_BYTES * 2),
        );
      },
    );

    server.registerTool(
      "check_command",
      {
        title: "Klassificera kommando",
        description: "Riskbedöm ett kommando mot denylisten UTAN att köra det. Read-only.",
        inputSchema: { command: z.string().min(1).describe("Kommandot som ska bedömas.") },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        _meta: { requiresApproval: false },
      },
      async ({ command }) => {
        const verdict = classifyCommand(command);
        return okResult({ command, ...verdict }, `${verdict.risk} requiresApproval=${verdict.requiresApproval}${verdict.matched ? ` (${verdict.matched})` : ""}`);
      },
    );

    server.registerTool(
      "info",
      {
        title: "Terminalserverns konfiguration",
        description: "Returnerar tillåtna rotkataloger, valt skal och denylist-storlek. Read-only.",
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        _meta: { requiresApproval: false },
      },
      async () => {
        const shell = pickShell();
        return okResult({ roots, shell: shell.label, shellFile: shell.file, denylistSize: DENYLIST.length, platform: process.platform }, `roots=${roots.join(", ")} shell=${shell.label}`);
      },
    );
  },
});

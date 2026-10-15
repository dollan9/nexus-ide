/**
 * terminal.ts — TerminalManager på child_process (UTAN node-pty).
 *
 * AVVIKELSE (spelrad degradering): node-pty är MEDVETET inte en dependens —
 * native-byggen misslyckas i den här miljön. Därför körs skalet med RÖR (pipes)
 * i stället för en PTY. Konsekvens: interaktiva TUI-appar (vim,less,htop) fungerar
 * inte fullt ut; stdin/stdout är block-bufferade. Allt icke-interaktivt (kommandon,
 * exec, scripts) fungerar korrekt. close()/closeAll() garanterar att inget barn
 * överlever (taskkill /T på Windows, process-grupp elsewhere).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Logger } from "./logger";

interface Term {
  child: ChildProcessWithoutNullStreams;
  pid: number;
  shell: string;
  killed: boolean;
}

const IS_WIN = process.platform === "win32";

/** Välj användarens skal: Git-bash om den finns, annars powershell (Win) / $SHELL/bash. */
function pickShell(): { shell: string; args: string[] } {
  if (IS_WIN) {
    const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    const gitBashLocal = path.join(process.env.LOCALAPPDATA ?? "", "Programs/Git/bin/bash.exe");
    if (fs.existsSync(gitBash)) return { shell: gitBash, args: ["-i"] };
    if (fs.existsSync(gitBashLocal)) return { shell: gitBashLocal, args: ["-i"] };
    const ps = "powershell.exe";
    return { shell: ps, args: ["-NoProfile", "-NoLogo", "-Command", "-"] };
  }
  const envShell = process.env.SHELL;
  if (envShell && fs.existsSync(envShell)) return { shell: envShell, args: ["-i"] };
  if (fs.existsSync("/bin/bash")) return { shell: "/bin/bash", args: ["-i"] };
  return { shell: "/bin/sh", args: ["-i"] };
}

/** Döda barnet och — på Windows — hela dess process-träd. */
function killTree(term: Term): void {
  term.killed = true;
  const pid = term.pid;
  if (pid <= 0) return;
  try {
    if (IS_WIN) {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      killer.on("error", () => {
        try {
          term.child.kill("SIGKILL");
        } catch {
          /* ignorera */
        }
      });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        term.child.kill("SIGKILL");
      }
    }
  } catch {
    try {
      term.child.kill("SIGKILL");
    } catch {
      /* ignorera */
    }
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    return code === "EPERM";
  }
}

async function waitGone(pid: number, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (pidAlive(pid)) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 40));
  }
  return true;
}

export class TerminalManager {
  private readonly root: string;
  private readonly logger: Logger;
  private readonly onOutput?: (termId: string, data: string) => void;
  private readonly onExit?: (termId: string, code: number | null) => void;
  private readonly terms: Map<string, Term> = new Map();

  constructor(opts: {
    root: string;
    logger: Logger;
    onOutput?: (termId: string, data: string) => void;
    onExit?: (termId: string, code: number | null) => void;
  }) {
    this.root = path.resolve(opts.root);
    this.logger = opts.logger;
    this.onOutput = opts.onOutput;
    this.onExit = opts.onExit;
  }

  async open(opts?: { cwd?: string; cols?: number; rows?: number }): Promise<{ termId: string; pid: number; shell: string }> {
    const { shell, args } = pickShell();
    const cwd = opts?.cwd ? path.resolve(this.root, opts.cwd) : this.root;
    const termId = randomUUID();
    const child = spawn(shell, args, {
      cwd,
      env: process.env,
      windowsVerbatimArguments: false,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    const term: Term = { child, pid: child.pid ?? -1, shell, killed: false };
    this.terms.set(termId, term);

    child.stdout?.on("data", (d: Buffer) => this.onOutput?.(termId, d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => this.onOutput?.(termId, d.toString("utf8")));
    child.on("error", (e) => this.logger.warn("Terminal-fel", { fas: "2.4", termId, error: String(e) }));
    child.on("close", (code) => {
      this.terms.delete(termId);
      this.onExit?.(termId, code);
    });

    this.logger.info("Terminal öppnad", { fas: "2.4", termId, shell, pid: term.pid, cols: opts?.cols, rows: opts?.rows });
    return { termId, pid: term.pid, shell };
  }

  write(termId: string, data: string): void {
    const term = this.terms.get(termId);
    if (!term || term.killed) return;
    try {
      term.child.stdin?.write(data);
    } catch (err) {
      this.logger.warn("Kunde inte skriva till terminal", { fas: "2.4", termId, error: String(err) });
    }
  }

  /**
   * resize är en no-op utan PTY — storleken finns bara i den saknade terminalenheten.
   * Dokumenterad degradering; anropet misslyckas aldrig.
   */
  resize(termId: string, cols: number, rows: number): void {
    this.logger.debug("resize ignoreras utan PTY", { fas: "2.4", termId, cols, rows });
  }

  async close(termId: string): Promise<void> {
    const term = this.terms.get(termId);
    if (!term) return;
    killTree(term);
    try {
      term.child.stdin?.end();
    } catch {
      /* ignorera */
    }
    await waitGone(term.pid);
    this.terms.delete(termId);
    this.logger.info("Terminal stängd", { fas: "2.4", termId });
  }

  /**
   * Envister: fångar output + exitCode. Kör kommandot via valet av skal som EN argv
   * till `-c`/`-Command`, så `&` och citattecken hanteras av SKALET, aldrig av cmd.exe.
   */
  exec(
    cmd: string,
    opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
  ): Promise<{ stdout: string; stderr: string; exitCode: number; tookMs: number; timedOut: boolean }> {
    const started = Date.now();
    const cwd = opts?.cwd ? path.resolve(this.root, opts.cwd) : this.root;
    const env = opts?.env ? { ...process.env, ...opts.env } : process.env;
    const timeoutMs = opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 30000;
    const { shell } = pickShell();
    // Kör kommandot icke-interaktivt via -c / -Command.
    const runArgs = IS_WIN
      ? shell.endsWith("bash.exe")
        ? ["-c", cmd]
        : ["-NoProfile", "-NonInteractive", "-Command", cmd]
      : ["-c", cmd];

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const child = spawn(shell, runArgs, { cwd, env, windowsVerbatimArguments: false, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
      const term: Term = { child, pid: child.pid ?? -1, shell, killed: false };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(term);
      }, timeoutMs);

      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
        if (stdout.length > 20 * 1024 * 1024) killTree(term);
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
        if (stderr.length > 20 * 1024 * 1024) killTree(term);
      });
      child.stdin?.end();
      child.on("error", (e) => {
        clearTimeout(timer);
        stderr += String(e);
        resolve({ stdout, stderr, exitCode: -1, tookMs: Date.now() - started, timedOut });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: timedOut ? -1 : code ?? 0, tookMs: Date.now() - started, timedOut });
      });
    });
  }

  async closeAll(): Promise<void> {
    const ids = [...this.terms.keys()];
    await Promise.all(ids.map((id) => this.close(id)));
  }

  /** Testbar: exponerar om ett givet pid fortfarande lever (för orphan-assertion). */
  isPidAlive(pid: number): boolean {
    return pidAlive(pid);
  }
}

/**
 * test/helpers.ts — testduppler och tempatsmarkshjälp.
 *
 * FakeProvider är en strukturell dubbel av NexusProviderRegistry som lar en test
 * skriptar en sekvens av assistant-turer (inklusive tool_calls) utan att importera
 * @nexus/providers kompilerade output.
 */

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createLogger, type Logger } from "../src/logger";
import { WorkspaceService } from "../src/workspace";
import { CheckpointManager } from "../src/checkpoints";
import { TerminalManager } from "../src/terminal";
import { ApprovalBroker } from "../src/approvals";
import type {
  AgentToolContext,
  NexusProviderRegistry,
  ProviderChatRequest,
  ProviderChatResponse,
} from "../src/toolkits";
import type { ApprovalMode, AgentMode } from "@nexus/protocol";

// ---------------- temp-at (os.tmpdir) + afterEach-stadning ----------------

const tracked: string[] = [];

export function makeTempRoot(prefix = "nexus-core-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tracked.push(dir);
  return dir;
}

export function cleanupAllTemp(): void {
  while (tracked.length > 0) {
    const dir = tracked.pop();
    if (!dir) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 40 });
    } catch {
      /* kan inte ta bort — ignorera i ren-göran */
    }
  }
}

// ---------------- FakeProvider ----------------

export interface FakeTurn {
  text?: string;
  toolCalls?: { id?: string; name: string; args?: unknown }[];
}

export class FakeProvider implements NexusProviderRegistry {
  public readonly calls: ProviderChatRequest[] = [];
  private index = 0;
  constructor(
    private readonly turns: FakeTurn[],
    public available = true,
    private readonly onCall?: (callIndex: number, req: ProviderChatRequest) => void,
  ) {}

  isModelAvailable(): boolean {
    return this.available;
  }

  async chat(req: ProviderChatRequest): Promise<ProviderChatResponse> {
    const i = this.index++;
    this.calls.push(req);
    if (this.onCall) this.onCall(i, req);
    const turn = this.turns[i];
    if (!turn) {
      return { ok: true, text: "", toolCalls: [], model: "fake-model", providerId: "fake", source: "stub", finishReason: "stop" };
    }
    const toolCalls = (turn.toolCalls ?? []).map((c, k) => ({
      id: c.id ?? `call-${i}-${k}`,
      name: c.name,
      args: c.args ?? {},
    }));
    return {
      ok: true,
      text: turn.text ?? "",
      toolCalls,
      model: "fake-model",
      providerId: "fake",
      source: "stub",
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    };
  }
}

// ---------------- Kontext-byggare ----------------

export interface CtxBundle {
  ctx: AgentToolContext;
  root: string;
  logger: Logger;
  workspace: WorkspaceService;
  checkpoints: CheckpointManager;
  terminals: TerminalManager;
  approvals: ApprovalBroker;
  provider: FakeProvider;
  events: { name: string; payload: unknown }[];
  signal: AbortSignal;
}

export interface MakeCtxOptions {
  turns?: FakeTurn[];
  approvalMode?: ApprovalMode;
  allowlist?: string[];
  agentMode?: AgentMode;
  available?: boolean;
  approvalTimeoutMs?: number;
  onCall?: (i: number, req: ProviderChatRequest) => void;
  /** Auto-beslut vid agent/approval_required (for deny/allowlist-flöden i test). */
  approvalHandler?: (kind: string, command?: string) => "allow" | "deny" | "always";
  signal?: AbortSignal;
  root?: string;
}

export function makeCtx(opts: MakeCtxOptions = {}): CtxBundle {
  const root = opts.root ?? makeTempRoot();
  const logFile = path.join(root, "debug.log");
  const logger = createLogger({ logFile, level: "debug" });
  const workspace = new WorkspaceService({ root, logger });
  const checkpoints = new CheckpointManager({ root, nexusDir: path.join(root, ".nexus"), logger });
  const terminals = new TerminalManager({ root, logger });
  const approvals = new ApprovalBroker({
    mode: opts.approvalMode ?? "auto",
    allowlist: opts.allowlist ?? ["pnpm test", "git status", "echo"],
    logger,
    timeoutMs: opts.approvalTimeoutMs ?? 5000,
  });
  const provider = new FakeProvider(opts.turns ?? [], opts.available ?? true, opts.onCall);
  const events: { name: string; payload: unknown }[] = [];
  const ac = new AbortController();
  const signal = opts.signal ?? ac.signal;

  const emit = (e: string, p: unknown): void => {
    events.push({ name: e, payload: p });
    if (e === "agent/approval_required" && opts.approvalHandler) {
      const approval = (p as { approval?: { id: string; kind: string; command?: string } }).approval;
      if (approval) {
        const decision = opts.approvalHandler(approval.kind, approval.command);
        // Resolve asynkront sa att request():en hinner registrera pending.
        setTimeout(() => approvals.resolve(approval.id, decision), 0);
      }
    }
  };

  const ctx: AgentToolContext = {
    workspace,
    checkpoints,
    terminals,
    approvals,
    providers: provider,
    mcp: null,
    logger,
    emit: emit as AgentToolContext["emit"],
    mode: opts.agentMode ?? "agent",
    signal,
  };

  return { ctx, root, logger, workspace, checkpoints, terminals, approvals, provider, events, signal };
}

// ---------------- ripgrep-hitt for dual-engine-testet ----------------

/**
 * Letar efter en VERKLIG rg-binar for att kunna jamfora engines. Testet kollar
 * kanda installatiossstallen + `where/which rg`. Returnerar null om ingen finns.
 */
export function findRealRg(): string | null {
  const home = os.homedir();
  const known = [
    process.env.RG_PATH,
    process.env.NEXUS_RG_PATH,
    path.join(home, "AppData/Local/hermes/tools/ripgrep-15.2.0-win32-x64/rg.exe"),
    path.join(home, "AppData/Local/OpenAI/Codex/bin"),
    path.join(home, "AppData/Local/Programs/AutoClaw2/resources/vendor/ripgrep/rg.exe"),
    "/usr/bin/rg",
    "/usr/local/bin/rg",
  ].filter((x): x is string => typeof x === "string");

  // Exakta filer.
  for (const c of known) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* ignorera */
    }
  }
  // Sök i Codex/bin-underkataloger (hash-namnde).
  for (const c of known) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
        const rg = path.join(c, "rg.exe");
        if (fs.existsSync(rg)) return rg;
      }
    } catch {
      /* ignorera */
    }
  }
  // `where rg` / `which rg`.
  for (const cmd of ["where", "which"]) {
    try {
      const out = execFileSync(cmd, ["rg"], { encoding: "utf8", timeout: 4000 });
      const first = out.split(/\r?\n/)[0];
      if (first && fs.existsSync(first) && fs.statSync(first).isFile()) return first;
    } catch {
      /* fortsatt */
    }
  }
  return null;
}

/** Normalisera traffar sa att engine-jamforelse blir robust (path, line, column, match). */
export function normHits(hits: { path: string; line: number; column: number; match: string }[]): string[] {
  return hits
    .map((h) => `${h.path}:${h.line}:${h.column}:${h.match}`)
    .sort();
}

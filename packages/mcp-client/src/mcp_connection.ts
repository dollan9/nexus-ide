/**
 * McpConnection — en riktig MCP-serverförbindelse (FAS 4.1).
 *
 * Bygger transport utifrån en upplöst McpServerConfig och pratar Model Context
 * Protocol via @modelcontextprotocol/sdk 1.32: stdio (StdioClientTransport),
 * sse (SSEClientTransport) och streamable HTTP (StreamableHTTPClientTransport).
 * SDK 1.32 har alla tre — ingen transport behöver efterbyggas mot wire-formatet.
 *
 * Det här lagret ansvarar för:
 *   - timeout på varje roundtrip (connect/list/call) så en server aldrig blockerar
 *   - stderr läst rad för rad (→ mcp/log med serverId)
 *   - notifications/tools/list_changed → callback
 *   - pid + träffsäker nedstängning (taskkill /T på Windows, SIGTERM/SIGKILL på posix)
 */

import { spawn, spawnSync } from "node:child_process";
import type { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchema, McpToolResult } from "@nexus/protocol";
import type { McpToolDefinition, ResolvedServer } from "./types";

/** Tidsbudget för en förbindelse. */
export interface McpTimeoutOptions {
  readonly connectTimeoutMs: number;
  readonly listTimeoutMs: number;
  readonly callTimeoutMs: number;
}

/** Standardbudget — rymmer även kall npx-start (~16 s) och långsamma git-anrop. */
export const DEFAULT_TIMEOUTS: McpTimeoutOptions = {
  connectTimeoutMs: 30_000,
  listTimeoutMs: 15_000,
  callTimeoutMs: 60_000,
};

export interface McpConnectionHooks {
  readonly onStderrLine?: (line: string) => void;
  readonly onToolsChanged?: () => void;
  /** När transporten stängs av motparten (servern dog) — manager markerar stopped. */
  readonly onClosed?: (reason: string) => void;
}

/** Svaret från tools/call, innan mappen lägger till tookMs. */
export interface McpCallOutcome {
  readonly text: string;
  readonly images: string[];
  readonly structured: unknown;
  readonly isError: boolean;
}

/** Vilken transport som faktiskt används — för diagnostics och tester. */
export type McpTransportKind = "stdio" | "sse" | "http";

export class McpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpTimeoutError";
  }
}

/**
 * Kap ett löfte mot en millisekundsbudget. Egen timeout utöver SDK:ns, eftersom
 * en spawnad process som aldrig svarar på initialize annars håller livsloopet igång.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new McpTimeoutError(`${label}: timeout efter ${String(ms)} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Normalisera ett timeout-utfall. SDK:n kastar sin egen JSON-RPC-felkod -32001
 * ("Request timed out") närmre än vår budget; utan den här mappen fick UI:t och
 * agentloopet ett transport-specifit meddelande i stället för ett tydligt timeout.
 */
function asTimeoutError(err: unknown, label: string, ms: number): unknown {
  if (err instanceof McpTimeoutError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as unknown as { code?: number } | undefined)?.code;
  if (code === -32001 || /timed out|timeout/i.test(message)) {
    return new McpTimeoutError(`${label}: timeout efter ${String(ms)} ms (${message})`);
  }
  return err;
}

/**
 * Kör ett SDK-anrop med vår budget och normalisera bad timeout till McpTimeoutError.
 * (SDK:ns egen timeout kan hinna först — det ska inte synas som ett okänt fel.)
 */
async function timed<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  try {
    return await withTimeout(promise, ms, label);
  } catch (err) {
    throw asTimeoutError(err, label, ms);
  }
}

/**
 * En anslutning. Instansen äger sin Client och sin Transport och vet hur den
 * avlivas för gott (inklusive hela process-trädet).
 */
export class McpConnection {
  private readonly resolved: ResolvedServer;
  private readonly timeouts: McpTimeoutOptions;
  private readonly hooks: McpConnectionHooks;
  private client: Client | null = null;
  private transport: (Transport & { pid?: number | null }) | null = null;
  private childPid: number | null = null;
  private kind: McpTransportKind;
  private closed = false;
  private intentionalClose = false;

  constructor(resolved: ResolvedServer, timeouts: McpTimeoutOptions = DEFAULT_TIMEOUTS, hooks: McpConnectionHooks = {}) {
    this.resolved = resolved;
    this.timeouts = timeouts;
    this.hooks = hooks;
    this.kind = resolved.transport;
  }

  /**
   * Process-pid för stdio-transport, annars null. Läser ALDRIG bara det egna
   * fältet: en server som hänger under initialize har visst spawnats, och det
   * pid:t måste vi kunna avliva (annars lämnas ett liksprocess kvar).
   */
  get pid(): number | null {
    if (this.childPid !== null) return this.childPid;
    const live = (this.transport as unknown as { pid?: number | null } | null)?.pid;
    return typeof live === "number" ? live : null;
  }

  get transportKind(): McpTransportKind {
    return this.kind;
  }

  get isOpen(): boolean {
    return this.client !== null && !this.closed;
  }

  /**
   * Bygg transporten utifrån konfigurationen. Separerad metod så transportvalet
   * går att testa utan att starta någon process.
   */
  buildTransport(): Transport & { pid?: number | null } {
    const r = this.resolved;
    if (r.transport === "stdio") {
      if (r.command === undefined || r.command.trim().length === 0) {
        throw new Error(`stdio: command saknas för ${r.id}`);
      }
      // SDK:n merger den här miljön ovanpå en säker ärftlig bas (PATH, SystemRoot...),
      // så config:ens `env` GER bara extra variabler — den ersätter inte processmiljön.
      // NEXUS_MCP_SERVER_ID låter servern märka sin egen stderr med rätt id.
      const env: Record<string, string> = { ...r.env, NEXUS_MCP_SERVER_ID: r.id };
      const transport = new StdioClientTransport({
        command: r.command,
        args: r.args,
        env,
        ...(r.cwd !== undefined ? { cwd: r.cwd } : {}),
        // pipe: annars ärver klientprocessen barnets stderr och förlorar raderna.
        stderr: "pipe",
      });
      const stream = transport.stderr;
      if (stream !== null && stream !== undefined) {
        this.attachLineReader(stream as Readable, (line) => this.hooks.onStderrLine?.(line));
      }
      return transport as unknown as Transport & { pid?: number | null };
    }

    if (r.url === undefined || r.url.trim().length === 0) {
      throw new Error(`${r.transport}: url saknas för ${r.id}`);
    }
    const url = new URL(r.url);
    const headerEntries = Object.entries(r.headers);
    const headers: Record<string, string> = Object.fromEntries(headerEntries);

    if (r.transport === "http") {
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: headerEntries.length > 0 ? { headers } : undefined,
      });
      return transport as unknown as Transport & { pid?: number | null };
    }

    // SSE: headers måste gälla både GET-strömmen och de återkommande POST:erna.
    const fetchWithHeaders = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      fetch(input, { ...init, headers: { ...headers, ...((init?.headers ?? {}) as Record<string, string>) } });
    const transport = new SSEClientTransport(url, {
      requestInit: headerEntries.length > 0 ? { headers } : undefined,
      // eventsource-paketet deklarerar sin egen fetch-typ — samma signatur i praktiken.
      eventSourceInit: { fetch: fetchWithHeaders as unknown as typeof globalThis.fetch },
    });
    return transport as unknown as Transport & { pid?: number | null };
  }

  /**
   * Starta och handska. Kastar efter timeout — anroparen (manager) markerar
   * servern som error och avlivar eventuella barn.
   */
  async connect(): Promise<void> {
    if (this.client !== null) throw new Error(`${this.resolved.id}: är redan ansluten`);
    const client = new Client({ name: "nexus-ide-mcp-client", version: "1.0.0" }, { capabilities: {} });
    client.onclose = () => {
      // Endast oväntat avstängning rapporteras — annars larmar varje planerad stop.
      if (!this.intentionalClose) {
        this.closed = true;
        this.hooks.onClosed?.("transporten stängdes av servern");
      } else {
        this.closed = true;
      }
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.hooks.onToolsChanged?.();
    });

    const transport = this.buildTransport();
    this.transport = transport;
    try {
      await timed(
        client.connect(transport, { timeout: this.timeouts.connectTimeoutMs }),
        this.timeouts.connectTimeoutMs + 1_000,
        `connect ${this.resolved.id}`,
      );
    } catch (err) {
      // Stäng halvansluten transport direkt — annars lämnas ett liks-process.
      await this.hardClose().catch(() => undefined);
      this.client = null;
      throw err;
    }
    this.client = client;
    const maybePid = (transport as unknown as { pid?: number | null }).pid;
    if (typeof maybePid === "number") this.childPid = maybePid;
  }

  private require(): Client {
    if (this.client === null) throw new Error(`server ${this.resolved.id} är inte ansluten`);
    return this.client;
  }

  /** tools/list → definitionerna i samma ordning som servern rapporterar. */
  async listTools(): Promise<McpToolDefinition[]> {
    const client = this.require();
    const result = await timed(
      client.listTools(undefined, { timeout: this.timeouts.listTimeoutMs, maxTotalTimeout: this.timeouts.listTimeoutMs + 5_000 }),
      this.timeouts.listTimeoutMs + 2_000,
      `tools/list ${this.resolved.id}`,
    );
    return result.tools.map((tool) => {
      const meta = (tool as unknown as { _meta?: Record<string, unknown> })._meta;
      return {
        name: tool.name,
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        description: tool.description ?? "",
        inputSchema: (tool.inputSchema ?? { type: "object" }) as unknown as JsonSchema,
        ...(tool.annotations !== undefined
          ? {
              annotations: {
                ...(tool.annotations.title !== undefined ? { title: tool.annotations.title } : {}),
                readOnlyHint: tool.annotations.readOnlyHint === true,
                destructiveHint: tool.annotations.destructiveHint === true,
                idempotentHint: tool.annotations.idempotentHint === true,
                openWorldHint: tool.annotations.openWorldHint === true,
              },
            }
          : {}),
        ...(meta !== undefined && typeof meta === "object" ? { _meta: meta } : {}),
      };
    });
  }

  /** resources/list — URI:er som UI:t visar; tomt om servern inte erbjuder det. */
  async listResourceNames(): Promise<string[]> {
    const client = this.require();
    if (client.getServerCapabilities()?.resources === undefined) return [];
    try {
      const result = await timed(client.listResources(undefined, { timeout: this.timeouts.listTimeoutMs }), this.timeouts.listTimeoutMs + 2_000, `resources/list ${this.resolved.id}`);
      return result.resources.map((resource) => resource.uri);
    } catch {
      return [];
    }
  }

  /** prompts/list — samma nedgradering om servern lyser det. */
  async listPromptNames(): Promise<string[]> {
    const client = this.require();
    if (client.getServerCapabilities()?.prompts === undefined) return [];
    try {
      const result = await timed(client.listPrompts(undefined, { timeout: this.timeouts.listTimeoutMs }), this.timeouts.listTimeoutMs + 2_000, `prompts/list ${this.resolved.id}`);
      return result.prompts.map((prompt) => prompt.name);
    } catch {
      return [];
    }
  }

  /**
   * tools/call. Returnerar alltid ett strukturerat utfall — ett tool-fel är
   * isError:true, aldrig en krasch upp genom host (CONVENTIONS R5).
   * @param name lokalt verktygsnamn, utan namespace
   * @param args argumenten som skickas rakt till servern
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallOutcome> {
    const client = this.require();
    const raw = await timed(
      client.callTool({ name, arguments: args }, CallToolResultSchema, {
        timeout: this.timeouts.callTimeoutMs,
        maxTotalTimeout: this.timeouts.callTimeoutMs + 10_000,
        resetTimeoutOnProgress: true,
      }),
      this.timeouts.callTimeoutMs + 5_000,
      `tools/call ${this.resolved.id}__${name}`,
    );
    const content = Array.isArray(raw.content) ? raw.content : [];
    const texts: string[] = [];
    const images: string[] = [];
    for (const part of content) {
      if (part.type === "text") texts.push(part.text);
      else if (part.type === "image") images.push(`data:${part.mimeType};base64,${part.data}`);
      else texts.push(JSON.stringify(part));
    }
    const all = raw as unknown as { structuredContent?: unknown; isError?: boolean };
    return {
      text: texts.join("\n"),
      images,
      structured: all.structuredContent,
      isError: raw.isError === true,
    };
  }

  /**
   * Graciös stängning: transportens egen close (stdio stänger stdin, sedan
   * SIGTERM). Används när servern ska hinna städa själv.
   * @param graceMs
   */
  async close(graceMs: number): Promise<void> {
    this.intentionalClose = true;
    if (this.client === null) {
      await this.hardClose();
      return;
    }
    const client = this.client;
    this.client = null;
    try {
      await withTimeout(client.close(), graceMs, `close ${this.resolved.id}`);
    } catch {
      await this.hardClose();
    }
    this.closed = true;
  }

  /**
   * Avliva process-trädet. På Windows: taskkill /T /F fångar barn och barnbarn
   * — npx- och skalwrapper har ALDRIG bara ett steg.
   * @returns pid:t som avlivades (eller null) — så manager:en kan logga beviset
   *   att även en server som dog under connect lämnar inget lik efter sig.
   */
  async hardClose(): Promise<number | null> {
    this.intentionalClose = true;
    const pid = this.pid;
    let treeKilled = false;
    if (pid !== null && process.platform === "win32") {
      treeKilled = await killProcessTreeWin32(pid);
    }
    try {
      await this.transport?.close?.();
    } catch {
      // Transporten är redan stängd.
    }
    if (pid !== null && process.platform !== "win32") {
      await killProcessTreePosix(pid);
    }
    if (pid !== null && !treeKilled) {
      await waitForPidExit(pid, 3_000);
      if (isPidAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // redan ute
        }
      }
    }
    this.client = null;
    this.transport = null;
    this.closed = true;
    return pid;
  }

  private attachLineReader(stream: Readable, onLine: (line: string) => void): void {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line.trim().length > 0) onLine(line);
        index = buffer.indexOf("\n");
      }
      if (buffer.length > 8_000) {
        // Rest utan nyrad: släpp ändå, minnet är viktigare än tron.
        onLine(buffer.slice(0, 4_000));
        buffer = "";
      }
    });
    stream.on("end", () => {
      if (buffer.trim().length > 0) onLine(buffer.trim());
      buffer = "";
    });
  }
}

/**
 * taskkill /T /F — stänger hela trädet. Returnerar false om kommandot saknas
 * eller processen redan är borta (det senare är bra, inte ett fel).
 * @param pid
 */
export async function killProcessTreeWin32(pid: number): Promise<boolean> {
  return new Promise((res) => {
    let child;
    try {
      child = spawn("taskkill.exe", ["/T", "/F", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
    } catch {
      res(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // taskkill hänger — ger upp och litar på waitForPidExit.
      }
      res(false);
    }, 5_000);
    child.on("error", () => {
      clearTimeout(timer);
      res(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      res(code === 0);
    });
  });
}

/**
 * Posix-fallback: SIGTERM sedan SIGKILL till processen.
 * @param pid
 */
async function killProcessTreePosix(pid: number): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(pid, signal);
    } catch {
      return;
    }
    await waitForPidExit(pid, signal === "SIGTERM" ? 1_500 : 2_000);
  }
}

/**
 * Vänta in att ett pid inte längre existerar. True om det försvann.
 * @param pid
 * @param ms
 */
export async function waitForPidExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!isPidAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Lever pid:t? Windows: tasklist (read-only, riskerar att avliva något).
 * Posix: signal 0.
 * @param pid
 */
export function isPidAlive(pid: number): boolean {
  if (process.platform === "win32") {
    const result = spawnSync("tasklist.exe", ["/FI", `PID eq ${String(pid)}`, "/NH"], { encoding: "utf8", windowsHide: true });
    const out = result.stdout ?? "";
    return out.split(/\r?\n/).some((line) => line.trim().startsWith(String(pid)) || new RegExp(`\\b${String(pid)}\\b`).test(line));
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Bygg McpToolResult av utfall + tid (exporterad så host kan återanvända). */
export function makeToolResult(outcome: McpCallOutcome, tookMs: number, error?: string): McpToolResult {
  return {
    ok: !outcome.isError && error === undefined,
    text: outcome.text,
    ...(outcome.structured !== undefined ? { structured: outcome.structured } : {}),
    ...(outcome.images.length > 0 ? { images: outcome.images } : {}),
    tookMs,
    ...(error !== undefined ? { error } : {}),
  };
}

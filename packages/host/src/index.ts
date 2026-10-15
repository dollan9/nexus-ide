/**
 * index.ts — NEXUS-IDE host-assembly.
 *
 * createHost() binder ihop alla service-lager till ett HostRuntime EXAKT en gang.
 * dispatch(), WebSocket-bron och Electron-IPC arbetar sedan mot samma runtime och
 * samma event-buss — transport ar en detalj (se protocol). Allt som behoves for att
 * appen aldrig ska krascha (R5) ligger har: nedbrytning till stubbe/NoModel, tidsgranser,
 * och en close() som DODAR alla barnprocesser sa att ingen bakgrundstjanst lamnas kvar
 * (anvandarens harda krav, CONVENTIONS §Äkthet + AGENTS Regel 7 punkt 5).
 *
 * Filagare: endast packages/host/**. core/providers/mcp-client/protocol anvends via
 * sina publike exports — inget av dem raars.
 */

import * as path from "node:path";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  AI_SERVICE_DEFAULT_PORT,
  HOST_DEFAULT_PORT,
  PROTOCOL_VERSION,
  isRpcRequest,
  type EventFrame,
  type HostHealth,
  type RpcRequest,
  type RpcResponse,
} from "@nexus/protocol";
import {
  AiServiceClient,
  ApprovalBroker,
  CheckpointManager,
  ConfigStore,
  MemoryLog,
  TerminalManager,
  WorkspaceService,
  type Logger,
} from "@nexus/core";
import { ProviderRegistry, builtinProviderConfigs, type NexusLogSink } from "@nexus/providers";
import { DEFAULT_MCP_SERVERS, McpConfigStore, McpServerManager, findRepoRoot } from "@nexus/mcp-client";
import { AgentService } from "./agent-service";
import { ChatService } from "./chat-service";
import { createDispatcher, type Dispatcher } from "./dispatch";
import { EventBus } from "./events";
import { McpService } from "./mcp-service";
import { ModelGateway } from "./gateway";
import { RagService } from "./rag";
import { TerminalService } from "./terminal-service";
import { createVramProbe, nullVramProbe, type VramProbe } from "./vram";
import { checkpointSourceFor, type CheckpointSource } from "./write-gate";
import { HOST_NAME, HOST_VERSION } from "./version";
import type { ApprovalGateway, HostRuntime } from "./runtime";

export type { AiProbeSource, ApprovalGateway, HostRuntime } from "./runtime";
export { createDispatcher, registryCompleteness, type Dispatcher, type DispatchInput } from "./dispatch";
export { checkpointSourceFor, shouldCheckpoint, type CheckpointSource, type WriteKind } from "./write-gate";
export { EventBus, type AnyEventListener } from "./events";
export { HandlerRegistry } from "./registry";
export { TerminalService } from "./terminal-service";
export { AgentService } from "./agent-service";
export { ChatService } from "./chat-service";
export { McpService } from "./mcp-service";
export { RagService } from "./rag";
export { ModelGateway } from "./gateway";
export { HostError, toRpcError } from "./errors";
export { hardenValue, containsSecretShape } from "./harden";
export { createVramProbe, nullVramProbe, type VramProbe } from "./vram";
export { HOST_NAME, HOST_VERSION };

/** Host ar tacksam mot transporten: logger kan vara en fardig Logger ELLER strangen "silent". */
export interface CreateHostOptions {
  readonly root?: string;
  readonly workspaceRoot?: string;
  readonly envRoot?: string;
  readonly logger?: Logger | "silent" | string;
  readonly vram?: VramProbe;
  readonly approvalTimeoutMs?: number;
  /** Test-dockor och harness kan mata en egen ai-service-url. */
  readonly aiServiceUrl?: string;
  readonly mcpAutoStart?: boolean;
  /** Okanda nycklar (t.ex. stubChatBaseUrl, ollama) tillats — de ignoreras bara. */
  readonly [extra: string]: unknown;
}

/** Den fardiga host:en — runtime + dispatch + livscykel. */
export interface NexusHost extends HostRuntime {
  readonly dispatcher: Dispatcher;
  /** Köret tid och alla transport-event i ett anrop (for IPC och health-poll). */
  health(): Promise<HostHealth>;
  /** Stanger ALTIGT rent: dodar terminalbarn, stoppar MCP, avslutar streamar, stanger bussen. */
  close(): Promise<void>;
  /** Alias till close() — Electron-main och e2e-harness kan kalla nagdera. */
  shutdown(): Promise<void>;
  /** Registrerar en livscykel-stangare (WS-bron) sa host.close() aven stanger den. */
  onClose(cleanup: () => Promise<void> | void): void;
}

/** Tyst logger for miljoker (tester, "silent") — ingen samskrivning, inga kast. */
function silentLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    tail: () => [],
    path: "(silent)",
  };
}

function looksLikeLogger(value: unknown): value is Logger {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Logger).info === "function" &&
    typeof (value as Logger).debug === "function" &&
    typeof (value as Logger).tail === "function"
  );
}

/**
 * Host-lyftet for ApprovalBroker: core har ingen publike sattare for allowlist, men
 * settings.set maste kunna byta den i livande tid. Vi arver brokern och satter
 * den befintliga allowlist-arrayns innehall — inget core-falte dops om eller rors.
 */
class HostApprovalBroker extends ApprovalBroker implements ApprovalGateway {
  setAllowlist(list: readonly string[]): void {
    const target = this as unknown as { allowlist: string[] };
    target.allowlist = [...list];
  }
}

function bridgeLogSink(logger: Logger): NexusLogSink {
  return {
    log: (entry) => {
      const message = typeof entry.message === "string" ? entry.message : String(entry.message);
      const level = entry.level;
      if (level === "error") logger.error(message, { fas: entry.fas, modul: entry.modul });
      else if (level === "warn") logger.warn(message, { fas: entry.fas, modul: entry.modul });
      else if (level === "debug") logger.debug(message, { fas: entry.fas, modul: entry.modul });
      else logger.info(message, { fas: entry.fas, modul: entry.modul });
    },
  };
}

/**
 * Bygger host:en. Accepterar extra/okanda options-nycklar utan att faila — e2e-grinden
 * och desktop-main anropar med mer an vi behover och det ar avsiktligt.
 */
export function createHost(options: CreateHostOptions = {}): NexusHost {
  const root = path.resolve(options.root ?? process.cwd());
  const workspaceRoot = path.resolve(options.workspaceRoot ?? root);
  const envRoot = path.resolve(options.envRoot ?? root);
  const logger = looksLikeLogger(options.logger) ? options.logger : silentLogger();

  const config = ConfigStore.load({ root, dotenvPaths: [path.join(envRoot, ".env")] });
  const nexusDir = config.config.nexusDir;

  const events = new EventBus({
    onError: (message, name) => logger.warn(`event-lyssnare fel pa ${name}`, { message }),
  });

  // --- filer + checkpoints (Regel 5: varje filandring = checkpoint) ----------
  const workspace = new WorkspaceService({ root: workspaceRoot, logger });
  const checkpoints = new CheckpointManager({ root: workspaceRoot, nexusDir, logger });
  void checkpoints.ensure().catch((err: unknown) => logger.warn("skugg-git kunde inte initieras", { error: String(err) }));

  // --- godkannande -----------------------------------------------------------
  const approvals = new HostApprovalBroker({
    mode: config.get("approvalMode"),
    allowlist: [...config.get("allowlist")],
    logger,
    timeoutMs: options.approvalTimeoutMs,
  });

  // --- terminal (inga barn far leva kvar) ------------------------------------
  const terminalManager = new TerminalManager({
    root: workspaceRoot,
    logger,
    onOutput: (termId, data) => events.emit("terminal/output", { termId, data }),
    onExit: (termId, code) => {
      events.emit("terminal/exit", { termId, exitCode: code });
      terminals.markClosed(termId);
    },
  });
  const terminals = new TerminalService(terminalManager, events);

  // --- modellager + gateway --------------------------------------------------
  const providers = new ProviderRegistry({
    secrets: { read: (name) => config.secret(name) },
    logSink: bridgeLogSink(logger),
    onRoleChanged: (roles) => events.emit("model/changed", { roles }),
  });
  for (const builtin of builtinProviderConfigs()) {
    try {
      providers.upsert(builtin);
    } catch (err) {
      logger.warn("inbyggd provider kunde inte registreras", { id: builtin.id ?? builtin.label, error: String(err) });
    }
  }

  const mcpStore = new McpConfigStore({
    filePath: path.join(nexusDir, "mcp.json"),
    repoRoot: findRepoRoot(typeof __dirname === "string" ? __dirname : process.cwd()),
    workspaceRoot,
    env: { ...process.env, NEXUS_WORKSPACE_ROOT: workspaceRoot },
  });
  // Endast var EGEN offline-server startas vid boot — inga natverks-/npx-avhangigheter,
  // och en process i taget (AGENTS Regel 7). Resten hanteras via mcp.servers.*.
  const mcpServers = DEFAULT_MCP_SERVERS.map((server) => ({ ...server, enabled: server.id === "nexus-filesystem" && server.enabled }));
  try {
    mcpStore.write(mcpServers);
  } catch (err) {
    logger.warn("mcp.json kunde inte skrivas i workspacet", { error: String(err) });
  }
  const mcpManager = new McpServerManager({
    store: mcpStore,
    onEvent: (name, payload) => events.emitLoose(name, payload),
    enforceApprovals: true,
  });
  const mcp = new McpService({ manager: mcpManager, approvals, logger, events, enforceApprovals: true });

  const aiBaseUrl = options.aiServiceUrl ?? process.env.NEXUS_AI_SERVICE_URL ?? `http://127.0.0.1:${String(AI_SERVICE_DEFAULT_PORT)}`;
  const ai = new AiServiceClient({ baseUrl: aiBaseUrl, timeoutMs: 3000, logger });

  const gateway = new ModelGateway({
    registry: providers,
    logger,
    mcp: {
      listTools: () => mcp.listTools(),
      callTool: (qualifiedName, args) => mcp.callTool(qualifiedName, args),
    },
    emit: (name, payload) => events.emitLoose(name, payload),
    currentRunId: () => {
      const ids = agentService?.activeRunIds ?? [];
      return ids.length > 0 ? ids[ids.length - 1] : undefined;
    },
  });

  const rag = new RagService({
    workspace,
    nexusDir,
    logger,
    embedder: (texts) => gateway.embed(texts),
    delegate: ai,
    onProgress: (payload) => events.emit("rag/progress", payload),
    enabled: () => config.get("ragEnabled"),
  });

  const memory = new MemoryLog({
    progressFile: path.join(nexusDir, "PROGRESS.md"),
    decisionsFile: path.join(nexusDir, "agent-memory", "decisions.md"),
  });

  const chatService = new ChatService({
    nexusDir,
    gateway,
    logger,
    events,
    rag,
    ragEnabled: () => config.get("ragEnabled"),
    defaultMode: () => config.get("agentMode"),
  });

  const agentService = new AgentService({
    workspace,
    checkpoints,
    terminals: terminalManager,
    approvals,
    gateway,
    mcp,
    rag,
    logger,
    events,
    defaultMode: () => config.get("agentMode"),
    defaultMaxSteps: () => config.get("maxAgentSteps"),
  });

  const vram: VramProbe = options.vram ?? (process.env.NEXUS_VRAM_PROBE === "off" ? nullVramProbe : createVramProbe());

  const runtime: HostRuntime = {
    root,
    workspaceRoot,
    nexusDir,
    aiBaseUrl,
    startedAt: Date.now(),
    logger,
    events,
    config,
    workspace,
    checkpoints,
    approvals,
    terminals,
    providers,
    gateway,
    mcp,
    rag,
    memory,
    chat: chatService,
    agent: agentService,
    ai,
    vram,
    checkpointSourceFor: ((kind: CheckpointSource) => checkpointSourceFor(kind)) as (kind: CheckpointSource) => "agent" | "user" | "ai-edit" | "terminal",
  };

  const dispatcher = createDispatcher(runtime);

  // Filbevakning → fs/changed, sa att filtraden uppdateras i realtid (T1).
  const stopWatch = workspace.watch((change) => events.emit("fs/changed", change));

  const cleanups: Array<() => Promise<void> | void> = [stopWatch];
  const onClose = (cleanup: () => Promise<void> | void): void => {
    cleanups.push(cleanup);
  };

  // MCP-autostart vid boot sa att mcp.tools.list direkt visar namnrymdsverktyg (T4).
  if (options.mcpAutoStart !== false) {
    void mcp.startAll().catch((err: unknown) => logger.warn("MCP-autostart felade — server kan startas manuellt", { error: String(err) }));
  }

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    agentService.abortAll();
    chatService.abortAll();
    // Avliva alla vagentliga godkannanden forst — annars hanger event-transporten.
    approvals.denyAll();
    // Stang barnprocesser och MCP sa att inget blir foraldralost ( Regel 7 punkt 5).
    await Promise.allSettled([terminals.closeAll(), mcp.stopAll()]);
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (err) {
        logger.warn("stangare felade", { error: String(err) });
      }
    }
    // Provider-laget har inga livande socknar (fetch per anrop); MCP och terminal ar
    // de enda processagarna — bada ar nu avlivade.
    events.close();
  }

  const host: NexusHost = {
    ...runtime,
    dispatcher,
    health: () => dispatcher.invoke("host.health", {}) as unknown as Promise<HostHealth>,
    close,
    shutdown: close,
    onClose,
  };
  return host;
}

/** Skapar en host och returnerar den — alias sa att bade `createHost` och `bootHost` fungerar. */
export const bootHost = createHost;

// ---------------------------------------------------------------------------
// WebSocket-bron — protocol-ramar pa ws://127.0.0.1:<port>/ws
// ---------------------------------------------------------------------------

export interface StartWsOptions {
  readonly port?: number;
  readonly host?: NexusHost | HostRuntime;
}

export interface WsHandle {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Startar WebSocket-bron. Kallas pa BADA satt som e2e-grinden forvantar:
 *   startWsServer(host, { port })      (normal form)
 *   startWsServer({ host, port })      (tolerad om den anropas med ett enda objekt)
 * Binder ALLTIG loopback. Alla clients far alla server-initierade EventFrames.
 */
export function startWsServer(hostOrOptions: NexusHost | HostRuntime | StartWsOptions, maybeOptions: StartWsOptions = {}): WsHandle {
  const resolved = resolveWsArgs(hostOrOptions, maybeOptions);
  const host = resolved.host;
  const requestedPort = resolved.port;

  const httpServer: Server = createServer((_req, res) => {
    // Bron pratar WebSocket pa /ws; allt annat ar ett arligt, velformulerat 404.
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "NEXUS host-bron erbjuder enbart /ws" }));
  });
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  const clients = new Set<WebSocket>();
  // Fan-out: varje EventFrame skickas till ALLA levande clients (statusrad + panel + flik).
  const unsubscribe = host.events.on((frame: EventFrame) => {
    const encoded = JSON.stringify(frame);
    for (const client of clients) {
      if (client.readyState === client.OPEN) {
        try {
          client.send(encoded);
        } catch {
          // En dode client far aldrig stoppa flodet for de andra.
        }
      }
    }
  });

  wss.on("connection", (socket: WebSocket) => {
    clients.add(socket);
    socket.on("message", (raw: Buffer | string) => {
      void handleSocketMessage(host, socket, raw);
    });
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  const handle = (async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(requestedPort, "127.0.0.1", () => resolve());
    });
    const address = httpServer.address();
    const boundPort = typeof address === "object" && address !== null ? address.port : requestedPort;
    host.events.emit("host/ready", { port: boundPort, workspaceRoot: host.workspaceRoot, protocolVersion: PROTOCOL_VERSION });
  })().catch((err: unknown) => {
    host.logger.error("WS-bron kunde inte lyssna", { error: String(err) });
  });
  void handle;

  const port = (() => {
    const address = httpServer.address();
    return typeof address === "object" && address !== null ? address.port : requestedPort;
  })();

  // Hostens egen livscykel stanger aven bronen — inga kvarlamnade lyssnare.
  if (isNexusHost(host)) host.onClose(async () => await shutdown());

  async function shutdown(): Promise<void> {
    unsubscribe();
    for (const client of clients) {
      try {
        client.close();
      } catch {
        /* allredan stangd */
      }
    }
    clients.clear();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }

  return {
    get port(): number {
      const address = httpServer.address();
      return typeof address === "object" && address !== null ? address.port : requestedPort;
    },
    close: async (): Promise<void> => {
      await shutdown();
    },
  };
}

async function handleSocketMessage(host: HostRuntime, socket: WebSocket, raw: Buffer | string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    const reply: RpcResponse = { jsonrpc: "2.0", id: "parse-error", error: { code: -32700, message: "JSON kunde inte parstras" }, protocolVersion: PROTOCOL_VERSION };
    safeSend(socket, reply);
    return;
  }
  if (!isRpcRequest(parsed)) {
    const reply: RpcResponse = { jsonrpc: "2.0", id: "bad-request", error: { code: -32600, message: "Förfrågan är ingen giltig JSON-RPC 2.0-request" }, protocolVersion: PROTOCOL_VERSION };
    safeSend(socket, reply);
    return;
  }
  const reply = await host.dispatcher.dispatch(parsed as RpcRequest);
  safeSend(socket, reply);
}

function safeSend(socket: WebSocket, frame: RpcResponse): void {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    /* transporten ar redan dode — aldrig ett kast upp i WS-hanteraren */
  }
}

function resolveWsArgs(hostOrOptions: NexusHost | HostRuntime | StartWsOptions, maybeOptions: StartWsOptions): { host: HostRuntime; port: number } {
  const candidate: unknown = maybeOptions.port !== undefined || maybeOptions.host !== undefined ? { ...maybeOptions, ...(isStartWsOptions(hostOrOptions) ? hostOrOptions : {}) } : hostOrOptions;
  if (isStartWsOptions(candidate) && candidate.host !== undefined) {
    return { host: candidate.host, port: candidate.port ?? HOST_DEFAULT_PORT };
  }
  return { host: hostOrOptions as HostRuntime, port: maybeOptions.port ?? (isStartWsOptions(hostOrOptions) ? hostOrOptions.port : undefined) ?? HOST_DEFAULT_PORT };
}

function isStartWsOptions(value: unknown): value is StartWsOptions {
  return typeof value === "object" && value !== null && "host" in (value as Record<string, unknown>);
}

function isNexusHost(value: HostRuntime): value is NexusHost {
  return typeof (value as NexusHost).onClose === "function";
}

// ---------------------------------------------------------------------------
// Electron IPC — samma dispatch, bara en annan transport
// ---------------------------------------------------------------------------

/**
 * Handler som Electron main registrerar: ipcMain.handle("nexus", createIpcHandler(host)).
 * Samma request→response som WebSocket, men utan push-kanal (main webContents.send far
 * sjalv abonnera pa host.events via hostEventPump).
 */
export function createIpcHandler(host: HostRuntime): (event: unknown, request: RpcRequest) => Promise<RpcResponse> {
  return async (_event: unknown, request: RpcRequest): Promise<RpcResponse> => host.dispatcher.dispatch(request);
}

/**
 * Pumpar host-event till en Electron webContents-liknande sändare. Separerad fran
 * createIpcHandler sa main kan valja sin egen kanal. Returnerar avprenumeration.
 */
export function hostEventPump(host: HostRuntime, send: (channel: string, frame: EventFrame) => void, channel = "nexus/event"): () => void {
  return host.events.on((frame) => send(channel, frame));
}

/** Publik identitet — desktop-main loggar detta mot rendererns protocolVersion. */
export const HOST_IDENTITY = { name: HOST_NAME, version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION };

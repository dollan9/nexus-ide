/**
 * McpServerManager — alla servrar, en dynamisk registry (FAS 4.4).
 *
 * Anvar:
 *   - start manga servrar concurrently, per-server timeout + isolering (en dod
 *     eller langsam server far aldrig rivna de andra eller hanga livsloppet)
 *   - tools/list fran varje server vid start, och live-refresh nar en server
 *     skickar notifications/tools/list_changed
 *   - registry med namespace `<serverId>__<toolName>` via protokolhjarna
 *     mcpToolName/splitMcpToolName. Kollision ar strukturellt omojlig: server-id
 *     valideras utan "__" och splitMcpToolName tar forsta avgransare, sa
 *     (serverId, localName) -> qualified ar injectiv
 *   - events `mcp/changed` och `mcp/log`; per-server stderr infangad med serverId
 *   - stopAll() avlivar hela process-tradet (taskkill /T pa Windows)
 */

import { mcpToolName, splitMcpToolName } from "@nexus/protocol";
import type { JsonSchema, McpServerConfig, McpServerInfo, McpToolInfo, McpToolResult } from "@nexus/protocol";
import { McpConfigStore } from "./config_store";
import { DEFAULT_TIMEOUTS, McpConnection, makeToolResult, type McpTimeoutOptions } from "./mcp_connection";
import type { McpEventName, McpEventHandler, McpEventPayload, McpEventSink, McpRegisteredTool, McpToolDefinition } from "./types";

export interface McpServerManagerOptions {
  /** Config-lagret. Utelat: en egen store pa mcp.json-standarden. */
  readonly store?: McpConfigStore;
  /** Direkt config (test, eller host som redan last disk). Store anvands for mutationer. */
  readonly servers?: readonly McpServerConfig[];
  readonly timeouts?: Partial<McpTimeoutOptions>;
  /** Hur manga servrar som far handska samtidigt. Standard 6. */
  readonly maxConcurrentConnects?: number;
  /** Callback for mcp/changed + mcp/log (samma som on(), enklare for host). */
  readonly onEvent?: McpEventSink;
  /** Extra säkerhetslager: vi blockerar lokalt verktyg vars metadata kräver godkännande. */
  readonly enforceApprovals?: boolean;
}

interface Runtime {
  config: McpServerConfig;
  info: McpServerInfo;
  connection: McpConnection | null;
  tools: McpRegisteredTool[];
  /** Skyddar mot överlappande start/stopp för samma id. */
  busy: boolean;
  /**
   * Ökar vid varje nedstängning. En connectande worker jämför generationen när
   * den blir klar: har den ändrats blev servern stoppad under anslaget, och den
   * nyöppnade förbindelsen måste avlivas i stället för att lämnas som orphan.
   */
  generation: number;
}

const DEFAULT_CONCURRENCY = 6;

/**
 * Managern. En instans per host-process; den ager alla barnprocesser och MASTE
 * avlivas via stopAll() nar appen stanger (CONVENTIONS: inga bakgrundstjanster).
 */
export class McpServerManager {
  private readonly store: McpConfigStore;
  private readonly timeouts: McpTimeoutOptions;
  private readonly concurrency: number;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly registry = new Map<string, McpRegisteredTool>();
  private readonly listeners = new Map<McpEventName, Set<(payload: McpEventPayload<McpEventName>) => void>>();
  private readonly externalSink: McpEventSink | undefined;
  private readonly enforceApprovals: boolean;
  private started = false;

  constructor(options: McpServerManagerOptions = {}) {
    this.store = options.store ?? new McpConfigStore();
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...(options.timeouts ?? {}) };
    this.concurrency = Math.max(1, options.maxConcurrentConnects ?? DEFAULT_CONCURRENCY);
    this.externalSink = options.onEvent;
    this.enforceApprovals = options.enforceApprovals ?? false;

    const configs = options.servers !== undefined ? options.servers : this.readConfigs();
    for (const server of configs) this.runtimes.set(server.id, emptyRuntime(server));
  }

  /** Las disk utan att krascha: korrupt mcp.json ger tom lista + loggrad (R5). */
  private readConfigs(): readonly McpServerConfig[] {
    try {
      return this.store.read();
    } catch (err) {
      this.emit("mcp/log", { serverId: "mcp-config", line: `mcp.json kunde inte lasas: ${messageOf(err)}` });
      return [];
    }
  }

  /** Config-lagret som UI:t muterar genom. */
  getConfigStore(): McpConfigStore {
    return this.store;
  }

  /** Prenumerera pa klientevents. Returnerar avprenumeration. */
  on<N extends McpEventName>(name: N, handler: McpEventHandler<N>): () => void {
    const set = this.listeners.get(name) ?? new Set<(payload: McpEventPayload<McpEventName>) => void>();
    set.add(handler as (payload: McpEventPayload<McpEventName>) => void);
    this.listeners.set(name, set);
    return () => {
      set.delete(handler as (payload: McpEventPayload<McpEventName>) => void);
    };
  }

  private emit<N extends McpEventName>(name: N, payload: McpEventPayload<N>): void {
    const set = this.listeners.get(name);
    if (set !== undefined) {
      for (const handler of [...set]) {
        try {
          (handler as (p: McpEventPayload<N>) => void)(payload);
        } catch {
          // En lyssnare far aldrig dva hela transporten.
        }
      }
    }
    try {
      this.externalSink?.(name, payload);
    } catch {
      // Samma regel for extern callback (host:ens eventbus).
    }
  }

  /** Snapshot av alla servrar, i konfigurationsordning. */
  listServers(): McpServerInfo[] {
    return [...this.runtimes.values()].map((runtime) => ({ ...runtime.info, tools: [...runtime.info.tools] }));
  }

  /** Namespacade verktyg for alla anslutna servrar — det agentkarnan ser. */
  listTools(): McpToolInfo[] {
    return [...this.registry.values()].map(toToolInfo);
  }

  /** Samma lista men med sakerhetsmetadata (requiresApproval, risk). */
  listRegisteredTools(): McpRegisteredTool[] {
    return [...this.registry.values()];
  }

  getTool(qualifiedName: string): McpRegisteredTool | undefined {
    return this.registry.get(qualifiedName);
  }

  getServer(id: string): McpServerInfo | undefined {
    const runtime = this.runtimes.get(id);
    return runtime === undefined ? undefined : { ...runtime.info, tools: [...runtime.info.tools] };
  }

  /**
   * Process-pid för en stdio-server, annars null. Behövs för beviset att inget
   * barnprocess lämnas kvar efter stopAll (test) och för UI:s diagnostik.
   */
  pidOf(id: string): number | null {
    return this.runtimes.get(id)?.connection?.pid ?? null;
  }

  activeToolCount(): number {
    return this.registry.size;
  }

  private emitChanged(): void {
    this.emit("mcp/changed", { servers: this.listServers(), activeTools: this.registry.size });
  }

  /**
   * Starta alla aktiva servrar samtidigt. Återkommer ALLTID — per-server fel
   * samlas in i respektive McpServerInfo och andra servrar paverkas inte.
   */
  async startAll(): Promise<McpServerInfo[]> {
    this.started = true;
    const targets = [...this.runtimes.values()].filter((runtime) => runtime.config.enabled && runtime.info.status !== "connected");
    await this.runPool(targets, this.concurrency, (runtime) => this.connectRuntime(runtime));
    this.emitChanged();
    return this.listServers();
  }

  /** Ladda om fran disk och starta om allt (mcp.servers.reload). */
  async reload(): Promise<{ servers: McpServerInfo[]; activeTools: number }> {
    await this.stopAll();
    let servers: readonly McpServerConfig[];
    try {
      servers = this.store.read();
    } catch (err) {
      this.emit("mcp/log", { serverId: "mcp-config", line: `reload lyckades inte: ${messageOf(err)}` });
      return { servers: this.listServers(), activeTools: this.registry.size };
    }
    this.runtimes.clear();
    this.registry.clear();
    for (const server of servers) this.runtimes.set(server.id, emptyRuntime(server));
    await this.startAll();
    return { servers: this.listServers(), activeTools: this.registry.size };
  }

  /** Starta (eller starta om) en server for sig. */
  async start(id: string): Promise<McpServerInfo> {
    const runtime = this.runtimes.get(id);
    if (runtime === undefined) throw new Error(`okand server-id: ${id}`);
    await this.connectRuntime(runtime);
    this.emitChanged();
    return { ...runtime.info, tools: [...runtime.info.tools] };
  }

  /** Stang en server och avliva dess process-trad. */
  async stop(id: string): Promise<boolean> {
    const runtime = this.runtimes.get(id);
    if (runtime === undefined) return false;
    await this.disconnectRuntime(runtime, "stop");
    this.emitChanged();
    return true;
  }

  /**
   * Stang allt. Anropas vid host-avslutning. Garanterar att inget barnprocesstrad
   * lever kvar (testat pa Windows med taskkill /T-semantik).
   */
  async stopAll(): Promise<void> {
    const targets = [...this.runtimes.values()];
    await this.runPool(targets, Math.max(this.concurrency, targets.length), async (runtime) => {
      await this.disconnectRuntime(runtime, "stopAll");
    });
    this.registry.clear();
    for (const runtime of this.runtimes.values()) {
      runtime.tools = [];
      runtime.info = { ...runtime.info, status: "stopped", tools: [], resources: [], prompts: [], startedAt: undefined };
    }
    this.started = false;
    this.emitChanged();
  }

  /**
   * Call a tool by its namespaced name `<serverId>__<toolName>`.
   * Returnerar ALLTID ett McpToolResult — okand server, okant verktyg, timeout
   * och tool-fel ar alla ok:false med textlig forklaring, aldrig ett undantag.
   */
  async callTool(qualifiedName: string, args: Record<string, unknown>, options: { readonly approved?: boolean } = {}): Promise<McpToolResult> {
    const startedAt = Date.now();
    const { serverId, localName } = splitMcpToolName(qualifiedName);
    const tool = this.registry.get(qualifiedName);
    const runtime = this.runtimes.get(serverId);
    const connection = runtime?.connection ?? null;

    // En server som är stoppad eller avstängd registrerar inga verktyg alls. För ett namespace som
    // ändå pekar ut en känd server är "inte ansluten" det sanna svaret — "verktyg finns inte" får
    // användaren att jakta en felaktig gissning i stället för den riktiga orsaken.
    if (runtime !== undefined && (connection === null || !connection.isOpen)) {
      return {
        ok: false,
        text: "",
        tookMs: Date.now() - startedAt,
        error: `server ${serverId} ar inte ansluten (status ${String(runtime.info.status)})`,
      };
    }
    if (tool === undefined || localName.length === 0) {
      return { ok: false, text: "", tookMs: Date.now() - startedAt, error: `verktyg finns inte: ${qualifiedName}` };
    }
    if (runtime === undefined) {
      return { ok: false, text: "", tookMs: Date.now() - startedAt, error: `server ${serverId} ar inte ansluten (okand server)` };
    }
    // Explicit granskning hit medan (inte bara early-return ovan) — annars tappar TypeScript
    // narrowing och raden under blir TS18047. Beteendet är oförändrat, bara typen blir sann.
    if (connection === null || !connection.isOpen) {
      return {
        ok: false,
        text: "",
        tookMs: Date.now() - startedAt,
        error: `server ${serverId} ar inte ansluten (status ${String(runtime.info.status)})`,
      };
    }
    if (this.enforceApprovals && tool.requiresApproval && options.approved !== true) {
      return {
        ok: false,
        text: "",
        tookMs: Date.now() - startedAt,
        error: `verktyget ${qualifiedName} kraver godkannande (risk ${tool.risk})`,
        structured: { requiresApproval: true, serverId, localName, risk: tool.risk },
      };
    }
    try {
      const outcome = await connection.callTool(localName, args);
      return makeToolResult(outcome, Date.now() - startedAt);
    } catch (err) {
      const message = messageOf(err);
      this.emit("mcp/log", { serverId, line: `tools/call ${localName} fel: ${message}` });
      return { ok: false, text: "", tookMs: Date.now() - startedAt, error: message };
    }
  }

  // ------------------------------------------------------------------
  // UI-mutationer (FAS 4.2 + 4.4): alltid icke-forstorande vid fel.
  // ------------------------------------------------------------------

  /**
   * Lagg till eller ersatt en server. Skrivning till disk forst; lyckas inte
   * skrivningen rors varken registry eller igangvarande forbindelser. Lyckas
   * skrivningen men inte anslutningen far servern status "error" — de andra
   * serverns verktyg finns kvar i registry.
   */
  async upsert(server: McpServerConfig): Promise<McpServerInfo> {
    const existing = this.runtimes.get(server.id);
    let result;
    try {
      result = this.store.upsert(server);
    } catch (err) {
      // Korrupt mcp.json: lagret vill inte ens lasas. Icke-forstorande — inget
      // rors, servern rapporterar felet, igangvarande forbindelser lever vidare.
      const message = `upsert avvisad: ${messageOf(err)}`;
      this.emit("mcp/log", { serverId: server.id, line: message });
      return existing === undefined
        ? { id: server.id, label: server.label ?? server.id, transport: server.transport, status: "error", error: message, tools: [], resources: [], prompts: [] }
        : { ...existing.info, tools: [...existing.info.tools] };
    }
    if (!result.ok) {
      this.emit("mcp/log", { serverId: server.id, line: `upsert avvisad: ${result.error ?? "validering"}` });
      if (existing === undefined) {
        return { id: server.id, label: server.label ?? server.id, transport: server.transport, status: "error", error: result.error, tools: [], resources: [], prompts: [] };
      }
      return { ...existing.info, tools: [...existing.info.tools] };
    }
    if (existing !== undefined) await this.disconnectRuntime(existing, "upsert ersatter");
    const runtime = emptyRuntime(server);
    this.runtimes.set(server.id, runtime);
    if (server.enabled) await this.connectRuntime(runtime);
    this.emitChanged();
    return { ...runtime.info, tools: [...runtime.info.tools] };
  }

  /** Ta bort en server: stang forst, skriv sedan. Fel pa disk = angarning. */
  async remove(id: string): Promise<{ ok: boolean; error?: string }> {
    const runtime = this.runtimes.get(id);
    if (runtime === undefined) return { ok: false, error: `okand server-id: ${id}` };
    const snapshot = runtime.config;
    await this.disconnectRuntime(runtime, "remove");
    let result;
    try {
      result = this.store.remove(id);
    } catch (err) {
      const message = messageOf(err);
      this.emit("mcp/log", { serverId: id, line: `remove avvisad: ${message}` });
      const restored = emptyRuntime(snapshot);
      restored.info = { ...restored.info, status: "error", error: message };
      this.runtimes.set(id, restored);
      this.emitChanged();
      return { ok: false, error: message };
    }
    if (!result.ok) {
      // Aterstall i minnet sa att lagre och disk star i overensstammelse igen.
      const restored = emptyRuntime(snapshot);
      restored.info = { ...restored.info, status: "error", error: result.error };
      this.runtimes.set(id, restored);
      this.emitChanged();
      return { ok: false, error: result.error };
    }
    this.runtimes.delete(id);
    this.emitChanged();
    return { ok: true };
  }

  /**
   * Slå på/av. Avstängning deaktiverar servern. Påslagning ansluter; misslyckas
   * anslutningen reverseras `enabled` pa disk, sa att inte startAll loopar pa fel.
   */
  async toggle(id: string, enabled?: boolean): Promise<McpServerInfo> {
    const runtime = this.runtimes.get(id);
    if (runtime === undefined) {
      return { id, label: id, transport: "stdio", status: "error", error: `okand server-id: ${id}`, tools: [], resources: [], prompts: [] };
    }
    const targetEnabled = enabled ?? !runtime.config.enabled;
    let flip;
    try {
      flip = this.store.toggle(id, targetEnabled);
    } catch (err) {
      this.emit("mcp/log", { serverId: id, line: `toggle avvisad: ${messageOf(err)}` });
      return { ...runtime.info, tools: [...runtime.info.tools] };
    }
    if (!flip.ok) {
      this.emit("mcp/log", { serverId: id, line: `toggle avvisad: ${flip.error ?? "validering"}` });
      return { ...runtime.info, tools: [...runtime.info.tools] };
    }
    const stored = flip.servers.find((s) => s.id === id);
    if (stored === undefined) return { ...runtime.info, tools: [...runtime.info.tools] };

    runtime.config = stored;
    runtime.info = { ...runtime.info, label: stored.label ?? stored.id, transport: stored.transport };

    if (!stored.enabled) {
      await this.disconnectRuntime(runtime, "toggle av");
      this.emitChanged();
      return { ...runtime.info, tools: [...runtime.info.tools] };
    }
    await this.connectRuntime(runtime);
    if (runtime.info.status === "error") {
      // Icke-forstorande: en server som inte gar att starta lamnas avstangd, och
      // fran-slagningen pa disk far aldrig kasta upp genom anroparen.
      let revertedConfig: McpServerConfig | undefined;
      try {
        const reverted = this.store.toggle(id, false);
        revertedConfig = reverted.ok ? reverted.servers.find((s) => s.id === id) : undefined;
      } catch (err) {
        this.emit("mcp/log", { serverId: id, line: `automatisk fran-slagning lyckades inte: ${messageOf(err)}` });
      }
      if (revertedConfig !== undefined) {
        runtime.config = revertedConfig;
        runtime.info = { ...runtime.info, status: "stopped", error: `${runtime.info.error ?? "start lyckades inte"} (automatiskt fran-slaget)` };
      }
    }
    this.emitChanged();
    return { ...runtime.info, tools: [...runtime.info.tools] };
  }

  // ------------------------------------------------------------------
  // Intern livscykel
  // ------------------------------------------------------------------

  private async connectRuntime(runtime: Runtime): Promise<void> {
    if (runtime.busy) return;
    runtime.busy = true;
    const id = runtime.config.id;
    try {
      if (runtime.info.status === "connected" && runtime.connection !== null) return;
      runtime.info = { ...runtime.info, status: "starting", error: undefined, startedAt: Date.now() };

      let resolved;
      try {
        resolved = this.store.resolve(runtime.config);
      } catch (err) {
        const message = `konfigurationsupplösning: ${messageOf(err)}`;
        runtime.info = { ...runtime.info, status: "error", error: message };
        this.emit("mcp/log", { serverId: id, line: message });
        return;
      }
      if (resolved.missing.length > 0) {
        const message = `miljövariabel saknas: ${resolved.missing.join(", ")}`;
        runtime.info = { ...runtime.info, status: "error", error: message };
        this.emit("mcp/log", { serverId: id, line: message });
        return;
      }
      if (resolved.missingOptional.length > 0) {
        // Degradera mjuk: servern startes utan nyckeln, UI:t far veta varfor.
        this.emit("mcp/log", { serverId: id, line: `utesluter miljövariabler (ej satta): ${resolved.missingOptional.join(", ")}` });
      }

      const connection = new McpConnection(resolved, this.timeouts, {
        onStderrLine: (line) => this.emit("mcp/log", { serverId: id, line }),
        onToolsChanged: () => {
          void this.refreshTools(id).catch((err: unknown) => {
            this.emit("mcp/log", { serverId: id, line: `tools/list_changed-refresh fel: ${messageOf(err)}` });
          });
        },
        onClosed: (reason) => {
          const current = this.runtimes.get(id);
          if (current === undefined || current.connection !== connection) return;
          current.connection = null;
          current.info = { ...current.info, status: "stopped", error: reason };
          this.removeServerTools(id);
          this.emitChanged();
        },
      });
      runtime.connection = connection;
      const generation = runtime.generation;

      try {
        await connection.connect();
      } catch (err) {
        // Barnet kan ha spawnats fast handskaingen aldrig klarade — da MASTE
        // tradet avlivas har, annars har vi en foraldralos orphan-process for varje
        // misconfigurerad server. Loggningen ar testets bevis att sa inte sker.
        const killed = await connection.hardClose().catch(() => null);
        runtime.connection = null;
        runtime.info = { ...runtime.info, status: "error", error: messageOf(err) };
        this.emit("mcp/log", { serverId: id, line: `anslutning fel: ${messageOf(err)}${killed !== null && killed !== undefined ? ` (avlivade pid ${String(killed)})` : ""}` });
        return;
      }

      // Blev servern stoppad under handskaingen? Da far den nyoppna forbindelsen
      // ALDRIG tas i bruk — den avlivas har, sa stopAll inte lamnar ett barn kvar.
      if (runtime.generation !== generation) {
        await connection.hardClose().catch(() => undefined);
        if (runtime.connection === connection) runtime.connection = null;
        return;
      }

      try {
        const tools = await connection.listTools();
        const resources = await connection.listResourceNames();
        const prompts = await connection.listPromptNames();
        if (runtime.generation !== generation) {
          await connection.hardClose().catch(() => undefined);
          if (runtime.connection === connection) runtime.connection = null;
          return;
        }
        this.replaceServerTools(id, tools);
        runtime.info = {
          id,
          label: runtime.config.label ?? id,
          transport: runtime.config.transport,
          status: "connected",
          tools: tools.map((tool) => mcpToolName(id, tool.name)),
          resources,
          prompts,
          startedAt: Date.now(),
        };
        this.emit("mcp/log", { serverId: id, line: `ansluten, ${String(tools.length)} verktyg` });
      } catch (err) {
        const killed = await connection.hardClose().catch(() => null);
        runtime.connection = null;
        const message = `tools/list: ${messageOf(err)}`;
        runtime.info = { ...runtime.info, status: "error", error: message };
        this.emit("mcp/log", { serverId: id, line: `${message}${killed !== null && killed !== undefined ? ` (avlivade pid ${String(killed)})` : ""}` });
      }
    } finally {
      runtime.busy = false;
    }
  }

  private async disconnectRuntime(runtime: Runtime, reason: string): Promise<void> {
    const connection = runtime.connection;
    runtime.connection = null;
    // Signalerar för alla connectande workers att resultatet inte längre är brukbart.
    runtime.generation += 1;
    if (connection !== null) {
      // Forst graciost (stdio stanger stdin — var egen server avslutar da rent),
      // sedan trad-dreiv taskkill om pid:t inte vill darfor.
      await connection.close(2_500);
      if (connection.pid !== null && connection.transportKind === "stdio") {
        await connection.hardClose();
      }
    }
    this.removeServerTools(runtime.config.id);
    runtime.info = { ...runtime.info, status: "stopped", error: undefined, tools: [], startedAt: undefined };
    this.emit("mcp/log", { serverId: runtime.config.id, line: `stangd (${reason})` });
  }

  /** Last tools/list igen — anvands av notifications/tools/list_changed. */
  async refreshTools(id: string): Promise<McpRegisteredTool[]> {
    const runtime = this.runtimes.get(id);
    const connection = runtime?.connection;
    if (connection === undefined || connection === null || !connection.isOpen) return [];
    const tools = await connection.listTools();
    this.replaceServerTools(id, tools);
    if (runtime !== undefined) {
      runtime.info = { ...runtime.info, tools: tools.map((tool) => mcpToolName(id, tool.name)) };
      this.emit("mcp/log", { serverId: id, line: `registry uppdaterad: ${String(tools.length)} verktyg` });
      this.emitChanged();
      return runtime.tools;
    }
    return [];
  }

  private replaceServerTools(id: string, tools: readonly McpToolDefinition[]): void {
    this.removeServerTools(id);
    const runtime = this.runtimes.get(id);
    if (runtime === undefined) return;
    for (const definition of tools) {
      const qualified = mcpToolName(id, definition.name);
      if (this.registry.has(qualified)) {
        // Kan inte hända (id har aldrig "__"), men vi vägrar skriva över ett annat
        // servers verktyg i stallet for att anta att nagot ar fel.
        this.emit("mcp/log", { serverId: id, line: `kollision undveken: ${qualified}` });
        continue;
      }
      const registered = toRegistered(id, definition);
      this.registry.set(qualified, registered);
      runtime.tools.push(registered);
    }
  }

  private removeServerTools(id: string): void {
    for (const [qualified, tool] of this.registry) {
      if (tool.serverId === id) this.registry.delete(qualified);
    }
    const runtime = this.runtimes.get(id);
    if (runtime !== undefined) runtime.tools = [];
  }

  /** Enkel async-pool med begransad parallelism. */
  private async runPool<T>(items: readonly T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
    let index = 0;
    const lanes = Math.min(Math.max(1, size), items.length);
    const runners: Promise<void>[] = [];
    for (let lane = 0; lane < lanes; lane += 1) {
      runners.push(
        (async () => {
          for (;;) {
            const current = index;
            index += 1;
            const item = items[current];
            if (item === undefined) return;
            try {
              await worker(item);
            } catch {
              // connectRuntime samlar redan in fel i info; poolen far aldrig kasta.
            }
          }
        })(),
      );
    }
    await Promise.all(runners);
  }

  /**
   * Kontrollerar och återstartar servrar som dött av sig själva. Anropas med
   * intervall fra host — aldrig i den synkrona UI-vagen.
   */
  async healthCheck(): Promise<McpServerInfo[]> {
    for (const runtime of this.runtimes.values()) {
      if (runtime.config.enabled && runtime.connection !== null && !runtime.connection.isOpen) {
        runtime.connection = null;
        runtime.info = { ...runtime.info, status: "stopped", error: "forbindelsen tappades" };
        this.removeServerTools(runtime.config.id);
      }
    }
    if (this.started) {
      const down = [...this.runtimes.values()].filter((runtime) => runtime.config.enabled && runtime.info.status === "stopped");
      await this.runPool(down, this.concurrency, async (runtime) => {
        await this.connectRuntime(runtime);
      });
    }
    this.emitChanged();
    return this.listServers();
  }
}

function emptyRuntime(config: McpServerConfig): Runtime {
  return {
    config,
    info: {
      id: config.id,
      label: config.label ?? config.id,
      transport: config.transport,
      status: "stopped",
      tools: [],
      resources: [],
      prompts: [],
    },
    connection: null,
    tools: [],
    busy: false,
    generation: 0,
  };
}

/** Bygg McpRegisteredTool av serverdefinition + sakerhetsmetadata. */
export function toRegistered(serverId: string, definition: McpToolDefinition): McpRegisteredTool {
  const meta = definition._meta ?? {};
  const readOnly = definition.annotations?.readOnlyHint === true;
  const destructive = definition.annotations?.destructiveHint === true;
  const idempotent = definition.annotations?.idempotentHint === true;
  const openWorld = definition.annotations?.openWorldHint === true;
  const metaApproval = meta["requiresApproval"] === true;
  const requiresApproval = metaApproval || (destructive && !readOnly);
  const declaredRisk = meta["riskLevel"];
  const risk: McpRegisteredTool["risk"] =
    declaredRisk === "low" || declaredRisk === "medium" || declaredRisk === "high"
      ? declaredRisk
      : requiresApproval
        ? "high"
        : readOnly
          ? "low"
          : "medium";
  const qualified = mcpToolName(serverId, definition.name);
  const result: McpRegisteredTool = {
    name: qualified,
    qualifiedName: qualified,
    serverId,
    localName: definition.name,
    description: definition.description,
    inputSchema: (definition.inputSchema ?? { type: "object" }) as JsonSchema,
    readOnly,
    requiresApproval,
    destructive,
    idempotent,
    openWorld,
    risk,
  };
  if (definition.title !== undefined) return { ...result, title: definition.title };
  return result;
}

function toToolInfo(tool: McpRegisteredTool): McpToolInfo {
  return { name: tool.name, serverId: tool.serverId, localName: tool.localName, description: tool.description, inputSchema: tool.inputSchema, readOnly: tool.readOnly };
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return JSON.stringify(err);
}

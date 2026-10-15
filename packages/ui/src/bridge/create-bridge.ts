/**
 * bridge/create-bridge.ts — HostBridge ovanpå en Transport.
 *
 * Detta är den ENDSTA platsen renderer skapar löften mot host. Komponenter ser bara
 * `bridge.request("fs.read", {...})` och `bridge.on("chat/token", ...)`, aldrig en
 * transport, aldrig fetch, aldrig ipcRenderer.
 */
import {
  PROTOCOL_VERSION,
  type EventName,
  type HostBridge,
  type MethodName,
  type ParamsOf,
  type PayloadOf,
  type ResultOf,
  type RpcId,
} from "@nexus/protocol";
import {
  NexusError,
  PendingMap,
  checkProtocolVersion,
  decodeFrame,
  encodeRequest,
  nextRpcId,
  unwrapResponse,
} from "./frames";
import type { Transport, TransportKind } from "./transport";

/** HostBridge.transport är en sluten mängd i protokollet; postMessage är "in-process-liknande" (samma app, egen kanal). */
const TRANSPORT_TO_PROTOCOL: Record<TransportKind, HostBridge["transport"]> = {
  websocket: "websocket",
  "electron-ipc": "electron-ipc",
  postmessage: "in-process",
};

export interface BridgeOptions {
  readonly transport: Transport;
  readonly defaultTimeoutMs?: number;
  readonly log?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface BridgeDiagnostics {
  readonly transport: TransportKind;
  readonly describe: string;
  readonly connected: boolean;
  readonly pending: number;
  readonly pendingMethods: string[];
  readonly lastError: string | null;
  readonly protocolWarning: string | null;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly reconnects: number;
}

export interface NexusHostBridge extends HostBridge {
  readonly transportKind: TransportKind;
  readonly describe: string;
  /** Lyssna på alla events — för diagnostics-vyn och statusradens sista fel. */
  onAny(cb: (name: EventName, payload: unknown, ts: number) => void): () => void;
  /** Prestanda för statusrad: tid sedan senaste svar per metod. */
  lastLatencyMs(method: MethodName): number;
  onConnection(cb: (connected: boolean, detail: string) => void): () => void;
  diagnostics(): BridgeDiagnostics;
  /** Avbryt en pågående förfrågan (används av ghost-text när ett svar hunnit bli föråldrat). */
  cancelRequest(id: RpcId, reason?: string): boolean;
  start(): void;
  dispose(): void;
}

type AnyHandler = (name: EventName, payload: unknown, ts: number) => void;

export function createHostBridge(options: BridgeOptions): NexusHostBridge {
  const { transport } = options;
  const defaultTimeout = options.defaultTimeoutMs ?? 20000;
  const log = options.log ?? ((): void => undefined);
  const pending = new PendingMap();
  const listeners = new Map<EventName, Set<(payload: never) => void>>();
  const connectionListeners = new Set<(connected: boolean, detail: string) => void>();
  const anyListeners = new Set<AnyHandler>();
  const latency = new Map<MethodName, number>();

  let connected = false;
  let lastError: string | null = null;
  let protocolWarning: string | null = null;
  let bytesIn = 0;
  let bytesOut = 0;
  let reconnects = 0;
  let started = false;
  let disposed = false;

  const setConnected = (value: boolean, detail: string): void => {
    if (connected === value) return;
    connected = value;
    for (const cb of connectionListeners) cb(value, detail);
  };

  const handleData = (text: string): void => {
    bytesIn += text.length;
    const frame = decodeFrame(text);
    if (frame.kind === "noise") {
      log("warn", `förbisedd ram: ${frame.reason}`);
      return;
    }
    if (frame.kind === "response") {
      const warning = checkProtocolVersion(frame.response.protocolVersion);
      if (warning) protocolWarning = warning;
      const settled = pending.settle(frame.response);
      if (!settled) log("info", `svar utan förfrågan (id ${String(frame.response.id)})`);
      return;
    }
    const event = frame.event;
    const set = listeners.get(event.name as EventName);
    if (set) {
      for (const handler of [...set]) {
        const fn = handler as (payload: unknown) => void;
        try {
          fn(event.payload);
        } catch (err) {
          log("error", `event-handler för ${event.name} kastade: ${(err as Error).message}`);
        }
      }
    }
    for (const any of [...anyListeners]) {
      try {
        any(event.name, event.payload, event.ts);
      } catch (err) {
        log("error", `any-handler kastade: ${(err as Error).message}`);
      }
    }
  };

  const request = <M extends MethodName>(
    method: M,
    params: ParamsOf<M>,
    timeoutMs?: number,
  ): Promise<ResultOf<M>> => {
    if (disposed) return Promise.reject(new NexusError("bron är stängd", -32603, { method, reason: "disconnected" }));
    if (!started) bridge.start();
    const id: RpcId = nextRpcId();
    const limit = timeoutMs ?? defaultTimeout;
    const promise = pending.add(id, method, limit);
    const text = encodeRequest(id, method, params);
    bytesOut += text.length;
    if (!transport.write(text)) {
      log("warn", `ram köad (transporten stängd): ${method}`);
    }
    const startedAt = Date.now();
    return promise.then(
      (response) => {
        latency.set(method, Math.max(0, Date.now() - startedAt));
        return unwrapResponse(response, method);
      },
      (err: unknown) => {
        lastError = err instanceof NexusError ? err.message : String(err);
        throw err instanceof NexusError ? err : new NexusError(String(err), -32603, { method });
      },
    );
  };

  const bridge: NexusHostBridge = {
    transport: TRANSPORT_TO_PROTOCOL[transport.kind],
    transportKind: transport.kind,
    describe: transport.describe,
    get connected(): boolean {
      return connected;
    },
    request,
    on<E extends EventName>(name: E, handler: (payload: PayloadOf<E>) => void): () => void {
      let set = listeners.get(name);
      if (!set) {
        set = new Set();
        listeners.set(name, set);
      }
      const fn = handler as (payload: never) => void;
      set.add(fn);
      return () => {
        const current = listeners.get(name);
        if (!current) return;
        current.delete(fn);
        if (current.size === 0) listeners.delete(name);
      };
    },
    onAny(cb: AnyHandler): () => void {
      anyListeners.add(cb);
      return () => {
        anyListeners.delete(cb);
      };
    },
    onConnection(cb): () => void {
      connectionListeners.add(cb);
      cb(connected, transport.describe);
      return () => {
        connectionListeners.delete(cb);
      };
    },
    lastLatencyMs(method: MethodName): number {
      return latency.get(method) ?? 0;
    },
    cancelRequest(id: RpcId, reason?: string): boolean {
      return pending.cancel(id, reason);
    },
    diagnostics(): BridgeDiagnostics {
      return {
        transport: transport.kind,
        describe: transport.describe,
        connected,
        pending: pending.size,
        pendingMethods: pending.pendingMethods(),
        lastError,
        protocolWarning,
        bytesIn,
        bytesOut,
        reconnects,
      };
    },
    start(): void {
      if (started || disposed) return;
      started = true;
      transport.open({
        onData: handleData,
        onOpen(): void {
          if (connected) reconnects += 1;
          lastError = null;
          setConnected(true, transport.describe);
          log("info", `transport öppen: ${transport.kind} ${transport.describe}`);
        },
        onClose(info): void {
          setConnected(false, info.reason);
          lastError = info.reason;
          const dropped = pending.rejectAll(
            `host frånkopplad (${info.reason})`,
            "disconnected",
          );
          if (dropped > 0) log("warn", `${dropped} pågående förfrågningar avbröts`);
          if (!info.retryable) log("error", `transport stängd permanent: ${info.reason}`);
        },
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      pending.rejectAll("bron stängdes", "disconnected");
      transport.close();
      listeners.clear();
      anyListeners.clear();
      connectionListeners.clear();
    },
  };

  // Start direkt så att det första host.health:et kan skickas så fort kanalen är redo.
  bridge.start();
  return bridge;
}

/** Exponerad för tester och diagnostics: protokollversionen renderern kör. */
export const RENDERER_PROTOCOL_VERSION = PROTOCOL_VERSION;

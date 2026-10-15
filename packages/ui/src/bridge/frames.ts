/**
 * bridge/frames.ts — JSON-RPC-ramarna fram och tillbaka över alla tre transporterna.
 *
 * All logik här är ren och testbar: kodning, avkodning, klassificering, felöversättning
 * och korrelering av svar till förfrågningar (med tidsgräns). Transporterna är medvetet
 * dumma — de flyttar bara text-ramar — så att bara DENNA fil behöver förstå protokollet.
 *
 * En ram på tråden är alltid en JSON-text. Inga binära ramar, inga egna headerar.
 */
import {
  PROTOCOL_VERSION,
  isEventFrame,
  makeRequest as protoMakeRequest,
  type EventFrame,
  type EventName,
  type MethodName,
  type ParamsOf,
  type ResultOf,
  type RpcError,
  type RpcId,
  type RpcRequest,
  type RpcResponse,
} from "@nexus/protocol";

/** Klassificerad inkommande ram. `noise` = något vi inte förstår; den loggas men får aldrig krascha appen. */
export type InboundFrame =
  | { readonly kind: "response"; readonly response: RpcResponse }
  | { readonly kind: "event"; readonly event: EventFrame }
  | { readonly kind: "noise"; readonly raw: string; readonly reason: string };

export class NexusError extends Error {
  readonly code: number;
  readonly method?: MethodName;
  readonly data?: unknown;
  /** Kort, mänsklig orsak för statusraden. */
  readonly reason: "rpc" | "timeout" | "disconnected" | "protocol" | "encode";

  constructor(
    message: string,
    code: number,
    opts: { method?: MethodName; data?: unknown; reason?: NexusError["reason"] } = {},
  ) {
    super(message);
    this.name = "NexusError";
    this.code = code;
    this.method = opts.method;
    this.data = opts.data;
    this.reason = opts.reason ?? "rpc";
  }
}

/** ErrorCode-värden → stabil UI-nyckel, så paneler kan visa egna tillstånd utan sifferslutning. */
export const ERROR_KIND: Record<number, string> = {
  [-32600]: "bad-request",
  [-32601]: "method-not-found",
  [-32602]: "invalid-params",
  [-32603]: "internal",
  [-32001]: "approval-denied",
  [-32002]: "no-model",
  [-32003]: "ai-service-offline",
  [-32004]: "tool-not-found",
  [-32005]: "rate-limited",
  [-32006]: "checkpoint-not-found",
};

let counter = 0;

/** Monoton id per render-process; kollision med en annan flik är ofarlig eftersom svaret korreleras per anslutning. */
export function nextRpcId(prefix = "r"): RpcId {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

export function encodeRequest<M extends MethodName>(
  id: RpcId,
  method: M,
  params: ParamsOf<M>,
): string {
  const frame: RpcRequest<M> = protoMakeRequest(id, method, params);
  return JSON.stringify(frame);
}

/**
 * Avkodar en text-ram. Alltid total: kastar aldrig, returnerar `noise` med anledning,
 * så transporten kan logga utan att trasig data får UI:t att falla.
 */
export function decodeFrame(text: string): InboundFrame {
  if (typeof text !== "string" || text.length === 0) {
    return { kind: "noise", raw: text ?? "", reason: "empty frame" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { kind: "noise", raw: text, reason: `invalid json: ${(err as Error).message}` };
  }
  if (value === null || typeof value !== "object") {
    return { kind: "noise", raw: text, reason: "frame is not an object" };
  }
  const rec = value as Record<string, unknown>;
  if (isEventFrame(rec)) {
    return { kind: "event", event: rec as unknown as EventFrame };
  }
  if (rec["jsonrpc"] === "2.0" && "id" in rec) {
    const res = rec as unknown as RpcResponse;
    if (typeof res.id !== "number" && typeof res.id !== "string") {
      return { kind: "noise", raw: text, reason: "response id has wrong type" };
    }
    return { kind: "response", response: res };
  }
  return { kind: "noise", raw: text, reason: "unknown frame shape" };
}

/** Protokollmismatch är en varning, aldrig ett brott — annars låser sig utveckling mellan paket. */
export function checkProtocolVersion(reported: string | undefined): string | null {
  if (!reported) return "host reporterade ingen protocolVersion";
  if (reported === PROTOCOL_VERSION) return null;
  return `protokollmismatch: host ${reported} vs renderer ${PROTOCOL_VERSION}`;
}

export function errorFromRpc(err: RpcError, method: MethodName): NexusError {
  return new NexusError(err.message || ERROR_KIND[err.code] || "okänt fel", err.code, {
    method,
    data: err.data,
    reason: "rpc",
  });
}

/** Plockar ut resultatet ur ett svar och kastar NexusError vid fel-ram. */
export function unwrapResponse<M extends MethodName>(
  response: RpcResponse,
  method: M,
): ResultOf<M> {
  if (response.error) throw errorFromRpc(response.error, method);
  return response.result as ResultOf<M>;
}

export interface PendingEntry {
  readonly method: MethodName;
  readonly resolve: (value: RpcResponse) => void;
  readonly reject: (err: NexusError) => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Korrelerar svar till öppna förfrågningar och garanterar att inget löfte hänger för evigt:
 * varje post har tidsgräns, och `rejectAll` skjuter allt vid frånkoppling.
 */
export class PendingMap {
  private readonly entries = new Map<RpcId, PendingEntry>();

  /**
   * Timer-injection gör klassen testbar utan fake timers: testet styr själv när tiden går.
   */
  constructor(
    private readonly setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout> = (
      cb,
      ms,
    ) => setTimeout(cb, ms),
    private readonly clearTimer: (t: ReturnType<typeof setTimeout> | undefined) => void = (t) => {
      if (t !== undefined) clearTimeout(t);
    },
  ) {}

  add(id: RpcId, method: MethodName, timeoutMs: number): Promise<RpcResponse> {
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = timeoutMs > 0 ? this.setTimer(() => this.expire(id), timeoutMs) : undefined;
      this.entries.set(id, { method, resolve, reject, timer });
    });
  }

  /** Returnerar true om id:t tillhörde en öppna förfrågan (annars är svaret föråldrat). */
  settle(response: RpcResponse): boolean {
    const entry = this.entries.get(response.id);
    if (!entry) return false;
    this.entries.delete(response.id);
    this.clearTimer(entry.timer);
    entry.resolve(response);
    return true;
  }

  private expire(id: RpcId): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    entry.reject(
      new NexusError(`timeout: ${entry.method} svarade inte`, -32603, {
        method: entry.method,
        reason: "timeout",
      }),
    );
  }

  /** Avbryt en förfrågan explicit (t.ex. när användaren stänger en flik eller skrivning avbryts). */
  cancel(id: RpcId, message = "avbruten av användaren"): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    this.clearTimer(entry.timer);
    entry.reject(
      new NexusError(message, -32603, { method: entry.method, reason: "disconnected" }),
    );
    return true;
  }

  rejectAll(message: string, reason: NexusError["reason"] = "disconnected"): number {
    const ids = [...this.entries.keys()];
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      this.entries.delete(id);
      this.clearTimer(entry.timer);
      entry.reject(new NexusError(message, -32603, { method: entry.method, reason }));
    }
    return ids.length;
  }

  get size(): number {
    return this.entries.size;
  }

  /** För diagnostics: metoder som väntar, utan att röra löftena. */
  pendingMethods(): MethodName[] {
    return [...this.entries.values()].map((e) => e.method);
  }
}

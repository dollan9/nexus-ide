/**
 * bridge/detect.ts — autodetektering av transport. Ren funktion, testbar i node utan DOM.
 *
 * Ordning (första träff vinner):
 *   1. uttrycklig tvingning: ?transport=ws|postmessage|ipc, eller `window.nexusEnv.transport`
 *   2. MessagePort från preload  → postmessage   (Electron, samma fönster, ingen serialization av löften)
 *   3. ipcRenderer-yta i preload → electron-ipc  (Electron utan port)
 *   4. http/https (browser, dev, e2e) → websocket till ws://127.0.0.1:7946/ws
 *   5. file: utan preload         → websocket som ärligt fallback (host måste köra WS-server)
 */
import { resolveWsUrl, WS_DEFAULT_PORT, type TransportKind } from "./transport";

export interface DetectInput {
  readonly hasIpcSurface: boolean;
  readonly hasMessagePort: boolean;
  readonly protocol: string;
  readonly search: string;
  /** `window.nexusEnv` som main-processen kan injicera (adress, inte hemlighet). */
  readonly injectedTransport?: string;
  readonly injectedWsUrl?: string;
  readonly hostname?: string;
}

export interface Detected {
  readonly kind: TransportKind;
  readonly reason: string;
  readonly wsUrl: string;
}

const KIND_BY_QUERY: Record<string, TransportKind> = {
  ws: "websocket",
  websocket: "websocket",
  port: "postmessage",
  postmessage: "postmessage",
  ipc: "electron-ipc",
  "electron-ipc": "electron-ipc",
};

export function detectTransport(input: DetectInput): Detected {
  const params = new URLSearchParams(input.search || "");
  const forcedRaw = params.get("transport") ?? input.injectedTransport ?? undefined;
  const wsUrl = resolveWsUrl({
    explicit: params.get("ws") ?? params.get("host") ?? input.injectedWsUrl ?? undefined,
    hostname: input.hostname,
    port: numberParam(params.get("port")),
  });

  if (forcedRaw && forcedRaw !== "auto") {
    const forced = KIND_BY_QUERY[forcedRaw.toLowerCase()];
    if (forced) return { kind: forced, reason: `tvingad via ?transport=${forcedRaw}`, wsUrl };
  }
  if (forcedRaw === "auto") return pick(input, wsUrl, "tvingad auto");
  return pick(input, wsUrl, "autodetekterad");
}

function pick(input: DetectInput, wsUrl: string, prefix: string): Detected {
  if (input.hasMessagePort) {
    return { kind: "postmessage", reason: `${prefix}: MessagePort från preload`, wsUrl };
  }
  if (input.hasIpcSurface) {
    return { kind: "electron-ipc", reason: `${prefix}: ipcRenderer-yta i preload`, wsUrl };
  }
  if (input.protocol === "http:" || input.protocol === "https:") {
    return {
      kind: "websocket",
      reason: `${prefix}: webbläsarläge mot ${wsUrl}`,
      wsUrl,
    };
  }
  return {
    kind: "websocket",
    reason: `${prefix}: ${input.protocol || "okänd"} utan preload — fallback till ${wsUrl}`,
    wsUrl,
  };
}

function numberParam(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : undefined;
}

export { WS_DEFAULT_PORT };

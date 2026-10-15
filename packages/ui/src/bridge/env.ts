/**
 * bridge/env.ts — läser renderer-miljön och bygger transporten.
 *
 * All kontakt med `window` samlas här (och i context.tsx) så att resten av UI:t kan testas
 * utan DOM. Ingen komponent får läsa window.location eller hitta på en egen URL.
 */
import { detectTransport, type Detected } from "./detect";
import { createElectronIpcTransport } from "./electron-ipc";
import { createPostMessageTransport, type PortLike } from "./postmessage";
import { createWebSocketTransport } from "./websocket";
import type { ElectronIpcSurface, Transport, TransportKind, WebSocketOptions } from "./transport";

export interface RendererEnv {
  readonly protocol: string;
  readonly hostname: string;
  readonly search: string;
  readonly ipcSurface: ElectronIpcSurface | null;
  readonly messagePort: PortLike | null;
  readonly injectedTransport?: string;
  readonly injectedWsUrl?: string;
}

/** Kallas i browsern. I tester/node returneras en ofullständig miljö → websocket-fallback. */
export function readRendererEnv(): RendererEnv {
  if (typeof window === "undefined") {
    return { protocol: "", hostname: "127.0.0.1", search: "", ipcSurface: null, messagePort: null };
  }
  return {
    protocol: window.location?.protocol ?? "",
    hostname: window.location?.hostname || "127.0.0.1",
    search: window.location?.search ?? "",
    ipcSurface: window.nexusDesktop ?? null,
    messagePort: window.nexusHostPort ?? null,
    injectedTransport: window.nexusEnv?.transport,
    injectedWsUrl: window.nexusEnv?.wsUrl,
  };
}

export interface AutoResult {
  readonly transport: Transport;
  readonly detected: Detected;
  readonly kind: TransportKind;
}

export function buildTransport(env: RendererEnv, wsOptions: WebSocketOptions = {}): AutoResult {
  const detected = detectTransport({
    hasIpcSurface: env.ipcSurface !== null,
    hasMessagePort: env.messagePort !== null,
    protocol: env.protocol,
    search: env.search,
    injectedTransport: env.injectedTransport,
    injectedWsUrl: env.injectedWsUrl,
    hostname: env.hostname,
  });

  let transport: Transport;
  if (detected.kind === "postmessage" && env.messagePort) {
    transport = createPostMessageTransport({ port: env.messagePort });
  } else if (detected.kind === "electron-ipc" && env.ipcSurface) {
    transport = createElectronIpcTransport(env.ipcSurface);
  } else {
    // Websocket är alltid giltigt: host startar WS-bron i både dev- och desktop-läge,
    // så ett felvalt läge ger en återuppkopplingsloop istället för en död UI-process.
    transport = createWebSocketTransport({
      ...wsOptions,
      url: wsOptions.url ?? detected.wsUrl,
      env: { hostname: env.hostname, protocol: env.protocol || "http:" },
    });
  }
  return { transport, detected, kind: detected.kind };
}

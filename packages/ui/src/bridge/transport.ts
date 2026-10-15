/**
 * bridge/transport.ts — den enda nivån transporterna behöver uppfylla.
 *
 * En transport flyttar TEXT-RAMAR (JSON) fram och tillbaka. Den vet inget om metoder,
 * svar eller events — det sköts av create-bridge.ts. Därför kan vi byta WebSocket mot
 * postMessage mot Electron IPC utan att en enda komponent märker skillnaden.
 */

export type TransportKind = "websocket" | "postmessage" | "electron-ipc";

export interface TransportHandlers {
  /** Inkommande ram som text. Avkodning sker sen, här är det bara bytes → string. */
  onData(text: string): void;
  onOpen(): void;
  onClose(info: { readonly reason: string; readonly retryable: boolean }): void;
}

export interface Transport {
  readonly kind: TransportKind;
  /** Startar anslutningen. Får aldrig kasta — fel rapporteras via handlers.onClose. */
  open(handlers: TransportHandlers): void;
  /** Skickar en ram. Returnerar false om transporten inte är ögonblickligen skrivbar. */
  write(text: string): boolean;
  close(): void;
  readonly isOpen: boolean;
  /** Kort beskrivning av adressen, för statusrad och felsökning. */
  readonly describe: string;
}

/** Alternativ för WebSocket-transporten (webbläsarläge, dev-läge, e2e). */
export interface WebSocketOptions {
  readonly url?: string;
  readonly reconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
  /** Injectbar så test kan köra utan riktig WebSocket. */
  readonly socketFactory?: (url: string) => WebSocketLike;
}

/** Minimal yta vi kräver av en WebSocket — `WebSocket` i DOM uppfyller den via adaptern i websocket.ts. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
}

export const WS_DEFAULT_PATH = "/ws";
export const WS_DEFAULT_PORT = 7946;

/** Bygger ws:-url från värd/port/läge — loopback om inget anges (host lyssnar aldrig externt). */
export function resolveWsUrl(input: {
  readonly explicit?: string;
  readonly hostname?: string;
  readonly protocol?: string;
  readonly port?: number;
}): string {
  if (input.explicit) return input.explicit;
  const host = input.hostname && input.hostname.length > 0 ? input.hostname : "127.0.0.1";
  const port = input.port ?? WS_DEFAULT_PORT;
  const secure = input.protocol === "https:" || input.protocol === "wss:";
  return `${secure ? "wss" : "ws"}://${host}:${port}${WS_DEFAULT_PATH}`;
}

/** Ytan Electron-preadloaden exponerar (se apps/desktop/src/preload). Strukturtypad — UI:t känner inte till preload. */
export interface ElectronIpcSurface {
  readonly transport: "electron-ipc";
  readonly protocolVersion?: string;
  write(text: string): void;
  onFrame(cb: (text: string) => void): () => void;
}

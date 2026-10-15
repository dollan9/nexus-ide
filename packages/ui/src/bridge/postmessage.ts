/**
 * bridge/postmessage.ts — postMessage-transporten (Electron med MessagePort från preload).
 *
 * Preload skapar en MessageChannel, skickar port 2 till main via `ipcRenderer.postMessage`
 * och exponerar port 1 för rendereran. Därmed får vi en verklig strömmande kanal —
 * `ipcRenderer.invoke` kan bara returnera ett svar per anrop, vilket inte duger för
 * streaming-tokens. Allt är text-ramar på samma format som över WebSocket.
 */
import type { Transport, TransportHandlers } from "./transport";

export interface PortLike {
  postMessage(message: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  start?: () => void;
  close?: () => void;
}

export const CHANNEL = "nexus:frame";

export interface PostMessageOptions {
  readonly port?: PortLike;
  /** Alternativ: fönster-kanal (iframe/parent) med uttrycklig targetOrigin. */
  readonly target?: { postMessage(message: unknown, targetOrigin: string): void };
  readonly own?: { addEventListener(type: "message", cb: (ev: unknown) => void): void };
  readonly targetOrigin?: string;
}

function isFrameEnvelope(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (rec["channel"] === CHANNEL && typeof rec["text"] === "string") return rec["text"];
  }
  return null;
}

export function createPostMessageTransport(opts: PostMessageOptions): Transport {
  const { port, target, own } = opts;
  const origin = opts.targetOrigin ?? "*";
  let handlers: TransportHandlers | null = null;
  let open = false;
  const outbox: string[] = [];

  const attach = (): void => {
    if (port) {
      port.onmessage = (ev: { data: unknown }) => {
        const text = isFrameEnvelope(ev.data);
        if (text !== null) handlers?.onData(text);
      };
      port.start?.();
      return;
    }
    if (own) {
      own.addEventListener("message", (raw: unknown) => {
        const ev = raw as { data?: unknown };
        // Skydd: bara ramar med vårt channel-fält släpps igenom, resten är sidoljud från
        // andra skript i samma dokument (DevTools, extensioner, React DevTools).
        const text = isFrameEnvelope(ev.data);
        if (text !== null) handlers?.onData(text);
      });
    }
  };

  const deliver = (text: string): boolean => {
    if (!open) return false;
    if (port) {
      port.postMessage({ channel: CHANNEL, text });
      return true;
    }
    if (target) {
      target.postMessage({ channel: CHANNEL, text }, origin);
      return true;
    }
    return false;
  };

  return {
    kind: "postmessage",
    describe: port ? "MessagePort (preload)" : target ? "window.postMessage" : "postmessage (ingen kanal)",
    get isOpen(): boolean {
      return open;
    },
    open(h: TransportHandlers): void {
      handlers = h;
      if (!port && !target) {
        h.onClose({ reason: "postMessage: varken MessagePort eller target finns", retryable: false });
        return;
      }
      attach();
      open = true;
      h.onOpen();
      const pending = outbox.splice(0, outbox.length);
      for (const frame of pending) deliver(frame);
    },
    write(text: string): boolean {
      if (!open) {
        outbox.push(text);
        return false;
      }
      return deliver(text);
    },
    close(): void {
      open = false;
      handlers = null;
      outbox.length = 0;
      if (port) {
        port.onmessage = null;
        port.close?.();
      }
    },
  };
}

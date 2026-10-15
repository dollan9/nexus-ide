/**
 * bridge/websocket.ts — WebSocket-transporten (browser-läge, dev-läge, e2e).
 *
 * Vi pratar med host på ws://127.0.0.1:7946/ws. Ingen hämtning, ingen egen HTTP-route —
 * exakt samma JSON-RPC-ramar som över IPC. Automatisk återuppkoppling med backoff, och
 * en kö för ramar som skickas medan handskakningen pågår (annars tappar UI:t sitt första
 * host.health och statusraden förblir tom).
 */
import type { Transport, TransportHandlers, WebSocketLike, WebSocketOptions } from "./transport";
import { resolveWsUrl } from "./transport";

const OPEN = 1;

export interface WebSocketTransportEnv {
  readonly hostname?: string;
  readonly protocol?: string;
}

export function createWebSocketTransport(
  opts: WebSocketOptions & { readonly env?: WebSocketTransportEnv },
): Transport {
  const env = opts.env ?? {};
  const url =
    opts.url ??
    resolveWsUrl({ hostname: env.hostname ?? "127.0.0.1", protocol: env.protocol ?? "http:" });
  const factory = opts.socketFactory ?? defaultSocketFactory;
  const baseDelay = opts.reconnectDelayMs ?? 400;
  const maxDelay = opts.maxReconnectDelayMs ?? 8000;

  let socket: WebSocketLike | null = null;
  let handlers: TransportHandlers | null = null;
  let closedByUs = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outbox: string[] = [];

  const flush = (): void => {
    if (!socket || socket.readyState !== OPEN) return;
    const pending = outbox.splice(0, outbox.length);
    for (const frame of pending) {
      try {
        socket.send(frame);
      } catch (err) {
        handlers?.onClose({ reason: `send misslyckades: ${(err as Error).message}`, retryable: true });
        return;
      }
    }
  };

  const scheduleReconnect = (): void => {
    if (closedByUs || !handlers) return;
    attempt += 1;
    const delay = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
    timer = setTimeout(() => open(), delay);
  };

  function open(): void {
    if (closedByUs || !handlers) return;
    try {
      socket = factory(url);
    } catch (err) {
      handlers.onClose({ reason: `ws kunde inte skapas: ${(err as Error).message}`, retryable: true });
      scheduleReconnect();
      return;
    }
    socket.addEventListener("open", () => {
      attempt = 0;
      handlers?.onOpen();
      flush();
    });
    socket.addEventListener("message", (ev) => {
      const data = (ev as { data?: unknown }).data;
      if (typeof data === "string") handlers?.onData(data);
      else if (data instanceof Uint8Array) handlers?.onData(new TextDecoder().decode(data));
      else handlers?.onData(String(data ?? ""));
    });
    socket.addEventListener("close", (ev) => {
      const info = ev as { code?: number; reason?: string };
      handlers?.onClose({
        reason: info.reason || `stängd (kod ${info.code ?? "okänd"})`,
        retryable: info.code !== 1008,
      });
      socket = null;
      scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      handlers?.onClose({ reason: "ws-fel (host svarar inte)", retryable: true });
    });
  }

  return {
    kind: "websocket",
    describe: url,
    get isOpen(): boolean {
      return socket !== null && socket.readyState === OPEN;
    },
    open(h: TransportHandlers): void {
      handlers = h;
      closedByUs = false;
      open();
    },
    write(text: string): boolean {
      if (socket && socket.readyState === OPEN) {
        try {
          socket.send(text);
          return true;
        } catch {
          outbox.push(text);
          return false;
        }
      }
      outbox.push(text);
      if (outbox.length > 200) outbox.splice(0, outbox.length - 200);
      return false;
    },
    close(): void {
      closedByUs = true;
      handlers = null;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      outbox.length = 0;
      socket?.close(1000, "renderer stänger");
      socket = null;
    },
  };
}

/** Adapter så DOM:ens WebSocket uppfyller vår smala WebSocketLike utan typcast på objektet. */
function defaultSocketFactory(url: string): WebSocketLike {
  const ws = new WebSocket(url);
  return {
    get readyState(): number {
      return ws.readyState;
    },
    send: (data: string) => ws.send(data),
    close: (code?: number, reason?: string) => ws.close(code, reason),
    addEventListener: (type: string, listener: (ev: unknown) => void) =>
      ws.addEventListener(type, (ev: Event) => {
        listener(ev);
      }),
  };
}

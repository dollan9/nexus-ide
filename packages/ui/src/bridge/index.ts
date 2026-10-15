/**
 * bridge/index.ts — skapar bron med autodetektering. Den ENDSTA ingången till host.
 */
import { buildTransport, readRendererEnv, type RendererEnv } from "./env";
import { createHostBridge, type NexusHostBridge } from "./create-bridge";
import type { WebSocketOptions } from "./transport";

export interface AutoBridgeOptions {
  readonly env?: RendererEnv;
  readonly websocket?: WebSocketOptions;
  readonly defaultTimeoutMs?: number;
  readonly log?: (level: "info" | "warn" | "error", message: string) => void;
}

export function createAutoBridge(options: AutoBridgeOptions = {}): NexusHostBridge {
  const env = options.env ?? readRendererEnv();
  const { transport, detected } = buildTransport(env, options.websocket ?? {});
  const bridge = createHostBridge({
    transport,
    defaultTimeoutMs: options.defaultTimeoutMs,
    log: (level, message): void => {
      options.log?.(level, message);
      if (level === "error") console.error(`[nexus-bridge] ${message}`);
      else if (level === "warn") console.warn(`[nexus-bridge] ${message}`);
    },
  });
  // Transportvalet ska vara synligt: det är hela poängen med att samma UI kör i browser och desktop.
  console.info(`[nexus-bridge] ${detected.kind}: ${detected.reason} → ${transport.describe}`);
  return bridge;
}

export * from "./create-bridge";
export * from "./frames";
export * from "./transport";
export * from "./detect";
export * from "./env";
export { createWebSocketTransport } from "./websocket";
export { createPostMessageTransport, CHANNEL as POSTMESSAGE_CHANNEL } from "./postmessage";
export { createElectronIpcTransport } from "./electron-ipc";

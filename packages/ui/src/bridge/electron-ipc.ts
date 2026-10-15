/**
 * bridge/electron-ipc.ts — Electron IPC-transporten (native, utan MessagePort).
 *
 * Preload exponerar en smala ytan `window.nexusDesktop` med bara `write` + `onFrame`.
 * Ingen `ipcRenderer` läcker till renderer, ingen `process.env` läcker, och inget component
 * kan anropa ipcRenderer direkt — bara den här transporten, via HostBridge.
 */
import type { ElectronIpcSurface, Transport, TransportHandlers } from "./transport";

export function createElectronIpcTransport(surface: ElectronIpcSurface): Transport {
  let handlers: TransportHandlers | null = null;
  let detach: (() => void) | null = null;
  let open = false;
  const outbox: string[] = [];

  return {
    kind: "electron-ipc",
    describe: "ipcRenderer (nexusDesktop.write/onFrame)",
    get isOpen(): boolean {
      return open;
    },
    open(h: TransportHandlers): void {
      handlers = h;
      detach = surface.onFrame((text: string) => h.onData(text));
      open = true;
      h.onOpen();
      const pending = outbox.splice(0, outbox.length);
      for (const frame of pending) {
        try {
          surface.write(frame);
        } catch (err) {
          h.onClose({ reason: `ipc-write failed: ${(err as Error).message}`, retryable: false });
          open = false;
          return;
        }
      }
    },
    write(text: string): boolean {
      if (!open) {
        outbox.push(text);
        return false;
      }
      try {
        surface.write(text);
        return true;
      } catch (err) {
        handlers?.onClose({ reason: `ipc-write failed: ${(err as Error).message}`, retryable: false });
        open = false;
        return false;
      }
    },
    close(): void {
      open = false;
      handlers = null;
      detach?.();
      detach = null;
      outbox.length = 0;
    },
  };
}

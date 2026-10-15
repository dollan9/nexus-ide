import type { ElectronIpcSurface } from "./bridge/transport";
import type { PortLike } from "./bridge/postmessage";

declare global {
  interface Window {
    /** Electron-preadloadens smala yta (electron-ipc). Innehåller ALDRIG process.env. */
    nexusDesktop?: ElectronIpcSurface;
    /** MessagePort från preadload (postmessage). */
    nexusHostPort?: PortLike;
    /** Ofarliga adresser main-processen kan injicera — aldrig hemligheter. */
    nexusEnv?: {
      transport?: string;
      wsUrl?: string;
      workspaceRoot?: string;
      hostPort?: number;
    };
  }
}

export {};

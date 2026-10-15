/**
 * terminal-service.ts — en tunn host-del kring @nexus/core TerminalManager.
 *
 * Kärnan hall processerna och garanterar att inget barn överlever close(); den
 * vet bara inte vilka termId:s som existerar (skrivning mot en okand term ar en
 * tyst no-op dar). Det ar ett problem för protocol: terminal.input/resize/close
 * lovar `ok: boolean`, sa vi maste kunna sja att nej. Har ligger den kunskapen:
 * en levande mangd termId:n, uppdaterad av open() och av exit-callbacken.
 *
 * Output och exit vidareforas som terminal/output respektive terminal/exit —
 * samma ram oavsett om renderern ar ansluten via IPC eller WebSocket.
 */

import type { TerminalManager } from "@nexus/core";
import { HostError } from "./errors";
import type { EventBus } from "./events";

export interface TerminalHooks {
  onOutput(termId: string, data: string): void;
  onExit(termId: string, code: number | null): void;
}

export class TerminalService {
  private readonly live = new Set<string>();

  constructor(
    private readonly terminals: TerminalManager,
    private readonly events: EventBus,
  ) {}

  /** Hookar som MUST skickas med TerminalManager-konstruktorn for att events ska flyta. */
  static hooks(events: EventBus, onExit?: (termId: string, code: number | null) => void): TerminalHooks {
    return {
      onOutput: (termId, data) => {
        events.emit("terminal/output", { termId, data });
      },
      onExit: (termId, code) => {
        events.emit("terminal/exit", { termId, exitCode: code });
        onExit?.(termId, code);
      },
    };
  }

  markLive(termId: string): void {
    this.live.add(termId);
  }

  markClosed(termId: string): void {
    this.live.delete(termId);
  }

  isLive(termId: string): boolean {
    return this.live.has(termId);
  }

  get openCount(): number {
    return this.live.size;
  }

  async open(opts?: { cwd?: string; cols?: number; rows?: number }): Promise<{ termId: string; pid: number; shell: string }> {
    const opened = await this.terminals.open(opts);
    this.live.add(opened.termId);
    return opened;
  }

  write(termId: string, data: string): boolean {
    if (!this.live.has(termId)) return false;
    this.terminals.write(termId, data);
    return true;
  }

  resize(termId: string, cols: number, rows: number): boolean {
    if (!this.live.has(termId)) return false;
    this.terminals.resize(termId, cols, rows);
    return true;
  }

  async close(termId: string): Promise<boolean> {
    if (!this.live.has(termId)) {
      // Redan stangd eller okand — inget att gora, men aldrig ett hang.
      return false;
    }
    await this.terminals.close(termId);
    this.live.delete(termId);
    return true;
  }

  /** Stäng allt — host.close() kallar denna; inga bakgrundsprocesser får leva kvar. */
  async closeAll(): Promise<void> {
    const ids = [...this.live];
    for (const id of ids) {
      try {
        await this.terminals.close(id);
      } catch (err) {
        throw HostError.internal(`terminal.close misslyckades for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.live.clear();
  }

  exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<{ stdout: string; stderr: string; exitCode: number; tookMs: number; timedOut: boolean }> {
    return this.terminals.exec(cmd, opts);
  }

  isPidAlive(pid: number): boolean {
    return this.terminals.isPidAlive(pid);
  }
}

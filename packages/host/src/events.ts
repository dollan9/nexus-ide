/**
 * events.ts — event-bussen (fan-out) som alla streamingsvar går igenom.
 *
 * Varför en egen buss i stället för att returnera async-iteratorer per anrop:
 * transporten (Electron IPC och WebSocket) har EN långlivad kanal per renderer,
 * och flera lyssnare (statusrad, chat-panel, terminal-flik) vill se samma ram
 * samtidigt. dispatch() ger svaret, bussen ger resten av sanningen.
 *
 * Ingen lyssnare får aldrig kunna kväsa en annan: varje anrop wrapppas i try/catch
 * och felet går bara till logger (R5 — appen får aldrig krascha).
 */

import { makeEvent, type EventFrame, type EventName, type PayloadOf } from "@nexus/protocol";

/** Lyssnare på hela flödet (transporter använder denna). */
export type AnyEventListener = (frame: EventFrame) => void;

/**
 * Internal lagringstyp. `(payload: never) => void` är den enda typen Alla
 * specifika handlerar är tilldelningsbara utan cast (kontravarians), och
 * kartan är namnrymds­separerad per event — så anropet är trotzdem typsäkert.
 */
type StoredHandler = (payload: never) => void;

export interface EventBusOptions {
  readonly onError?: (message: string, eventName: EventName) => void;
  /** Räkna emit:er — health/diagnostics och tester läs av detta. */
  readonly onEmitted?: (name: EventName) => void;
}

export class EventBus {
  private readonly wildcards = new Set<AnyEventListener>();
  private readonly named = new Map<EventName, Set<StoredHandler>>();
  private closed = false;
  private emitted = 0;

  constructor(private readonly options: EventBusOptions = {}) {}

  /** Prenumerera på alla event. Returnerar avprenumeration. */
  on(listener: AnyEventListener): () => void {
    if (this.closed) return () => undefined;
    this.wildcards.add(listener);
    return () => {
      this.wildcards.delete(listener);
    };
  }

  /** Prenumerera på ett namngivet event, med typed payload. */
  onNamed<E extends EventName>(name: E, handler: (payload: PayloadOf<E>) => void): () => void {
    if (this.closed) return () => undefined;
    const set = this.named.get(name) ?? new Set<StoredHandler>();
    const stored = handler as StoredHandler;
    set.add(stored);
    this.named.set(name, set);
    return () => {
      set.delete(stored);
      const current = this.named.get(name);
      if (current !== undefined && current.size === 0) this.named.delete(name);
    };
  }

  emit<E extends EventName>(name: E, payload: PayloadOf<E>): void {
    this.publish(makeEvent(name, payload));
  }

  /**
   * Lösningen för kärnans lösa emit-signatur (`(e: EventName, p: unknown) => void`
   * i @nexus/core AgentToolContext). Kärnan producerar redan protocol-formade
   * payloads; den här metoden är den enda platsen där typen vidgas medvetet.
   */
  emitLoose(name: EventName, payload: unknown): void {
    this.publish({ type: "event", name, payload: payload as PayloadOf<EventName>, ts: Date.now() });
  }

  private publish(frame: EventFrame): void {
    if (this.closed) return;
    this.emitted += 1;
    try {
      this.options.onEmitted?.(frame.name);
    } catch (err) {
      this.report(err, frame.name);
    }
    for (const listener of [...this.wildcards]) {
      try {
        listener(frame);
      } catch (err) {
        this.report(err, frame.name);
      }
    }
    const set = this.named.get(frame.name);
    if (set !== undefined) {
      for (const handler of [...set]) {
        try {
          handler(frame.payload as never);
        } catch (err) {
          this.report(err, frame.name);
        }
      }
    }
  }

  private report(err: unknown, name: EventName): void {
    const message = err instanceof Error ? err.message : String(err);
    try {
      this.options.onError?.(message, name);
    } catch {
      // En felrapportör som felar får aldrig stoppa flödet.
    }
  }

  get emitCount(): number {
    return this.emitted;
  }

  get listenerCount(): number {
    return this.wildcards.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
    this.wildcards.clear();
    this.named.clear();
  }
}

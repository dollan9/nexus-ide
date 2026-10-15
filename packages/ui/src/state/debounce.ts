/**
 * state/debounce.ts — avbrytbar debounce med injicerbar scheduler (testbar utan fake timers).
 *
 * Autocomplete använder denna: 300 ms efter sista tangenttryck, och varje nytt tryck
 * ersätter det tidigare inlägget så att ingen gammal begäran skickas.
 */

export interface Scheduler {
  set(cb: () => void, ms: number): ReturnType<typeof setTimeout>;
  clear(handle: ReturnType<typeof setTimeout> | undefined): void;
}

export const realScheduler: Scheduler = {
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (handle) => {
    if (handle !== undefined) clearTimeout(handle);
  },
};

export interface Debounced<A extends readonly unknown[]> {
  (...args: A): void;
  cancel(): void;
  /** Kör omedelbart om något väntar (används när användaren trycker Tab eller stänger filen). */
  flush(): void;
  readonly pending: boolean;
  readonly scheduledMs: number;
}

export function createDebounce<A extends readonly unknown[]>(
  fn: (...args: A) => void,
  ms: number,
  scheduler: Scheduler = realScheduler,
): Debounced<A> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: A | undefined;
  let pending = false;

  const wrapped = (...args: A): void => {
    lastArgs = args;
    pending = true;
    scheduler.clear(handle);
    handle = scheduler.set(() => {
      handle = undefined;
      pending = false;
      const call = lastArgs;
      lastArgs = undefined;
      if (call) fn(...call);
    }, Math.max(0, ms));
  };

  return Object.defineProperties(wrapped, {
    cancel: { value: () => {
      scheduler.clear(handle);
      handle = undefined;
      lastArgs = undefined;
      pending = false;
    } },
    flush: { value: () => {
      if (!pending) return;
      scheduler.clear(handle);
      handle = undefined;
      pending = false;
      const call = lastArgs;
      lastArgs = undefined;
      if (call) fn(...call);
    } },
    pending: { get: () => pending },
    scheduledMs: { get: () => ms },
  }) as Debounced<A>;
}

/**
 * En "senaste svar vinner"-guard. Varje anrop får ett löpande nummer; endast det
 * senaste numret får skriva till state. Detta är mekanismen som gör att ett föråldrat
 * completion-svar aldrig hamnar i editorn.
 */
export function createSeqGuard(): { next(): number; current(): number; isLatest(seq: number): boolean } {
  let seq = 0;
  return {
    next(): number {
      seq += 1;
      return seq;
    },
    current(): number {
      return seq;
    },
    isLatest(candidate: number): boolean {
      return candidate === seq;
    },
  };
}

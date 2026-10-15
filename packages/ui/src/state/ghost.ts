/**
 * state/ghost.ts — ghost-text-maskinen för autocomplete (FIM).
 *
 * Tillstånd:
 *   idle        — ingen väntande/begäran
 *   scheduled   — debounce löper, än har ingen begäran skickats
 *   requesting  — begäran nr N är ute
 *   shown       — svar för begäran N visas som ghost
 *   dismissed   — användaren avvisade; blockera nya tills texten flyttats
 *
 * Det viktigaste felet vi skyddar mot: ett sent svar från en gammal begäran som hamnar i
 * editorn efter att användaren skrivit vidare. Varje begäran bär ett `seq`, och
 * `ghostReducer` kastar allt som inte matchar nuvarande seq. Maskinen är ren → testbar.
 */
import type { ModelSource } from "@nexus/protocol";

export type GhostStatus = "idle" | "scheduled" | "requesting" | "shown" | "dismissed" | "skipped";

export interface GhostState {
  readonly status: GhostStatus;
  readonly seq: number;
  /** Innehållet i det svar som faktiskt visas. */
  readonly text: string;
  readonly model: string;
  readonly providerId: string;
  readonly source: ModelSource;
  readonly latencyMs: number;
  readonly cached: boolean;
  readonly skipped: string | null;
  readonly error: string | null;
  readonly line: number;
  readonly column: number;
  readonly requestedAt: number;
  readonly shownAt: number;
}

export type GhostEvent =
  | { type: "input"; seq: number; line: number; column: number; at: number }
  | { type: "sent"; seq: number; at: number }
  | { type: "response"; seq: number; at: number; text: string; model: string; providerId: string; source: ModelSource; latencyMs: number; cached: boolean }
  | { type: "skipped"; seq: number; reason: string }
  | { type: "error"; seq: number; message: string }
  | { type: "accepted" }
  | { type: "dismissed"; reason: "escape" | "moved" | "blur" | "typing" }
  | { type: "reset" };

export function initialGhostState(): GhostState {
  return {
    status: "idle",
    seq: 0,
    text: "",
    model: "",
    providerId: "",
    source: "none",
    latencyMs: 0,
    cached: false,
    skipped: null,
    error: null,
    line: 0,
    column: 0,
    requestedAt: 0,
    shownAt: 0,
  };
}

/** Ett svar är föråldrat om dess seq inte längre är det senaste eller maskinen lämnat `requesting`. */
export function isStale(state: GhostState, seq: number): boolean {
  return seq !== state.seq || (state.status !== "requesting" && state.status !== "scheduled");
}

export function ghostReducer(state: GhostState, event: GhostEvent): GhostState {
  switch (event.type) {
    case "input":
      // Nytt tangenttryck: gamla begäranden är dömda. seq ökar så svaret kasseras.
      return {
        ...state,
        status: "scheduled",
        seq: event.seq,
        text: "",
        error: null,
        skipped: null,
        line: event.line,
        column: event.column,
        shownAt: 0,
      };

    case "sent":
      if (event.seq !== state.seq) return state;
      if (state.status !== "scheduled") return state;
      return { ...state, status: "requesting", requestedAt: event.at };

    case "response": {
      if (isStale(state, event.seq)) return state;
      if (event.text.length === 0) return { ...state, status: "idle", text: "" };
      return {
        ...state,
        status: "shown",
        text: event.text,
        model: event.model,
        providerId: event.providerId,
        source: event.source,
        latencyMs: event.latencyMs,
        cached: event.cached,
        skipped: null,
        error: null,
        shownAt: event.at,
      };
    }

    case "skipped":
      if (event.seq !== state.seq) return state;
      return { ...state, status: "skipped", text: "", skipped: event.reason, error: null };

    case "error":
      if (isStale(state, event.seq)) return state;
      return { ...state, status: "idle", text: "", error: event.message, latencyMs: 0 };

    case "accepted":
      return { ...initialGhostState(), seq: state.seq };

    case "dismissed":
      if (state.status !== "shown" && state.status !== "requesting") return state;
      return {
        ...initialGhostState(),
        seq: state.seq,
        status: "dismissed",
        skipped: event.reason,
        line: state.line,
        column: state.column,
      };

    case "reset":
      return initialGhostState();

    default:
      return state;
  }
}

/** Ska ett nytt in-data-läge alls trigga en begäran? (Inte mitt i dismissed utan textförändring.) */
export function shouldRequestOnInput(state: GhostState, positionChanged: boolean): boolean {
  if (state.status === "dismissed" && !positionChanged) return false;
  return true;
}

/** Flyttar ghost-accept: texten som ska sättas in i editorn. */
export function acceptText(state: GhostState): string {
  return state.status === "shown" ? state.text : "";
}

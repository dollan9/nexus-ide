/**
 * state/approvals.ts — godkännandeflödet (ask | allowlist | auto) som ren logik.
 *
 * Host äger den verkliga ApprovalBrokern; UI:t håller bara kön, besluten och allowlist-
 * redigeringen. Allt här är testbart utan DOM och utan bridge: beslutsfunktionen nedan är
 * samma regeluppsättning som broker använder, så UI visar aldrig en annan politik än host.
 */
import type { ApprovalMode, ApprovalRequest } from "@nexus/protocol";

export interface ApprovalState {
  readonly queue: ApprovalRequest[];
  readonly resolved: Record<string, ApprovalDecisionRecord>;
  readonly alwaysAllow: string[];
  readonly sending: string | null;
  readonly error: string | null;
}

export interface ApprovalDecisionRecord {
  readonly decision: "allow" | "deny" | "always";
  readonly at: number;
}

export type ApprovalAction =
  | { type: "queue/set"; requests: readonly ApprovalRequest[] }
  | { type: "queue/add"; request: ApprovalRequest }
  | { type: "queue/remove"; id: string }
  | { type: "decide"; id: string; decision: "allow" | "deny" | "always"; at: number }
  | { type: "sending"; id: string | null }
  | { type: "error"; message: string | null }
  | { type: "allowlist/set"; entries: readonly string[] };

export function initialApprovalState(): ApprovalState {
  return { queue: [], resolved: {}, alwaysAllow: [], sending: null, error: null };
}

export function approvalReducer(state: ApprovalState, action: ApprovalAction): ApprovalState {
  switch (action.type) {
    case "queue/set": {
      const seen = new Set(state.queue.map((r) => r.id));
      const merged = [...action.requests];
      // Behåll lokala förfrågningar som ännu inte hunnit synas i host-svaret.
      for (const local of state.queue) {
        if (!merged.some((r) => r.id === local.id) && !seen.has(local.id)) merged.push(local);
      }
      return { ...state, queue: sortQueue(merged) };
    }
    case "queue/add": {
      if (state.queue.some((r) => r.id === action.request.id)) return state;
      return { ...state, queue: sortQueue([...state.queue, action.request]) };
    }
    case "queue/remove":
      return { ...state, queue: state.queue.filter((r) => r.id !== action.id) };
    case "decide": {
      const request = state.queue.find((r) => r.id === action.id);
      const queue = state.queue.filter((r) => r.id !== action.id);
      const resolved = { ...state.resolved, [action.id]: { decision: action.decision, at: action.at } };
      const alwaysAllow =
        request && action.decision === "always" && request.command
          ? addRule(state.alwaysAllow, request.command)
          : state.alwaysAllow;
      return { ...state, queue, resolved, alwaysAllow };
    }
    case "sending":
      return { ...state, sending: action.id };
    case "error":
      return { ...state, error: action.message };
    case "allowlist/set":
      return { ...state, alwaysAllow: [...action.entries] };
    default:
      return state;
  }
}

/** Farligst först, sedan kronologiskt — en high-risk-begäran får inte begravas bakom lågrisk. */
export function sortQueue(requests: readonly ApprovalRequest[]): ApprovalRequest[] {
  const weight = { high: 0, medium: 1, low: 2 } as const;
  return [...requests].sort(
    (a, b) => weight[a.risk] - weight[b.risk] || a.createdAt - b.createdAt,
  );
}

export type BrokerDecision = "allow" | "ask" | "deny";

/**
 * Beslutsreglen. `auto` tillåter allt; `allowlist` tillåter matchande och frågar resten;
 * `ask` frågar allt som inte står på allowlisten (allowlist gäller fortfarande som genväg).
 */
export function decideFor(
  mode: ApprovalMode,
  allowlist: readonly string[],
  command: string,
  kind: ApprovalRequest["kind"] = "terminal",
): BrokerDecision {
  if (mode === "auto") return "allow";
  const normalized = normalizeCommand(command);
  if (normalized.length === 0 && kind === "terminal") return "ask";
  if (matchesAllowlist(allowlist, normalized)) return "allow";
  return "ask";
}

export function matchesAllowlist(allowlist: readonly string[], command: string): boolean {
  const normalized = normalizeCommand(command);
  return allowlist.some((entry) => {
    const rule = normalizeCommand(entry);
    if (rule.length === 0) return false;
    if (rule.endsWith("*")) return normalized.startsWith(rule.slice(0, -1).trim());
    return normalized === rule || normalized.startsWith(`${rule} `);
  });
}

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLowerCase();
}

/** "Always" skriver en regel: hela kommandot, eller prefixet före första pipe/&&. */
export function addRule(allowlist: readonly string[], command: string): string[] {
  const rule = firstSegment(normalizeCommand(command));
  if (rule.length === 0 || allowlist.some((entry) => normalizeCommand(entry) === rule)) {
    return [...allowlist];
  }
  return [...allowlist, rule];
}

export function removeRule(allowlist: readonly string[], rule: string): string[] {
  const target = normalizeCommand(rule);
  return allowlist.filter((entry) => normalizeCommand(entry) !== target);
}

export function parseAllowlist(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function firstSegment(command: string): string {
  return command.split(/\s*(?:&&|\|\||;|\|)\s*/)[0]?.trim() ?? "";
}

export function riskLabel(risk: ApprovalRequest["risk"]): string {
  return risk === "high" ? "hög risk" : risk === "medium" ? "medelrisk" : "låg risk";
}

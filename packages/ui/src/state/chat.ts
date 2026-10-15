/**
 * state/chat.ts — AI-panelens tillståndsmaskin (ren, reducer, testbar).
 *
 * Host skickar chat/token | chat/done | chat/error och agent/*-events. Vi plockar isär
 * det till: meddelandelista med streaming, tidslinje av tool-anrop, plansteg och checkpoint-
 * händelser. Allt flöde går via reducer så att inget anrop kan råkar dubbel-appenda en token.
 */
import type {
  AgentStep,
  Checkpoint,
  ChatMessage,
  ChatRole,
  FileDiff,
  ModelSource,
  RagChunk,
  SessionInfo,
  ToolCallRecord,
} from "@nexus/protocol";

export interface UiMessage {
  readonly id: string;
  readonly role: ChatRole;
  readonly text: string;
  readonly createdAt: number;
  readonly streaming: boolean;
  readonly model?: string;
  readonly providerId?: string;
  readonly source?: ModelSource;
  readonly error?: string;
  readonly contextUsed?: RagChunk[];
  readonly toolCalls?: ToolCallRecord[];
  readonly usage?: { prompt: number; completion: number };
}

export type TimelineStatus = "running" | "done" | "failed" | "pending";

export interface TimelineItem {
  readonly kind: "step" | "tool" | "thought" | "diff" | "checkpoint";
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly status: TimelineStatus;
  readonly at: number;
  readonly tool?: string;
  readonly output?: string;
  readonly tookMs?: number;
  readonly approval?: "allowed" | "denied" | "auto";
}

export interface ChatUiState {
  readonly sessionId: string | null;
  readonly sessions: SessionInfo[];
  readonly messages: UiMessage[];
  readonly timeline: TimelineItem[];
  readonly steps: AgentStep[];
  readonly diffs: FileDiff[];
  readonly checkpoints: Checkpoint[];
  readonly busy: boolean;
  readonly runId: string | null;
  readonly lastSource: ModelSource | null;
  readonly error: string | null;
}

export type ChatAction =
  | { type: "sessions/set"; sessions: SessionInfo[] }
  | { type: "session/set"; sessionId: string | null }
  | { type: "history/set"; messages: readonly ChatMessage[] }
  | { type: "local/append"; message: UiMessage }
  | { type: "token"; messageId: string; text: string; sessionId?: string }
  | {
      type: "done";
      messageId: string;
      fullText: string;
      model: string;
      providerId: string;
      source: ModelSource;
      usage?: { prompt: number; completion: number };
    }
  | { type: "stream/error"; messageId: string; message: string }
  | { type: "send/state"; busy: boolean }
  | { type: "run/start"; runId: string }
  | { type: "run/finish"; ok: boolean; summary: string }
  | { type: "run/error"; message: string }
  | { type: "plan/set"; steps: AgentStep[] }
  | { type: "step/update"; index: number; status: AgentStep["status"]; detail?: string }
  | { type: "thought"; runId: string; text: string; at: number }
  | { type: "tool/call"; callId: string; tool: string; args: unknown; at: number }
  | { type: "tool/result"; callId: string; tool: string; ok: boolean; output: string; tookMs: number }
  | { type: "diff/set"; diffs: FileDiff[] }
  | { type: "checkpoint/add"; checkpoint: Checkpoint }
  | { type: "checkpoint/set"; checkpoints: Checkpoint[] }
  | { type: "message/context"; messageId: string; contextUsed: RagChunk[] }
  | { type: "chat/clear" };

export function initialChatState(sessionId: string | null = null): ChatUiState {
  return {
    sessionId,
    sessions: [],
    messages: [],
    timeline: [],
    steps: [],
    diffs: [],
    checkpoints: [],
    busy: false,
    runId: null,
    lastSource: null,
    error: null,
  };
}

export function chatReducer(state: ChatUiState, action: ChatAction): ChatUiState {
  switch (action.type) {
    case "sessions/set":
      return { ...state, sessions: action.sessions };

    case "session/set":
      return { ...initialChatState(action.sessionId), sessions: state.sessions };

    case "history/set":
      return { ...state, messages: action.messages.map(toUiMessage), busy: false };

    case "local/append":
      return { ...state, messages: [...state.messages, action.message] };

    case "token": {
      const existing = state.messages.find((m) => m.id === action.messageId);
      if (!existing) {
        return {
          ...state,
          messages: [
            ...state.messages,
            {
              id: action.messageId,
              role: "assistant",
              text: action.text,
              createdAt: Date.now(),
              streaming: true,
            },
          ],
        };
      }
      // Skydd mot dubbla append: en token hamnar aldrig två gånger i samma meddelande.
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.messageId ? { ...m, text: m.text + action.text, streaming: true } : m,
        ),
      };
    }

    case "done":
      return {
        ...state,
        busy: false,
        lastSource: action.source,
        messages: state.messages.map((m) =>
          m.id === action.messageId
            ? {
                ...m,
                text: action.fullText.length > 0 ? action.fullText : m.text,
                streaming: false,
                model: action.model,
                providerId: action.providerId,
                source: action.source,
                usage: action.usage,
              }
            : m,
        ),
      };

    case "stream/error":
      return {
        ...state,
        busy: false,
        error: action.message,
        messages: state.messages.map((m) =>
          m.id === action.messageId ? { ...m, streaming: false, error: action.message } : m,
        ),
      };

    case "send/state":
      return { ...state, busy: action.busy };

    case "run/start":
      return { ...state, runId: action.runId, busy: true, timeline: [], steps: [], diffs: [], error: null };

    case "run/finish":
      return {
        ...state,
        busy: false,
        runId: null,
        messages: [
          ...state.messages,
          {
            id: `run-${Date.now().toString(36)}`,
            role: "assistant",
            text: action.ok ? `Agenten klar: ${action.summary}` : `Agenten avbröts: ${action.summary}`,
            createdAt: Date.now(),
            streaming: false,
          },
        ],
      };

    case "run/error":
      return { ...state, busy: false, runId: null, error: action.message };

    case "plan/set":
      return { ...state, steps: action.steps, timeline: mergePlan(state.timeline, action.steps) };

    case "step/update": {
      const steps = state.steps.map((step) =>
        step.index === action.index
          ? { ...step, status: action.status, detail: action.detail ?? step.detail }
          : step,
      );
      return {
        ...state,
        steps,
        timeline: state.timeline.map((item) =>
          item.kind === "step" && item.id === `step-${String(action.index)}`
            ? { ...item, status: toTimelineStatus(action.status), detail: action.detail ?? item.detail }
            : item,
        ),
      };
    }

    case "thought": {
      const id = `thought-${action.runId}-${state.timeline.length}`;
      return {
        ...state,
        timeline: [
          ...state.timeline,
          { kind: "thought", id, title: "Tanke", detail: action.text, status: "done", at: action.at },
        ],
      };
    }

    case "tool/call": {
      if (state.timeline.some((item) => item.id === action.callId)) return state;
      return {
        ...state,
        timeline: [
          ...state.timeline,
          {
            kind: "tool",
            id: action.callId,
            title: action.tool,
            detail: formatArgs(action.args),
            status: "running",
            at: action.at,
            tool: action.tool,
          },
        ],
      };
    }

    case "tool/result": {
      const found = state.timeline.some((item) => item.id === action.callId);
      const timeline: TimelineItem[] = found
        ? state.timeline.map((item) =>
            item.id === action.callId
              ? {
                  ...item,
                  status: action.ok ? "done" : "failed",
                  output: action.output,
                  tookMs: action.tookMs,
                }
              : item,
          )
        : [
            ...state.timeline,
            {
              kind: "tool",
              id: action.callId,
              title: action.tool,
              status: action.ok ? "done" : "failed",
              at: Date.now(),
              tool: action.tool,
              output: action.output,
              tookMs: action.tookMs,
            },
          ];
      return { ...state, timeline };
    }

    case "diff/set":
      return {
        ...state,
        diffs: action.diffs,
        timeline: [
          ...state.timeline,
          ...action.diffs.map((diff) => ({
            kind: "diff" as const,
            id: `diff-${diff.path}`,
            title: diff.path,
            detail: `+${diff.added} −${diff.removed}`,
            status: "done" as const,
            at: Date.now(),
          })),
        ],
      };

    case "checkpoint/add":
      if (state.checkpoints.some((c) => c.id === action.checkpoint.id)) return state;
      return {
        ...state,
        checkpoints: [action.checkpoint, ...state.checkpoints],
        timeline: [
          ...state.timeline,
          {
            kind: "checkpoint",
            id: `cp-${action.checkpoint.id}`,
            title: action.checkpoint.label,
            detail: `${action.checkpoint.files.length} filer`,
            status: "done",
            at: action.checkpoint.createdAt,
          },
        ],
      };

    case "checkpoint/set":
      return { ...state, checkpoints: action.checkpoints };

    case "message/context":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.messageId ? { ...m, contextUsed: action.contextUsed } : m,
        ),
      };

    case "chat/clear":
      return initialChatState(state.sessionId);

    default:
      return state;
  }
}

function mergePlan(timeline: readonly TimelineItem[], steps: readonly AgentStep[]): TimelineItem[] {
  const kept = timeline.filter((item) => item.kind !== "step");
  const plan: TimelineItem[] = steps.map((step) => ({
    kind: "step",
    id: `step-${String(step.index)}`,
    title: step.title,
    detail: step.detail,
    status: toTimelineStatus(step.status),
    at: Date.now(),
    tool: step.tool,
  }));
  return [...plan, ...kept];
}

function toTimelineStatus(status: AgentStep["status"]): TimelineStatus {
  if (status === "done") return "done";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  return "pending";
}

function toUiMessage(message: ChatMessage): UiMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
    streaming: Boolean(message.streaming),
    model: message.model,
    providerId: message.providerId,
    contextUsed: message.contextUsed,
    toolCalls: message.toolCalls,
  };
}

export function formatArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

/** Delar ett svar i kodblock och text så AI-panelen kan erbjuda Copy/Apply per block. */
export interface AnswerSegment {
  readonly kind: "text" | "code";
  readonly language: string;
  readonly content: string;
}

const FENCE = /^```([a-zA-Z0-9+#._-]*)\s*$/;

export function splitCodeBlocks(text: string): AnswerSegment[] {
  const lines = text.split(/\r?\n/);
  const segments: AnswerSegment[] = [];
  let buffer: string[] = [];
  let code: string[] | null = null;
  let language = "";

  for (const line of lines) {
    const open = code === null ? FENCE.exec(line) : null;
    if (open) {
      if (buffer.length > 0) {
        segments.push({ kind: "text", language: "", content: buffer.join("\n") });
        buffer = [];
      }
      code = [];
      language = open[1] ?? "";
      continue;
    }
    if (code !== null && FENCE.test(line.trim())) {
      segments.push({ kind: "code", language, content: code.join("\n") });
      code = null;
      language = "";
      continue;
    }
    if (code !== null) code.push(line);
    else buffer.push(line);
  }
  if (code !== null) segments.push({ kind: "code", language, content: code.join("\n") });
  if (buffer.length > 0) segments.push({ kind: "text", language: "", content: buffer.join("\n") });
  return segments;
}

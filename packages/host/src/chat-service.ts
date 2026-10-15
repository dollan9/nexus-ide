/**
 * chat-service.ts — sessioner, historik och streaming (FAS 7 chat, P0).
 *
 * chat.send ar protokollmässigt ett "id nu, resten pä bussen"-anrop: svaret
 * returnerar messageId omedelbart och tokenströmmen går som chat/token →
 * chat/done (eller chat/error). Därför lever AbortControllers här, per session,
 * sa att chat.cancel kan avbryta den underliggande provider-förfrágan
 * (abort-signalen gar hela vägen in i fetch) — inte bara sluta visa text.
 *
 * Sessioner persisteras under <root>/.nexus/sessions/<id>.json: historiken är
 * användarens, och en host-omstart fär inte radera den.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ErrorCode,
  type AgentMode,
  type Attachment,
  type ChatMessage,
  type EventTable,
  type ModelSource,
  type RagChunk,
  type SessionInfo,
} from "@nexus/protocol";
import type { ChatTurn } from "@nexus/providers";
import type { Logger } from "@nexus/core";
import type { EventBus } from "./events";
import type { ModelGateway } from "./gateway";
import type { RagService } from "./rag";
import { HostError } from "./errors";
import { clip } from "./utils";

const MAX_HISTORY_TURNS = 32;
const MAX_TEXT_BYTES = 200_000;

interface SessionRecord {
  info: SessionInfo;
  messages: ChatMessage[];
}

export interface ChatServiceOptions {
  readonly nexusDir: string;
  readonly gateway: ModelGateway;
  readonly logger: Logger;
  readonly events: EventBus;
  readonly rag: RagService;
  readonly ragEnabled: () => boolean;
  readonly defaultMode: () => AgentMode;
}

function modeInstruction(mode: AgentMode): string {
  switch (mode) {
    case "ask":
      return "Läge Fråga: svara med förklaringar, föreslå kodbitar men skriv inga filer.";
    case "debug":
      return "Läge Felsök: reproducera, hypotes, instrumentera, riktad fix, verifiera.";
    case "eyes":
      return "Läge Ögon: bekräfta vad som syns på skärmen innan du föreslår nästa steg.";
    case "voice":
      return "Läge Röst: målet kan vara transkriberat tal — bekräfta innan du skriver.";
    default:
      return "Läge Agent: planera kort och svara precist.";
  }
}

export class ChatService {
  private readonly dir: string;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly inflight = new Map<string, AbortController>();

  constructor(private readonly options: ChatServiceOptions) {
    this.dir = path.join(options.nexusDir, "sessions");
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.dir)) return;
      for (const entry of fs.readdirSync(this.dir)) {
        if (!entry.endsWith(".json")) continue;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(this.dir, entry), "utf8")) as SessionRecord;
          if (raw.info?.id !== undefined && Array.isArray(raw.messages)) this.sessions.set(raw.info.id, raw);
        } catch {
          this.options.logger.warn("Sessionfil kunde inte läsas — hoppas över", { fas: "7", file: entry });
        }
      }
    } catch (err) {
      this.options.logger.warn("Kunde inte läsa sessions-mappen", { fas: "7", error: String(err) });
    }
  }

  private persist(record: SessionRecord): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const target = path.join(this.dir, `${record.info.id}.json`);
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
      fs.renameSync(tmp, target);
    } catch (err) {
      this.options.logger.warn("Kunde inte spara session", { fas: "7", error: String(err) });
    }
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()]
      .map((record) => ({ ...record.info, messageCount: record.messages.length }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  newSession(title?: string, mode?: AgentMode): SessionInfo {
    const now = Date.now();
    const info: SessionInfo = {
      id: randomUUID(),
      title: title !== undefined && title.trim().length > 0 ? title.trim() : `Session ${new Date(now).toLocaleString("sv-SE")}`,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      mode: mode ?? this.options.defaultMode(),
    };
    const record: SessionRecord = { info, messages: [] };
    this.sessions.set(info.id, record);
    this.persist(record);
    return { ...info };
  }

  private mustGet(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      throw HostError.invalidParams(`Okänd session: ${sessionId} — öppna en ny med chat.newSession.`);
    }
    return record;
  }

  history(sessionId: string): ChatMessage[] {
    return this.mustGet(sessionId).messages.map((message) => ({ ...message }));
  }

  get activeStreamCount(): number {
    return this.inflight.size;
  }

  /**
   * Startar en streamingtur. Returnerar messageId omedelbart — arbetet fortsätter
   * pä bussen. Fel blir chat/error, aldrig ett kast tillbaka till anroparen.
   */
  send(params: { sessionId: string; text: string; mode?: AgentMode; attachments?: Attachment[]; useRag?: boolean }): { messageId: string } {
    const record = this.mustGet(params.sessionId);
    const text = clip(params.text ?? "", MAX_TEXT_BYTES);
    const now = Date.now();

    const userMessage: ChatMessage = {
      id: randomUUID(),
      sessionId: record.info.id,
      role: "user",
      text,
      createdAt: now,
      ...(params.attachments !== undefined && params.attachments.length > 0 ? { attachments: params.attachments } : {}),
    };
    const assistant: ChatMessage = {
      id: randomUUID(),
      sessionId: record.info.id,
      role: "assistant",
      text: "",
      createdAt: Date.now(),
      streaming: true,
    };
    record.messages.push(userMessage, assistant);
    record.info = {
      ...record.info,
      updatedAt: Date.now(),
      messageCount: record.messages.length,
      ...(params.mode !== undefined ? { mode: params.mode } : {}),
      ...(record.info.title.startsWith("Session ") && text.length > 0 ? { title: clip(text, 60) } : {}),
    };
    this.persist(record);

    const controller = new AbortController();
    this.inflight.set(record.info.id, controller);
    // Fire-and-forget: hela kedjan är fångad, inget onhandled rejection.
    void this.streamTurn(record, assistant.id, text, params.useRag !== false, controller.signal).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.options.logger.error("chat.send bakgrundsjobb kraschade", { fas: "7", error: message });
      this.options.events.emit("chat/error", { sessionId: record.info.id, messageId: assistant.id, message, code: ErrorCode.Internal });
    });
    return { messageId: assistant.id };
  }

  cancel(sessionId: string): boolean {
    const controller = this.inflight.get(sessionId);
    if (controller === undefined) return false;
    controller.abort();
    return true;
  }

  /** Avslutar assistant-meddelandet och skickar chat/done (även vid avbrott). */
  private finalize(record: SessionRecord, messageId: string, patch: Partial<ChatMessage>): ChatMessage | null {
    const index = record.messages.findIndex((message) => message.id === messageId);
    if (index < 0) return null;
    const existing = record.messages[index];
    if (existing === undefined) return null;
    const next: ChatMessage = { ...existing, ...patch, streaming: false };
    record.messages[index] = next;
    record.info = { ...record.info, updatedAt: Date.now(), messageCount: record.messages.length };
    this.persist(record);
    return next;
  }

  private buildTurns(record: SessionRecord, mode: AgentMode): ChatTurn[] {
    const turns: ChatTurn[] = [{ role: "system", content: `Du är NEXUS-assistenten i en egen IDE. ${modeInstruction(mode)}` }];
    const recent = record.messages.filter((message) => message.role === "user" || message.role === "assistant").slice(-MAX_HISTORY_TURNS);
    for (const message of recent) {
      if (message.role === "user") {
        const images = (message.attachments ?? [])
          .filter((attachment): attachment is Attachment => attachment.kind === "image" && typeof attachment.dataBase64 === "string")
          .map((attachment) => ({ dataBase64: attachment.dataBase64 as string, mime: attachment.mime ?? "image/png", ...(attachment.name !== undefined ? { name: attachment.name } : {}) }));
        turns.push({ role: "user", content: message.text, ...(images.length > 0 ? { images } : {}) });
      } else {
        turns.push({ role: "assistant", content: message.text });
      }
    }
    return turns;
  }

  private async streamTurn(record: SessionRecord, messageId: string, question: string, useRag: boolean, signal: AbortSignal): Promise<void> {
    const mode = record.info.mode;
    let context: RagChunk[] = [];
    if (useRag && this.options.ragEnabled()) {
      try {
        context = await this.options.rag.search(question, 4);
      } catch (err) {
        this.options.logger.warn("RAG-kontext uteblev — chatten körs utan", { fas: "3.5", error: String(err) });
      }
    }

    const turns = this.buildTurns(record, mode);
    let full = "";
    let failure: unknown;
    try {
      for await (const token of this.options.gateway.stream({ role: "chat", messages: turns, signal, ...(context.length > 0 ? { contextChunks: context } : {}) })) {
        if (signal.aborted) break;
        full += token;
        this.options.events.emit("chat/token", { sessionId: record.info.id, messageId, text: token });
      }
    } catch (err) {
      failure = err;
    }

    const report = this.options.gateway.report("chat");
    const resolved = this.options.gateway.resolveRole("chat");
    const model = report?.model ?? resolved?.model ?? "none";
    const providerId = report?.providerId ?? resolved?.providerId ?? "none";
    const source: ModelSource = report?.source ?? resolved?.source ?? "none";
    const cancelled = signal.aborted;

    if (failure !== undefined && !cancelled) {
      const code = failure instanceof HostError ? failure.code : ErrorCode.NoModelAvailable;
      const message = failure instanceof Error ? failure.message : String(failure);
      const partial = this.finalize(record, messageId, { text: full, model, providerId });
      if (partial !== null) {
        this.options.events.emit("chat/error", { sessionId: record.info.id, messageId, message, code });
      }
      this.inflight.delete(record.info.id);
      return;
    }

    const finalized = this.finalize(record, messageId, {
      text: full,
      model,
      providerId,
      ...(context.length > 0 ? { contextUsed: context } : {}),
    });
    if (finalized === null) {
      this.inflight.delete(record.info.id);
      return;
    }
    const done: EventTable["chat/done"] = {
      sessionId: record.info.id,
      messageId,
      fullText: finalized.text,
      model,
      providerId,
      source,
    };
    this.options.events.emit("chat/done", done);
    if (cancelled) {
      this.options.logger.info("chat-stream avbruten av användaren", { fas: "7", sessionId: record.info.id, characters: finalized.text.length });
    }
    this.inflight.delete(record.info.id);
  }

  /** Avsluta alla pausade strömmar — kallas frän host.close(). */
  abortAll(): void {
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
  }

  /** For tester/diagnostik: plocka en session med metadata. */
  peek(sessionId: string): { info: SessionInfo; messages: ChatMessage[] } | null {
    const record = this.sessions.get(sessionId);
    return record === undefined ? null : { info: { ...record.info }, messages: record.messages.map((m) => ({ ...m })) };
  }
}

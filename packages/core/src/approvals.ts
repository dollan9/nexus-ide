/**
 * approvals.ts — ApprovalBroker (FAS 7.2).
 *
 * ask: emitterar agent/approval_required, väntar på UI-beslut, timeout → deny.
 * allowlist: prefix/regex-match mot konfigurerad allowlist (t.ex. "pnpm test").
 * auto: inget blockerar. "always" lägger till i sessionens allowlist.
 * Avslag ger ALLTID ErrorCode.ApprovalDenied — aldrig ett häng.
 */

import { randomUUID } from "node:crypto";
import type { ApprovalMode, ApprovalRequest, EventName } from "@nexus/protocol";
import { ErrorCode } from "@nexus/protocol";
import type { Logger } from "./logger";

interface Pending {
  approval: ApprovalRequest;
  subject: string;
  resolve: (decision: "allow" | "deny" | "always") => void;
  timer: NodeJS.Timeout;
}

function entryMatches(entry: string, subject: string): boolean {
  const s = subject.trim();
  const e = entry.trim();
  if (e.length === 0) return false;
  // Slash-avgränsad regex: /pattern/
  if (e.length > 1 && e.startsWith("/") && e.endsWith("/")) {
    try {
      return new RegExp(e.slice(1, -1)).test(s);
    } catch {
      return false;
    }
  }
  // Exakt eller prefix (ordgräns).
  return s === e || s.startsWith(e + " ") || s.startsWith(e + "\t");
}

export class ApprovalBroker {
  private mode: ApprovalMode;
  private allowlist: string[];
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private emit?: (e: EventName, p: unknown) => void;
  private readonly pendingMap: Map<string, Pending> = new Map();

  constructor(opts: { mode: ApprovalMode; allowlist: string[]; logger: Logger; timeoutMs?: number }) {
    this.mode = opts.mode;
    this.allowlist = [...opts.allowlist];
    this.logger = opts.logger;
    this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 60000;
  }

  setMode(mode: ApprovalMode): void {
    this.mode = mode;
  }

  getMode(): ApprovalMode {
    return this.mode;
  }

  /** Trådkoppling till händelser — sätts av värden (agent/host). */
  setEmit(emit?: (e: EventName, p: unknown) => void): void {
    this.emit = emit;
  }

  isAllowedByList(subject: string): boolean {
    return this.allowlist.some((entry) => entryMatches(entry, subject));
  }

  needs(kind: ApprovalRequest["kind"], subject: string): boolean {
    if (this.mode === "auto") return false;
    if (this.mode === "allowlist") {
      // Skriv- och delete-åtgärder kräver alltid beslut i allowlist-läge;
      // terminal kan auto-godkännas via listan.
      if (kind !== "terminal") return true;
      return !this.isAllowedByList(subject);
    }
    // ask
    return true;
  }

  request(partial: Omit<ApprovalRequest, "id" | "createdAt">): Promise<{ decision: "allow" | "deny" | "always"; approval: ApprovalRequest }> {
    const approval: ApprovalRequest = { ...partial, id: randomUUID(), createdAt: Date.now() };
    const subject = approval.command ?? (approval.paths ?? []).join(",") ?? approval.title;

    // auto: direkt godkännande utan att vänta.
    if (this.mode === "auto") {
      return Promise.resolve({ decision: "allow", approval });
    }
    // allowlist: terminal-kommandon som matchar listan godkänns tyst.
    if (this.mode === "allowlist" && approval.kind === "terminal" && this.isAllowedByList(subject)) {
      this.logger.info("Auto-godkänd via allowlist", { fas: "7.2", subject });
      return Promise.resolve({ decision: "allow", approval });
    }

    return new Promise<{ decision: "allow" | "deny" | "always"; approval: ApprovalRequest }>((outerResolve) => {
      const finish = (decision: "allow" | "deny" | "always"): void => outerResolve({ decision, approval });
      const timer = setTimeout(() => {
        const p = this.pendingMap.get(approval.id);
        if (p) {
          this.pendingMap.delete(approval.id);
          this.logger.warn("Godkännande tidsutlöpt → nekas", { fas: "7.2", id: approval.id });
          finish("deny");
        }
      }, this.timeoutMs);
      this.pendingMap.set(approval.id, { approval, subject, resolve: finish, timer });
      if (this.emit) {
        this.emit("agent/approval_required", { approval });
      }
    });
  }

  /** UI/host beslutar. "always" berikar sessionens allowlist. Retunerar om id:f:t fanns. */
  resolve(requestId: string, decision: "allow" | "deny" | "always"): boolean {
    const entry = this.pendingMap.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pendingMap.delete(requestId);
    if (decision === "always") {
      if (entry.subject.length > 0 && !this.allowlist.includes(entry.subject)) {
        this.allowlist.push(entry.subject);
      }
      this.logger.info("Always tillagd i allowlist", { fas: "7.2", subject: entry.subject });
    }
    entry.resolve(decision);
    return true;
  }

  /** Väntande godkännanden (API.md: `pending()`). */
  pending(): ApprovalRequest[] {
    return [...this.pendingMap.values()].map((p) => p.approval);
  }

  denyAll(): void {
    for (const [id, entry] of [...this.pendingMap.entries()]) {
      clearTimeout(entry.timer);
      this.pendingMap.delete(id);
      entry.resolve("deny");
    }
  }

  get allowlistSnapshot(): string[] {
    return [...this.allowlist];
  }

  approvalDeniedCode(): number {
    return ErrorCode.ApprovalDenied;
  }
}

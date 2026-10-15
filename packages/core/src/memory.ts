/**
 * memory.ts — MemoryLog (FAS 7.4).
 *
 * Skriver till PROGRESS.md och .agent-memory/decisions.md. ORKESTRATORN ager
 * innehallare av PROGRESS.md, darfor skriver jag ALDRIG utfor mitt avgransade
 * block <!-- nexus:core:begin --> ... <!-- nexus:core:end --> — blocket ersatts
 * atomiskt sa att andra sektioner bevaras. Saknas filen skapas den med bara mitt block.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const BEGIN = "<!-- nexus:core:begin -->";
const END = "<!-- nexus:core:end -->";

interface MemoryEntry {
  id: string;
  text: string;
  kind: string;
  at: number;
}

/** Maskinlasbar markering pa en rad; texten ar base64 sa att den aldrig krockar med markdown. */
function encodeEntry(e: MemoryEntry): string {
  const data = Buffer.from(e.text, "utf8").toString("base64");
  return `- **${e.kind}** ${e.text.replace(/\s+/g, " ")} <!--nexus:mem id="${e.id}" kind="${e.kind}" at="${e.at}" data="${data}"-->`;
}

function collectEntries(raw: string): MemoryEntry[] {
  const m = /<!--nexus:mem id="([^"]+)" kind="([^"]+)" at="(\d+)" data="([^"]*)"-->/g;
  const out: MemoryEntry[] = [];
  let match: RegExpExecArray | null;
  while ((match = m.exec(raw)) !== null) {
    const id = match[1];
    const kind = match[2];
    const atStr = match[3];
    const data = match[4];
    if (!id || !kind || !atStr || data === undefined) continue;
    let text = "";
    try {
      text = Buffer.from(data, "base64").toString("utf8");
    } catch {
      continue;
    }
    out.push({ id, kind, at: Number(atStr), text });
  }
  return out;
}

function atomicWrite(target: string, content: string): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.mem-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, content, { encoding: "utf8" });
  fs.renameSync(tmp, target);
}

export class MemoryLog {
  private readonly progressFile: string;
  private readonly decisionsFile: string;

  constructor(opts: { progressFile: string; decisionsFile: string }) {
    this.progressFile = path.resolve(opts.progressFile);
    this.decisionsFile = path.resolve(opts.decisionsFile);
  }

  async append(kind: "decision" | "note" | "result", text: string): Promise<{ id: string; path: string }> {
    const entry: MemoryEntry = { id: randomUUID(), text, kind, at: Date.now() };
    const line = encodeEntry(entry);
    if (kind === "decision") {
      this.appendToPlain(line);
      return { id: entry.id, path: this.decisionsFile };
    }
    this.appendToProgressBlock(line);
    return { id: entry.id, path: this.progressFile };
  }

  private appendToPlain(line: string): void {
    let raw = "";
    try {
      raw = fs.readFileSync(this.decisionsFile, "utf8");
    } catch {
      raw = "# NEXUS-IDE — Beslut\n\n";
    }
    const sep = raw.endsWith("\n") ? "" : "\n";
    atomicWrite(this.decisionsFile, `${raw}${sep}${line}\n`);
  }

  /** Ersatter BARA mitt block; allting utanfor blocket är orört. */
  private appendToProgressBlock(line: string): void {
    let raw = "";
    try {
      raw = fs.readFileSync(this.progressFile, "utf8");
    } catch {
      raw = "";
    }
    if (raw.length === 0) {
      const fresh = `# NEXUS-IDE — PROGRESS\n\n${BEGIN}\n${line}\n${END}\n`;
      atomicWrite(this.progressFile, fresh);
      return;
    }
    const bIdx = raw.indexOf(BEGIN);
    const eIdx = raw.indexOf(END);
    if (bIdx >= 0 && eIdx > bIdx) {
      const inner = raw.slice(bIdx + BEGIN.length, eIdx);
      const nextInner = `${inner}${inner.endsWith("\n") ? "" : "\n"}${line}\n`;
      const updated = raw.slice(0, bIdx + BEGIN.length) + nextInner + raw.slice(eIdx);
      atomicWrite(this.progressFile, updated);
      return;
    }
    // Block saknas i en existerande fil → lagg till ett eget block sist, clobbra inget.
    const sep = raw.endsWith("\n") ? "" : "\n";
    atomicWrite(this.progressFile, `${raw}${sep}\n${BEGIN}\n${line}\n${END}\n`);
  }

  async recent(limit = 20): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = [];
    for (const file of [this.progressFile, this.decisionsFile]) {
      try {
        entries.push(...collectEntries(fs.readFileSync(file, "utf8")));
      } catch {
        /* filen kan saknas */
      }
    }
    entries.sort((a, b) => b.at - a.at);
    const capped = limit > 0 ? entries.slice(0, limit) : entries;
    return capped;
  }

  /** Testbar hjalpare: returnerar innrehalllet i mitt block (eller null). */
  readProgressBlock(): string | null {
    try {
      const raw = fs.readFileSync(this.progressFile, "utf8");
      const bIdx = raw.indexOf(BEGIN);
      const eIdx = raw.indexOf(END);
      if (bIdx >= 0 && eIdx > bIdx) return raw.slice(bIdx + BEGIN.length, eIdx).trim();
    } catch {
      /* saknas */
    }
    return null;
  }
}

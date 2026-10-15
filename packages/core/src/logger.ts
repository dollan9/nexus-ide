/**
 * logger.ts — roterande append-only-logg (R7: allt till debug.log).
 *
 * Varje rad har ISO-tidstämpel, nivå, modul, fas-id och JSON-meta.
 * Innehållet redigeras FÖRE det når disk: nyckel-/bearer-mönster maskas (R2).
 *
 * AVVIKELSE: API.md anger bara Logger-gränssnittet; rotation + rödaktning är
 * internal som lagts till för att uppfylla FAS-dokuments krav. Publika namn är orörda.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  tail(lines?: number): string[];
  readonly path: string;
}

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

/** Rödaktning: dölj värden, behåll namn + kort prefix för felsökning. */
function redact(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_\-]{6,}\b/g, "sk-****")
    .replace(/\bnvapi-[A-Za-z0-9_\-]{6,}\b/g, "nvapi-****")
    .replace(/\bbearer\s+[A-Za-z0-9._\-]+/gi, "Bearer ****")
    .replace(/(["']?\bauthorization\b["']?\s*[:=]\s*)(["'])(.*?)\2/gi, "$1$2****$2")
    .replace(/(\bauthorization\s*[:=]\s*)(\S+)/gi, "$1****");
}

/** Serierar meta-objektet och rödkar nyckel-/bearer-värden rekursivt. */
function serialiseMeta(meta: Record<string, unknown> | undefined): string {
  if (!meta || Object.keys(meta).length === 0) return "";
  try {
    return " " + redact(JSON.stringify(meta));
  } catch {
    return " " + redact(String(meta));
  }
}

export function createLogger(opts: {
  logFile: string;
  level?: "debug" | "info" | "warn" | "error";
  maxBytes?: number;
}): Logger {
  const logPath = path.resolve(opts.logFile);
  const threshold = LEVELS[opts.level ?? "debug"];
  const maxBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : 5 * 1024 * 1024;

  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  function currentSize(): number {
    try {
      return fs.statSync(logPath).size;
    } catch {
      return 0;
    }
  }

  /** Rotation: flytta Nuvarande → .1 medans man tappar äldre. */
  function rotate(): void {
    try {
      const rotated = logPath + ".1";
      if (fs.existsSync(rotated)) fs.rmSync(rotated, { force: true });
      fs.renameSync(logPath, rotated);
    } catch (err) {
      // Loggning får aldrig krascha appen (R5). Tyst ignorera rotationsfel.
      void err;
    }
  }

  function write(level: Level, msg: string, meta?: Record<string, unknown>): void {
    if (LEVELS[level] < threshold) return;
    const line = `${new Date().toISOString()}|${level.toUpperCase()}|${redact(msg)}${serialiseMeta(meta)}\n`;
    if (currentSize() + Buffer.byteLength(line) > maxBytes) rotate();
    try {
      fs.appendFileSync(logPath, line, { encoding: "utf8" });
    } catch {
      // Uteslut diskfel — en app får aldrig dö på grund av loggning.
    }
  }

  return {
    debug: (msg, meta) => write("debug", msg, meta),
    info: (msg, meta) => write("info", msg, meta),
    warn: (msg, meta) => write("warn", msg, meta),
    error: (msg, meta) => write("error", msg, meta),
    tail(lines = 200): string[] {
      let raw = "";
      try {
        raw = fs.readFileSync(logPath, "utf8");
      } catch {
        return [];
      }
      const arr = raw.split(/\r?\n/).filter((l) => l.length > 0);
      return arr.slice(Math.max(0, arr.length - lines));
    },
    get path(): string {
      return logPath;
    },
  };
}

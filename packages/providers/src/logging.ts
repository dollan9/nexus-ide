/**
 * Logistik (CONVENTIONS §"Fel och nedbrytning").
 *
 * Varje extern reaktion ska loggas med `fas`, `modul`, `nivå`, `meddelande`. host har den
 * roterande fil-loggeren i @nexus/core, men providers FÅR inte bero på core (core beror på
 * providers — cykliskt). Därför: vi definierar ett litet emitter-gränssnitt och host
 * implementerar det. Testerna använder `MemoryLogger`.
 *
 * ALLT som skrivs här går genom `maskSecrets()` — även `meta`. Det är den enda
 * försäkringen vi har mot att en nyckel läcker via ett felmeddelande.
 */

import { maskHeaders, maskSecrets } from "./secrets";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface NexusLogRecord {
  readonly fas: string;
  readonly modul: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly meta?: Record<string, unknown>;
  readonly at: number;
}

/** Gränssnittet host implementerar (vår logger-adapter i @nexus/core uppfyller detta). */
export interface NexusLogSink {
  log(record: NexusLogRecord): void;
}

/** Testdocka och standardutskrift. Riktiga assertions, ingen tystnad. */
export class MemoryLogger implements NexusLogSink {
  readonly records: NexusLogRecord[] = [];

  log(record: NexusLogRecord): void {
    this.records.push(record);
  }

  lines(): string[] {
    return this.records.map((r) => formatRecord(r));
  }

  text(): string {
    return this.lines().join("\n");
  }

  filter(level: LogLevel): string[] {
    return this.records.filter((r) => r.level === level).map((r) => formatRecord(r));
  }

  clear(): void {
    this.records.length = 0;
  }
}

export class ConsoleLogger implements NexusLogSink {
  log(record: NexusLogRecord): void {
    const line = formatRecord(record);
    if (record.level === "error") console.error(line);
    else if (record.level === "warn") console.warn(line);
    else console.info(line);
  }
}

/** Ingen utskrift alls — för testsnabbare körningar där loggen inte är poängen. */
export class NullLogger implements NexusLogSink {
  log(_record: NexusLogRecord): void {
    // Medvetet tomt: den här sänkaren ska aldrig skriva någonstans.
    void _record;
  }
}

export function formatRecord(record: NexusLogRecord): string {
  const meta = record.meta === undefined || Object.keys(record.meta).length === 0
    ? ""
    : ` ${maskSecrets(safeJson(record.meta))}`;
  return `[${record.fas}] ${record.modul} ${record.level}: ${record.message}${meta}`;
}

/**
 * Provider-loggaren: vet hur man skriver request/response utan att läcka.
 * Trunkerar kroppar — loggen ska inte innehålla hela workspace-dumpar.
 */
export class ProviderLogger {
  private readonly fas: string;
  private readonly modul: string;
  private readonly bodyLimit: number;

  constructor(
    private readonly sink: NexusLogSink,
    opts: { fas?: string; modul?: string; bodyLimit?: number } = {},
  ) {
    this.fas = opts.fas ?? "FAS 3";
    this.modul = opts.modul ?? "providers";
    this.bodyLimit = opts.bodyLimit ?? 600;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.emit("debug", message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.emit("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.emit("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.emit("error", message, meta);
  }

  request(method: string, url: string, headers?: Record<string, string>, body?: unknown): void {
    this.emit("debug", `${method} ${url}`, {
      headers: maskHeaders(headers),
      body: body === undefined ? undefined : truncate(maskSecrets(safeJson(body)), this.bodyLimit),
    });
  }

  response(method: string, url: string, status: number, tookMs: number, body?: unknown): void {
    const level: LogLevel = status >= 500 ? "error" : status >= 400 ? "warn" : "debug";
    this.emit(level, `${method} ${url} → ${status} (${tookMs}ms)`, {
      body: body === undefined ? undefined : truncate(maskSecrets(safeJson(body)), this.bodyLimit),
    });
  }

  /** Rad från SSE/NDJSON — kan innehålla vad som helst från leverantören. */
  streamLine(line: string): void {
    this.emit("debug", `stream: ${truncate(maskSecrets(line), 200)}`);
  }

  private emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    this.sink.log({
      fas: this.fas,
      modul: this.modul,
      level,
      // Även meddelandet i sig maskeras: feltexter fra leverantörer kan innehålla nyckeln.
      message: maskSecrets(message),
      meta: meta === undefined ? undefined : maskMeta(meta),
      at: Date.now(),
    });
  }
}

function maskMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    out[key] = typeof value === "string" ? maskSecrets(value) : value;
  }
  // Sista försäkring: hela JSON-dumpen en gång till, ifall en nästlad body bär en nyckel.
  return JSON.parse(maskSecrets(safeJson(out))) as Record<string, unknown>;
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[object kunde inte serialiseras]";
  }
}

/** Intern klippning av loggekroppar — exporteras inte (errors.truncate är publik). */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(+${text.length - max})`;
}

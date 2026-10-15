/**
 * context.ts — kontextblocket chatten skickar med till modellen (FAS 3.5, P0:
 * "Top-k chunks automatiskt in i varje chat-fråga").
 *
 * Budgeten är i BYTE, inte tokens: blocket vandrar genom IPC och hamnar i en
 * prompt, och den enda storhet som både host och renderer kan hävda mot varandra
 * utan en tokenizer-per-dependency är Buffer.byteLength.
 *
 * Regler:
 *   - Dubbletter faller: samma path+intervall behåller högre score, resten skutas.
 *   - Varje chunk trimras till maxChunkChars med en markerad trunkering, så att
 *     radintervallet alltid fortfarande beskriver den text som visas.
 *   - Inget kast, aldrig en krasch (R5): usla inputs ger ett kortare eller tomt block.
 */

import type { RagChunk } from "@nexus/protocol";

export const DEFAULT_CONTEXT_MAX_BYTES = 8 * 1024;
export const DEFAULT_CHUNK_MAX_CHARS = 1400;
const TRUNCATION_MARK = "\n// … trunkerad av NEXUS RAG …";

export interface ContextOptions {
  /** Hård gräns för det returnerade blockets storlek i UTF-8 byte. */
  readonly maxBytes?: number;
  /** Max tecken per chunk-text före trunkering. */
  readonly maxChunkChars?: number;
  /** Fler poster än så här tas inte ens emot (skydd mot skräm-framtagna topplistor). */
  readonly k?: number;
  /** Språk för markdown-staket; host kan mata WorkspaceService.languageOf. */
  readonly languageOf?: (path: string) => string;
}

export interface FormattedContext {
  readonly text: string;
  readonly used: RagChunk[];
  readonly bytes: number;
  readonly dropped: number;
}

function byteLen(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Klipp chunk-texten så att radintervallet fortfarande är ärligt mot det som visas. */
export function trimChunkText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - TRUNCATION_MARK.length);
  if (keep <= 0) return text.slice(0, Math.max(0, maxChars));
  return `${text.slice(0, keep)}${TRUNCATION_MARK}`;
}

/**
 * Dedupe: fullt lika id:er slås alltid ihop. Överlappande radintervall i samma fil
 * (typ en förälder-symbol och dess metod) behålls bara om de inte är identiska —
 * annars dupliceras samma kod i kontexten och budgeten bränns.
 */
export function dedupeChunks(chunks: readonly RagChunk[]): RagChunk[] {
  const byId = new Map<string, RagChunk>();
  for (const c of chunks) {
    if (!c || typeof c.id !== "string") continue;
    const existing = byId.get(c.id);
    if (!existing || c.score > existing.score) byId.set(c.id, c);
  }
  const out: RagChunk[] = [];
  const seenRanges = new Set<string>();
  for (const c of byId.values()) {
    const key = `${c.path}:${c.startLine}-${c.endLine}`;
    if (seenRanges.has(key)) continue;
    seenRanges.add(key);
    out.push(c);
  }
  return out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine);
}

function fenceFor(language: string): string {
  return language.length > 0 ? language : "";
}

/**
 * Bygg Markdown-blocket: `### path:start-end (symbol)` + trunkerad chunk-text.
 * Returnerar strängen som läggas in i systemprompten.
 */
export function formatContextBlock(chunks: readonly RagChunk[], opts: ContextOptions = {}): string {
  return buildChatContextFromChunks(chunks, opts).text;
}

/**
 * Huvudingången: kontextblock + de RagChunk:er som faktiskt kom med, dvs
 * `ChatMessage.contextUsed`. `dropped` räknar chunks som budgeten inte räckte till —
 * den siffran visas i UI så användaren förstår att kontexten begränsats.
 */
export function buildChatContextFromChunks(chunks: readonly RagChunk[], opts: ContextOptions = {}): FormattedContext {
  const maxBytes = Math.max(256, opts.maxBytes ?? DEFAULT_CONTEXT_MAX_BYTES);
  const maxChunkChars = Math.max(80, opts.maxChunkChars ?? DEFAULT_CHUNK_MAX_CHARS);
  const limit = Math.max(1, Math.min(50, opts.k ?? chunks.length));
  const candidates = dedupeChunks(chunks).slice(0, limit);

  const parts: string[] = [];
  const used: RagChunk[] = [];
  let dropped = 0;
  let bytes = 0;

  const header = "Kontext från kodbasindex (NEXUS RAG):";
  parts.push(header);
  bytes = byteLen(parts.join("\n"));

  for (const chunk of candidates) {
    const text = trimChunkText(chunk.text ?? "", maxChunkChars);
    const symbol = chunk.symbol ? ` — ${chunk.symbol}` : "";
    const lang = opts.languageOf ? fenceFor(opts.languageOf(chunk.path)) : "";
    const block = [`### ${chunk.path}:${chunk.startLine}-${chunk.endLine}${symbol}`, "```" + lang, text, "```"].join("\n");
    const cost = byteLen(block) + 1;
    if (bytes + cost > maxBytes) {
      // Passa u den chunk som rymts in — budgeten är en gräns, inte en riktlinje.
      dropped += 1;
      continue;
    }
    parts.push(block);
    used.push(chunk);
    bytes += cost;
  }

  if (used.length === 0) {
    return { text: "", used: [], bytes: 0, dropped };
  }
  const text = parts.join("\n");
  return { text, used, bytes: byteLen(text), dropped };
}

/**
 * `ChatMessage.contextUsed` — samma dedupe och budget som blocket, men returnerar
 * chunk-listan (protocol-typen) utan markdown. Anroparen sparar resultatet på
 * meddelandet så användaren kan se vilka filer som actually matte in i prompten.
 */
export function contextUsedFromChunks(chunks: readonly RagChunk[], opts: ContextOptions = {}): RagChunk[] {
  return buildChatContextFromChunks(chunks, opts).used;
}

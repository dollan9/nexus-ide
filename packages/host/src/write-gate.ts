/**
 * write-gate.ts — AGENTS.md Regel 5: "varje filändring = checkpoint".
 *
 * Write-gaten är den enda platsen som avgör OM en skrivning ska skyddas av en
 * checkpoint och MED VILKEN källa den checkpointen registreras. Regeln är äkta,
 * inte en stubb: genererade vägar (.nexus/, node_modules/, dist/ och *.log) är
 * maskinproducerade och ska aldrig fylla användarens skugg-git med brus — allt
 * annat får en checkpoint. Varje checkpoint ska kunna återställa byte-identiskt,
 * därför fångas källan (agent | user | ai-edit | terminal) här och never gissas.
 */

import type { Checkpoint } from "@nexus/protocol";

/** Källan till en checkpoint — exakt den mängd protocol tillåter. */
export type CheckpointSource = Checkpoint["source"];

/**
 * Vilken sorts skrivning som sker. Idag sammanfaller mängden med CheckpointSource
 * (transporten skickar redan den klassificerade källan), men typen hålls separat
 * så att en framtida finare klassificering (t.ex. "refactor" eller "format") kan
 * mappas hit utan att röpa publicerad API-yta.
 */
export type WriteKind = CheckpointSource;

/** Den fullständiga, giltiga mängden checkpoint-källor. */
const VALID_SOURCES: readonly CheckpointSource[] = ["agent", "user", "ai-edit", "terminal"];

/**
 * Mappa en skrivnings-sort till den checkpoint-källa som ska registreras.
 * Okända eller saknade värden (transporten kan skicka vad som helst) degraderas
 * ärligt till "user" — den säkraste klassen som ändå ger en återställbar punkt.
 */
export function checkpointSourceFor(kind: WriteKind): CheckpointSource {
  return VALID_SOURCES.includes(kind) ? kind : "user";
}

/**
 * Sökvägar som ALDRIG ska checkpointas: generatorer, beroenden och logg.
 * Matchar relativ eller absolut POSIX- och Windows-form; aldrig ett kast.
 */
const GENERATED_SEGMENT = /(^|[\\/])(?:\.nexus|node_modules|dist|out|build)(?:[\\/]|$)/i;
const GENERATED_SUFFIX = /\.(?:log)$/i;
const GENERATED_BASENAME = /(^|[\\/])npm-debug\.log$/i;

export interface ShouldCheckpointOptions {
  /**
   * När `false` checkpointas ÄVEN genererade vägar (används bara av uttryckliga
   * tvångskommandon); standard `true` = uteslut generatorer.
   */
  readonly ignoreGenerated?: boolean;
}

/**
 * Ska den här vägen skyddas av en checkpoint? Regel 5 gäller varje filändring —
 * men generatorer och loggar är inte användarens arbete och lämnas därför utan.
 */
export function shouldCheckpoint(path: string, opts: ShouldCheckpointOptions = {}): boolean {
  if (opts.ignoreGenerated === false) return true;
  if (typeof path !== "string" || path.trim().length === 0) return false;
  const normalized = path.replace(/\\/g, "/");
  if (GENERATED_SEGMENT.test(path) || GENERATED_SEGMENT.test(normalized)) return false;
  if (GENERATED_SUFFIX.test(normalized) || GENERATED_BASENAME.test(normalized)) return false;
  return true;
}

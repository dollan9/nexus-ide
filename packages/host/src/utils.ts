/**
 * utils.ts — sma hjalpare som hela host behover: timeout-race, jitterfri
 * verktygsvandring och formatering av tidsgivenheter.
 */

import { ErrorCode } from "@nexus/protocol";
import { HostError } from "./errors";

/**
 * Racing mot en timer. `onTimeout` ar en fabrik sa att felets text kan nama
 * metoden. Vinner alltid — ingen anropare hangar.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => unknown = () => new HostError(ErrorCode.Internal, `Tidsgräns överskriden efter ${String(timeoutMs)} ms`),
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          try {
            reject(onTimeout());
          } catch {
            // onTimeout ar en ren fabrik; kastar den har vi inget mer att gora.
          }
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Versalt syskon till withTimeout som ALDRIG kastar: ger standardvarde vid fel.
 * Används i host.health dar en nere tjinst bara ska rapportera ok:false.
 */
export async function settle<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  try {
    return await withTimeout(promise, timeoutMs);
  } catch {
    return fallback;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Klipp en lang strang med tydlig markering (for events och lograder). */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(+${String(text.length - max)})`;
}

/** Normalisera ett params-objekt som kan vara null/undefined fran transporten. */
export function paramsObject<T extends object>(params: T | Record<string, never> | undefined): T {
  return { ...(params ?? {}) } as T;
}

/** POSIX-sokvag for alla protocol-typer (workspace-tjansten anvander redan positiv). */
export function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/**
 * Enkel tokenisering for den deterministiska lokala embeddern (rag.ts) och for
 * overlappspoeng. Hanterar camelCase och snake_case, kastar aldrig.
 */
export function tokenize(text: string): string[] {
  const lowered = text.toLowerCase();
  const parts = lowered
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && token.length <= 40);
  return parts;
}

/** FNV-1a 32-bit — deterministisk hash utan beroenden. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

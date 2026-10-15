/**
 * helpers/evidence.ts — varje P0-test skriver ett bevis till tests/RESULT.jsonl.
 * scripts/make_result.mjs gör RESULT.md av det. Poängen: BEVIS-kolumnen kommer från utförd körning,
 * inte från en tro. source-fältet (local | cloud | stub | none) är den enda giltiga bevisnivån.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export type BevisNiva = "local" | "cloud" | "stub" | "none" | "n/a";

export interface Evidence {
  readonly test: string;
  readonly title: string;
  readonly status: "pass" | "fail" | "skip";
  readonly bevis: BevisNiva;
  readonly detalj: string;
  readonly tookMs: number;
  readonly kommando: string;
}

let dirReady = false;

async function outPath(): Promise<string> {
  if (!dirReady) {
    await mkdir(resolve(process.cwd(), "..", "..", "tests"), { recursive: true }).catch(() => undefined);
    dirReady = true;
  }
  const candidates = [
    join(process.cwd(), "..", "..", "tests", "RESULT.jsonl"),
    join(process.cwd(), "RESULT.jsonl"),
  ];
  return candidates[0]!;
}

export async function record(e: Omit<Evidence, "tookMs"> & { tookMs?: number }): Promise<void> {
  const line = JSON.stringify({ ...e, tookMs: e.tookMs ?? 0, at: new Date().toISOString() }) + "\n";
  await appendFile(await outPath(), line, "utf8");
}

export function startTimer(): () => number {
  const t0 = Date.now();
  return () => Date.now() - t0;
}

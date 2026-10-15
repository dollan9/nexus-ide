/**
 * vram.ts — VRAM-prob (FAS 3.3 statusrad). Bara nvidia-smi, annars null.
 *
 * Vi gissar ALDRIG minne. Utan nvidia-smi (ingen GPU, saknad driver, ute ur
 * PATH) ar svaret `null` och statusraden sager "VRAM okand" — ett ärligt
 * fragmend, inget patet. Anropet ar tidsbegransat och kastar aldrig (R5).
 *
 * Eksporteras som en `VramProbe` sa att tester kan mata en egen (host tar den
 * som option) och UI:t aldrig blockeras av en hangande subprocess.
 */

import { spawn } from "node:child_process";
import type { VramInfo } from "@nexus/protocol";

export type VramProbe = () => Promise<VramInfo | null>;

const NVIDIA_QUERY = [
  "--query-gpu=name,memory.total,memory.used,memory.free,driver_version",
  "--format=csv,noheader,nounits",
];

function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : undefined;
}

/** Kör nvidia-smi och samla stdout; null vid vilket fel som helst. */
function runNvidiaSmi(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("nvidia-smi", NVIDIA_QUERY, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Redan daod — finish ska inte hänga.
      }
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 64 * 1024) finish(stdout);
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? stdout : null));
  });
}

/**
 * Parset: en rad per GPU. Vi valjer kortet med mest fritt minne (det ar dar
 * modellen landar) och namner kartan ärligt.
 */
export function parseNvidiaSmi(csv: string): VramInfo | null {
  const rows = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let best: VramInfo | null = null;
  for (const row of rows) {
    const parts = row.split(",").map((part) => part.trim());
    const name = parts[0] ?? "";
    const totalMb = parseNumber(parts[1]);
    const usedMb = parseNumber(parts[2]);
    const freeMb = parseNumber(parts[3]);
    if (name.length === 0 || totalMb === undefined || usedMb === undefined || freeMb === undefined) continue;
    const info: VramInfo = {
      gpuName: name,
      totalMb,
      usedMb,
      freeMb,
      source: "nvidia-smi",
      ...(parts[4] !== undefined && parts[4].length > 0 ? { driverVersion: parts[4] } : {}),
    };
    if (best === null || info.freeMb > best.freeMb) best = info;
  }
  return best;
}

export interface VramProbeOptions {
  readonly timeoutMs?: number;
  /** Inspektionspunkt for tester: egen csv-kalla (alltid "stub"-agad, aldrig fejkad GPU). */
  readonly runner?: (timeoutMs: number) => Promise<string | null>;
}

export function createVramProbe(options: VramProbeOptions = {}): VramProbe {
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 2500;
  const runner = options.runner ?? runNvidiaSmi;
  return async (): Promise<VramInfo | null> => {
    try {
      const csv = await runner(timeoutMs);
      if (csv === null) return null;
      return parseNvidiaSmi(csv);
    } catch {
      return null;
    }
  };
}

/** null-prob for miljober utan GPU — uttryckligt, inte en bortglomning. */
export const nullVramProbe: VramProbe = async () => null;

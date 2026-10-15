/**
 * helpers/adapter.ts — löser beroendet av verkliga exportnamn i de paket som byggts parallellt.
 * Vi gissar inte och vi fejkar inte: om namnet saknas rapporteras faktiska exports, så felsökningen
 * i FAS 8 blir ett reellt matchningsproblem och inte ett tyst fel.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface Resolved<T = unknown> { value: T; via: string }

/** Importerar ett workspace-paket, föredrar byggd dist men faller tillbaka på src via ts-import. */
export async function importPkg(name: string): Promise<any> {
  const candidates = [name, `${name}/dist/index.js`];
  const errors: string[] = [];
  for (const c of candidates) {
    try {
      return await import(c);
    } catch (err) {
      errors.push(`${c}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(`Kunde inte importera ${name}.\n${errors.join("\n")}`);
}

/** Plockar första fungerande exportnamnet — behållaren är dokumenterad i räckvidgsordningen. */
export function pick<T>(mod: Record<string, unknown>, names: string[], what: string): Resolved<T> {
  for (const n of names) {
    const v = mod[n];
    if (typeof v === "function") return { value: v as T, via: n };
  }
  throw new Error(
    `Hittade ingen ${what}. Provade ${names.join(", ")}. Faktiska exports i paketet: ` +
      `${Object.keys(mod).slice(0, 40).join(", ")}`,
  );
}

/** Var ligger den BYGGDA renderern? Byggaren kan ha använt dist/, out/ eller build/. */
export function findRendererDir(root = process.cwd()): string {
  const up = resolve(root, "..", "..");
  const dirs = [
    join(up, "apps", "desktop", "dist", "renderer"),
    join(up, "apps", "desktop", "dist", "renderer", "dist"),
    join(up, "apps", "desktop", "dist"),
    join(up, "apps", "desktop", "out", "renderer"),
    join(up, "apps", "desktop", "out"),
    join(up, "apps", "desktop", "build"),
    join(up, "packages", "ui", "dist"),
  ];
  for (const d of dirs) {
    if (existsSync(join(d, "index.html"))) return d;
  }
  throw new Error(
    `Hittade ingen byggd renderer med index.html. Sökta: \n${dirs.join("\n")}\n` +
      `Kör först: pnpm --filter @nexus/desktop build`,
  );
}

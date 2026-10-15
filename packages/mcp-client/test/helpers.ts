/**
 * helpers.ts — gemensam testutrustning for @nexus/mcp-client:s tester.
 * Allt arbetar mot rika filer, rika processer och rika git-anrop. Ingen stubb.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "@nexus/protocol";

const here = dirname(fileURLToPath(import.meta.url));

/** packages/mcp-client */
export const packageRoot = resolve(here, "..");
/** nexus-ide (repo-rot) */
export const repoRoot = resolve(packageRoot, "..", "..");
/** scripts/mcp-servers — vara egna produktionsservrar */
export const serversDir = join(repoRoot, "scripts", "mcp-servers");
/** test/fixtures/nexus_test_server.mjs */
export const fixtureServer = join(here, "fixtures", "nexus_test_server.mjs");
/** Absolut node-sokvag — kravet i FAS 4.3: spawnbar med absolut node-sokvag. */
export const nodeExe = process.execPath;

/** Skapa en temporar katalog som stadas i afterAll. */
export function makeTempDir(prefix = "nexus-mcp-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Synkron kort vila utan barnprocess (Windows håller ibland filen öppen en stund). */
function napSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Rensa en temporar katalog robust (Windows kan hålla filar öppna kort). */
export function removeTempDir(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      napSync(200);
    }
  }
}

/** Kor ett git-kommando och kaster om det felar — for fixturer av verkliga repo. */
export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} i ${cwd} fejade (${String(result.status)}): ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Bygg ett riggt git-worktree i en temp-katalog med en commit och en
 * ospurad fil — sa att status/diff faktiskt har nagot att svara om.
 */
export function makeGitRepo(dir: string): { repo: string; committedFile: string; untrackedFile: string } {
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "nexus-test@example.invalid");
  git(dir, "config", "user.name", "NEXUS Test");
  git(dir, "config", "commit.gpgsign", "false");
  const committedFile = join(dir, "tracked.txt");
  writeFileSync(committedFile, "ursprungligt innehåll\n", "utf8");
  git(dir, "add", "tracked.txt");
  git(dir, "commit", "-m", "init: spåra tracked.txt");
  const untrackedFile = join(dir, "untracked.txt");
  writeFileSync(untrackedFile, "ny fil som inte är indexerad\n", "utf8");
  return { repo: dir, committedFile, untrackedFile };
}

/** Config för fixture-servern (stdio, absolut node-sökväg). */
export function fixtureConfig(id: string, extraArgs: string[] = []): McpServerConfig {
  return {
    id,
    label: `fixture ${id}`,
    transport: "stdio",
    command: nodeExe,
    args: [fixtureServer, "--name", id, ...extraArgs],
    enabled: true,
  };
}

/** Config för en av våra riktiga produktionsservrar. */
export function productConfig(id: string, script: string, args: string[], env?: Record<string, string>): McpServerConfig {
  return {
    id,
    label: id,
    transport: "stdio",
    command: nodeExe,
    args: [join(serversDir, script), ...args],
    ...(env !== undefined ? { env } : {}),
    enabled: true,
  };
}

/** Vänta fram till timeout tills predikatet är sant. */
export async function waitFor(label: string, predicate: () => boolean, timeoutMs = 5_000, intervalMs = 40): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`waitFor: ${label} blev inte sant inom ${String(timeoutMs)} ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Plocka texten ur ett McpToolResult-structuredContent (test-hjälpare). */
export function structured(result: unknown): Record<string, unknown> {
  const record = result as { structured?: unknown };
  if (typeof record?.structured === "object" && record.structured !== null) return record.structured as Record<string, unknown>;
  return {};
}

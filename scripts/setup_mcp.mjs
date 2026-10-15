#!/usr/bin/env node
/**
 * setup_mcp.mjs — automatisk registrering av MCP-servrar i `mcp.json` (FAS 4.3).
 *
 * Kor:  node scripts/setup_mcp.mjs [--check] [--force] [--offline-fs] [--repo <sokvag>]
 *
 *   (utan flaggor)  skapar mcp.json om den saknas, annars läggs bara saknade
 *                   inbyggda servrar till — brukarens egna poster rörs aldrig
 *   --check         validera bara, skriv aldrig (CI-grind)
 *   --force         skriv över de INNBGGDA serverna till standard (brukarens
 *                   egna poster och alla extra id:n bevaras)
 *   --offline-fs    bekräftar standardvalet: vår egen nexus-filesystem.mjs PÅ,
 *                   den officiella npx-servern (nätverk) AV. Idag är det redan
 *                   default, så flaggan är ett explicit, idempotent val för CI
 *                   och offline-maskiner.
 *
 * Hemligheter: skriver ut tryggt — aldrig till disk, bara ${ENV_VAR} (jfr R2).
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const require = createRequire(import.meta.url);
const clientEntry = join(repoRoot, "packages", "mcp-client", "dist", "index.js");

if (!existsSync(clientEntry)) {
  process.stderr.write("setup_mcp: @nexus/mcp-client ar inte byggt. Kor: pnpm --filter @nexus/mcp-client build\n");
  process.exit(2);
}

const { McpConfigStore, DEFAULT_MCP_SERVERS, ensureDefaultConfig, validateServerConfig } = require(clientEntry);

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(`--${flag}`) || argv.includes(flag);
const valueOf = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
};

/**
 * Bygg den önskade listan med hänsyn till flaggorna.
 * @param {import("@nexus/protocol").McpServerConfig[]} current
 */
function desiredList(current) {
  if (has("offline-fs")) {
    return current.map((server) => {
      if (server.id === "nexus-filesystem") return { ...server, enabled: true };
      if (server.id === "nexus-filesystem-official") return { ...server, enabled: false };
      return server;
    });
  }
  return current;
}

function main() {
  const store = new McpConfigStore({ repoRoot: valueOf("--repo", repoRoot) });
  process.stdout.write(`mcp.json: ${store.filePath}\n`);

  let existing = [];
  let existingError = null;
  try {
    existing = [...store.read()];
  } catch (err) {
    existingError = err;
  }

  if (has("check")) {
    if (existingError !== null) {
      process.stderr.write(`check FEL: ${existingError.message}\n`);
      for (const issue of existingError.issues ?? []) process.stderr.write(`  - ${issue}\n`);
      process.exit(1);
    }
    const problems = [];
    for (const server of existing) {
      const issues = validateServerConfig(server);
      if (issues.length > 0) problems.push(`${server.id}: ${issues.join("; ")}`);
      const resolved = store.resolve(server);
      if (resolved.missing.length > 0) problems.push(`${server.id}: saknar miljövariabel ${resolved.missing.join(", ")}`);
      if (server.transport === "stdio" && resolved.command !== undefined && resolved.args.length > 0) {
        const script = resolved.args[0];
        if (script.endsWith(".mjs") && !existsSync(script)) problems.push(`${server.id}: scriptet finns inte: ${script}`);
      }
    }
    if (problems.length > 0) {
      process.stderr.write(`check FEL (${problems.length} problem):\n`);
      for (const line of problems) process.stderr.write(`  - ${line}\n`);
      process.exit(1);
    }
    process.stdout.write(`check OK: ${existing.length} servrar validerar\n`);
    for (const server of existing) process.stdout.write(`  ${server.enabled ? "[x]" : "[ ]"} ${server.id} (${server.transport})\n`);
    process.exit(0);
  }

  if (has("force") && existing.length > 0) {
    // Kraft: bygg standardlistan men behall brukarens egna (icke-inbyggda) poster.
    const builtinIds = new Set(DEFAULT_MCP_SERVERS.map((s) => s.id));
    const userKept = existing.filter((s) => !builtinIds.has(s.id));
    store.write(desiredList([...DEFAULT_MCP_SERVERS, ...userKept]));
    process.stdout.write(`force: skrev om ${DEFAULT_MCP_SERVERS.length} inbyggda servrar + ${userKept.length} egna\n`);
  } else {
    const result = ensureDefaultConfig(store);
    if (result.created) process.stdout.write(`skapade mcp.json med ${result.servers.length} servrar\n`);
    else if (result.added.length > 0) process.stdout.write(`lade till: ${result.added.join(", ")} (befintliga: ${result.skipped.join(", ")})\n`);
    else process.stdout.write(`ingen förändring — alla inbyggda servrar redan registrerade\n`);
    if (existingError !== null && !result.created) {
      process.stderr.write(`WARNING: mcp.json kunde inte läsas innan (${existingError.message}) — ingen överskrivning gjordes\n`);
    }
  }

  const final = [...store.read()];
  const offlineTweak = desiredList(final);
  if (has("offline-fs") && JSON.stringify(offlineTweak) !== JSON.stringify(final)) {
    store.write(offlineTweak);
  }

  process.stdout.write("\nRegistrerade servrar:\n");
  for (const server of [...store.read()]) {
    const resolved = store.resolve(server);
    const target = server.transport === "stdio" ? `${resolved.command} ${resolved.args.join(" ")}`.trim() : resolved.url;
    const missing = resolved.missing.length > 0 ? `  [DÖDLIGT saknas: ${resolved.missing.join(", ")}]` : "";
    const optional = resolved.missingOptional.length > 0 ? `  [valfri saknas: ${resolved.missingOptional.join(", ")}]` : "";
    process.stdout.write(`  ${server.enabled ? "[x]" : "[ ]"} ${server.id.padEnd(24)} ${server.transport.padEnd(6)} ${target}${missing}${optional}\n`);
  }
  process.stdout.write(`\nMilljonycklar som refereras: ${store.referencedEnvNames().join(", ") || "(inga)"} — satts i .env, aldrig i mcp.json\n`);
  process.exit(0);
}

main();

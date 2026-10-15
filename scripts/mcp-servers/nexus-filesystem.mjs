#!/usr/bin/env node
/**
 * nexus-filesystem.mjs — NEXUS-IDE:s egen fil-MCP-server (FAS 4.3, offline-fallback).
 *
 * Officiella @modelcontextprotocol/server-filesystem är förvald i mcp.json när den
 * går att hämta via npx. Den här servern är reserven som fungerar UTAN nätverk och
 * lägger på det som försvaret kräver: strikt tillåten-rot-jail och skrifter som
 * MÅSTE ha approved:true (alltså godkännande i UI:t) innan de skriver.
 *
 * Start: node <absolut sökväg>/nexus-filesystem.mjs --root <sökväg> [--root ...] [--allow-write]
 */

import { z } from "zod";
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { errorResult, okResult, parseArgs, resolveWithinRoots, JailViolation, startStdioServer } from "./nexus_mcp_lib.mjs";

const args = parseArgs(process.argv.slice(2));
const roots = (args.flags["root"] ?? [process.cwd()]).map((r) => resolve(r));
const allowWriteFlag = args.flags["allow-write"] !== undefined;
// Klienten kan ha satt NEXUS_MCP_SERVER_ID till server-id:t i mcp.json — da
// ar det den som ska sta i stderr-raderna, inte skriptnamnet.
process.env.NEXUS_MCP_SERVER_ID ??= "nexus-filesystem";

const MAX_READ_BYTES = 512_000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", ".nexus", "__pycache__", ".venv", "target", "build", ".next"]);

/**
 * Jailad absolut sökväg, med tydligt felmeddelande till klienten.
 * @param {string} candidate
 */
function jailPath(candidate) {
  try {
    return { path: resolveWithinRoots(isAbsolute(candidate) ? resolve(candidate) : resolve(roots[0] ?? process.cwd(), candidate), roots) };
  } catch (err) {
    return { error: err instanceof JailViolation ? err.message : err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Enkelt glob-mönster för filnamn (stjärna och questionmark, inga klamrar).
 * Helt egenimplementerat — inga externella paket.
 * @param {string} rel
 * @param {string} glob
 */
function matchesGlob(rel, glob) {
  const normalized = rel.split(sep).join("/");
  const source = glob
    .split("*")
    .map((piece) => piece.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  const anchored = source.startsWith("**") ? source.slice(3) : source;
  const re = new RegExp(`^(?:.*/)?${anchored.replace(/^\//, "")}$`);
  return re.test(normalized) || re.test(normalized.split("/").pop() ?? normalized);
}

/**
 * Rekursiv filvandring med djupgräns och ignorerade kataloger.
 * @param {string} dir
 * @param {string[]} out
 * @param {number} depth
 * @param {number} maxFiles
 */
async function walk(dir, out, depth, maxFiles) {
  if (depth > 12 || out.length >= maxFiles) return;
  /** @type {import("node:fs").Dirent[]} */
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= maxFiles) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await walk(full, out, depth + 1, maxFiles);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

await startStdioServer({
  name: "nexus-filesystem",
  version: "1.0.0",
  title: "NEXUS filesystem",
  register: (server) => {
    server.registerTool(
      "read_file",
      {
        title: "Läs fil",
        description: "Läs en textfil inom tillåtna rötter. Returnerar innehåll + byteantal och truncerad-flagga.",
        inputSchema: { path: z.string().min(1).describe("Sökväg (absolut eller relativ rot)."), maxBytes: z.number().int().min(1).max(MAX_READ_BYTES).optional().describe("Maks antal lästa byte.") },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        _meta: { requiresApproval: false },
      },
      async ({ path, maxBytes }) => {
        const j = jailPath(path);
        if (j.error) return errorResult(j.error);
        const limit = maxBytes ?? MAX_READ_BYTES;
        try {
          const info = await stat(j.path);
          if (!info.isFile()) return errorResult(`inte en fil: ${j.path}`);
          const buffer = await readFile(j.path);
          const truncated = buffer.byteLength > limit;
          return okResult(
            { path: j.path, bytes: buffer.byteLength, size: info.size, mtimeMs: info.mtimeMs, truncated, content: buffer.subarray(0, limit).toString("utf8") },
            buffer.subarray(0, limit).toString("utf8"),
          );
        } catch (err) {
          return errorResult(`läsning fejade: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    );

    server.registerTool(
      "list_dir",
      {
        title: "Lista katalog",
        description: "Direkt innehållsförteckning med filtyper och storlekar. Read-only.",
        inputSchema: { path: z.string().describe("Katalog att lista."), includeSize: z.boolean().optional().describe("Statistik för varje fil.") },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        _meta: { requiresApproval: false },
      },
      async ({ path, includeSize }) => {
        const j = jailPath(path);
        if (j.error) return errorResult(j.error);
        try {
          const entries = await readdir(j.path, { withFileTypes: true });
          const rows = [];
          for (const entry of entries) {
            const full = join(j.path, entry.name);
            /** @type {number | undefined} */
            let size;
            if (includeSize !== false && entry.isFile()) {
              try {
                size = (await stat(full)).size;
              } catch {
                size = undefined;
              }
            }
            rows.push({ name: entry.name, path: full, kind: entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "link" : "file", size });
          }
          return okResult({ path: j.path, entries: rows }, rows.map((r) => `${r.kind === "dir" ? "d" : "-"} ${r.path}`).join("\n") || "(tom katalog)");
        } catch (err) {
          return errorResult(`listning fejade: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    );

    server.registerTool(
      "search_files",
      {
        title: "Sök i filer",
        description: "Innehållssökning (sträng eller regex) över trädet under en rot. JS-implementerad, kräver ingen ripgrep.",
        inputSchema: {
          query: z.string().min(1).describe("Text eller regex att söka efter."),
          path: z.string().optional().describe("Katalog att söka i, standard första roten."),
          isRegex: z.boolean().optional().describe("Tolka query som regex."),
          includeGlob: z.string().optional().describe("Begränsa till filer som matchar glob, t.ex. *.ts"),
          maxResults: z.number().int().min(1).max(2000).optional().describe("Max antal träffar."),
          ignoreCase: z.boolean().optional().describe("Skiftlägesokänslig sökning."),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        _meta: { requiresApproval: false },
      },
      async ({ query, path, isRegex, includeGlob, maxResults, ignoreCase }) => {
        const base = path ?? roots[0] ?? process.cwd();
        const j = jailPath(base);
        if (j.error) return errorResult(j.error);
        let re;
        try {
          re = isRegex ? new RegExp(query, ignoreCase ? "i" : "") : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ignoreCase ? "i" : "");
        } catch (err) {
          return errorResult(`ogiltigt mönster: ${err instanceof Error ? err.message : String(err)}`);
        }
        const files = [];
        await walk(j.path, files, 0, 5000);
        const limit = maxResults ?? 300;
        const hits = [];
        const scanned = [];
        for (const file of files) {
          if (includeGlob && !matchesGlob(file.slice(j.path.length + 1), includeGlob)) continue;
          scanned.push(file);
          /** @type {string} */
          let text = "";
          try {
            const buf = await readFile(file);
            if (buf.includes(0)) continue; // binär
            text = buf.toString("utf8");
          } catch {
            continue;
          }
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i] ?? "";
            const m = re.exec(line);
            if (m === null) continue;
            hits.push({ path: file, line: i + 1, column: m.index + 1, preview: line.trim().slice(0, 200), match: m[0] ?? query });
            if (hits.length >= limit) break;
          }
          if (hits.length >= limit) break;
        }
        return okResult({ query, root: j.path, numMatches: hits.length, numFiles: scanned.length, truncated: hits.length >= limit, hits }, hits.map((h) => `${h.path}:${h.line}:${h.column}: ${h.preview}`).join("\n") || "(inga träffar)");
      },
    );

    server.registerTool(
      "write_file",
      {
        title: "Skriv fil",
        description: "Skriv eller overskriv en fil. Kräver approved:true (användarens godkännande) och att write_file inte är avstängd, annars nekas anropet.",
        inputSchema: {
          path: z.string().min(1).describe("Målsökväg inom tillåtna rötter."),
          content: z.string().describe("Filens nya innehåll (hel fil, ingen patch)."),
          approved: z.boolean().optional().describe("Måste vara true — bekräftar att användaren godkänt skrivningen."),
          mkdir: z.boolean().optional().describe("Skapa saknade föräldrakataloger."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        _meta: { requiresApproval: true, riskLevel: "medium", jailEnforced: true },
      },
      async ({ path, content, approved, mkdir: makeParents }) => {
        const j = jailPath(path);
        if (j.error) return errorResult(j.error);
        if (!allowWriteFlag) {
          return errorResult(`skrivningar är avstängda för servern (startades utan --allow-write): ${j.path}`, { requiresApproval: true, disabled: true });
        }
        if (approved !== true) {
          return errorResult("nekad: write_file kräver användarens godkännande. Skicka approved:true.", { requiresApproval: true, path: j.path, bytes: Buffer.byteLength(content, "utf8") });
        }
        try {
          if (makeParents === true) await mkdir(j.path.slice(0, j.path.lastIndexOf(sep)), { recursive: true });
          await writeFile(j.path, content, "utf8");
          const info = await stat(j.path);
          return okResult({ path: j.path, bytes: info.size, written: true }, `skrev ${info.size} byte till ${j.path}`);
        } catch (err) {
          return errorResult(`skrivning fejade: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    );

    server.registerTool(
      "list_roots",
      {
        title: "Lista tillåtna rötter",
        description: "Returnerar de kataloger servern är jailad till. Read-only.",
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        _meta: { requiresApproval: false },
      },
      async () => okResult({ roots, allowWrite: allowWriteFlag }, roots.join("\n")),
    );
  },
});

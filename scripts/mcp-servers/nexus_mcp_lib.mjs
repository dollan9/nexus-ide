/**
 * nexus_mcp_lib.mjs — delad bootstrap för NEXUS-IDE:s egna MCP-servrar.
 *
 * Krav (FAS 4.3):
 *   - Ren ESM (.mjs) och ONLYA beroenden: @modelcontextprotocol/sdk + Node-inkapslade moduler.
 *   - Startbar med absolut node-sökväg: `node /sökväg/nexus-git.mjs --repo <sökväg>`.
 *   - MÅSTE avsluta rent när föräldern stänger stdin — inga kvarlämnade processer.
 *   - Aktiva barnprocesser (git, skal) avlivas innan vi själv avslutar.
 *
 * Kommentarer på svenska, publik API på engelska (CONVENTIONS.md).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** alla aktiva barnprocesser — spåras så inget barn överlever oss. */
const activeChildren = new Set();

/**
 * Registrerar ett barn hos libbet så att det hinner avlivas vid shutdown.
 * @param {import("node:child_process").ChildProcess} child
 * @returns {import("node:child_process").ChildProcess}
 */
export function trackChild(child) {
  activeChildren.add(child);
  const forget = () => activeChildren.delete(child);
  child.on("exit", forget);
  child.on("error", forget);
  return child;
}

function killChildrenNow() {
  for (const child of activeChildren) {
    try {
      // Windows: SIGKILL saknas egentligen, men Node skickar nonetheless ett
      // avslut till processen. taskkill /T sköter trädret utifrån klienten.
      child.kill("SIGKILL");
    } catch {
      // Redan död — struntar i det.
    }
  }
  activeChildren.clear();
}

/**
 * Enkel flaggparserare: `--repo <v>`, `--root <v>` (upprepningsbar), `--dry-run`.
 * @param {string[]} argv
 * @returns {{ flags: Record<string, string[]>, rest: string[] }}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string[]>} */
  const flags = {};
  /** @type {string[]} */
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== "string" || !token.startsWith("--")) {
      if (token !== undefined) rest.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = [...(flags[key] ?? []), "true"];
      continue;
    }
    flags[key] = [...(flags[key] ?? []), next];
    i += 1;
  }
  return { flags, rest };
}

/**
 * Skriv till stderr — klienten fångar detta som `mcp/log` med server-id.
 * stdout är reserverad för JSON-RPC och får ALDRIG smutsas ner.
 * @param {string} message
 */
export function log(message) {
  process.stderr.write(`[${process.env.NEXUS_MCP_SERVER_ID ?? "nexus-mcp"}] ${message}\n`);
}

/**
 * Framgångsrikt tool-svar: text för människor + structuredContent för maskinen.
 * @param {unknown} data
 * @param {string} [text]
 * @returns {{content: {type: "text", text: string}[], structuredContent: Record<string, unknown>}}
 */
export function okResult(data, text) {
  const payload = typeof data === "object" && data !== null ? (data /** @type {Record<string, unknown>} */) : { value: data };
  const body = text ?? JSON.stringify(payload, null, 2);
  return {
    content: [{ type: "text", text: body }],
    structuredContent: { ok: true, ...payload },
  };
}

/**
 * Fel inifrån ett tool: isError enligt MCP-protokollet (transporten lever vidare).
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 */
export function errorResult(message, extra) {
  /** @type {Record<string, unknown>} */
  const structured = { ok: false, error: message, ...extra };
  return {
    content: [{ type: "text", text: `${message}${extra && Object.keys(extra).length > 0 ? `\n${JSON.stringify(extra)}` : ""}` }],
    structuredContent: structured,
    isError: true,
  };
}

/** Undantag för väg som lämnar tillåtna rötter. */
export class JailViolation extends Error {}

/**
 * Kontrollera att en sökväg faktiskt ligger under en av de tillåtna rötterna.
 * Följer realpath på befintlig förfader så att en symlink inte smugglar ut oss.
 * @param {string} candidate
 * @param {string[]} roots
 * @returns {string} absolut, normaliserad sökväg
 */
export function resolveWithinRoots(candidate, roots) {
  if (roots.length === 0) {
    throw new JailViolation("Inga tillåtna rotkataloger är konfigurerade för servern.");
  }
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(roots[0] ?? process.cwd(), candidate);
  const probe = deepestExistingRealpath(absolute);
  for (const root of roots) {
    const realRoot = deepestExistingRealpath(root);
    const rel = relative(realRoot, probe);
    if (rel === "") return absolute;
    if (rel !== undefined && !rel.startsWith("..") && !isAbsolute(rel)) return absolute;
  }
  throw new JailViolation(`Sökvägen ligger utanför tillåtna rotkataloger: ${absolute}`);
}

/**
 * Realpath för den djupast existerande förfadern (målen kan vara ännu obefintliga).
 * @param {string} p
 */
function deepestExistingRealpath(p) {
  let current = resolve(p);
  /** @type {string[]} */
  const missing = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : resolve(real, ...missing.reverse());
    } catch {
      const parent = current.slice(0, current.lastIndexOf(sep));
      if (parent === current || parent.length === 0) return current;
      missing.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

/**
 * Starta en stdio-MCP-server och avsluta rent när föräldern stänger av oss.
 * @param {{ name: string; version: string; title?: string; register: (server: McpServer) => void }} options
 * @returns {Promise<{ server: McpServer, transport: StdioServerTransport }>}
 */
export async function startStdioServer(options) {
  const server = new McpServer(
    { name: options.name, version: options.version, ...(options.title ? { title: options.title } : {}) },
    { instructions: "NEXUS-IDE egen MCP-server. Verktyg svarar med strukturerad JSON i structuredContent." },
  );
  options.register(server);

  const transport = new StdioServerTransport();
  let closing = false;

  /** Enkel shutdown-vakt: första anledningen vinner, inga dubbla exit. */
  const shutdown = (code, reason) => {
    if (closing) return;
    closing = true;
    log(`avslutar (${reason})`);
    killChildrenNow();
    // Protokoll-lagret stängs best-effort; vi väntar inte på det vid exit.
    void Promise.resolve(server.close()).catch(() => undefined);
    process.exitCode = code;
    process.exit(code);
  };

  // Transportens onclose överskrider Protocol.onclose, men den sista raden är
  // att stdin stängs — då finns ingen förälder kvar att svara på.
  transport.onclose = () => shutdown(0, "transport stängd");
  server.server.onclose = () => shutdown(0, "protokoll stängt");
  process.stdin.on("end", () => shutdown(0, "stdin EOF"));
  process.stdin.on("close", () => shutdown(0, "stdin stängd"));
  process.on("SIGTERM", () => shutdown(0, "SIGTERM"));
  process.on("SIGINT", () => shutdown(0, "SIGINT"));
  process.on("uncaughtException", (err) => {
    log(`okänt fel: ${err instanceof Error ? err.message : String(err)}`);
    shutdown(1, "uncaughtException");
  });
  process.on("unhandledRejection", (err) => {
    log(`okänt löfte: ${err instanceof Error ? err.message : String(err)}`);
    shutdown(1, "unhandledRejection");
  });

  await server.connect(transport);
  log("redo på stdio");
  return { server, transport };
}

/**
 * ensureDefaultConfig — auto-registrering av standardserverarna (FAS 4.3).
 *
 * Beteende som ar avsiktligt icke-forstorande:
 *   - saknas mcp.json: skriv whole standarduppsattningen
 *   - finns filen: bara NEXUS-ingbyggda serverns id som saknas laggs till,
 *     användarens egna poster och alla flaggor (enabled) lamnas ororda
 *   - ar en inbyggd post korrupt eller uteseden: sags till, ingen overskrivning
 */

import type { McpServerConfig } from "@nexus/protocol";
import { McpConfigError } from "./types";
import { DEFAULT_MCP_SERVERS } from "./defaults";
import type { McpConfigStore } from "./config_store";

export interface EnsureDefaultsResult {
  readonly created: boolean;
  readonly added: string[];
  readonly skipped: string[];
  readonly servers: readonly McpServerConfig[];
}

/**
 * Jamfor disken med DEFAULT_MCP_SERVERS och registrerar det som saknas.
 * @param store
 * @param defaults
 */
export function ensureDefaultConfig(store: McpConfigStore, defaults: readonly McpServerConfig[] = DEFAULT_MCP_SERVERS): EnsureDefaultsResult {
  let existing: readonly McpServerConfig[];
  try {
    existing = store.read();
  } catch (err) {
    // Saknad fil ar enda tillatet att skriva standard over; korrupt fil kastar
    // vidare sa att anvandarens data aldrig forstors.
    if (err instanceof McpConfigError && err.issues.includes("fil saknas")) {
      const written = store.ensureDefaults(defaults);
      return { created: written.created, added: defaults.map((s) => s.id), skipped: [], servers: written.servers };
    }
    throw err;
  }

  const present = new Set(existing.map((s) => s.id));
  const added: string[] = [];
  const skipped: string[] = [];
  const next = [...existing];
  for (const candidate of defaults) {
    if (present.has(candidate.id)) {
      skipped.push(candidate.id);
      continue;
    }
    next.push(candidate);
    added.push(candidate.id);
  }
  if (added.length > 0) store.write(next);
  return { created: false, added, skipped, servers: added.length > 0 ? store.read() : existing };
}

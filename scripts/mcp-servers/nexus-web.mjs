#!/usr/bin/env node
/**
 * nexus-web.mjs — NEXUS-IDE:s web-MCP-server (FAS 4.3, valfri men kravlös).
 *
 * fetch_url kraver INGEN nyckel och fungerar har (Node 24 har global fetch).
 * search_web kraver BRAVE_API_KEY och laiser den ALDRIG fran mcp.json — bara fran
 * processens miljo (servern startas med env-vidaregivningen ${BRAVE_API_KEY}),
 * och virgr snalt utan att lira naket varde i nagot svar.
 *
 * Start: node <absolut sokvag>/nexus-web.mjs
 */

import { z } from "zod";
import { errorResult, okResult, startStdioServer } from "./nexus_mcp_lib.mjs";

process.env.NEXUS_MCP_SERVER_ID ??= "nexus-web";

const MAX_BYTES = 400_000;

/**
 * HTML -> grov men lasbar text. Tar bort script/style, bevarar stycken.
 * @param {string} html
 */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * GET med timeout och abort-signal. Endast http/https hanteras av anroparen.
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {number} timeoutMs
 * @returns {Promise<{status:number, ok:boolean, contentType:string, body:string}>}
 */
async function httpGet(url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
    const body = await response.text();
    return { status: response.status, ok: response.ok, contentType: response.headers.get("content-type") ?? "", body };
  } finally {
    clearTimeout(timer);
  }
}

await startStdioServer({
  name: "nexus-web",
  version: "1.0.0",
  title: "NEXUS web",
  register: (server) => {
    server.registerTool(
      "fetch_url",
      {
        title: "Hamta URL",
        description: "GET:ar en http/https-URL och returnerar rakens text (HTML renas) eller raw body. Behover ingen API-nyckel.",
        inputSchema: {
          url: z.string().min(1).describe("Absolut URL med http eller https."),
          maxBytes: z.number().int().min(1).max(MAX_BYTES).optional().describe("Begransa svaret till N tecken."),
          as: z.enum(["text", "raw"]).optional().describe("text = HTML avtaggad, raw = original body."),
          timeoutMs: z.number().int().min(500).max(60_000).optional().describe("Network-timeout i millisekunder."),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        _meta: { requiresApproval: false },
      },
      async ({ url, maxBytes, as, timeoutMs }) => {
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          return errorResult(`ogiltig URL: ${url}`);
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return errorResult(`protokoll nekas: ${parsed.protocol} (endast http/https)`);
        }
        try {
          const r = await httpGet(parsed.toString(), {}, timeoutMs ?? 15_000);
          const rawBody = as === "raw" ? r.body : r.contentType.includes("html") ? htmlToText(r.body) : r.body;
          const limit = maxBytes ?? MAX_BYTES;
          const truncated = rawBody.length > limit;
          return okResult(
            { url: parsed.toString(), status: r.status, ok: r.ok, contentType: r.contentType, truncated, text: rawBody.slice(0, limit) },
            `HTTP ${r.status} ${r.contentType}\n${rawBody.slice(0, limit)}`,
          );
        } catch (err) {
          return errorResult(`hämtning fejade: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    );

    server.registerTool(
      "search_web",
      {
        title: "Webbsok (kraver BRAVE_API_KEY)",
        description: "Brave Free Search. Laser nyckeln ur processmiljon, aldrig ur mcp.json. Utan nyckel: tydligt fel, ingen licka.",
        inputSchema: { query: z.string().min(1).describe("Sokfrag."), count: z.number().int().min(1).max(20).optional().describe("Antal trafar.") },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        _meta: { requiresApproval: false, needsEnv: ["BRAVE_API_KEY"] },
      },
      async ({ query, count }) => {
        const key = process.env.BRAVE_API_KEY ?? "";
        if (key.length === 0) {
          return errorResult("search_web är otillgänglig: BRAVE_API_KEY är inte satt i .env/miljön. fetch_url fungerar ändå.", { needsEnv: "BRAVE_API_KEY" });
        }
        try {
          const endpoint = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${String(count ?? 10)}`;
          const r = await httpGet(endpoint, { Accept: "application/json", "X-Subscription-Token": key }, 15_000);
          if (!r.ok) return errorResult(`Brave svarade HTTP ${String(r.status)}`);
          const data = JSON.parse(r.body);
          const rows = Array.isArray(data?.web?.results) ? data.web.results : [];
          const results = rows.slice(0, count ?? 10).map((row) => ({ title: String(row.title ?? ""), url: String(row.url ?? ""), description: String(row.description ?? "") }));
          return okResult({ query, results }, results.map((x) => `${x.title} — ${x.url}`).join("\n") || "(inga trafar)");
        } catch (err) {
          return errorResult(`sök fejade: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    );
  },
});

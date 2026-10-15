/**
 * scripts/make_result.mjs — gör tests/RESULT.md av tests/RESULT.jsonl.
 * Tabellen är den enda plats där P0-gaten rapporteras, och BEVIS-kolumnen kommer från den verkliga
 * körningen (source-fältet local | cloud | stub | none), aldrig från en bedömning.
 *
 * Kör: node scripts/make_result.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const JSONL = join(ROOT, "tests", "RESULT.jsonl");
const OUT = join(ROOT, "tests", "RESULT.md");

const BEVIS_TEXT = {
  local: "lokalt svar (Ollama/egen modell)",
  cloud: "moln-API (riktig nyckel)",
  stub: "STUB — lokal deterministisk test-server",
  none: "ingen modell",
  "n/a": "inget modellanrop behovs",
};

const P0 = [
  ["T1", "App startar, UI renderas, filtrad visas"],
  ["T1-neg", "Ingen modell => kodat fel, ingen krasch"],
  ["T2", "Chat streamar svar"],
  ["T3", "Custom-API tillagd via UI, persistrad i .env"],
  ["T4", "MCP filesystem tool-call i agent-loop"],
  ["T5", "Terminal-tool faangar output + nekat kommando"],
  ["T6", "Rollback aterstaller fil byte-identiskt"],
  ["T7", "Autocomplete ghost-text i .ts-fil"],
  ["T8", "RAG-sok hittar ratt fil pa spraklig fraga"],
];

const ICON = { pass: "✅", fail: "❌", skip: "⚠️" };

async function main() {
  if (!existsSync(JSONL)) {
    await writeFile(OUT, "# Tester — RESULT.md\n\nInga resultat ännu. Kör `pnpm e2e` (eller `pnpm test`) först.\n", "utf8");
    console.log("RESULT.jsonl saknas — skrev tomma tabellen.");
    return;
  }
  const lines = (await readFile(JSONL, "utf8")).split("\n").filter(Boolean);
  const rows = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);

  // Senaste resultatet per test-id gäller (omkörningar efter fix ska vinna).
  const latest = new Map();
  for (const r of rows) latest.set(r.test, r);

  const unitRuns = rows.filter((r) => r.kommando === "pnpm test").length;
  const byId = new Map(P0.map(([id, title]) => [id, { title, row: latest.get(id) }]));

  const head = [
    "# Tester — RESULT.md",
    "",
    `Genererad ${new Date().toISOString()} av \`node scripts/make_result.mjs\`.`,
    `Källa: ${lines.length} rad(er) i RESULT.jsonl (senaste körningen per test gäller).`,
    "",
    "Läs BEVIS-kolumnen föreglva. `stub` innebar att flödet är verkligt (riktig host, riktig fil,",
    "riktig terminal, riktig MCP-server) men att texten kom fran en lokal deterministisk test-server,",
    "inte fran en riktig sprakmodell. Ingen rad i denna tabell utger en stub for ett verkligt molnsvar.",
    "",
    "| TEST | STATUS | BEVIS | LOGG |",
    "|------|--------|-------|------|",
  ];

  const body = [];
  let green = 0;
  for (const [id, { title, row }] of byId) {
    if (!row) {
      body.push(`| ${id} | ⚠️ ej körd | — | test finns i specs/p0.spec.ts men saknar resultatrad |`);
      continue;
    }
    if (row.status === "pass") green++;
    const bevis = BEVIS_TEXT[row.bevis] ?? row.bevis;
    const logg = String(row.detalj ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 300);
    body.push(`| ${id} ${title} | ${ICON[row.status] ?? "?"} ${row.status} | ${bevis} (${row.tookMs} ms) | ${logg} |`);
  }

  const tail = [
    "",
    `**P0-status: ${green}/${byId.size} goda.**`,
    "",
    "## Steg-for-steg-kommandon",
    "",
    "```bash",
    "pnpm install          # en gang",
    "pnpm -r build         # alla paket",
    "pnpm -r test          # enhetstester (vitest)",
    "pnpm e2e              # P0-gaten T1-T8 (Playwright)",
    "node scripts/make_result.mjs   # fornya denna fil",
    "```",
    "",
    unitRuns ? `Enhetstedsresultat franvar i samma JSONL (${unitRuns} rader).` : "",
    "",
  ].filter(Boolean);

  await writeFile(OUT, head.concat(body, tail).join("\n") + "\n", "utf8");
  console.log(`RESULT.md skriven: ${green}/${byId.size} P0-goda`);
  for (const [id, { row }] of byId) console.log(`  ${id.padEnd(8)} ${row ? row.status + "  bevis=" + row.bevis : "ej körd"}`);
}

main().catch((e) => {
  console.error("make_result fick fel:", e);
  process.exit(1);
});

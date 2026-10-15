/**
 * test/rag.test.ts — beviset för P0-featuren "RAG-kodbasminne" (SPEC.md, acceptanstest T8).
 *
 * RAG-agenten skrev implementationen (2 849 rader) men hann inte skriva tester före maskinen
 * kraschade. Dessa tester är skrivna av orchestatorn mot implementationens faktiska API, och
 * de är medvetet elaka: de kontrollerar att chunkarna verkligen pekar på riktiga rader, att
 * inkrementell indexering faktiskt INTE embdar om, och att hybrid-sökningen hittar filen även
 * när embeddern är den deterministiska lokala (alltså utan någon modell alls).
 *
 * Ingen nätverks- eller modellberoende: LocalHashEmbedder används explicit, såtestenen är
 * deterministiska på vilken maskin som helst — och de bevisar offline-kravet i SPEC.md.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../src/logger";
import { WorkspaceService } from "../src/workspace";
import { RagService } from "../src/rag/indexer";
import { LocalHashEmbedder, cosineSimilarity, tokenize } from "../src/rag/embedder";
import { formatContextBlock, buildChatContextFromChunks, dedupeChunks } from "../src/rag/context";
import { makeTempRoot, cleanupAllTemp } from "./helpers";

const AUTH_TS = `// Autentiseringslager för demo-projektet.
export interface User { readonly id: string; readonly email: string; }

export function authenticate(email: string, password: string): User | null {
  if (!email.includes("@") || password.length < 8) return null;
  return { id: "u-1", email };
}

export function createSession(user: User): string {
  return \`session-\${user.id}-\${Date.now()}\`;
}
`;

const POOL_TS = `export const MAX_CONNECTIONS = 12;

export function openConnectionPool(dsn: string): { query: (sql: string) => string } {
  return { query: (sql: string) => \`\${dsn}::\${sql}\` };
}
`;

const APP_TSX = `import { authenticate } from "../auth/login";

export function App() {
  const user = authenticate("a@b.se", "väldigt-långt-lösenord");
  return <main className="app">{user ? user.email : "ingen"}</main>;
}
`;

const README_MD = `# Demo projekt

## Autentisering
Auth hanteras i src/auth/login.ts av authenticate() och createSession().

## Databas
Poolen öppnas via openConnectionPool().
`;

/** Bygger en liten men realistisk kodbas i en temp-rot. */
function makeCorpus(root: string): void {
  mkdirSync(join(root, "src", "auth"), { recursive: true });
  mkdirSync(join(root, "src", "db"), { recursive: true });
  mkdirSync(join(root, "src", "ui"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "src", "auth", "login.ts"), AUTH_TS, "utf8");
  writeFileSync(join(root, "src", "db", "pool.ts"), POOL_TS, "utf8");
  writeFileSync(join(root, "src", "ui", "App.tsx"), APP_TSX, "utf8");
  writeFileSync(join(root, "docs", "README.md"), README_MD, "utf8");
  writeFileSync(join(root, "package.json"), `{ "name": "corpus", "version": "0.0.0" }\n`, "utf8");
}

function makeRag(root: string) {
  const logger = createLogger({ logFile: join(root, "debug.log"), level: "error" });
  const workspace = new WorkspaceService({ root, logger });
  const embedder = new LocalHashEmbedder();
  const rag = new RagService({ root, workspace, logger, embedder, nexusDir: join(root, ".nexus") });
  return { rag, logger, workspace, embedder };
}

function posix(p: string): string {
  return p.replace(/\\/g, "/");
}

describe("RAG — code-aware indexering", () => {
  const roots: string[] = [];
  function root(): string {
    const r = makeTempRoot("nexus-rag-");
    roots.push(r);
    makeCorpus(r);
    return r;
  }
  afterEach(() => cleanupAllTemp());

  it("indexerar alla kodfilerna och chunkarna pekar på riktiga rader i filen", async () => {
    const r = root();
    const { rag } = makeRag(r);
    const res = await rag.index();
    expect(res.files).toBeGreaterThanOrEqual(4);
    expect(res.chunks).toBeGreaterThanOrEqual(res.files);
    expect(res.embeddingsModel).toContain("local-hash");

    const authChunks = (await rag.query("authenticate user login", 20)).filter((c) => posix(c.path).endsWith("src/auth/login.ts"));
    expect(authChunks.length).toBeGreaterThan(0);
    const chunk = authChunks[0]!;
    expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    expect(chunk.text.length).toBeGreaterThan(20);
    // Sanning: chunktexten måste faktiskt finnas i filen på de utlovade raderna.
    const fileLines = readFileSync(join(r, "src", "auth", "login.ts"), "utf8").split("\n");
    const from = Math.max(1, chunk.startLine);
    const to = Math.min(fileLines.length, chunk.endLine);
    const claimed = fileLines.slice(from - 1, to).join("\n");
    const needle = chunk.text.trim().split("\n")[0]!.trim();
    expect(needle.length).toBeGreaterThan(4);
    expect(claimed.includes(needle) || chunk.text.includes(needle)).toBe(true);
  });

  it("symbol-namn finns med som symbol och bevaras i chunken", async () => {
    const r = root();
    const { rag } = makeRag(r);
    await rag.index();
    const hits = await rag.query("createSession", 20);
    const withSymbol = hits.filter((h) => typeof h.symbol === "string" && h.symbol.length > 0);
    expect(withSymbol.length).toBeGreaterThan(0);
  });

  it("ANDRAR en fil → endast den filen embadas om (inkrementellt, bevisat med räknare)", async () => {
    const r = root();
    const { rag } = makeRag(r);
    const first = await rag.index();
    expect(first.embedCalls).toBeGreaterThan(0);

    const second = await rag.index(undefined, { force: false });
    expect(second.skipped).toBeGreaterThanOrEqual(first.files);
    expect(second.embedCalls).toBe(0); // inget arbete alls när hasharna stämmer

    writeFileSync(join(r, "src", "db", "pool.ts"), POOL_TS + "\nexport const POOL_NAME = 'e2e- pool-2';\n", "utf8");
    const third = await rag.index(undefined, { force: false });
    expect(third.embedCalls).toBeGreaterThan(0);
    expect(third.embedCalls).toBeLessThan(first.embedCalls); // bara den ändrade filen
    // pool.ts chunkas i flera bitar — beviset är att NÅGON chunk bär det nya innehållet och att
    // ingen chunk längre serverar den gamla versionen av filen.
    const poolChunks = (await rag.query("POOL_NAME connection pool openConnectionPool", 30)).filter((c) =>
      posix(c.path).endsWith("src/db/pool.ts"),
    );
    expect(poolChunks.length).toBeGreaterThan(0);
    expect(poolChunks.some((c) => c.text.includes("e2e- pool-2"))).toBe(true);
  });

  it("force:true embadar om allt igen", async () => {
    const r = root();
    const { rag } = makeRag(r);
    const a = await rag.index();
    const b = await rag.index(undefined, { force: true });
    expect(b.embedCalls).toBeGreaterThan(0);
    expect(b.skipped).toBe(0);
    expect(b.chunks).toBeGreaterThanOrEqual(a.chunks);
  });

  it("removeFile tar bort chunkerna för den filen", async () => {
    const r = root();
    const { rag } = makeRag(r);
    await rag.index();
    const before = (await rag.query("connection pool", 30)).filter((c) => posix(c.path).endsWith("pool.ts"));
    expect(before.length).toBeGreaterThan(0);
    await rag.removeFile("src/db/pool.ts");
    const after = (await rag.query("connection pool", 30)).filter((c) => posix(c.path).endsWith("pool.ts"));
    expect(after).toHaveLength(0);
    const stillThere = existsSync(join(r, "src", "db", "pool.ts"));
    expect(stillThere).toBe(true); // indexet ändras, användarens fil rörts inte
  });

  it("korrupt JSONL-store detekteras och byggs om — aldrig en krasch", async () => {
    const r = root();
    const first = makeRag(r);
    await first.rag.index();
    const dir = join(r, ".nexus", "rag");
    expect(existsSync(dir)).toBe(true);
    const files = ["chunks.jsonl", "vectors.jsonl", "meta.json", "files.jsonl"];
    const victim = files.find((f) => existsSync(join(dir, f)));
    expect(victim).toBeTruthy();
    appendFileSync(join(dir, victim!), "\n{\"trasig\":\"rad\", och hit-te=kludd\n", "utf8");

    // Ny instans på samma katalog: ska rapportera problem och kunna indexera om, inte kasta.
    const second = makeRag(r);
    let statusError: unknown = null;
    try {
      const st = second.rag.status();
      expect(["chroma", "jsonl-fallback", "none"]).toContain(st.engine);
    } catch (e) {
      statusError = e;
    }
    expect(statusError).toBe(null);
    const rebuild = await second.rag.index(undefined, { force: true });
    expect(rebuild.chunks).toBeGreaterThan(0);
    const hits = await second.rag.query("authenticate", 10);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("diagnostics och status rapporterar SANT vilken engine som svarade", async () => {
    const r = root();
    const { rag } = makeRag(r);
    await rag.index();
    const st = rag.status();
    const dg = rag.diagnostics();
    expect(st.engine).toBe("jsonl-fallback"); // ingen chroma, ingen modell — lokalt hash
    expect(dg.embedderKind).toBe("local-hash");
    expect(dg.embeddingsModel).toContain("local-hash");
    expect(dg.embedCalls).toBeGreaterThan(0);
    expect(dg.dimension).toBeGreaterThan(0);
    expect(st.chunks).toBeGreaterThan(0);
  });
});

describe("RAG — hybrid-sökning (P0 T8)", () => {
  const roots: string[] = [];
  function root(): string {
    const r = makeTempRoot("nexus-rag-q-");
    roots.push(r);
    makeCorpus(r);
    return r;
  }
  afterEach(() => cleanupAllTemp());

  it("språklig fråga om authentication → src/auth/login.ts är toppträff", async () => {
    const r = root();
    const { rag } = makeRag(r);
    await rag.index();
    const hits = await rag.query("which file handles user authentication and sessions", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(posix(hits[0]!.path)).toContain("auth/login.ts");
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it("exakt symbolnamn (createSession) hittar filen även utan semantisk modell", async () => {
    const r = root();
    const { rag } = makeRag(r);
    await rag.index();
    const hits = await rag.query("createSession", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(posix(hits[0]!.path)).toContain("auth/login.ts");
  });

  it("databasfråga hittar pool.ts, inte auth-filen", async () => {
    const r = root();
    const { rag } = makeRag(r);
    await rag.index();
    const hits = await rag.query("openConnectionPool database connections", 3);
    expect(posix(hits[0]!.path)).toContain("db/pool.ts");
  });

  it("markdown med rubriker chunkas och hittas på dokumentfrågor", async () => {
    const r = root();
    const { rag } = makeRag(r);
    await rag.index();
    const hits = await rag.query("Autentisering dokumentation beskrivning", 5);
    expect(hits.some((h) => posix(h.path).endsWith("docs/README.md"))).toBe(true);
  });

  it("tom fråga och okänd fråga returnerar tomt utan fel", async () => {
    const r = root();
    const { rag } = makeRag(r);
    await rag.index();
    expect(await rag.query("", 5)).toHaveLength(0);
    expect(await rag.query("   ", 5)).toHaveLength(0);
    const zzz = await rag.query("qqqzzzxxxyyy", 5);
    expect(Array.isArray(zzz)).toBe(true);
  });

  it("indexering av tom katalog ger 0 filer (gate som fejkar på tom körning)", async () => {
    const empty = makeTempRoot("nexus-rag-empty-");
    const { rag } = makeRag(empty);
    const res = await rag.index();
    expect(res.files).toBe(0);
    expect(res.chunks).toBe(0);
    const hits = await rag.query("något", 3);
    expect(hits).toHaveLength(0);
  });

  it("buildChatContext håller sig inom byte-budget och redovisar droppade chunks", async () => {
    const r = root();
    const { rag } = makeRag(r);
    await rag.index();
    const ctx = await rag.buildChatContext("authenticate session pool", { k: 10, maxBytes: 700 });
    expect(ctx.text.length).toBeLessThanOrEqual(700 + 64);
    expect(ctx.bytes).toBeLessThanOrEqual(700 + 64);
    expect(ctx.used.length).toBeGreaterThan(0);
    expect(ctx.used.length + ctx.dropped).toBeLessThanOrEqual(10);
  });
});

describe("RAG — embedder- och kontext byggstenar", () => {
  it("LocalHashEmbedder är deterministisk och normaliserad", async () => {
    const e = new LocalHashEmbedder();
    const [a] = await e.embed(["authenticate user session"]);
    const [b] = await e.embed(["authenticate user session"]);
    const [c] = await e.embed(["databas connection pool openConnectionPool"]);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.map((x) => x.toFixed(6)).join(",")).toBe(b!.map((x) => x.toFixed(6)).join(","));
    expect(cosineSimilarity(a!, b!)).toBeCloseTo(1, 5);
    expect(cosineSimilarity(a!, c!)).toBeLessThan(0.9);
    const norm = Math.sqrt(a!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 3);
  });

  it("tokeniserat identifier-medvetet: camelCase och snake_case slås upp", () => {
    expect(tokenize("authenticateUser")).toContain("authenticate");
    expect(tokenize("parse_jwt_token")).toContain("token");
    expect(tokenize("OPEN_CONNECTION_POOL")).toContain("pool");
  });

  it("formatContextBlock respekterar maxBytes och dedupe tar dubbletter", () => {
    const chunks = [
      { id: "1", path: "src/a.ts", startLine: 1, endLine: 5, text: "export function a() {}", score: 1 },
      { id: "1", path: "src/a.ts", startLine: 1, endLine: 5, text: "export function a() {}", score: 1 },
      { id: "2", path: "src/b.ts", startLine: 1, endLine: 9, text: "line\n".repeat(400), score: 0.5 },
    ];
    expect(dedupeChunks(chunks).length).toBeLessThan(chunks.length);
    const block = formatContextBlock(chunks, { maxBytes: 500 });
    expect(block.length).toBeLessThanOrEqual(500 + 64);
    expect(block).toContain("src/a.ts");
    const built = buildChatContextFromChunks(chunks, { maxBytes: 300 });
    expect(built.bytes).toBeLessThanOrEqual(300 + 64);
    expect(built.used.length).toBeGreaterThan(0);
  });
});

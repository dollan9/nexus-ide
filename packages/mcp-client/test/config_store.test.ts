/**
 * FAS 4.2 — McpConfigStore: mcp.json, ${ENV}-interpolation, sekretess, validering
 * och icke-förstörande UI-mutationer. Alla tester arbetar mot riktiga filer.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { McpServerConfig } from "@nexus/protocol";
import {
  DEFAULT_MCP_SERVERS,
  McpConfigError,
  McpConfigStore,
  ensureDefaultConfig,
  interpolateString,
  looksLikeSecret,
  normalizeServer,
  parseDotEnv,
  validateServerConfig,
} from "../src/index";
import { makeTempDir, removeTempDir, repoRoot, serversDir } from "./helpers";

/** En falsk men formriktig nyckel — CONVENTIONS: aldrig en riktig nyckel i test. */
const FAKE_KEY = "sk-live-4f9Kj0QzPmW8xR2tB7nL";
const dirs: string[] = [];

interface TempStore {
  store: McpConfigStore;
  file: string;
  dir: string;
}

function tempStore(options: { env?: Record<string, string | undefined>; servers?: McpServerConfig[] } = {}): TempStore {
  const dir = makeTempDir("nexus-mcp-store-");
  dirs.push(dir);
  const file = join(dir, "mcp.json");
  if (options.servers !== undefined) {
    writeFileSync(file, JSON.stringify({ version: 1, servers: options.servers }, null, 2), "utf8");
  }
  const store = new McpConfigStore({
    filePath: file,
    repoRoot: dir,
    workspaceRoot: dir,
    env: { ...options.env, NEXUS_REPO_ROOT: dir, NEXUS_WORKSPACE_ROOT: dir },
    readDotEnv: false,
  });
  return { store, file, dir };
}

function stdio(id: string, command = "node", extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { id, transport: "stdio", command, args: ["--root", "${NEXUS_WORKSPACE_ROOT}"], enabled: true, ...extra };
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) removeTempDir(dir);
  }
});

describe(".env-tolk och interpolation", () => {
  it("tolkar kommentarer, export, citat och rad-kommentar", () => {
    const parsed = parseDotEnv(
      ["# kommentar", "", "OPENAI_API_KEY=sk-test-123", 'export QUOTED="hej\\nvärld"', "SINGLE='enkel'", "TRAIL=1   # rest", "dålig nyckel=", "=tom"].join("\n"),
    );
    expect(parsed["OPENAI_API_KEY"]).toBe("sk-test-123");
    expect(parsed["QUOTED"]).toBe("hej\nvärld");
    expect(parsed["SINGLE"]).toBe("enkel");
    expect(parsed["TRAIL"]).toBe("1");
    expect(Object.keys(parsed)).not.toContain("dålig nyckel");
    expect(Object.keys(parsed)).not.toContain("");
  });

  it("interpolerar ${VAR} och samlar saknade namn", () => {
    const env = { A: "alfa", PATH_TO: "/sökväg/server.mjs" };
    expect(interpolateString("${A}/${A}", env).value).toBe("alfa/alfa");
    expect(interpolateString("${PATH_TO} --x", env).value).toBe("/sökväg/server.mjs --x");
    const missing = interpolateString("${A} ${SAKNAS} ${A}", env);
    expect(missing.missing).toEqual(["SAKNAS"]);
    expect(missing.value).toContain("${SAKNAS}");
    expect(interpolateString("inget att göra", env)).toEqual({ value: "inget att göra", missing: [] });
  });

  it("nyckeln bor i .env — aldrig i mcp.json", () => {
    const dir = makeTempDir("nexus-mcp-dotenv-");
    dirs.push(dir);
    writeFileSync(join(dir, ".env"), `BRAVE_API_KEY=${FAKE_KEY}\n`, "utf8");
    const store = new McpConfigStore({ filePath: join(dir, "mcp.json"), repoRoot: dir, env: {}, readDotEnv: true });
    const server = stdio("web", "node", { env: { BRAVE_API_KEY: "${BRAVE_API_KEY}" } });
    store.write([server]);
    const onDisk = readFileSync(join(dir, "mcp.json"), "utf8");
    expect(onDisk).toContain("${BRAVE_API_KEY}");
    expect(onDisk).not.toContain(FAKE_KEY);
    const resolved = store.resolve(server);
    expect(resolved.env["BRAVE_API_KEY"]).toBe(FAKE_KEY);
    expect(resolved.missing).toEqual([]);

    const ui = store.listForUi();
    expect(JSON.stringify(ui)).not.toContain(FAKE_KEY);
    expect(ui[0]?.envNames).toContain("BRAVE_API_KEY");
  });
});

describe("validering av serverformer", () => {
  it("avvisar id som innehåller namespace-separatorn (kollision måste vara omöjlig)", () => {
    expect(validateServerConfig(stdio("dup__licit"))).toContain('id: får inte innehålla "__" (reserverad för namnrymd) (dup__licit)');
    expect(validateServerConfig(stdio("ok-id.1_2"))).toEqual([]);
    expect(validateServerConfig(stdio("tom", ""))).toContain("stdio: command krävs");
    // Id:t blir en del av verktygsnamnet som skickas till modell-API:erna (OpenAI och
    // Anthropic tillåter bara [A-Za-z0-9_-]), därför är å/ä/ö ett formfel — inte en
    // smakfråga. `label` är däremot fri text och får skrivas på svenska.
    expect(validateServerConfig(stdio("två")).some((i) => i.startsWith("id: ogiltigt format"))).toBe(true);
    expect(validateServerConfig(stdio("x", "node", { label: "Min server — två" }))).toEqual([]);
  });

  it("avvisar transport-/url-/args-/env-formfel", () => {
    expect(validateServerConfig({ id: "x", transport: "http", enabled: true })).toContain("http: url krävs");
    expect(validateServerConfig({ id: "x", transport: "ftp", enabled: true })[0]).toContain("transport:");
    expect(validateServerConfig({ id: "x", transport: "sse", url: "https://e.com/mcp", args: ["inte"], enabled: true })).toContain("args: endast giltig för stdio");
    expect(validateServerConfig(stdio("x", "node", { url: "https://e.com" }))).toContain("stdio: url får inte användas");
    expect(validateServerConfig({ id: "x", transport: "sse", url: "not-a-url", enabled: true }).some((i) => i.startsWith("url: ogiltig URL"))).toBe(true);
    expect(validateServerConfig({ id: "x", transport: "http", url: "ftp://e.com", enabled: true }).some((i) => i.startsWith("url: bara http/https"))).toBe(true);
    expect(validateServerConfig({ id: "x", transport: "stdio", command: "node" } as unknown)).toContain("enabled: boolean krävs");
    expect(validateServerConfig({ id: "x", transport: "stdio", command: "node", enabled: true, env: { A: 1 } })).toContain("env.A: värdet måste vara en sträng");
    expect(validateServerConfig("sträng")).toEqual(["server-objekt förväntas"]);
  });

  it("känner igen nyckelmönster och avvisar dem i config", () => {
    expect(looksLikeSecret(FAKE_KEY)).toBe(true);
    expect(looksLikeSecret("nvapi-Sup3rSecretToken1234567890")).toBe(true);
    expect(looksLikeSecret("sk-test-123")).toBe(false);
    expect(looksLikeSecret("${OPENAI_API_KEY}")).toBe(false);
    expect(validateServerConfig(stdio("x", FAKE_KEY))[0]).toContain("ser ut som en riktig nyckel");
    expect(validateServerConfig(stdio("x", "node", { args: ["--token", `Bearer ${FAKE_KEY}`] })).some((i) => i.startsWith("args[1]"))).toBe(true);
    expect(validateServerConfig(stdio("x", "node", { headers: { Authorization: FAKE_KEY } })).some((i) => i.startsWith("headers.Authorization"))).toBe(true);
  });
});

describe("McpConfigStore läs/skriv", () => {
  it("läser, normaliserar och skriver atomiskt med version 1", () => {
    const { store, file } = tempStore();
    store.write([stdio("alpha"), stdio("beta", "node", { enabled: false })]);
    const doc = JSON.parse(readFileSync(file, "utf8")) as { version: number; servers: McpServerConfig[] };
    expect(doc.version).toBe(1);
    expect(doc.servers.map((s) => s.id)).toEqual(["alpha", "beta"]);
    expect(doc.servers[1]?.enabled).toBe(false);
    expect(store.read().map((s) => s.id)).toEqual(["alpha", "beta"]);
    // Ingen tmp-fil lämnas kvar efter den atomiska skrivningen.
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it("kastar McpConfigError på korrupt JSON, dublett-id, okänd version och fel form", () => {
    const dir = makeTempDir("nexus-mcp-broken-");
    dirs.push(dir);
    const broken = join(dir, "mcp.json");

    writeFileSync(broken, "{ this is not json", "utf8");
    expect(() => new McpConfigStore({ filePath: broken, repoRoot: dir, readDotEnv: false }).read()).toThrowError(McpConfigError);
    expect(() => new McpConfigStore({ filePath: broken, repoRoot: dir, readDotEnv: false }).read()).toThrow(/giltig JSON/);

    writeFileSync(broken, JSON.stringify({ version: 1, servers: [stdio("dub"), stdio("dub")] }), "utf8");
    let caught: McpConfigError | null = null;
    try {
      new McpConfigStore({ filePath: broken, repoRoot: dir, readDotEnv: false }).read();
    } catch (err) {
      caught = err as McpConfigError;
    }
    expect(caught).toBeInstanceOf(McpConfigError);
    expect(caught?.issues.some((i) => i.includes("dublett-id"))).toBe(true);

    writeFileSync(broken, JSON.stringify({ version: 99, servers: [] }), "utf8");
    expect(() => new McpConfigStore({ filePath: broken, repoRoot: dir, readDotEnv: false }).read()).toThrow(/okänd version/);

    writeFileSync(broken, JSON.stringify({ version: 1, servers: "hela grejen" }), "utf8");
    expect(() => new McpConfigStore({ filePath: broken, repoRoot: dir, readDotEnv: false }).read()).toThrow(/måste vara en array/);

    writeFileSync(broken, JSON.stringify([stdio("x")]), "utf8");
    expect(() => new McpConfigStore({ filePath: broken, repoRoot: dir, readDotEnv: false }).read()).toThrow(/måste vara ett objekt/);

    expect(() => new McpConfigStore({ filePath: join(dir, "mcp-saknas.json"), repoRoot: dir, readDotEnv: false }).read()).toThrow(/mcp.json saknas/);
  });

  it("vägrar skriva en literal nyckel till disk och lämnar filen orörd", () => {
    const { store, file } = tempStore({ servers: [stdio("bevarad")] });
    const before = readFileSync(file, "utf8");
    let caught: McpConfigError | null = null;
    try {
      store.write([stdio("tjuvgodis", "node", { env: { OPENAI_API_KEY: FAKE_KEY } })]);
    } catch (err) {
      caught = err as McpConfigError;
    }
    expect(caught).toBeInstanceOf(McpConfigError);
    expect(caught?.issues.some((i) => i.includes("innehåller en nyckel"))).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(store.read().map((s) => s.id)).toEqual(["bevarad"]);
  });

  it("reverserar ett inmatat nyckelvärde till ${VAR} när nyckeln finns i miljön", () => {
    const { store, file } = tempStore({ env: { OPENAI_API_KEY: FAKE_KEY } });
    expect(store.upsert(stdio("key-carrier", "node", { env: { OPENAI_API_KEY: FAKE_KEY } })).ok).toBe(true);
    const onDisk = readFileSync(file, "utf8");
    expect(onDisk).toContain("${OPENAI_API_KEY}");
    expect(onDisk).not.toContain(FAKE_KEY);

    const saved = store.read().find((s) => s.id === "key-carrier");
    if (saved === undefined) throw new Error("servern skrevs inte");
    // Upplösningen ger fortfarande rätt värde till processen.
    expect(store.resolve(saved).env["OPENAI_API_KEY"]).toBe(FAKE_KEY);
  });
});

describe("UI-mutationerna är icke-förstörande", () => {
  it("upsert av en ogiltig server ändrar varken disk eller minne", () => {
    const { store, file } = tempStore({ servers: [stdio("redan")] });
    const before = readFileSync(file, "utf8");
    const result = store.upsert({ id: "fel__id", transport: "stdio", command: "node", enabled: true });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ogiltig serverkonfiguration");
    expect(result.servers.map((s) => s.id)).toEqual(["redan"]);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(store.read().map((s) => s.id)).toEqual(["redan"]);
  });

  it("upsert ersätter befintlig, remove tar bort — okänt id är en no-op", () => {
    const { store } = tempStore({ servers: [stdio("ett", "node", { label: "första" }), stdio("two", "node", { enabled: false })] });
    expect(store.upsert(stdio("ett", "node", { label: "andra" })).ok).toBe(true);
    expect(store.read().find((s) => s.id === "ett")?.label).toBe("andra");
    expect(store.remove("two").ok).toBe(true);
    expect(store.read().map((s) => s.id)).toEqual(["ett"]);
    const ghost = store.remove("finns-inte");
    expect(ghost.ok).toBe(false);
    expect(ghost.error).toContain("okänd server-id");
    expect(store.read().map((s) => s.id)).toEqual(["ett"]);
  });

  it("toggle växlar enabled och bevarar övriga fält", () => {
    const { store, file } = tempStore({ servers: [stdio("toggle-me", "node", { env: { A: "${NODE_EXECUTABLE}" }, cwd: "/tmp/x" })] });
    expect(store.toggle("toggle-me").ok).toBe(true);
    const off = store.read().find((s) => s.id === "toggle-me");
    expect(off?.enabled).toBe(false);
    expect(off?.env).toEqual({ A: "${NODE_EXECUTABLE}" });
    expect(off?.cwd).toBe("/tmp/x");
    expect(store.toggle("toggle-me", false).ok).toBe(true);
    expect(store.read().find((s) => s.id === "toggle-me")?.enabled).toBe(false);
    expect(store.toggle("toggle-me", true).ok).toBe(true);
    expect(readFileSync(file, "utf8")).toContain('"enabled": true');
    expect(store.toggle("okänd").ok).toBe(false);
  });

  it("en skrivning som kraschar på disk återställer cachen till det gamla läget", () => {
    const dir = makeTempDir("nexus-mcp-ro-");
    dirs.push(dir);
    const file = join(dir, "mcp.json");
    const store = new McpConfigStore({ filePath: file, repoRoot: dir, readDotEnv: false });
    expect(store.upsert(stdio("ny")).ok).toBe(true);
    expect(store.read().map((s) => s.id)).toEqual(["ny"]);

    // Gör målplatsen omöjlig att skriva: en katalog med namnet mcp.json.
    removeTempDir(file);
    mkdirSync(file, { recursive: true });
    const broken = store.upsert(stdio("tva"));
    expect(broken.ok).toBe(false);
    expect(broken.error).toBeTruthy();
    expect(broken.servers.map((s) => s.id)).toEqual(["ny"]);
    expect(store.read().map((s) => s.id)).toEqual(["ny"]);
  });
});

describe("upplösning av ${VAR} i alla fem fälten", () => {
  it("command, args, cwd interpoleras; env/headers är mjuka — saknad path är dödlig", () => {
    const { store, dir } = tempStore({ env: { SERVER_SCRIPT: join(serversDir, "nexus-git.mjs"), PORT: "7999" } });
    const server = stdio("alla", "${NODE_EXECUTABLE}", {
      args: ["${SERVER_SCRIPT}", "--repo", "${NEXUS_WORKSPACE_ROOT}"],
      env: { VALD: "${PORT}", SAKNAD: "${HELT_SAKNAD}" },
      cwd: "${NEXUS_REPO_ROOT}",
    });
    store.write([server]);
    const stored = store.read()[0];
    if (stored === undefined) throw new Error("servern skrevs inte");
    const resolved = store.resolve(stored);
    expect(resolved.command).toBe(process.execPath);
    expect(resolved.args[0]).toBe(join(serversDir, "nexus-git.mjs"));
    expect(resolved.args[2]).toBe(dir);
    expect(resolved.env["VALD"]).toBe("7999");
    expect(resolved.env["SAKNAD"]).toBeUndefined();
    expect(resolved.missingOptional).toEqual(["HELT_SAKNAD"]);
    expect(resolved.missing).toEqual([]);
    expect(resolved.cwd).toBe(dir);
    expect(normalizeServer(server).id).toBe("alla");

    const fatal = store.resolve(stdio("dödlig", "node", { args: ["${HAR_EN_DIGTAR_EJ}"] }));
    expect(fatal.missing).toEqual(["HAR_EN_DIGTAR_EJ"]);
    expect(fatal.args[0]).toContain("${HAR_EN_DIGTAR_EJ}");
  });

  it("headers och url interpoleras för http-servrar", () => {
    const { store } = tempStore({ env: { TOKEN: "hemligt-värde" } });
    const server: McpServerConfig = {
      id: "http",
      transport: "http",
      url: "https://example.com/${TOKEN}/mcp",
      headers: { Authorization: "Bearer ${TOKEN}", "X-Fast": "hard" },
      enabled: true,
    };
    const resolved = store.resolve(server);
    expect(resolved.url).toBe("https://example.com/hemligt-värde/mcp");
    expect(resolved.headers["Authorization"]).toBe("Bearer hemligt-värde");
    expect(resolved.headers["X-Fast"]).toBe("hard");
  });
});

describe("standardkonfigurationen i rot-mcp.json (FAS 4.2/4.3)", () => {
  let store: McpConfigStore;
  beforeAll(() => {
    store = new McpConfigStore({ repoRoot });
  });

  it("existerar, validerar och pekar på skript som finns på denna maskin", () => {
    const servers = store.read();
    expect(servers.length).toBeGreaterThanOrEqual(5);
    const enabled = servers.filter((s) => s.enabled).map((s) => s.id);
    expect(enabled).toEqual(expect.arrayContaining(["nexus-filesystem", "nexus-git", "nexus-terminal", "nexus-web"]));
    for (const server of servers) {
      const resolved = store.resolve(server);
      expect(resolved.missing, `${server.id}: ${resolved.missing.join(",")}`).toEqual([]);
      if (resolved.command === process.execPath) {
        expect(existsSync(resolved.args[0] ?? "")).toBe(true);
      }
    }
    expect(JSON.stringify(servers)).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/);
  });

  it("DEFAULT_MCP_SERVERS är samma som filen och registreringen är idempotent", () => {
    const dir = makeTempDir("nexus-mcp-defaults-");
    dirs.push(dir);
    const fresh = new McpConfigStore({ filePath: join(dir, "mcp.json"), repoRoot: dir, workspaceRoot: dir, readDotEnv: false });
    const first = ensureDefaultConfig(fresh, DEFAULT_MCP_SERVERS);
    expect(first.created).toBe(true);
    expect(first.servers.map((s) => s.id)).toEqual(DEFAULT_MCP_SERVERS.map((s) => s.id));
    const second = ensureDefaultConfig(fresh, DEFAULT_MCP_SERVERS);
    expect(second.created).toBe(false);
    expect(second.added).toEqual([]);
    expect(second.skipped).toHaveLength(DEFAULT_MCP_SERVERS.length);

    // Rotfilen ska innehålla exakt standard-id:na.
    expect(store.read().map((s) => s.id)).toEqual(DEFAULT_MCP_SERVERS.map((s) => s.id));
  });

  it("auto-registrering bevarar användarens egen server och lägger bara till det som saknas", () => {
    const dir = makeTempDir("nexus-mcp-user-");
    dirs.push(dir);
    const file = join(dir, "mcp.json");
    const mine = stdio("min-egen", "node", { enabled: false, args: ["--flagga", "/sökväg"], label: "brukarens" });
    writeFileSync(file, JSON.stringify({ version: 1, servers: [mine] }), "utf8");
    const local = new McpConfigStore({ filePath: file, repoRoot, workspaceRoot: dir, readDotEnv: false });
    const result = ensureDefaultConfig(local, DEFAULT_MCP_SERVERS);
    expect(result.created).toBe(false);
    expect(result.added).toEqual(DEFAULT_MCP_SERVERS.map((s) => s.id));
    const after = local.read();
    expect(after.find((s) => s.id === "min-egen")?.enabled).toBe(false);
    expect(after.find((s) => s.id === "min-egen")?.label).toBe("brukarens");
    expect(after).toHaveLength(DEFAULT_MCP_SERVERS.length + 1);
  });

  it("korrupt fil skrivs ALDRIG över av auto-registreringen", () => {
    const dir = makeTempDir("nexus-mcp-corrupt-");
    dirs.push(dir);
    const file = join(dir, "mcp.json");
    writeFileSync(file, "{ trasig", "utf8");
    const local = new McpConfigStore({ filePath: file, repoRoot: dir, readDotEnv: false });
    expect(() => ensureDefaultConfig(local, DEFAULT_MCP_SERVERS)).toThrowError(McpConfigError);
    expect(readFileSync(file, "utf8")).toBe("{ trasig");
  });
});

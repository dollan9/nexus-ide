/**
 * FAS 4.3 — nexus-web.mjs: web-hämtning UTAN API-nyckel, testad mot en lokal
 * HTTP-server (deterministiskt, ingen extern beroendekedja) och med ett
 * sekretess-test som visar att en saknad nyckel aldrig läcker i något svar.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpConfigStore, McpServerManager } from "../src/index";
import { fixtureConfig, makeTempDir, productConfig, removeTempDir, repoRoot, structured } from "./helpers";

const dir = makeTempDir("nexus-mcp-web-");
let manager: McpServerManager;
let webPort = 0;
const localServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/sida") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><h1>NEXUS</h1><p>webbro fungerar</p><!-- doljt -->footer</body></html>");
    return;
  }
  if (url.pathname === "/json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ hej: "världen", user: req.headers["x-nexus-probe"] ?? null }));
    return;
  }
  res.writeHead(404).end("inte funnen");
});

beforeAll(async () => {
  await new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", resolve));
  const address = localServer.address();
  if (address === null || typeof address === "string") throw new Error("lyckades inte läsa port");
  webPort = (address as AddressInfo).port;

  const store = new McpConfigStore({ filePath: join(dir, "mcp.json"), repoRoot, workspaceRoot: dir, readDotEnv: false });
  store.write([productConfig("nexus-web", "nexus-web.mjs", [])]);
  manager = new McpServerManager({ store, timeouts: { connectTimeoutMs: 25_000, listTimeoutMs: 15_000, callTimeoutMs: 30_000 } });
  await manager.startAll();
  expect(manager.getServer("nexus-web")?.status).toBe("connected");
});

afterAll(async () => {
  await manager?.stopAll();
  await new Promise<void>((resolve) => localServer.close(() => resolve()));
  removeTempDir(dir);
});

describe("nexus-web__fetch_url", () => {
  it(" Verktygen är namespace:ade med korrekt läsbarhetsmetadata", () => {
    const names = manager.listTools().map((t) => t.name);
    expect(names).toContain("nexus-web__fetch_url");
    expect(names).toContain("nexus-web__search_web");
    expect(manager.getTool("nexus-web__fetch_url")?.readOnly).toBe(true);
    expect(manager.getTool("nexus-web__fetch_url")?.requiresApproval).toBe(false);
    expect(manager.getTool("nexus-web__fetch_url")?.openWorld).toBe(true);
  });

  it("hämtar en riktig URL och rensar HTML till läsbar text", async () => {
    const result = await manager.callTool("nexus-web__fetch_url", { url: `http://127.0.0.1:${String(webPort)}/sida` });
    expect(result.ok, result.error).toBe(true);
    const data = structured(result);
    expect(data.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(String(data.text)).toContain("webbro fungerar");
    expect(String(data.text)).toContain("NEXUS");
    // script/style/kommentar ska vara borta efter avtaggningen
    expect(String(data.text)).not.toContain("alert(1)");
    expect(String(data.text)).not.toContain("color:red");
    expect(String(data.text)).not.toContain("doljt");
  });

  it("as:raw ger originalbodyn och maxBytes trunkerar", async () => {
    const raw = await manager.callTool("nexus-web__fetch_url", { url: `http://127.0.0.1:${String(webPort)}/sida`, as: "raw" });
    expect(raw.ok).toBe(true);
    expect(String(structured(raw).text)).toContain("<script>alert(1)</script>");

    const capped = await manager.callTool("nexus-web__fetch_url", { url: `http://127.0.0.1:${String(webPort)}/sida`, as: "raw", maxBytes: 12 });
    expect(structured(capped).truncated).toBe(true);
    expect(String(structured(capped).text)).toHaveLength(12);
  });

  it(" HTTP 404 och ogiltiga protokoll svarar ok:false — aldrig ett undantag", async () => {
    const missing = await manager.callTool("nexus-web__fetch_url", { url: `http://127.0.0.1:${String(webPort)}/finns-inte` });
    expect(missing.ok).toBe(true); // hämtningen lyckades, status 404 rapporteras
    expect(structured(missing).status).toBe(404);

    const file = await manager.callTool("nexus-web__fetch_url", { url: `file:///${join(dir, "mcp.json")}` });
    expect(file.ok).toBe(false);
    expect(file.text + (file.error ?? "")).toMatch(/protokoll nekas/);

    const bogus = await manager.callTool("nexus-web__fetch_url", { url: "det här är ingen url" });
    expect(bogus.ok).toBe(false);
    expect(bogus.text).toMatch(/ogiltig URL/);

    const dead = await manager.callTool("nexus-web__fetch_url", { url: "http://127.0.0.1:1/", timeoutMs: 1500 });
    expect(dead.ok).toBe(false);
    expect(dead.text).toMatch(/hämtning fejade/);
  });

  it("search_web utan BRAVE_API_KEY ger tydligt fel och läcker ingen nyckel", async () => {
    const result = await manager.callTool("nexus-web__search_web", { query: "nexus ide" });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/BRAVE_API_KEY/);
    expect(structured(result).needsEnv).toBe("BRAVE_API_KEY");
    // Ingen utskrift av ett nyckelvärde (den finns inte, men vi testar ändå).
    expect(result.text).not.toMatch(/sk-/);
  });

  it("en server som startas med en miljövariabel får den via ${ENV} — inte via mcp.json", async () => {
    // Beviset: nexus-web läser BRAVE_API_KEY ur sin processmiljö. Utan nyckeln går
    // anropet till "saknas"-grenen; med en (falsk) nyckel når den faktiskt API:t.
    const store = manager.getConfigStore();
    const config = store.read().find((s) => s.id === "nexus-web");
    if (config === undefined) throw new Error("nexus-web saknas i config");
    const probeKey = "BRAVEFALSKEGETSK1234567890";
    const withKey: typeof config = { ...config, env: { BRAVE_API_KEY: probeKey } };
    const info = await manager.upsert(withKey);
    expect(info.status).toBe("connected");

    const result = await manager.callTool("nexus-web__search_web", { query: "nexus" });
    expect(result.ok).toBe(false);
    // Aldrig "nyckeln är inte satt" — alltså gick env-vidaregivningen in.
    expect(result.text).not.toMatch(/inte satt/);
    expect(result.text).toMatch(/Brave svarade HTTP|hämtning fejade/);
    // Nyckeln läcker inte ut i något svar.
    expect(result.text).not.toContain(probeKey);
    expect(JSON.stringify(structured(result))).not.toContain(probeKey);
  }, 90_000);
});

describe("web-transporten som fixture", () => {
  it("nexus-web kan också prata över en egen stdio-kanal med samma register", async () => {
    const store = new McpConfigStore({ filePath: join(dir, "mcp2.json"), repoRoot, workspaceRoot: dir, readDotEnv: false });
    store.write([fixtureConfig("web-fixture"), productConfig("nexus-web-2", "nexus-web.mjs", [])]);
    const second = new McpServerManager({ store, timeouts: { connectTimeoutMs: 25_000, listTimeoutMs: 15_000, callTimeoutMs: 30_000 } });
    await second.startAll();
    expect(second.getServer("web-fixture")?.status).toBe("connected");
    expect(second.getServer("nexus-web-2")?.status).toBe("connected");
    const result = await second.callTool("nexus-web-2__fetch_url", { url: `http://127.0.0.1:${String(webPort)}/json` });
    expect(result.ok, result.error).toBe(true);
    expect(String(structured(result).text)).toContain("världen");
    await second.stopAll();
    expect(second.activeToolCount()).toBe(0);
  });
});

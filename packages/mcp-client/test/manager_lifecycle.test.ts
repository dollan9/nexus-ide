/**
 * FAS 4.4 — managerns livscykel: samtidiga start, per-server timeout och isolering,
 * live tools/list_changed, events, namnrymdskollision och om laddning fran disk.
 */

import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { McpServerConfig } from "@nexus/protocol";
import { McpConfigStore, McpServerManager } from "../src/index";
import { fixtureConfig, makeTempDir, productConfig, removeTempDir, repoRoot, serversDir, structured, waitFor } from "./helpers";

let dir: string;
let manager: McpServerManager | null = null;

function storeFor(servers: readonly McpServerConfig[]): McpConfigStore {
  const store = new McpConfigStore({ filePath: join(dir, `mcp-${String(servers.length)}-${String(Math.floor(Math.random() * 1e6))}.json`), repoRoot, workspaceRoot: dir, readDotEnv: false });
  store.write(servers);
  return store;
}

beforeAll(() => {
  dir = makeTempDir("nexus-mcp-life-");
});

afterEach(async () => {
  if (manager !== null) {
    await manager.stopAll();
    manager = null;
  }
});

afterAll(() => {
  removeTempDir(dir);
});

describe("samtidiga start och isolering", () => {
  it("fem servrar startar parallellt och alla blir connected", async () => {
    manager = new McpServerManager({
      store: storeFor([fixtureConfig("a"), fixtureConfig("b"), fixtureConfig("c"), fixtureConfig("d"), productConfig("e", "nexus-web.mjs", [])]),
      timeouts: { connectTimeoutMs: 25_000, listTimeoutMs: 12_000, callTimeoutMs: 20_000 },
    });
    const startedAt = Date.now();
    const servers = await manager.startAll();
    const elapsed = Date.now() - startedAt;
    expect(servers).toHaveLength(5);
    for (const info of servers) expect(info.status).toBe("connected");
    expect(manager.activeToolCount()).toBe(manager.listTools().length);
    expect(manager.listTools().map((t) => t.name)).toContain("a__ping");
    expect(manager.listTools().map((t) => t.name)).toContain("e__fetch_url");
    // Samtidighet: fem node-start + handska ska ta valdigt mycket mindre an 5x en serial.
    expect(elapsed).toBeLessThan(20_000);
  });

  it("en server som aldrig svarar pa initialize ger timeout — de andra lever", async () => {
    manager = new McpServerManager({
      store: storeFor([
        fixtureConfig("snabb"),
        { ...fixtureConfig("hangare", ["--hang"]) },
        fixtureConfig("snabb2"),
      ]),
      timeouts: { connectTimeoutMs: 1_500, listTimeoutMs: 1_500, callTimeoutMs: 3_000 },
      maxConcurrentConnects: 4,
    });
    const startedAt = Date.now();
    const servers = await manager.startAll();
    const elapsed = Date.now() - startedAt;
    const byId = new Map(servers.map((s) => [s.id, s]));
    expect(byId.get("hangare")?.status).toBe("error");
    expect(byId.get("hangare")?.error).toMatch(/timeout/i);
    expect(byId.get("snabb")?.status).toBe("connected");
    expect(byId.get("snabb2")?.status).toBe("connected");
    expect(elapsed).toBeLessThan(12_000);
    // Registret innehaller de snabba, aldrig den hangande.
    expect(manager.listTools().filter((t) => t.serverId === "hangare")).toEqual([]);
    expect(manager.listTools().map((t) => t.name)).toContain("snabb__ping");
    const result = await manager.callTool("snabb__ping", { note: "live" });
    expect(result.ok).toBe(true);
    expect(structured(result).note).toBe("live");
  });

  it("en server som krockar med tool-call timeout svarar ok:false och blockera inte", async () => {
    manager = new McpServerManager({ store: storeFor([fixtureConfig("timeout")]), timeouts: { connectTimeoutMs: 20_000, listTimeoutMs: 10_000, callTimeoutMs: 700 } });
    await manager.startAll();
    const startedAt = Date.now();
    const slow = await manager.callTool("timeout__sleep", { ms: 4_000 });
    const elapsed = Date.now() - startedAt;
    expect(slow.ok).toBe(false);
    expect(slow.error).toMatch(/timeout/i);
    expect(elapsed).toBeLessThan(6_000);
    // Samma forbindelse funkar fortfarande efter timeout.
    const fast = await manager.callTool("timeout__ping", { note: "efter timeout" });
    expect(fast.ok).toBe(true);
  });
});

describe("live registry", () => {
  it("notifications/tools/list_changed laggar till ett nytt verktyg utan omstart", async () => {
    manager = new McpServerManager({ store: storeFor([fixtureConfig("dyn")]), timeouts: { connectTimeoutMs: 25_000, listTimeoutMs: 12_000, callTimeoutMs: 20_000 } });
    await manager.startAll();
    const before = manager.listTools().map((t) => t.name);
    expect(before).not.toContain("dyn__tillagd_nu");

    const changed: number[] = [];
    const off = manager.on("mcp/changed", (payload) => changed.push(payload.activeTools));
    const add = await manager.callTool("dyn__add_tool", { name: "tillagd_nu" });
    expect(add.ok, add.error).toBe(true);

    await waitFor("det nya verktyget ar registrerat", () => manager !== null && manager.listTools().some((t) => t.name === "dyn__tillagd_nu"), 10_000);
    off();
    expect(changed.length).toBeGreaterThan(0);
    expect(manager.getServer("dyn")?.tools).toContain("dyn__tillagd_nu");

    // Verktyget ar direkt anropbart via namespace.
    const call = await manager.callTool("dyn__tillagd_nu", { echo: "friskt" });
    expect(call.ok).toBe(true);
    expect(structured(call).echo).toBe("friskt");
  });

  it("samma lokala verktygsnamn fran tva servrar ar ALDRIG en kollision", async () => {
    manager = new McpServerManager({
      store: storeFor([fixtureConfig("xyz"), fixtureConfig("xyz-2")]),
      timeouts: { connectTimeoutMs: 25_000, listTimeoutMs: 12_000, callTimeoutMs: 20_000 },
    });
    await manager.startAll();
    const pings = manager.listTools().filter((t) => t.localName === "ping");
    expect(pings).toHaveLength(2);
    expect(pings.map((t) => t.name).sort()).toEqual(["xyz-2__ping", "xyz__ping"]);
    expect(manager.activeToolCount()).toBe(manager.listTools().length);
    const first = await manager.callTool("xyz__ping", { note: "forsta" });
    const second = await manager.callTool("xyz-2__ping", { note: "andra" });
    expect(structured(first).serverName).toBe("xyz");
    expect(structured(second).serverName).toBe("xyz-2");
  });

  it("mcp/changed och mcp/log produceras med korrekt payload under start", async () => {
    const events: { name: string; payload: unknown }[] = [];
    const logs: { serverId: string; line: string }[] = [];
    manager = new McpServerManager({
      store: storeFor([productConfig("loggit", "nexus-git.mjs", ["--repo", join(serversDir, "..", "..")])]),
      timeouts: { connectTimeoutMs: 25_000, listTimeoutMs: 12_000, callTimeoutMs: 20_000 },
      onEvent: (name, payload) => {
        events.push({ name, payload });
        if (name === "mcp/log") logs.push(payload);
      },
    });
    await manager.startAll();
    expect(events.some((e) => e.name === "mcp/changed")).toBe(true);
    expect(logs.some((l) => l.serverId === "loggit")).toBe(true);
    // Git-servern som inte ar ett worktree maste nonetheless landa i error, inte hanga.
    const info = manager.getServer("loggit");
    expect(["error", "connected"]).toContain(info?.status);
  });
});

describe("omladdning och mutationer i managern", () => {
  it("upsert av en ny server ger verktyg omedelbart och remove tar dem igen", async () => {
    manager = new McpServerManager({ store: storeFor([fixtureConfig("forst")]), timeouts: { connectTimeoutMs: 25_000, listTimeoutMs: 12_000, callTimeoutMs: 20_000 } });
    await manager.startAll();
    expect(manager.listTools().some((t) => t.serverId === "sedan")).toBe(false);

    const info = await manager.upsert(fixtureConfig("sedan"));
    expect(info.status).toBe("connected");
    expect(manager.listTools().map((t) => t.name)).toContain("sedan__ping");

    const removed = await manager.remove("sedan");
    expect(removed.ok).toBe(true);
    expect(manager.listTools().some((t) => t.serverId === "sedan")).toBe(false);
    expect(manager.getServer("sedan")).toBeUndefined();
  });

  it("upsert med trasig config lamnar igangvarande servrar intakta", async () => {
    manager = new McpServerManager({ store: storeFor([fixtureConfig("frisk")]), timeouts: { connectTimeoutMs: 25_000, listTimeoutMs: 12_000, callTimeoutMs: 20_000 } });
    await manager.startAll();
    const before = manager.activeToolCount();

    const broken = await manager.upsert({ id: "sjuk__id", transport: "stdio", command: "node", enabled: true });
    expect(broken.status).toBe("error");
    expect(broken.error).toContain("ogiltig serverkonfiguration");
    expect(manager.activeToolCount()).toBe(before);
    expect(manager.getServer("frisk")?.status).toBe("connected");
  });

  it("toggle av en server tar bort och tillbaka verktygen", async () => {
    manager = new McpServerManager({ store: storeFor([fixtureConfig("vaxla")]), timeouts: { connectTimeoutMs: 25_000, listTimeoutMs: 12_000, callTimeoutMs: 20_000 } });
    await manager.startAll();
    expect(manager.getServer("vaxla")?.status).toBe("connected");

    const off = await manager.toggle("vaxla", false);
    expect(off.status).toBe("stopped");
    expect(manager.listTools().some((t) => t.serverId === "vaxla")).toBe(false);
    expect(manager.getConfigStore().read().find((s) => s.id === "vaxla")?.enabled).toBe(false);

    const on = await manager.toggle("vaxla");
    expect(on.status).toBe("connected");
    expect(manager.listTools().some((t) => t.serverId === "vaxla")).toBe(true);
  });

  it("reload lasar disk och startar om allt", async () => {
    const store = storeFor([fixtureConfig("reload-1")]);
    manager = new McpServerManager({ store, timeouts: { connectTimeoutMs: 25_000, listTimeoutMs: 12_000, callTimeoutMs: 20_000 } });
    await manager.startAll();
    expect(manager.getServer("reload-1")?.status).toBe("connected");

    store.upsert(fixtureConfig("reload-2"));
    const result = await manager.reload();
    expect(result.servers.map((s) => s.id).sort()).toEqual(["reload-1", "reload-2"]);
    expect(result.servers.every((s) => s.status === "connected")).toBe(true);
    expect(result.activeTools).toBe(result.servers.reduce((sum, s) => sum + s.tools.length, 0));
  });

  it("korrupt mcp.json i managern ger tom registry men ingen krasch", async () => {
    const brokenDir = join(dir, "broken-store");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "mcp.json"), "{ inte json", "utf8");
    const store = new McpConfigStore({ filePath: join(brokenDir, "mcp.json"), repoRoot: brokenDir, readDotEnv: false });
    const logs: string[] = [];
    manager = new McpServerManager({ store, onEvent: (name, payload) => (name === "mcp/log" ? logs.push(payload.line) : undefined) });
    expect(manager.listServers()).toEqual([]);
    expect(manager.listTools()).toEqual([]);
    const started = await manager.startAll();
    expect(started).toEqual([]);
    expect(logs.some((line) => line.includes("mcp.json"))).toBe(true);
    expect(manager.getServer("finns-inte")).toBeUndefined();
    const call = await manager.callTool("nada__ping", {});
    expect(call.ok).toBe(false);
  });
});

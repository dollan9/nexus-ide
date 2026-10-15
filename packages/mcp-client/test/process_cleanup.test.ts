/**
 * FAS 4.3/4.4 — beviset att inga processer lämnas kvar.
 *
 * Fyra saker testas på denna Windows-maskin:
 *   1. stopAll() dödar HELA process-trädet — både serverprocessen (pid från
 *      StdioClientTransport) och ett barnbarn som den själv har startat
 *      (taskkill /T /F-semantik). Vi jämför specifika pid:er, inte ett globalt
 *      antal, eftersom andra testfiler kör parallellt och startar egna barn.
 *   2. våra egna .mjs-servrar avslutar rent när föräldern stänger stdin
 *   3. stopAll är idempotent — ett andra anrop startar ingenting
 *   4. en server som hänger under connect lämnar inte ett liksom-efter sig
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { McpConfigStore, McpServerManager, isPidAlive, waitForPidExit } from "../src/index";
import { fixtureConfig, makeTempDir, productConfig, removeTempDir, repoRoot, serversDir, structured, waitFor } from "./helpers";

const dir = makeTempDir("nexus-mcp-clean-");
const timeouts = { connectTimeoutMs: 25_000, listTimeoutMs: 15_000, callTimeoutMs: 25_000 };

afterAll(() => {
  removeTempDir(dir);
});

function storeFor(file: string) {
  const store = new McpConfigStore({ filePath: join(dir, file), repoRoot, workspaceRoot: dir, readDotEnv: false });
  return store;
}

describe("process-träd avlivas", () => {
  it("stopAll dödar serverprocessen OCH ett av dess barn (taskkill /T)", async () => {
    const store = storeFor("clean-1.json");
    store.write([fixtureConfig("tree-host"), productConfig("terminal", "nexus-terminal.mjs", ["--root", dir])]);
    const manager = new McpServerManager({ store, timeouts });
    await manager.startAll();
    expect(manager.getServer("tree-host")?.status).toBe("connected");

    // Starta ett barnbarn inuti serverprocessen och ta reda på dess pid.
    const spawned = await manager.callTool("tree-host__spawn_child", { ms: 90_000 });
    expect(spawned.ok, spawned.error).toBe(true);
    const childPid = Number(structured(spawned).childPid);
    const selfPid = Number(structured(spawned).selfPid);
    expect(Number.isInteger(childPid)).toBe(true);
    expect(Number.isInteger(selfPid)).toBe(true);
    expect(childPid).not.toBe(selfPid);
    await waitFor("barnet lever", () => isPidAlive(childPid) && isPidAlive(selfPid), 8_000);

    // Managern ska känna till sitt eget spawn-pid (transportens barn).
    const managerPid = manager.pidOf("tree-host");
    expect(managerPid).not.toBeNull();
    expect(isPidAlive(managerPid ?? -1)).toBe(true);

    await manager.stopAll();

    expect(await waitForPidExit(selfPid, 12_000)).toBe(true);
    expect(await waitForPidExit(childPid, 12_000)).toBe(true);
    expect(await waitForPidExit(managerPid ?? -1, 12_000)).toBe(true);
    expect(isPidAlive(selfPid)).toBe(false);
    expect(isPidAlive(childPid)).toBe(false);
    expect(isPidAlive(managerPid ?? -1)).toBe(false);

    expect(manager.listTools()).toEqual([]);
    expect(manager.activeToolCount()).toBe(0);
    expect(manager.pidOf("tree-host")).toBeNull();
    for (const info of manager.listServers()) expect(info.status).toBe("stopped");
  }, 90_000);

  it("stopAll är idempotent och healthCheck startar ingenting efteråt", async () => {
    const store = storeFor("clean-2.json");
    store.write([fixtureConfig("dubbel")]);
    const manager = new McpServerManager({ store, timeouts });
    await manager.startAll();
    const pid = manager.pidOf("dubbel");
    expect(pid).not.toBeNull();
    await manager.stopAll();
    await manager.stopAll();
    expect(await waitForPidExit(pid ?? -1, 8_000)).toBe(true);
    expect(manager.listTools()).toEqual([]);
    const health = await manager.healthCheck();
    expect(health.every((s) => s.status === "stopped")).toBe(true);
    expect(manager.listTools()).toEqual([]);
  });

  it("våra egna .mjs-servrar avslutar när stdin stängs — ingen kvarvarande daemon", async () => {
    const scripts = ["nexus-git.mjs", "nexus-terminal.mjs", "nexus-filesystem.mjs", "nexus-web.mjs"];
    for (const script of scripts) {
      const child = spawn(process.execPath, [join(serversDir, script), "--root", dir, "--repo", dir], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const pid = child.pid;
      expect(typeof pid).toBe("number");
      const seen: string[] = [];
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => seen.push(chunk));
      child.stdout?.resume();
      await waitFor(`${script} startade`, () => isPidAlive(pid ?? -1), 5_000);

      const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
      child.stdin?.end();
      const code = await Promise.race([exited, new Promise<null>((r) => setTimeout(() => r(null), 6_000))]);
      expect(code, `${script} avslutade inte inom 6 s; stderr: ${seen.join("")}`).toBe(0);
      expect(await waitForPidExit(pid ?? -1, 3_000)).toBe(true);
    }
  }, 120_000);

  it("stop av en server tar bort dess verktyg men inte grannarnas", async () => {
    const store = storeFor("clean-3.json");
    store.write([fixtureConfig("dok"), fixtureConfig("frisk")]);
    const manager = new McpServerManager({ store, timeouts });
    await manager.startAll();
    expect(manager.getServer("frisk")?.status).toBe("connected");
    const pid = manager.pidOf("dok");
    expect(pid).not.toBeNull();

    expect(await manager.stop("dok")).toBe(true);
    expect(await waitForPidExit(pid ?? -1, 8_000)).toBe(true);
    expect(manager.getServer("dok")?.status).toBe("stopped");
    expect(manager.listTools().some((t) => t.serverId === "dok")).toBe(false);
    expect(manager.getServer("frisk")?.status).toBe("connected");
    expect(manager.listTools().map((t) => t.name)).toContain("frisk__ping");
    await manager.stopAll();
    expect(isPidAlive(manager.pidOf("frisk") ?? -1)).toBe(false);
  });

  it("en server som hänger under connect lämnar inget lik efter sig", async () => {
    const store = storeFor("clean-4.json");
    store.write([{ ...fixtureConfig("hangare", ["--hang"]), label: "hänger (test)" }]);
    const logs: string[] = [];
    const manager = new McpServerManager({
      store,
      timeouts: { connectTimeoutMs: 1_500, listTimeoutMs: 1_500, callTimeoutMs: 2_000 },
      onEvent: (name, payload) => (name === "mcp/log" ? logs.push(`${payload.serverId}: ${payload.line}`) : undefined),
    });
    const servers = await manager.startAll();
    expect(servers[0]?.status).toBe("error");
    expect(servers[0]?.error).toMatch(/timeout/i);
    // Processen som spawnades men aldrig handskakades måste vara död.
    const hangPid = manager.pidOf("hangare");
    expect(hangPid).toBeNull();
    expect(manager.listTools()).toEqual([]);
    await manager.stopAll();
    expect(logs.some((line) => line.includes("hangare"))).toBe(true);
  }, 60_000);

  it("callTool till en server som inte är ansluten svarar ok:false utan att starta process", async () => {
    const store = storeFor("clean-5.json");
    store.write([fixtureConfig("disabled-host")]);
    const manager = new McpServerManager({ store, timeouts });
    const result = await manager.callTool("disabled-host__ping", { note: "ska inte köra" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("inte ansluten");
    expect(manager.pidOf("disabled-host")).toBeNull();
  });
});

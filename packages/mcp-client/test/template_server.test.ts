/**
 * FAS 4.5 — mallen for egna servrar: `templates/mcp-server-ts` byggs och ansluts
 * av den verkliga managern, och `templates/mcp-server-py` kopplas pa samma vag
 * om en lokal venv med MCP-SDK finns (verifierad pa denna maskinen, se README).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpConfigStore, McpServerManager } from "../src/index";
import { makeTempDir, removeTempDir, repoRoot, structured } from "./helpers";

const dir = makeTempDir("nexus-mcp-tpl-");
const tsEntry = join(repoRoot, "templates", "mcp-server-ts", "dist", "index.js");
const tsProject = join(repoRoot, "templates", "mcp-server-ts", "tsconfig.json");
const tscBin = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
const pyVenvWindows = join(repoRoot, "templates", "mcp-server-py", ".venv", "Scripts", "python.exe");
const pyVenvPosix = join(repoRoot, "templates", "mcp-server-py", ".venv", "bin", "python");
const pyEntry = join(repoRoot, "templates", "mcp-server-py", "server.py");

/** Bygg mallen pa samma satt som anvandaren: tsc -> dist/index.js. */
function buildTemplate(): void {
  const result = spawnSync(process.execPath, [tscBin, "-p", tsProject], { cwd: repoRoot, encoding: "utf8" });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(existsSync(tsEntry)).toBe(true);
}

let manager: McpServerManager | null = null;

beforeAll(() => {
  buildTemplate();
});

function storeFor(file: string, servers: Parameters<McpConfigStore["write"]>[0]): McpConfigStore {
  const store = new McpConfigStore({ filePath: join(dir, file), repoRoot, workspaceRoot: dir, readDotEnv: false });
  store.write(servers);
  return store;
}

describe("templates/mcp-server-ts (stdio, byggd och spawnad)", () => {
  it("managern kan lista och kora mallverktygen", async () => {
    manager = new McpServerManager({
      store: storeFor("ts.json", [
        {
          id: "min-ts-server",
          label: "TS-mallen",
          transport: "stdio",
          command: "${NODE_EXECUTABLE}",
          args: ["${NEXUS_REPO_ROOT}/templates/mcp-server-ts/dist/index.js"],
          enabled: true,
        },
      ]),
      timeouts: { connectTimeoutMs: 30_000, listTimeoutMs: 15_000, callTimeoutMs: 30_000 },
    });
    const servers = await manager.startAll();
    expect(servers[0]?.status, servers[0]?.error).toBe("connected");

    const names = manager.listTools().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["min-ts-server__nexus_demo", "min-ts-server__add_numbers"]));
    expect(manager.getTool("min-ts-server__nexus_demo")?.readOnly).toBe(true);
    expect(manager.getTool("min-ts-server__nexus_demo")?.requiresApproval).toBe(false);
    expect(manager.getTool("min-ts-server__nexus_demo")?.title).toBe("Demo tool");

    const demo = await manager.callTool("min-ts-server__nexus_demo", { name: "nexus", shout: true });
    expect(demo.ok, demo.error).toBe(true);
    expect(String(structured(demo).greeting)).toBe("HEJ NEXUS FRÅN MIN-TS-SERVER");
    expect(String(structured(demo).server)).toBe("nexus-template");

    const sum = await manager.callTool("min-ts-server__add_numbers", { a: 2, b: 40 });
    expect(structured(sum).sum).toBe(42);

    // Saknat obligatoriskt argument => tool-fel, inte krasch, och kanalen lever.
    const invalid = await manager.callTool("min-ts-server__add_numbers", { a: 1 });
    expect(invalid.ok).toBe(false);
    const after = await manager.callTool("min-ts-server__nexus_demo", {});
    expect(after.ok).toBe(true);

    const pid = manager.pidOf("min-ts-server");
    expect(pid).not.toBeNull();
    await manager.stopAll();
    expect(manager.pidOf("min-ts-server")).toBeNull();
    expect(await (await import("../src/index")).waitForPidExit(pid ?? -1, 12_000)).toBe(true);
    manager = null;
  }, 90_000);

  it("byggda filen ar kravbar direkt ocksa (node dist/index.js pratar MCP)", async () => {
    // Samma bevis men utan inlagd interpolation — absolut node-sokvag + absolut fil.
    manager = new McpServerManager({
      store: storeFor("ts2.json", [{ id: "abs", transport: "stdio", command: process.execPath, args: [tsEntry], enabled: true }]),
      timeouts: { connectTimeoutMs: 30_000, listTimeoutMs: 15_000, callTimeoutMs: 30_000 },
    });
    await manager.startAll();
    expect(manager.getServer("abs")?.status).toBe("connected");
    expect(manager.listTools().map((t) => t.localName)).toEqual(expect.arrayContaining(["nexus_demo", "add_numbers"]));
    await manager.stopAll();
    manager = null;
  }, 90_000);
});

describe("templates/mcp-server-py (FastMCP-stil, lokal venv)", () => {
  const pythonExe = existsSync(pyVenvWindows) ? pyVenvWindows : existsSync(pyVenvPosix) ? pyVenvPosix : null;

  // .venv ar gitignored ochskapen hos anvandaren enligt README. Om den saknas
  // hoppar vi over — men den HAR korts och verifierats pa denna maskinen
  // (Python 3.11.9, mcp 2.3.0), sa har pa THIS repo kor testet på riktigt.
  it.skipIf(pythonExe === null)("python-servern ansluts, listar verktyg och svarar", async () => {
    manager = new McpServerManager({
      store: storeFor("py.json", [
        {
          id: "min-py-server",
          transport: "stdio",
          command: pythonExe ?? "",
          args: [pyEntry],
          env: { NEXUS_NOTES_DIR: dir },
          enabled: true,
        },
      ]),
      timeouts: { connectTimeoutMs: 90_000, listTimeoutMs: 30_000, callTimeoutMs: 30_000 },
    });
    const servers = await manager.startAll();
    expect(servers[0]?.status, servers[0]?.error).toBe("connected");

    const names = manager.listTools().map((t) => t.localName);
    expect(names).toEqual(expect.arrayContaining(["nexus_demo", "add_numbers", "server_info", "write_note"]));
    // write_note ar destruktiv -> managern maste marka den som godkannandekravande.
    expect(manager.getTool("min-py-server__write_note")?.requiresApproval).toBe(true);
    expect(manager.getTool("min-py-server__nexus_demo")?.readOnly).toBe(true);

    const demo = await manager.callTool("min-py-server__nexus_demo", { name: "python" });
    expect(demo.ok, demo.error).toBe(true);
    expect(String(structured(demo).greeting)).toContain("hej python");

    const sum = await manager.callTool("min-py-server__add_numbers", { a: 20, b: 22 });
    expect(structured(sum).sum).toBe(42);

    const info = await manager.callTool("min-py-server__server_info", {});
    expect(String(structured(info).python)).toMatch(/^3\.\d+/);

    const pid = manager.pidOf("min-py-server");
    expect(pid).not.toBeNull();
    await manager.stopAll();
    expect(await (await import("../src/index")).waitForPidExit(pid ?? -1, 15_000)).toBe(true);
    manager = null;
  }, 180_000);

  it.skipIf(pythonExe === null)("python-servern avslutar rent nar stdin stangs", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(pythonExe ?? "", [pyEntry], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const pid = child.pid;
    expect(typeof pid).toBe("number");
    child.stdout?.resume();
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    child.stdin?.end();
    const outcome = await Promise.race([exited, new Promise<null>((r) => setTimeout(r, 20_000))]);
    // Beviset är att den GÅR — inte att den hänger. Exitkod eller signal är OK.
    expect(outcome, "python-servern levde fortfarande 20 s efter att stdin stängts").not.toBeNull();
    const { isPidAlive } = await import("../src/index");
    expect(isPidAlive(pid ?? -1)).toBe(false);
  }, 60_000);
});

afterAll(async () => {
  if (manager !== null) await manager.stopAll();
  removeTempDir(dir);
});

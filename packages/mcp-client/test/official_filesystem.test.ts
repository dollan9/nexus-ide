/**
 * FAS 4.3 — beviset att standardservern `nexus-filesystem` (den officiella
 * @modelcontextprotocol/server-filesystem startad via npx) faktiskt kör och
 * pratar med vår manager på denna maskin. Nätverk ingår i vägen (npm-registret)
 * — om nätverket är borta används `nexus-filesystem-local` i stället.
 */

import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpConfigStore, McpServerManager } from "../src/index";
import { makeTempDir, removeTempDir, repoRoot, structured } from "./helpers";

const dir = makeTempDir("nexus-mcp-official-");
let manager: McpServerManager | null = null;

beforeAll(async () => {
  writeFileSync(join(dir, "innehåll.txt"), "rad ett\nrad två med VERIFIERARTAG\n", "utf8");
  const store = new McpConfigStore({ filePath: join(dir, "mcp.json"), repoRoot, workspaceRoot: dir, readDotEnv: false });
  store.write([
    {
      id: "nexus-filesystem",
      label: "officiell filesystem-server",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", dir],
      enabled: true,
      builtin: true,
    },
  ]);
  manager = new McpServerManager({ store, timeouts: { connectTimeoutMs: 90_000, listTimeoutMs: 45_000, callTimeoutMs: 45_000 } });
  await manager.startAll();
});

afterAll(async () => {
  await manager?.stopAll();
  expect(manager?.pidOf("nexus-filesystem") ?? null).toBeNull();
  removeTempDir(dir);
});

describe("officiella server-filesystem via npx", () => {
  it("ansluter och listar verktyg", () => {
    expect(manager).not.toBeNull();
    const info = manager?.getServer("nexus-filesystem");
    expect(info?.status, info?.error).toBe("connected");
    const names = manager?.listTools().map((t) => t.name) ?? [];
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(names).toContain("nexus-filesystem__read_file");
    expect(names).toContain("nexus-filesystem__list_directory");
    expect(names).toContain("nexus-filesystem__search_files");
    // Read-only-flaggorna kommer fran serverns egna annotationer.
    expect(manager?.getTool("nexus-filesystem__read_file")?.readOnly).toBe(true);
    expect(manager?.getTool("nexus-filesystem__write_file")?.readOnly).toBe(false);
  });

  it("läser en riktig fil genom den namespace:ade registry-posten", async () => {
    const result = await manager?.callTool("nexus-filesystem__read_file", { path: join(dir, "innehåll.txt") });
    expect(result?.ok, result?.error).toBe(true);
    expect(result?.text).toContain("VERIFIERARTAG");
    expect(readFileSync(join(dir, "innehåll.txt"), "utf8")).toContain("VERIFIERARTAG");
  });

  it("jailen i officiella servern nekar filer utanfor roten", async () => {
    const result = await manager?.callTool("nexus-filesystem__read_file", { path: join(repoRoot, "package.json") });
    expect(result?.ok).toBe(false);
    expect(`${result?.text} ${result?.error ?? ""}`).toMatch(/outside|allowed|not allowed| utanför/i);
  });

  it("list_allowed_directories visar den temp-katalog vi jailade till", async () => {
    const result = await manager?.callTool("nexus-filesystem__list_allowed_directories", {});
    expect(result?.ok, result?.error).toBe(true);
    expect(result?.text.toLowerCase()).toContain(dir.toLowerCase());
  });

  it("stopAll lämnar ingen npx- eller node-process kvar", async () => {
    const pid = manager?.pidOf("nexus-filesystem") ?? null;
    expect(pid).not.toBeNull();
    await manager?.stopAll();
    if (pid !== null) {
      expect(await waitForPidGone(pid)).toBe(true);
    }
  });
});

/** Vänta på att pid försvinner (Windows: tasklist, posix: signal 0). */
async function waitForPidGone(pid: number): Promise<boolean> {
  const { isPidAlive, waitForPidExit } = await import("../src/index");
  const gone = await waitForPidExit(pid, 12_000);
  return gone && !isPidAlive(pid);
}

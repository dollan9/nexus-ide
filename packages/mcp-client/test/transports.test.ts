/**
 * FAS 4.1 — SSE och streamable HTTP. Bada transporterna mot riktiga MCP-servrar
 * (in-process, riktig wire) och bevisar att ${ENV}-upplösta headers når servern.
 */

import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { McpServerConfig } from "@nexus/protocol";
import { McpConfigStore, McpServerManager } from "../src/index";
import { makeTempDir, removeTempDir, repoRoot, structured } from "./helpers";
import { startFixtureServers, type FixtureServers } from "./fixtures/http_fixture";

const TOKEN_VALUE = "nexus-token-från-miljön";

let dir: string;
let fixture: FixtureServers;
let store: McpConfigStore;
let manager: McpServerManager;

beforeAll(async () => {
  dir = makeTempDir("nexus-mcp-http-");
  fixture = await startFixtureServers({});
  const servers: McpServerConfig[] = [
    {
      id: "http-host",
      label: "streamable http",
      transport: "http",
      url: fixture.httpUrl,
      headers: { "x-nexus-token": "${NEXUS_FIXTURE_TOKEN}", "x-nexus-mode": "http" },
      enabled: true,
    },
    {
      id: "sse-host",
      label: "legacy sse",
      transport: "sse",
      url: fixture.sseUrl,
      headers: { "x-nexus-token": "${NEXUS_FIXTURE_TOKEN}", "x-nexus-mode": "sse" },
      enabled: true,
    },
    {
      id: "dead-host",
      label: "ingen lyssnare",
      transport: "http",
      url: "http://127.0.0.1:1/mcp",
      enabled: true,
    },
  ];
  store = new McpConfigStore({ filePath: join(dir, "mcp.json"), repoRoot, workspaceRoot: dir, env: { NEXUS_FIXTURE_TOKEN: TOKEN_VALUE }, readDotEnv: false });
  store.write(servers);
  manager = new McpServerManager({ store, timeouts: { connectTimeoutMs: 15_000, listTimeoutMs: 10_000, callTimeoutMs: 15_000 } });
  await manager.startAll();
});

afterAll(async () => {
  await manager?.stopAll();
  await fixture?.close();
  if (dir !== undefined) removeTempDir(dir);
});

describe("streamable http (StreamableHTTPClientTransport)", () => {
  it("servern är ansluten och verktygen är namespace:ade", () => {
    expect(manager.getServer("http-host")?.status).toBe("connected");
    const names = manager.listTools().map((t) => t.name);
    expect(names).toContain("http-host__fixture_echo");
    expect(names).toContain("http-host__fixture_fail");
    expect(manager.getServer("http-host")?.transport).toBe("http");
  });

  it("tools/call går över riktig HTTP med upplösta headers i requesten", async () => {
    const result = await manager.callTool("http-host__fixture_echo", { note: "hej http" });
    expect(result.ok, result.error).toBe(true);
    expect(result.text).toBe("hej http");
    const headers = structured(result).headers as Record<string, string>;
    // Bevis for interpolateString i headers + url — värdet kom fram till servern.
    expect(headers["x-nexus-token"]).toBe(TOKEN_VALUE);
    expect(headers["x-nexus-mode"]).toBe("http");
  });

  it("ett tool-fel över http är ok:false men transporten lever vidare", async () => {
    const fail = await manager.callTool("http-host__fixture_fail", {});
    expect(fail.ok).toBe(false);
    expect(fail.text).toContain("fel");
    const again = await manager.callTool("http-host__fixture_echo", { note: "fortfarande vid liv" });
    expect(again.ok).toBe(true);
  });
});

describe("sse (SSEClientTransport)", () => {
  it("servern är ansluten och verktygen är namespace:ade", () => {
    expect(manager.getServer("sse-host")?.status).toBe("connected");
    expect(manager.listTools().map((t) => t.name)).toContain("sse-host__fixture_echo");
  });

  it("tools/call fungerar över SSE-strömmen och POST-endpointen", async () => {
    const result = await manager.callTool("sse-host__fixture_echo", { note: "hej sse" });
    expect(result.ok, result.error).toBe(true);
    const headers = structured(result).headers as Record<string, string>;
    expect(headers["x-nexus-token"]).toBe(TOKEN_VALUE);
    expect(headers["x-nexus-mode"]).toBe("sse");
  });
});

describe("isolering över nätet", () => {
  it("en död http-url ger status error men sänker inte de andra", () => {
    const dead = manager.getServer("dead-host");
    expect(dead?.status).toBe("error");
    expect(dead?.error).toBeTruthy();
    expect(manager.getServer("http-host")?.status).toBe("connected");
    expect(manager.getServer("sse-host")?.status).toBe("connected");
    expect(manager.activeToolCount()).toBe(manager.listTools().length);
    expect(manager.listTools().some((t) => t.serverId === "dead-host")).toBe(false);
  });

  it("bada transporterna kan samexistera i samma registry", () => {
    const byServer = new Map<string, string[]>();
    for (const tool of manager.listTools()) {
      byServer.set(tool.serverId, [...(byServer.get(tool.serverId) ?? []), tool.localName]);
    }
    expect(byServer.get("http-host")?.sort()).toEqual(["fixture_echo", "fixture_fail"]);
    expect(byServer.get("sse-host")?.sort()).toEqual(["fixture_echo", "fixture_fail"]);
    expect(manager.listServers().filter((s) => s.status === "connected")).toHaveLength(2);
  });
});

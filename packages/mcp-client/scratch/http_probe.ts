import { startFixtureServers } from "../test/fixtures/http_fixture.ts";
import { McpConfigStore, McpServerManager } from "../src/index.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bag: Record<string, string> = {};
const fixture = await startFixtureServers(bag);
console.log("urls", fixture.sseUrl, fixture.httpUrl);
const dir = mkdtempSync(join(tmpdir(), "probe-"));
const store = new McpConfigStore({ filePath: join(dir, "mcp.json"), repoRoot: dir, workspaceRoot: dir, env: { TOK: "x" }, readDotEnv: false });
store.write([
  { id: "http-host", transport: "http", url: fixture.httpUrl, headers: { "x-nexus-token": "${TOK}" }, enabled: true },
  { id: "sse-host", transport: "sse", url: fixture.sseUrl, headers: { "x-nexus-token": "${TOK}" }, enabled: true },
]);
console.log("read back", store.read().map((s) => s.id));
const manager = new McpServerManager({ store, timeouts: { connectTimeoutMs: 8000, listTimeoutMs: 5000, callTimeoutMs: 8000 } });
const servers = await manager.startAll();
console.log("servers", JSON.stringify(servers));
const r = await manager.callTool("http-host__fixture_echo", { note: "hallo" });
console.log("call", JSON.stringify(r));
await manager.stopAll();
await fixture.close();
process.exit(0);

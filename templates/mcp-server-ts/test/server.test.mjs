import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Självtest för mallen: testet förutsätter att `pnpm build` har körts (pretest
 * gör det automatiskt), startar den byggda servern som en riktig barnprocess och
 * pratar riktig MCP. Avslutar med att bevisa att barnet dör när vi stänger av det.
 */

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "dist", "index.js");

/** client + transport under hela filen */
const session = { client: null, transport: null };

before(async () => {
  assert.ok(existsSync(entry), `dist/index.js saknas — kör pnpm build (pretest gör det automatiskt)`);
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], stderr: "pipe" });
  const client = new Client({ name: "template-selftest", version: "1.0.0" });
  await client.connect(transport, { timeout: 20_000 });
  session.client = client;
  session.transport = transport;
});

after(async () => {
  const { client, transport } = session;
  const pid = transport?.pid ?? null;
  await client?.close();
  if (pid !== null) {
    // Beproof: ingen kvarvarande process efter att klienten stängts.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (!alive) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`serverprocess ${String(pid)} levde fortfarande efter close()`);
  }
});

describe("nexus-mcp-template-ts", () => {
  it("listar sina verktyg", async () => {
    const tools = await session.client.listTools(undefined, { timeout: 15_000 });
    const names = tools.tools.map((t) => t.name);
    assert.deepEqual(names.sort(), ["add_numbers", "nexus_demo"]);
    assert.equal(tools.tools.find((t) => t.name === "nexus_demo")?.annotations?.readOnlyHint, true);
  });

  it("körr nexus_demo och returnerar structuredContent", async () => {
    const result = await session.client.callTool({ name: "nexus_demo", arguments: { name: "testare", shout: true } }, undefined, { timeout: 15_000 });
    assert.equal(result.isError, undefined);
    const first = result.content[0];
    assert.equal(first?.type, "text");
    assert.match(String(first.type === "text" ? first.text : ""), /HEJ TESTARE/);
    assert.equal(result.structuredContent.greeting, "HEJ TESTARE FRÅN NEXUS-TEMPLATE");
  });

  it("validerar obligatoriska argument (add_numbers utan args ger tool-fel, inte krasch)", async () => {
    const result = await session.client.callTool({ name: "add_numbers", arguments: {} }, undefined, { timeout: 15_000 });
    assert.equal(result.isError, true);
    const still = await session.client.callTool({ name: "add_numbers", arguments: { a: 2, b: 40 } }, undefined, { timeout: 15_000 });
    assert.equal(still.structuredContent.sum, 42);
  });
});

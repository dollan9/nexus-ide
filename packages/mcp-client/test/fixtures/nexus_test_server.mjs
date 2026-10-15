#!/usr/bin/env node
/**
 * nexus_test_server.mjs — test-fixture for @nexus/mcp-client (inte en produktserver).
 *
 * Den har de verktyg testerna behöver för att bevisa managerns lagar:
 *   ping            eckar ett argument (read-only)
 *   boom            returnerar isError:true (tool-fel ska aldrig krascha klienten)
 *   tools_count     antal registrerade verktyg just nu
 *   add_tool        registrerar ett verktyg LIVE och skickar tools/list_changed
 *   spawn_child     startar en barnprocess som lever länge (bevis för process-träd)
 *   sleep           blockerar svaret i N millisekunder (timeout-väg)
 *   close_self      dödar servern själv (oväntat dödsfall)
 *
 * Flaggor: --name <id> | --hang (svarar aldrig på initialize) | --no-tools
 * Avslutar rent när stdin stängs, exakt som produktserverna.
 */

import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const argv = process.argv.slice(2);

/** Läs värdet efter en `--flagg`. */
function flagValue(name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? (argv[index + 1] ?? "") : "";
}

const serverName = flagValue("name") || "nexus-test";
const shouldHang = argv.includes("--hang");
const noTools = argv.includes("--no-tools");

/** Alla barnprocesser — måste avlivas innan vi själv går. */
const children = new Set();
let exiting = false;

function shutdown(reason) {
  if (exiting) return;
  exiting = true;
  process.stderr.write(`[${serverName}] avslutar (${reason})\n`);
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // redan ute
    }
  }
  process.exit(0);
}

if (shouldHang) {
  // Som en server som står och tänker: håll stdin öppen men svara aldrig.
  process.stdin.resume();
  process.stdin.on("end", () => shutdown("stdin EOF"));
  process.stdin.on("close", () => shutdown("stdin stängd"));
  process.stderr.write(`[${serverName}] hänger avsiktligt\n`);
} else {
  const server = new McpServer({ name: serverName, version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });

  /** Gemensamt svar: text för människor + structuredContent för testerna. */
  const reply = (payload, body) => ({
    content: [{ type: "text", text: body ?? JSON.stringify(payload) }],
    structuredContent: { ok: true, ...payload },
  });

  // Antal verktyg räknas härifrån, inte inuti SDK:ns privata fält.
  let registeredNames = new Set();

  if (!noTools) {
    server.registerTool(
      "ping",
      { title: "Ping", description: "Eckar tillbaka note together med serverns namn. Read-only.", inputSchema: { note: z.string().optional() }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
      async ({ note }) => reply({ serverName, note: note ?? "pong" }),
    );

    server.registerTool(
      "boom",
      { title: "Boom", description: "Returnerar alltid ett tool-fel (isError:true).", inputSchema: {}, annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: "text", text: "det här dog" }], isError: true }),
    );

    server.registerTool(
      "tools_count",
      { title: "Tools count", description: "Antal verktyg servern exponerar just nu.", inputSchema: {}, annotations: { readOnlyHint: true } },
      async () => reply({ count: registeredNames.size, names: [...registeredNames].sort() }),
    );

    server.registerTool(
      "add_tool",
      {
        title: "Add tool live",
        description: "Registrerar ett nytt verktyg och skickar notifications/tools/list_changed.",
        inputSchema: { name: z.string().min(1) },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async ({ name }) => {
        server.registerTool(
          name,
          { title: `Dynamisk ${name}`, description: `Verktyg som lades till efter start (${name}).`, inputSchema: { echo: z.string().optional() }, annotations: { readOnlyHint: true } },
          async ({ echo }) => reply({ added: name, echo: echo ?? null }),
        );
        registeredNames.add(name);
        server.sendToolListChanged();
        return reply({ added: name, count: registeredNames.size });
      },
    );

    server.registerTool(
      "spawn_child",
      {
        title: "Spawn child",
        description: "Startar en långlivad node-barnprocess och returnerar dess pid. För process-träd-tester.",
        inputSchema: { ms: z.number().int().min(1000).max(120000) },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async ({ ms }) => {
        const child = spawn(process.execPath, ["-e", `setTimeout(()=>process.exit(0),${String(ms)});setInterval(()=>{},1000);`], { stdio: "ignore", windowsHide: true });
        children.add(child);
        child.on("exit", () => children.delete(child));
        return reply({ childPid: child.pid ?? null, selfPid: process.pid });
      },
    );

    server.registerTool(
      "sleep",
      { title: "Sleep", description: "Svarar först efter N millisekunder — för att prova per-server timeout.", inputSchema: { ms: z.number().int().min(0).max(120000) }, annotations: { readOnlyHint: true } },
      async ({ ms }) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return reply({ sleptMs: ms });
      },
    );

    server.registerTool(
      "close_self",
      { title: "Close self", description: "Avslutar serverprocessen — simulerar en oväntat död MCP-server.", inputSchema: {}, annotations: { readOnlyHint: false, destructiveHint: true } },
      async () => {
        setTimeout(() => shutdown("close_self anropad"), 80);
        return reply({ closing: true });
      },
    );

    registeredNames = new Set(["ping", "boom", "tools_count", "add_tool", "spawn_child", "sleep", "close_self"]);
  }

  const transport = new StdioServerTransport();
  process.stdin.on("end", () => shutdown("stdin EOF"));
  process.stdin.on("close", () => shutdown("stdin stängd"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  // StdioClientTransport stänger vår stdin → ovan hook sätter punkten.
  void server.connect(transport).then(() => {
    process.stderr.write(`[${serverName}] redo\n`);
  });
}

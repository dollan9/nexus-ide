/**
 * nexus-mcp-template-ts — mall för att skriva dina egna MCP-servrar (FAS 4.5).
 *
 * Köra:
 *   pnpm i
 *   pnpm build
 *   node dist/index.js          (pratar MCP på stdio, två demo-verktyg)
 *
 * Registrera den i NEXUS-IDE genom att lägga till ett paket i `mcp.json` (se
 * README.md), till exempel:
 *   { "id": "min-server", "transport": "stdio",
 *     "command": "${NODE_EXECUTABLE}",
 *     "args": ["${NEXUS_REPO_ROOT}/templates/mcp-server-ts/dist/index.js"],
 *     "enabled": true }
 *
 * Krav som uppfylls här:
 *   - TypeScript strict, inga `any`, inga @ts-ignore
 *   - CommonJS-bygg till dist/ (package.json har ingen "type")
 *   - ren avgång när föräldern stänger stdin — ingen kvarvarande process
 *   - verktyg med annotationer + _meta så NEXUS kan visa dem korrekt
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SERVER_NAME = process.env.NEXUS_MCP_TEMPLATE_NAME ?? "nexus-template";
const SERVER_VERSION = "1.0.0";
/**
 * NEXUS sätter NEXUS_MCP_SERVER_ID till det id som servern har i mcp.json, så en
 * server kan logga och svara med sitt registernamn. Utan NEXUS (fristående körning)
 * faller den tillbaka på mallens eget namn.
 */
const INSTANCE_ID = process.env.NEXUS_MCP_SERVER_ID ?? SERVER_NAME;

/** Skriv till stderr — stdout är reserverad för JSON-RPC. */
function log(message: string): void {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

/** Bygg servern och registrera verktygen. Separerad så ett test kan återanvända den. */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "NEXUS MCP-mall (TypeScript)" },
    {
      // listChanged:true låter oss skicka notifications/tools/list_changed senare.
      capabilities: { tools: { listChanged: true } },
      instructions: "Demo-server för NEXUS-IDE. Verktyg svarar med text och structuredContent.",
    },
  );

  server.registerTool(
    "nexus_demo",
    {
      title: "Demo tool",
      description: "Returnerar en hälsning, en tidsstämpel och argumentet du skickade. Read-only.",
      inputSchema: {
        name: z.string().min(1).max(200).optional().describe("Vem hälsningen gäller. Standard 'world'."),
        shout: z.boolean().optional().describe("Versaler på hälsningen."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { requiresApproval: false, example: { name: "nexus" } },
    },
    async ({ name, shout }) => {
      const greeting = `hej ${name ?? "world"} från ${INSTANCE_ID}`;
      const text = shout === true ? greeting.toUpperCase() : greeting;
      return {
        content: [{ type: "text", text }],
        structuredContent: { ok: true, greeting: text, at: new Date().toISOString(), server: SERVER_NAME, instance: INSTANCE_ID },
      };
    },
  );

  server.registerTool(
    "add_numbers",
    {
      title: "Add numbers",
      description: "Adderar två tal — exempel på ett verktyg med obligatoriska argument.",
      inputSchema: { a: z.number().int().describe("Första talet."), b: z.number().int().describe("Andra talet.") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }],
      structuredContent: { ok: true, sum: a + b },
    }),
  );

  return server;
}

/**
 * Stäng och avsluta — exakt en gång, oavsett vad som triggade.
 * Föräldern (NEXUS) stänger vår stdin när servern ska ner.
 */
function attachShutdown(server: McpServer): void {
  let exiting = false;
  const shutdown = (reason: string): void => {
    if (exiting) return;
    exiting = true;
    log(`avslutar (${reason})`);
    void Promise.resolve(server.close())
      .catch(() => undefined)
      .finally(() => {
        process.exit(0);
      });
  };
  process.stdin.on("end", () => shutdown("stdin EOF"));
  process.stdin.on("close", () => shutdown("stdin stängd"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (error: Error) => {
    log(`okänt fel: ${error.message}`);
    shutdown("uncaughtException");
  });
}

/**
 * Huvudflöde: connecta transporten och håll liv tills föräldern stänger av oss.
 * Exporteras inte — filen är en server, inte ett bibliotek.
 */
async function main(): Promise<void> {
  const server = createServer();
  attachShutdown(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Protocol.connect har redan satt transport.onclose; vi lägger vårt ovanpå
  // utan att tappas — SDK:ns egen nedstängning körs genom server.close().
  const previous = transport.onclose;
  transport.onclose = () => {
    previous?.();
    shutdownAfterTransport();
  };
  log("redo på stdio");
}

/** Transporten dog: stäng servern och gå, annars hänger processen. */
function shutdownAfterTransport(): void {
  process.stderr.write(`[${SERVER_NAME}] transporten stängd\n`);
  process.exit(0);
}

void main().catch((error: unknown) => {
  process.stderr.write(`[${SERVER_NAME}] start fel: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

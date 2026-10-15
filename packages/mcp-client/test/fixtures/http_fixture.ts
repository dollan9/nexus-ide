/**
 * http_fixture.ts — rigga upp riktiga MCP-servrar i testprocessen som pratar
 * SSE och streamable HTTP (FAS 4.1:s fjärde transportbevis, utan externa binärer).
 *
 * Inget barnprocesstrad inblandat: en node http-server i samma process, stängd
 * i afterAll. Bevismodet är alltså: vår client → riktig HTTP/SSE-wire → riktig
 * McpServer → tools/call → tillbaka.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export interface FixtureServers {
  readonly sseUrl: string;
  readonly httpUrl: string;
  /** Headren servern faktiskt såg — beviset för ${VAR}-interpolation på http/sse. */
  seenHeaders: Record<string, string>;
  close: () => Promise<void>;
}

/** Bygg en MCP-server med ett enda verktyg som ekar + rapporterar headern. */
function makeServer(headerBag: Record<string, string>): McpServer {
  const server = new McpServer({ name: "nexus-http-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.registerTool(
    "fixture_echo",
    {
      title: "Fixture echo",
      description: "Eckar note och returnerar vilka anropsheadrar servern såg.",
      inputSchema: { note: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ note }) => ({
      content: [{ type: "text", text: note ?? "echo" }],
      structuredContent: { ok: true, note: note ?? null, headers: { ...headerBag } },
    }),
  );
  server.registerTool(
    "fixture_fail",
    { title: "Fixture fail", description: "Alltid isError — transporten ska ändå leva vidare.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: "text", text: "fel" }], isError: true }),
  );
  return server;
}

/** Läs och tolka en JSON-body från en Node-request. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) return undefined;
  return JSON.parse(raw) as unknown;
}

const isInitialize = (body: unknown): boolean => typeof body === "object" && body !== null && (body as { method?: unknown }).method === "initialize";

/**
 * Starta SSE- och streamable-HTTP-servarnarna på slumpmässiga loopback-portar.
 * @param headerBag dit inslagna headrar loggas (delat mellan transporterna)
 */
export async function startFixtureServers(headerBag: Record<string, string>): Promise<FixtureServers> {
  const sseTransports = new Map<string, SSEServerTransport>();
  const httpTransports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string" && name.startsWith("x-nexus")) headerBag[name] = value;
      }
      try {
        if (url.pathname === "/sse" && req.method === "GET") {
          // SSEServerTransport.genererar sitt sessionId FÖRST inuti start(), och Protocol.connect()
          // anropar start(). Skriver vi in transporten i mappan före connect är nyckeln undefined,
          // klienten POST:ar det riktiga id:t, och uppkopplingen dör på "okänd sessionId".
          const transport = new SSEServerTransport("/messages", res);
          const server = makeServer(headerBag);
          await server.connect(transport);
          sseTransports.set(transport.sessionId, transport);
          transport.onclose = () => sseTransports.delete(transport.sessionId);
          return;
        }
        if (url.pathname === "/messages" && req.method === "POST") {
          const sessionId = url.searchParams.get("sessionId") ?? "";
          const transport = sseTransports.get(sessionId);
          if (transport === undefined) {
            res.writeHead(400).end("okänd sessionId");
            return;
          }
          await transport.handlePostMessage(req, res);
          return;
        }
        if (url.pathname === "/mcp") {
          if (req.method === "POST") {
            const body = await readJson(req);
            const requestedSession = req.headers["mcp-session-id"];
            const existing = typeof requestedSession === "string" ? httpTransports.get(requestedSession) : undefined;
            if (existing !== undefined) {
              await existing.handleRequest(req, res, body);
              return;
            }
            if (!isInitialize(body)) {
              res.writeHead(400).end("streamable http: initialize krävs först");
              return;
            }
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
            const server = makeServer(headerBag);
            transport.onclose = () => {
              if (transport.sessionId !== undefined) httpTransports.delete(transport.sessionId);
            };
            await server.connect(transport);
            await transport.handleRequest(req, res, body);
            if (transport.sessionId !== undefined) httpTransports.set(transport.sessionId, transport);
            return;
          }
          if (req.method === "GET" || req.method === "DELETE") {
            const requestedSession = req.headers["mcp-session-id"];
            const transport = typeof requestedSession === "string" ? httpTransports.get(requestedSession) : undefined;
            if (transport === undefined) {
              res.writeHead(400).end("streamable http: saknar session");
              return;
            }
            await transport.handleRequest(req, res);
            return;
          }
          res.writeHead(405).end("metod ej tillåten");
          return;
        }
        res.writeHead(404).end("inte funnen");
      } catch (err) {
        if (!res.headersSent) res.writeHead(500);
        res.end(`fixture error: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (address === null || typeof address === "string") throw new Error("fixture: kunde inte läsa lyttande port");
  const port = (address as AddressInfo).port;
  const base = `http://127.0.0.1:${String(port)}`;

  return {
    sseUrl: `${base}/sse`,
    httpUrl: `${base}/mcp`,
    seenHeaders: headerBag,
    close: async () => {
      for (const transport of sseTransports.values()) await transport.close().catch(() => undefined);
      for (const transport of httpTransports.values()) await transport.close().catch(() => undefined);
      sseTransports.clear();
      httpTransports.clear();
      await new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      });
    },
  };
}

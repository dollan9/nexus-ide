/**
 * helpers/stub-llm.ts — en ÖPPET REDOVISS OpenAI-kompatibel local server som e2e-sviten äger.
 *
 * Varför inte byggets egen fixture? För att P0-gaten får inte lita på den implementering den testar.
 * Denna server är medvetet enkel och deterministisk, och den deklarerar sig själv som stub i alla
 * svar (id-prefix "stub/", och host ska sätta source:"stub" för den baserat på baseUrl).
 *
 * Styrs via markörer i det senaste användarmeddelandet:
 *   [[TOOL:<name>]]{json}      → svarar med en tool_call på verktyget <name> med args json
 *   [[FINAL:<text>]]           → svarar med texten text (ingen tool_call)
 *   [[STREAM]]                 → strömmar svaret i flera SSE-chunks
 *   [[FIM]]                    → för /v1/completions och /api/generate: returnerar känd kod
 * Ingen markerad förfrågan → kort ekosvar, så testet aldrig hänger sig.
 */
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

export interface StubHandle {
  readonly url: string;
  readonly port: number;
  readonly calls: { path: string; body: any; at: number }[];
  close(): Promise<void>;
}

// Tool-namn kan innehålla bindestreck, punkt och dubbel-understreck (nexus-filesystem__list_directory),
// så klassen MÅSTE täcka dem — annars faller T4 tyst ner på ekosvaret och testet ljuger.
const TOOL_MARKER = /\[\[TOOL:([a-zA-Z0-9_:.\-]+)\]\]([\s\S]*?)(?:\[\[|$)/;
const FINAL_MARKER = /\[\[FINAL:([\s\S]*?)\]\]/;

function sseHead(res: import("node:http").ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
}

function chunk(res: import("node:http").ServerResponse, obj: unknown): void {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

export async function startStubLlm(): Promise<StubHandle> {
  const calls: { path: string; body: any; at: number }[] = [];

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += String(d)));
    req.on("end", async () => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      let body: any = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "bad json" } }));
        return;
      }
      calls.push({ path, body, at: Date.now() });

      // --- modellista -------------------------------------------------------
      if (path.endsWith("/models") && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "stub/chat", object: "model", owned_by: "stub" }, { id: "stub/coder", object: "model", owned_by: "stub" }] }));
        return;
      }
      if (path.endsWith("/api/tags") && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "stub/coder", size: 1_000_000 }] }));
        return;
      }
      if (path.endsWith("/embeddings") || path.endsWith("/api/embeddings")) {
        const texts: string[] = Array.isArray(body.input) ? body.input : [String(body.input ?? body.prompt ?? "")];
        const dim = 64;
        const vectors = texts.map((t) => {
          const v = new Array<number>(dim).fill(0);
          for (const tok of String(t).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
            let h = 0;
            for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
            v[h % dim] += 1;
          }
          const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
          return v.map((x) => x / n);
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(path.includes("api/") ? { embeddings: vectors } : { object: "list", data: vectors.map((e, i) => ({ object: "embedding", index: i, embedding: e })) }));
        return;
      }

      // --- completion / FIM  (viktig: /v1/chat/completions får INTE hamna här) ---------
      if ((path.endsWith("/completions") && !path.includes("/chat/")) || path.endsWith("/api/generate") || path.endsWith("/generate")) {
        const text = "return `session-${user.id}-${Date.now()}`;";
        if (body.stream) {
          sseHead(res);
          if (path.includes("api/")) chunk(res, { response: text, done: false });
          else chunk(res, { choices: [{ text, index: 0, finish_reason: null }] });
          if (path.includes("api/")) chunk(res, { response: "", done: true });
          else chunk(res, { choices: [{ text: "", index: 0, finish_reason: "stop" }] });
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            path.includes("api/")
              ? { response: text, done: true }
              : { id: "stub", object: "text_completion", choices: [{ text, index: 0, finish_reason: "stop" }] },
          ),
        );
        return;
      }

      // --- chat completions -------------------------------------------------
      if (path.endsWith("/chat/completions") || path.endsWith("/api/chat")) {
        const messages: any[] = body.messages ?? [];
        const lastUser = [...messages].reverse().find((m) => m.role === "user" || m.role === "tool");
        const content = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
        const gotToolResult = messages.some((m) => m.role === "tool" || m.role === "function");
        const toolMatch = TOOL_MARKER.exec(content);
        const finalMatch = FINAL_MARKER.exec(content);
        const id = `chatcmpl-stub-${calls.length}`;
        const streaming = Boolean(body.stream);

        // Steg 1: agenten har verktyg tillgängliga och vi har en tool-marker och ännu inget verktygsresultat
        if (toolMatch && !gotToolResult && Array.isArray(body.tools) && body.tools.length > 0) {
          const name = toolMatch[1]!;
          let args: unknown = {};
          try {
            args = toolMatch[2]?.trim() ? JSON.parse(toolMatch[2]!.trim()) : {};
          } catch {
            args = {};
          }
          const msg = {
            id,
            object: "chat.completion",
            model: body.model ?? "stub/chat",
            choices: [{ index: 0, message: { role: "assistant", content: `använder ${name}`, tool_calls: [{ id: "call-1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
          };
          if (streaming) {
            sseHead(res);
            chunk(res, { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] });
            chunk(res, { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(msg));
          return;
        }

        // Steg 2: ändläge — text, ev. strömmat
        const answer = finalMatch
          ? finalMatch[1]!.trim()
          : gotToolResult
            ? "Klart. Jag listade filerna och skrev filen."
            : `Stub-svar till: ${content.slice(0, 120)}`;

        if (streaming) {
          sseHead(res);
          const pieces = answer.match(/.{1,12}/gs) ?? [answer];
          for (const p of pieces) {
            chunk(res, { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: p }, finish_reason: null }] });
            await new Promise((ok) => setTimeout(ok, 8));
          }
          chunk(res, { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id, object: "chat.completion", model: body.model ?? "stub/chat", choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }] }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `stub: okänd path ${path}` } }));
    });
  });

  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    calls,
    close: () => new Promise<void>((ok, bad) => server.close((e) => (e ? bad(e) : ok()))),
  };
}

/**
 * mock-model-server.mjs — NEXUS-IDE:s DELADE test-docka för modellager (FAS 3, FAS 8).
 *
 * Vad det är: en riktig HTTP-server (Node `http`, noll beroenden) på 127.0.0.1 som
 * talar OpenAI-dialekt och Ollama-dialekt. Det är INTE en modell och det utgör sig
 * inte som en: alla id:n har prefixet `stub/`, och alla svar är medvetet triviala.
 * Ett test som går grönt mot den här får därför aldrig påstå att en riktig modell
 * svarade — beviset är `source: "stub"` (se CONVENTIONS.md §Äkthet i tester).
 *
 * Användning (CJS-tester, ingen top-level await):
 *   const { startMockModelServer } = await import("./fixtures/mock-model-server.mjs");
 *   const server = await startMockModelServer({ mode: "echo" });
 *   ...
 *   await server.close();    // ALDRIG lämna en server igång (användaren har invänt)
 *
 * Api:et:
 *   startMockModelServer({ port?, mode?, scriptResponse?, failFirst?, chunkDelayMs?, embeddingDimensions? })
 *     -> { url, baseUrl, port, requests, mode, setMode(mode), setScripted(replies), reset(), close() }
 *
 * Ruturer:
 *   GET  /v1/models              katalog med stub/ prefix
 *   POST /v1/chat/completions    stream (SSE) och icke-stream, verktyg och tool-result
 *   POST /v1/completions         r\u00e5 completion (FIM för OpenAI-kompatibla adapters)
 *   POST /v1/embeddings          vektorer (inte normaliserade — lagret ska normalisera)
 *   GET  /api/tags               Ollama modellista med storlek
 *   POST /api/chat               Ollama chat, NDJSON-stream
 *   POST /api/generate           Ollama FIM med raw:true, prompt + suffix
 *   POST /api/embeddings         Ollama embeddings (prompt per anrop)
 *   POST /api/pull               Ollama pull med progress (model/pull_progress-form)
 *
 * Lägen:
 *   echo        — alltid 200, trivialt svar (standard)
 *   scripted    — poppar ur en kö av malade svar, sista svaret upprepas
 *   ratelimit   — de N första anropen ger 429 med Retry-After, sedan echo
 *   error       — 500 med JSON-felkropp
 *   malformed   — 200 men trasig JSON (negativa tester)
 *   slow        — streamar med chunkDelayMs mellan varje bit, för ström-tester
 *   unavailable — anropet svarar aldrig; servern stänger anslutningen direkt
 */

import http from "node:http";
import { pathToFileURL } from "node:url";

const STUB_MODELS = [
  { id: "stub/mock-chat-1", object: "model", owned_by: "nexus-test-fixture", context_length: 8192 },
  { id: "stub/mock-reason-1", object: "model", owned_by: "nexus-test-fixture", context_length: 4096 },
  { id: "stub/mock-embed-1", object: "model", owned_by: "nexus-test-fixture", context_length: 2048 },
];

const STUB_OLLAMA_MODELS = [
  {
    model: "stub/qwen2.5-coder:1.5b",
    size: 995_000_000,
    details: { family: "qwen2", parameter_size: "1.5B", quantization_level: "Q4_K_M" },
  },
  {
    model: "stub/nomic-embed-text:latest",
    size: 274_000_000,
    details: { family: "nomic-bert", parameter_size: "137M", quantization_level: "F16" },
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(body);
}

function hash(text, salt) {
  let acc = 2166136261 ^ salt;
  for (let i = 0; i < text.length; i++) {
    acc ^= text.charCodeAt(i);
    acc = Math.imul(acc, 16777619);
  }
  return acc >>> 0;
}

/** Deterministisk men ej normaliserad vektor — konsumentens normalisering blir testbar. */
function embeddingVector(text, dimensions, salt) {
  const out = [];
  for (let i = 0; i < dimensions; i++) {
    const h = hash(`${text}#${i}`, salt);
    out.push(((h % 2048) + 1) / 8);
  }
  return out;
}

function lastUserText(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .filter((part) => typeof part?.text === "string")
        .map((part) => part.text)
        .join(" ");
    }
  }
  return "";
}

function hasToolResult(messages) {
  return (messages ?? []).some((message) => {
    if (message?.role === "tool" || message?.role === "function") return true;
    if (Array.isArray(message?.content)) {
      return message.content.some((part) => part?.type === "tool_result" || part?.type === "function_call_output");
    }
    return false;
  });
}

function wantsImage(messages) {
  return (messages ?? []).some(
    (message) => Array.isArray(message?.content) && message.content.some((part) => part?.type === "image_url"),
  );
}

function replyFor(body, state, fallback) {
  if (state.scripted.length > 0) {
    const next = state.scripted.length > 1 ? state.scripted.shift() : state.scripted[0];
    return next ?? fallback;
  }
  return fallback;
}

function sseHeaders(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

function ndjsonHeaders(res) {
  res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" });
}

/**
 * Skriver SSE-data i småbitar med delay emellan, så konsumenten MÅSTE hantera
 * chunk-splits. En rad kan till och med delas mitt i JSON-dokumentet.
 */
async function writeSplit(res, text, chunkDelayMs, pieces = 3) {
  if (chunkDelayMs <= 0 || pieces <= 1) {
    res.write(text);
    return;
  }
  const size = Math.max(1, Math.ceil(text.length / pieces));
  for (let i = 0; i < text.length; i += size) {
    res.write(text.slice(i, i + size));
    await sleep(chunkDelayMs);
  }
}

async function streamChat(res, state, model, text, toolCall) {
  sseHeaders(res);
  if (toolCall !== undefined) {
    const event = `data: ${JSON.stringify({
      id: "stub-chunk-1",
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: "" } } ] } }],
    })}\n\n`;
    await writeSplit(res, event, state.chunkDelayMs);
    const argEvent = `data: ${JSON.stringify({
      model,
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(toolCall.args) } } ] } }],
    })}\n\n`;
    await writeSplit(res, argEvent, state.chunkDelayMs);
    const finalEvent = `data: ${JSON.stringify({ model, choices: [{ index: 0, finish_reason: "tool_calls", delta: {} }] })}\n\ndata: [DONE]\n\n`;
    await writeSplit(res, finalEvent, state.chunkDelayMs);
    res.end();
    return;
  }
  const words = text.split(/(?<= )/);
  for (const [index, word] of words.entries()) {
    const payload = {
      id: `stub-chunk-${index}`,
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: { content: word }, finish_reason: null }],
    };
    await writeSplit(res, `data: ${JSON.stringify(payload)}\n\n`, state.chunkDelayMs, 2);
  }
  const tail = `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
  await writeSplit(res, tail, state.chunkDelayMs, 2);
  res.end();
}

async function streamOllamaChat(res, state, model, text) {
  ndjsonHeaders(res);
  const words = text.split(/(?<= )/);
  for (const word of words) {
    const line = `${JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: "assistant", content: word }, done: false })}\n`;
    await writeSplit(res, line, state.chunkDelayMs, 2);
  }
  const done = `${JSON.stringify({
    model,
    done: true,
    done_reason: "stop",
    prompt_eval_count: 11,
    eval_count: Math.max(1, words.length),
    total_duration: 1_000_000,
  })}\n`;
  await writeSplit(res, done, state.chunkDelayMs, 2);
  res.end();
}

export async function startMockModelServer(options = {}) {
  const {
    port = 0,
    mode = "echo",
    scriptResponse,
    scripted,
    failFirst = 1,
    chunkDelayMs = 0,
    embeddingDimensions = 8,
    retryAfterSeconds = 3,
  } = options;

  const state = {
    mode,
    failCounter: 0,
    failFirst,
    chunkDelayMs,
    embeddingDimensions,
    retryAfterSeconds,
    scripted: normalizeScript(scriptResponse ?? scripted),
  };
  const requests = [];

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      try {
        json(res, 500, { error: { message: `mock-model-server internt fel: ${err?.message ?? String(err)}` } });
      } catch {
        res.destroy();
      }
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const raw = req.method === "GET" || req.method === "DELETE" ? undefined : await readBody(req);
    let body;
    if (raw !== undefined && raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { raw };
      }
    }
    requests.push({
      method: req.method ?? "GET",
      path,
      search: url.search,
      body,
      headers: {
        authorization: req.headers.authorization ?? null,
        "x-api-key": req.headers["x-api-key"] ?? null,
        "x-goog-api-key": req.headers["x-goog-api-key"] ?? null,
        "content-type": req.headers["content-type"] ?? null,
        anthropic_version: req.headers["anthropic-version"] ?? null,
      },
      at: Date.now(),
    });

    if (state.mode === "unavailable") {
      res.destroy();
      return;
    }

    // --- Rate limit / error-läge gäller alla POST-ruturer -------------------
    const isChatRoute = path === "/v1/chat/completions" || path === "/api/chat" || path === "/v1/completions" || path === "/api/generate";
    if (state.mode === "ratelimit" && isChatRoute) {
      state.failCounter += 1;
      if (state.failCounter <= state.failFirst) {
        json(res, 429, { error: { message: "rate limit överskred (stub-server)", type: "rate_limit_error" }, retry_after: state.retryAfterSeconds }, {
          "retry-after": String(state.retryAfterSeconds),
        });
        return;
      }
    }
    if (state.mode === "error") {
      json(res, 500, { error: { message: "mock-model-server är i fel-läge", type: "server_error" } });
      return;
    }

    // --- Katalog -----------------------------------------------------------
    if (req.method === "GET" && path === "/v1/models") {
      json(res, 200, { object: "list", data: STUB_MODELS.map((m) => ({ ...m })) });
      return;
    }
    if (req.method === "GET" && path === "/api/tags") {
      json(res, 200, { models: STUB_OLLAMA_MODELS.map((m) => ({ ...m })) });
      return;
    }
    if (req.method === "GET" && path === "/api/version") {
      json(res, 200, { version: "stub-0.0.0" });
      return;
    }

    if (state.mode === "malformed") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"choices": [ {"message": {"content": "trasig');
      return;
    }

    // --- Chat (OpenAI-dialekt) --------------------------------------------
    if (req.method === "POST" && path === "/v1/chat/completions") {
      const model = body?.model ?? "stub/mock-chat-1";
      const tools = Array.isArray(body?.tools) ? body.tools : [];
      const toolResultSeen = hasToolResult(body?.messages);
      if (tools.length > 0 && !toolResultSeen) {
        const toolCall = {
          id: "stub-call-1",
          name: tools[0]?.function?.name ?? tools[0]?.name ?? "stub_tool",
          args: { path: "stub.txt", note: "test-docka, inte en riktig modell" },
        };
        if (body?.stream === true) {
          await streamChat(res, state, model, "", toolCall);
          return;
        }
        json(res, 200, {
          id: "stub-nonstream-1",
          object: "chat.completion",
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) } }],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 },
        });
        return;
      }

      const imageSeen = wantsImage(body?.messages);
      const fallback = toolResultSeen
        ? "stub-svar: verktygets resultat är läst och sammanfattat"
        : imageSeen
          ? "stub-beskrivning: test-docka såg en bild, ingen riktig VLM svarade"
          : `stub-svar till: ${truncateText(lastUserText(body?.messages), 60)}`;
      const text = replyFor(body, state, fallback);
      if (body?.stream === true) {
        await streamChat(res, state, model, text);
        return;
      }
      json(res, 200, {
        id: "stub-nonstream-2",
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 17, completion_tokens: 9, total_tokens: 26 },
      });
      return;
    }

    // --- Rå completion / FIM (OpenAI-dialekt) ------------------------------
    if (req.method === "POST" && path === "/v1/completions") {
      const model = body?.model ?? "stub/mock-chat-1";
      const prompt = typeof body?.prompt === "string" ? body.prompt : "";
      const text = replyFor(body, state, "  const stub = true;");
      json(res, 200, {
        id: "stub-completion-1",
        object: "text_completion",
        model,
        choices: [{ index: 0, text, finish_reason: "stop" }],
        usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
        // Dockan returnerar med prompt-delen så klienten kan klippa rätt.
        stub_prompt_length: prompt.length,
      });
      return;
    }

    // --- Embeddings --------------------------------------------------------
    if (req.method === "POST" && path === "/v1/embeddings") {
      const model = body?.model ?? "stub/mock-embed-1";
      const inputs = normalizeInput(body?.input);
      const data = inputs.map((text, index) => ({
        object: "embedding",
        index,
        embedding: embeddingVector(String(text), state.embeddingDimensions, index + 1),
      }));
      json(res, 200, { model, object: "list", data, usage: { prompt_tokens: inputs.length * 5, total_tokens: inputs.length * 5 } });
      return;
    }

    // --- Ollama chat -------------------------------------------------------
    if (req.method === "POST" && path === "/api/chat") {
      const model = body?.model ?? "stub/qwen2.5-coder:1.5b";
      const text = replyFor(body, state, `stub-svar från dockan till ${truncateText(lastUserText(body?.messages), 40)}`);
      if (body?.stream === false) {
        json(res, 200, {
          model,
          created_at: new Date().toISOString(),
          message: { role: "assistant", content: text },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 9,
          eval_count: 6,
        });
        return;
      }
      await streamOllamaChat(res, state, model, text);
      return;
    }

    // --- Ollama generate (FIM med raw:true, prompt + suffix) ---------------
    if (req.method === "POST" && path === "/api/generate") {
      const model = body?.model ?? "stub/qwen2.5-coder:1.5b";
      const prompt = typeof body?.prompt === "string" ? body.prompt : "";
      const suffix = typeof body?.suffix === "string" ? body.suffix : "";
      const completion = replyFor(body, state, "\n  return stub;");
      if (body?.stream === false) {
        json(res, 200, {
          model,
          response: completion,
          done: true,
          done_reason: "stop",
          context: { raw: body?.raw === true, prompt_length: prompt.length, suffix_length: suffix.length },
          prompt_eval_count: 42,
          eval_count: 8,
        });
        return;
      }
      ndjsonHeaders(res);
      res.write(`${JSON.stringify({ model, response: completion, done: false })}\n`);
      await sleep(state.chunkDelayMs);
      res.write(`${JSON.stringify({ model, done: true, done_reason: "stop", prompt_eval_count: 42, eval_count: 8 })}\n`);
      res.end();
      return;
    }

    // --- Ollama embeddings -------------------------------------------------
    if (req.method === "POST" && path === "/api/embeddings") {
      const model = body?.model ?? "stub/nomic-embed-text:latest";
      json(res, 200, { model, embedding: embeddingVector(String(body?.prompt ?? ""), state.embeddingDimensions, 3) });
      return;
    }

    // --- Ollama pull med progress ------------------------------------------
    if (req.method === "POST" && path === "/api/pull") {
      const name = body?.name ?? "stub/modell:latest";
      ndjsonHeaders(res);
      const total = 50_000_000;
      const steps = [
        { status: "pulling manifest" },
        { status: "downloading layer", percent: 25 },
        { status: "downloading layer", percent: 60 },
        { status: "verifying sha256 digest", percent: 90 },
        { status: "writing manifest", percent: 100 },
        { status: "success", percent: 100 },
      ];
      for (const step of steps) {
        const line = {
          status: step.status,
          digest: "sha256:stub000000000000000000000000000000000000000000000000000000000000",
        };
        if (step.percent !== undefined) {
          line.total = total;
          line.completed = Math.round((step.percent / 100) * total);
        }
        res.write(`${JSON.stringify(line)}\n`);
        await sleep(Math.max(1, state.chunkDelayMs));
      }
      res.end();
      return;
    }

    // --- Anthropic / Google-liknande former --------------------------------
    if (req.method === "POST" && path === "/v1/messages") {
      const model = body?.model ?? "stub/mock-chat-1";
      const text = replyFor(body, state, "stub-svar från mock-model-server");
      if (body?.stream === true) {
        sseHeaders(res);
        await writeSplit(res, `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "stub", model, role: "assistant" } })}\n\n`, state.chunkDelayMs);
        await writeSplit(res, `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`, state.chunkDelayMs);
        await writeSplit(res, `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`, state.chunkDelayMs);
        res.end();
        return;
      }
      json(res, 200, {
        id: "stub-msg-1",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 7 },
      });
      return;
    }
    if (req.method === "POST" && path.endsWith(":generateContent")) {
      const model = (path.split("/models/")[1] ?? "stub/mock-chat-1").split(":")[0];
      const text = replyFor(body, state, "stub-svar från mock-model-server");
      json(res, 200, {
        candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 5, totalTokenCount: 13 },
        modelVersion: `models/${model}`,
      });
      return;
    }
    if (req.method === "POST" && path.endsWith(":streamGenerateContent")) {
      const model = (path.split("/models/")[1] ?? "stub/mock-chat-1").split(":")[0];
      const text = replyFor(body, state, "stub-svar från mock-model-server");
      sseHeaders(res);
      await writeSplit(res, `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], modelVersion: `models/${model}` })}\n\n`, state.chunkDelayMs);
      await writeSplit(res, "data: [DONE]\n\n", state.chunkDelayMs);
      res.end();
      return;
    }
    if (req.method === "POST" && path.endsWith(":embedContent")) {
      json(res, 200, { embedding: { values: embeddingVector(String(body?.content?.parts?.[0]?.text ?? ""), state.embeddingDimensions, 5) } });
      return;
    }

    json(res, 404, { error: { message: `mock-model-server: okänd rout ${req.method} ${path}` } });
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;

  return {
    url: `http://127.0.0.1:${actualPort}`,
    baseUrl: `http://127.0.0.1:${actualPort}/v1`,
    port: actualPort,
    requests,
    get mode() {
      return state.mode;
    },
    setMode(next) {
      state.mode = next;
      if (next !== "ratelimit") state.failCounter = 0;
      return state.mode;
    },
    setScripted(replies) {
      state.scripted = normalizeScript(replies);
      state.mode = "scripted";
    },
    setChunkDelay(ms) {
      state.chunkDelayMs = ms;
    },
    reset() {
      requests.length = 0;
      state.failCounter = 0;
    },
    close() {
      return new Promise((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function normalizeScript(value) {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [];
}

function normalizeInput(input) {
  if (Array.isArray(input)) return input;
  if (typeof input === "string") return [input];
  if (input === undefined || input === null) return [];
  return [String(input)];
}

function truncateText(text, max) {
  if (typeof text !== "string") return "";
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// Hjälp för andra agenter: kör dockan från kommandoraden (exportera ingen port permanent).
const cliPath = process.argv[1] === undefined ? "" : pathToFileURL(process.argv[1]).href;
if (import.meta.url === cliPath) {
  const server = await startMockModelServer({ port: Number(process.env.PORT ?? 0), mode: "echo" });
  process.stdout.write(`mock-model-server på ${server.url} (stub, ingen riktig modell)\n`);
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

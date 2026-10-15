/**
 * tests/e2e/helpers/harness.ts — P0-gatens motor. Skrivet av orchestatorn, inte av byggarna,
 * för att självskattning inte är ett bevis.
 *
 * Verklig kedja, ingen mock av transporten:
 *   Playwright Chromium → http://127.0.0.1:7947 (bygd renderer, statisk server)
 *        → WebSocket ws://127.0.0.1:7946/ws  (@nexus/host startWsServer)
 *        → @nexus/core (riktig fil-IO, riktig shadow-git, riktig terminal-process)
 *        → @nexus/providers (antagen: riktig Ollama, annars mock-model-server med source:"stub")
 *        → @nexus/mcp-client (riktiga MCP-servrar över stdio)
 *
 * Allt som skrivs sker i en temp-kopia av fixtures/corpus — användarens riktiga träd rörts inte.
 */
import { createServer, type Server } from "node:http";
import { readFile, mkdir, mkdtemp, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, dirname, resolve } from "node:path";
import { WebSocket } from "ws";
import { request as httpRequest } from "node:http";

export const RENDERER_PORT = 7947;
export const HOST_PORT = 7946;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
};

/** Minimal statisk server — inga externa beroenden, serverar den byggda renderern. */
async function serveRenderer(root: string): Promise<Server> {
  const base = resolve(root);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${RENDERER_PORT}`);
      let p = decodeURIComponent(url.pathname);
      if (p === "/" || p === "") p = "/index.html";
      const full = resolve(join(base, p));
      // jail: servera aldrig utanför byggda mappen
      if (!full.startsWith(base)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      const body = await readFile(existsSync(full) && !full.endsWith(".html") ? full : join(base, "index.html"));
      res.writeHead(200, { "content-type": MIME[extname(full)] ?? "application/octet-stream" });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" }).end(`static error: ${(err as Error).message}`);
    }
  });
  await new Promise<void>((ok) => server.listen(RENDERER_PORT, "127.0.0.1", ok));
  return server;
}

export interface HarnessHandle {
  readonly workspaceRoot: string;
  readonly url: string;
  readonly modelSource: "local" | "stub";
  readonly ollamaModel?: string;
  close(): Promise<void>;
}

/**
 * Startar hela kedjan. `opts.host` injiceras av testet (vi importerar @nexus/host via dynamic
 * import för att slippa byggrace i CI-liknande körning).
 */
export async function startHarness(opts: {
  hostFactory: (o: Record<string, unknown>) => Promise<unknown> | unknown;
  wsStarter?: (host: unknown, port: number) => Promise<{ close(): Promise<void> }>;
  rendererDir: string;
  providersFixture?: { startMockModelServer(opts?: Record<string, unknown>): Promise<MockServer> };
  useOllama?: boolean;
}): Promise<HarnessHandle> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "nexus-e2e-"));
  await cp(join(process.cwd(), "fixtures", "corpus"), workspaceRoot, { recursive: true });
  await mkdir(join(workspaceRoot, ".env"), { recursive: false }).catch(() => undefined);

  let mock: MockServer | null = null;
  let modelSource: "local" | "stub" = "stub";
  let ollamaModel: string | undefined;

  if (opts.useOllama && (await ollamaAlive())) {
    modelSource = "local";
    ollamaModel = process.env.CHAT_MODEL ?? "qwen2.5-coder:1.5b";
  } else if (opts.providersFixture) {
    mock = await opts.providersFixture.startMockModelServer({ port: 0 });
    await mock.ready();
  }

  const host = await opts.hostFactory({
    root: workspaceRoot,
    ...(mock ? { stubChatBaseUrl: mock.url, stubEmbedBaseUrl: mock.url } : {}),
    ollama: modelSource === "local",
  });
  const ws = opts.wsStarter ? await opts.wsStarter(host, HOST_PORT) : undefined;
  const server = await serveRenderer(opts.rendererDir);

  return {
    workspaceRoot,
    url: `http://127.0.0.1:${RENDERER_PORT}/`,
    modelSource,
    ollamaModel,
    async close() {
      await new Promise<void>((ok) => server.close(() => ok()));
      await ws?.close();
      await mock?.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}

export interface MockServer {
  url: string;
  port: number;
  requests: unknown[];
  setMode?(mode: string): void;
  ready(): Promise<void>;
  close(): Promise<void>;
}

export async function ollamaAlive(): Promise<boolean> {
  const base = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  try {
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

// ===================== RESURSGUARD (AGENTS.md Regel 7) =====================
// Datorn kraschade 2026-10-15 för att qwen3:14b (9,28 GB) + qwen3:8b (5,23 GB) laddades medan
// flera build-processer körde på 16 GB RAM. En guard som MÄTER innan den lovar är den enda
// skyddet — ett antagande om att "det nog får plats" är exakt det som slog sönder maskinen.
// Om guarden säger nej faller testet tillbaka till stubben och BEVIS-kolumnen säger `stub`.

export interface GuardResult {
  readonly ok: boolean;
  readonly freeVramMb: number;
  readonly freeRamMb: number;
  readonly loaded: readonly { name: string; sizeMb: number }[];
  readonly loadedTotalMb: number;
  readonly reason: string;
}

export const MIN_FREE_VRAM_MB = 3000;
export const MIN_FREE_RAM_MB = 3000;
export const MAX_LOADED_MB = 6000;

function execText(cmd: string): string {
  try {
    return require("node:child_process").execSync(cmd, { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] }) as string;
  } catch {
    return "";
  }
}

export async function resourceGuard(): Promise<GuardResult> {
  const vramRaw = execText('nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits');
  const freeVramMb = parseInt(vramRaw.split("\n")[0]?.trim() ?? "", 10) || 0;

  const ramRaw = execText(
    'powershell.exe -NoProfile -Command ' +
      String.raw`"$os=Get-CimInstance Win32_OperatingSystem; [math]::Round($os.FreePhysicalMemory/1KB)"`,
  );
  const freeRamMb = parseInt(ramRaw.trim().split("\n").pop() ?? "0", 10) || 0;

  let loaded: { name: string; sizeMb: number }[] = [];
  try {
    const r = await fetch((process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434") + "/api/ps", { signal: AbortSignal.timeout(2000) });
    const j = (await r.json()) as { models?: { name: string; size?: number; size_vram?: number }[] };
    loaded = (j.models ?? []).map((m) => ({ name: m.name, sizeMb: Math.round((m.size_vram ?? m.size ?? 0) / 1e6) }));
  } catch {
    loaded = [];
  }
  const loadedTotalMb = loaded.reduce((a, b) => a + b.sizeMb, 0);

  const reasons: string[] = [];
  if (freeVramMb < MIN_FREE_VRAM_MB) reasons.push(`fri VRAM ${freeVramMb} < ${MIN_FREE_VRAM_MB} MiB`);
  if (freeRamMb < MIN_FREE_RAM_MB) reasons.push(`fri RAM ${freeRamMb} < ${MIN_FREE_RAM_MB} MiB`);
  if (loadedTotalMb > MAX_LOADED_MB) reasons.push(`redan laddade modeller ${loadedTotalMb} MiB > ${MAX_LOADED_MB} MiB (${loaded.map((l) => l.name).join(", ")})`);
  const big = loaded.find((l) => l.sizeMb > 4500);
  if (big) reasons.push(`stor modell laddad: ${big.name} ${big.sizeMb} MiB — får inte laddas under bygge (Regel 7)`);

  return {
    ok: reasons.length === 0,
    freeVramMb,
    freeRamMb,
    loaded,
    loadedTotalMb,
    reason: reasons.length ? reasons.join("; ") : `ryms: ${freeVramMb} MiB VRAM och ${freeRamMb} MiB RAM fri`,
  };
}

/** Släpp alla laddade modeller (keep_alive 0). Kallas i close() — inget ska ligga kvar i VRAM. */
export async function unloadOllamaModels(): Promise<string[]> {
  const base = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  const out: string[] = [];
  try {
    const r = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(2000) });
    const j = (await r.json()) as { models?: { name: string }[] };
    for (const m of j.models ?? []) {
      await fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: m.name, keep_alive: 0 }),
        signal: AbortSignal.timeout(10000),
      }).catch(() => undefined);
      out.push(m.name);
    }
  } catch {
    /* Ollama svarar inte — inget att lasta ur */
  }
  return out;
}

/** Miljö som begränsar Ollama till EN modell och EN parallell körning (Regel 7 punkt 2). */
export function applyOllamaLimits(): void {
  process.env.OLLAMA_MAX_LOADED_MODELS ??= "1";
  process.env.OLLAMA_NUM_PARALLEL ??= "1";
  process.env.OLLAMA_KEEP_ALIVE ??= "120";
  process.env.OLLAMA_FLASH_ATTENTION ??= "0";
}

/**
 * En WS-klient som pratar protocol-ramarna direkt — för tester där UI:t inte behöver klickas
 * (T4/T5/T6 kan verifieras på host-nivå, men vi kör dem ändå genom UI:t när det finns).
 */
export class WsClient {
  private nextId = 1;
  private pending = new Map<string | number, { ok: (v: unknown) => void; bad: (e: Error) => void }>();
  private handlers = new Map<string, Set<(p: unknown) => void>>();
  private socket!: WebSocket;
  public readonly events: { name: string; payload: unknown; at: number }[] = [];

  constructor(private readonly url = `ws://127.0.0.1:${HOST_PORT}/ws`) {}

  connect(): Promise<void> {
    return new Promise((ok, bad) => {
      this.socket = new WebSocket(this.url);
      this.socket.on("open", () => ok());
      this.socket.on("error", (e) => bad(e as Error));
      this.socket.on("message", (raw) => {
        let frame: any;
        try {
          frame = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (frame.type === "event") {
          this.events.push({ name: frame.name, payload: frame.payload, at: Date.now() });
          for (const h of this.handlers.get(frame.name) ?? []) h(frame.payload);
          return;
        }
        const p = this.pending.get(frame.id);
        if (!p) return;
        this.pending.delete(frame.id);
        if (frame.error) p.bad(new Error(`${frame.error.code}: ${frame.error.message}`));
        else p.ok(frame.result);
      });
    });
  }

  request<T = any>(method: string, params: unknown = {}, timeoutMs = 20000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((ok, bad) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        bad(new Error(`timeout ${timeoutMs}ms for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        ok: (v) => {
          clearTimeout(t);
          ok(v as T);
        },
        bad: (e) => {
          clearTimeout(t);
          bad(e);
        },
      });
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  on(name: string, fn: (p: any) => void): () => void {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name)!.add(fn);
    return () => this.handlers.get(name)!.delete(fn);
  }

  /** Väntar på nästa förekomst av event, med gräns — annars hänger sig testet. */
  waitFor(name: string, predicate: (p: any) => boolean = () => true, timeoutMs = 25000): Promise<any> {
    return new Promise((ok, bad) => {
      const t = setTimeout(() => {
        off();
        bad(new Error(`waitFor(${name}) timeout ${timeoutMs}ms — fick ${this.events.filter((e) => e.name === name).length} st events`));
      }, timeoutMs);
      const off = this.on(name, (p) => {
        if (predicate(p)) {
          clearTimeout(t);
          off();
          ok(p);
        }
      });
    });
  }

  close(): void {
    this.socket?.close();
  }
}

/** Felsökbar textfrånvaro: Playwright:s vanliga fel säger sällan vad som faktiskt finns i DOM. */
export async function firstExisting(page: import("playwright").Page, selectors: string[], timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) return loc;
    }
    await page.waitForTimeout(120);
  }
  const dump = await page.evaluate(() => document.body.innerText.slice(0, 400));
  const html = await page.evaluate(() => document.body.innerHTML.slice(0, 600));
  throw new Error(
    `Ingen av selektorerna ${JSON.stringify(selectors)} hittades.\n--- body text ---\n${dump}\n--- html ---\n${html}`,
  );
}

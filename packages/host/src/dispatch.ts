/**
 * dispatch.ts — den enda router:n som vänder protocol till host.
 *
 * Varje metod i MethodTable har EXAKT en handler här. Ingen handler får kasta råa
 * fel: allt som kastar blir ett HostError (med ErrorCode) och fångas av dispatch(),
 * som alltid svarar med ett välformat RpcResponse (CONVENTIONS §Fel och nedbrytning,
 * AGENTS Regel 4/5). Transporten (WebSocket, Electron-IPC, in-process) är bara en
 * innhyllning — dispatch äraffärslogikens enda inlopp.
 *
 * Kompletthet är strukturellt tvingad: HandlerRegistry.add<M> kräver att params- och
 * result-typen matchar MethodTable nyckeln, och testet jämför registret mot
 * ALL_METHOD_NAMES i BÅDA riktningar. En halvimplementerad metod syns där.
 */

import {
  ALL_METHOD_NAMES,
  ErrorCode,
  PROTOCOL_VERSION,
  isMethodName,
  isRpcRequest,
  makeError,
  makeResult,
  type CompletionRequest,
  type FileDiff,
  type HostHealth,
  type MethodName,
  type ProviderConfigInput,
  type RpcId,
  type RpcRequest,
  type RpcResponse,
  type SearchReplacePatch,
  type ServiceProbe,
} from "@nexus/protocol";
import { applyPatches, defaultCommands, unifiedDiff } from "@nexus/core";
import { buildFimBody, trimFimCompletion } from "@nexus/providers";
import type { HostRuntime } from "./runtime";
import { HandlerRegistry } from "./registry";
import { HostError, toRpcError } from "./errors";
import { hardenValue } from "./harden";
import { checkpointSourceFor, shouldCheckpoint } from "./write-gate";
import { settle, withTimeout } from "./utils";
import { HOST_VERSION } from "./version";

/** Ett dispatch-anrop: antingen en färdig request eller rått transport-JSON. */
export type DispatchInput = RpcRequest | { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

export interface Dispatcher {
  readonly registry: HandlerRegistry;
  /** Vänder en request till ett ALWAYS-velformatterat svar. Kastar aldrig. */
  dispatch(request: DispatchInput): Promise<RpcResponse>;
  /** In-process genväg för tester och host-interna anrop. */
  invoke<M extends MethodName>(method: M, params: RpcRequest<M>["params"], id?: RpcId): Promise<RpcResponse>;
  readonly names: MethodName[];
}

/**
 * Tidsgräns per metod. Få genvägar (ping/info) är snabba; fil-, search- och
 * model-anrop har rymliga gränser; godkännandeblockerade anrop (delete, mcp.tools.call,
 * checkpoint.rollback med UI-beslut) får överskrida brokerns egen 60s timeout sa att
 * transporten aldrig kliver avfore användaren hinner svara.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_TIMEOUT_MS = 180_000;
const APPROVAL_TIMEOUT_MS = 75_000;
const TIMEOUTS: Partial<Record<MethodName, number>> = {
  "rag.index": LONG_TIMEOUT_MS,
  "model.pull": LONG_TIMEOUT_MS,
  "fs.search": 60_000,
  "fs.replaceInFiles": LONG_TIMEOUT_MS,
  "fs.delete": APPROVAL_TIMEOUT_MS,
  "edit.apply": APPROVAL_TIMEOUT_MS,
  "mcp.tools.call": APPROVAL_TIMEOUT_MS,
  "mcp.servers.reload": LONG_TIMEOUT_MS,
  "mcp.servers.start": 60_000,
  "mcp.servers.upsert": 60_000,
  "checkpoint.rollback": APPROVAL_TIMEOUT_MS,
  "agent.lastRun": 5_000,
  "host.ping": 5_000,
  "host.info": 5_000,
};

function timeoutFor(method: MethodName): number {
  return TIMEOUTS[method] ?? DEFAULT_TIMEOUT_MS;
}

/** En test-docka-svar för ai-service nar en HTTP-prob inte ens kan byggas (R5). */
function offlineProbe(baseUrl: string, error: string): ServiceProbe {
  return { ok: false, baseUrl, error };
}

/** Miljönyckelnamn för en providers nyckel — MUST matcha ConfigStore SECRET_PATTERN (_KEY$). */
function envKeyForProvider(config: ProviderConfigInput): string {
  const base = (config.id ?? config.label ?? config.kind)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const trimmed = base.length > 0 ? base.slice(0, 40) : "CUSTOM";
  return `${trimmed}_API_KEY`;
}

/**
 * Parsa SEARCH/REPLACE-block ur ett modelsvar. Format (FAS 7.3):
 *   <<<<<<< SEARCH [path]
 *   <gammal text>
 *   =======
 *   <ny text>
 *   >>>>>>> REPLACE
 * Returnera patches i den ordning de förekom — aldrig en gissning.
 */
function parseSearchReplaceBlocks(text: string): SearchReplacePatch[] {
  const out: SearchReplacePatch[] = [];
  const fence = /<<<<<<< SEARCH[^\n]*\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> REPLACE/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    const search = match[1];
    const replace = match[2];
    if (search === undefined) continue;
    out.push({ search, replace: replace ?? "" });
  }
  return out;
}

/** Bygg en ny fil ur ```-staket om modellen inte returnerade strukturerade block. */
function extractFencedCode(text: string): string | null {
  const fence = /```[a-zA-Z0-9]*\n([\s\S]*?)```/;
  const match = fence.exec(text);
  return match !== null && match[1] !== undefined ? match[1] : null;
}

/**
 * Skapa checkpoint FÖRE skrivningen sa att rollback återskapar de gamla bytena
 * (AGENTS Regel 5). Genererade vägar checkpointas aldrig — write-gaten avgör.
 */
async function checkpointBeforeWrite(runtime: HostRuntime, relPath: string, source: "agent" | "user" | "ai-edit" | "terminal", label: string): Promise<string | undefined> {
  if (!shouldCheckpoint(relPath)) return undefined;
  const checkpoint = await runtime.checkpoints.create(label, [relPath], source);
  return checkpoint.id;
}

/** Alla handlers byggs över ett och samma runtime — inget lagret importeras direkt. */
export function createDispatcher(runtime: HostRuntime): Dispatcher {
  const { logger } = runtime;
  const registry = new HandlerRegistry();

  // --- Livscykel ------------------------------------------------------------
  registry.add("host.health", async (): Promise<HostHealth> => {
    const now = Date.now();
    const aiBaseUrl = runtime.aiBaseUrl;
    const ai = await settle(runtime.ai.health(), 3000, offlineProbe(aiBaseUrl, "ai-service svarade inte inom 3000 ms"));
    const vram = await settle(runtime.vram(), 3000, null);
    return {
      version: HOST_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      uptimeMs: Math.max(0, now - runtime.startedAt),
      platform: process.platform,
      workspaceRoot: runtime.workspaceRoot,
      aiService: ai,
      providers: runtime.providers.list(),
      roles: runtime.providers.roles(),
      mcp: { servers: runtime.mcp.listServers(), activeTools: runtime.mcp.activeTools() },
      agent: { mode: runtime.config.get("agentMode"), approval: runtime.approvals.getMode(), running: runtime.agent.isRunning },
      checkpoints: runtime.checkpoints.count(),
      rag: runtime.rag.status(),
      vram,
      modelReady: runtime.providers.modelReady(),
      timestamp: now,
    };
  });
  registry.add("host.info", () => ({
    version: HOST_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    startedAt: runtime.startedAt,
    pid: process.pid,
  }));
  registry.add("host.ping", (params) => ({ pong: params.echo ?? "pong", ts: Date.now() }));

  // --- Filer / editor -------------------------------------------------------
  registry.add("fs.listTree", (params) => runtime.workspace.listTree(params.root, params.depth));
  registry.add("fs.read", (params) => runtime.workspace.read(params.path, params.maxBytes));
  registry.add("fs.write", async (params) => {
    if (typeof params.path !== "string" || params.path.length === 0) throw HostError.invalidParams("fs.write kräver en path.");
    if (typeof params.content !== "string") throw HostError.invalidParams("fs.write kräver content (sträng).");
    const source = checkpointSourceFor(params.source ?? "user");
    const checkpointId = await checkpointBeforeWrite(runtime, params.path, source, params.label ?? `fs.write ${params.path}`);
    const result = await runtime.workspace.write(params.path, params.content, { source, label: params.label });
    runtime.events.emit("fs/changed", { path: result.path, change: result.created ? "add" : "change" });
    return checkpointId === undefined ? result : { ...result, checkpointId };
  });
  registry.add("fs.createNode", async (params) => {
    const result = await runtime.workspace.createNode(params.path, params.kind);
    runtime.events.emit("fs/changed", { path: result.path, change: "add" });
    return result;
  });
  registry.add("fs.rename", async (params) => {
    const result = await runtime.workspace.rename(params.from, params.to);
    runtime.events.emit("fs/changed", { path: result.path, change: "add" });
    return result;
  });
  registry.add("fs.delete", async (params) => {
    const outcome = await runtime.approvals.request({
      runId: "fs",
      kind: "delete",
      title: `Ta bort: ${params.path}`,
      paths: [params.path],
      risk: "high",
    });
    if (outcome.decision === "deny") {
      return { ok: false, approvalId: outcome.approval.id };
    }
    await runtime.workspace.remove(params.path);
    runtime.events.emit("fs/changed", { path: params.path, change: "unlink" });
    return { ok: true, approvalId: outcome.approval.id };
  });
  registry.add("fs.search", (params) => runtime.workspace.search(params.query, params.opts));
  registry.add("fs.replaceInFiles", async (params) => {
    const found = await runtime.workspace.search(params.find, { ...params.opts, maxResults: 5000 });
    const targets = [...new Set(found.hits.map((hit) => hit.path))];
    let checkpointId: string | undefined;
    if (targets.length > 0 && targets.some((p) => shouldCheckpoint(p))) {
      const source = checkpointSourceFor("ai-edit");
      const checkpoint = await runtime.checkpoints.create(`replace ${params.find}`, targets, source);
      checkpointId = checkpoint.id;
    }
    const replaced = await runtime.workspace.replaceInFiles(params.find, params.replace, params.opts);
    return { files: replaced.files, matches: replaced.matches, ...(checkpointId !== undefined ? { checkpointId } : {}) };
  });
  registry.add("fs.languageOf", (params) => ({ language: runtime.workspace.languageOf(params.path) }));
  registry.add("fs.recent", () => runtime.workspace.recent());

  // --- Terminal -------------------------------------------------------------
  registry.add("terminal.open", (params) => runtime.terminals.open(params));
  registry.add("terminal.input", (params) => {
    const ok = runtime.terminals.write(params.termId, params.data);
    return { ok };
  });
  registry.add("terminal.resize", (params) => ({ ok: runtime.terminals.resize(params.termId, params.cols, params.rows) }));
  registry.add("terminal.close", async (params) => ({ ok: await runtime.terminals.close(params.termId) }));

  // --- Provider / modeller --------------------------------------------------
  registry.add("provider.list", () => runtime.providers.list());
  registry.add("provider.upsert", (params) => {
    const config = params.config;
    if (typeof config.baseUrl !== "string" || config.baseUrl.length === 0) {
      throw HostError.invalidParams("provider.upsert kräver en baseUrl.");
    }
    const apiKey = config.apiKey;
    const wantsKey = typeof apiKey === "string" && apiKey.length > 0;
    const envName = envKeyForProvider(config);
    // R2: nyckeln skrivs ALDRIG till registret som värde — bara ConfigStore (via .env)
    // och ett env-NAMN får följa med konfiguraturen.
    const persist: ProviderConfigInput = { ...config, apiKeyEnvName: config.apiKeyEnvName ?? envName };
    if (wantsKey && typeof apiKey === "string") {
      runtime.config.setSecret(persist.apiKeyEnvName ?? envName, apiKey);
    }
    return runtime.providers.upsert({ ...persist, ...(wantsKey ? {} : { apiKey: undefined }) });
  });
  registry.add("provider.remove", (params) => ({ ok: runtime.providers.remove(params.id) }));
  registry.add("provider.test", async (params) => {
    const provider = runtime.providers.get(params.id);
    if (provider === undefined) throw HostError.invalidParams(`Okänd provider: ${params.id}`);
    return provider.probe();
  });
  registry.add("provider.setRole", (params) => {
    const assignment = runtime.providers.setRole(params.role, params.providerId, params.model, params.fallbackChain);
    const roles = runtime.config.get("roles");
    runtime.config.set({ roles: { ...roles, [params.role]: { providerId: params.providerId, model: params.model } } });
    runtime.events.emit("model/changed", { roles: runtime.providers.roles() });
    return assignment;
  });
  registry.add("provider.roles", () => runtime.providers.roles());
  registry.add("model.list", (params) => runtime.providers.models(params.scope ?? "all"));
  registry.add("model.pull", async (params) => {
    const outcome = await runtime.providers.pullModel(params.ref, (progress) => {
      runtime.events.emit("model/pull_progress", { ref: params.ref, ...progress });
    });
    return { ok: outcome.ok, message: outcome.message };
  });
  registry.add("model.vram", () => runtime.vram());

  // --- RAG ------------------------------------------------------------------
  registry.add("rag.index", (params) => runtime.rag.index({ ...(params.root !== undefined ? { root: params.root } : {}), ...(params.force !== undefined ? { force: params.force } : {}) }));
  registry.add("rag.search", (params) => runtime.rag.search(params.query, params.k));
  registry.add("rag.status", () => runtime.rag.status());

  // --- MCP ------------------------------------------------------------------
  registry.add("mcp.servers.list", () => runtime.mcp.listServers());
  registry.add("mcp.servers.upsert", async (params) => {
    const info = await runtime.mcp.upsert(params.server);
    runtime.events.emit("mcp/changed", { servers: runtime.mcp.listServers(), activeTools: runtime.mcp.activeTools() });
    return info;
  });
  registry.add("mcp.servers.remove", async (params) => {
    const result = await runtime.mcp.remove(params.id);
    runtime.events.emit("mcp/changed", { servers: runtime.mcp.listServers(), activeTools: runtime.mcp.activeTools() });
    if (result.error !== undefined && !result.ok) throw new HostError(ErrorCode.BadRequest, result.error);
    return { ok: result.ok };
  });
  registry.add("mcp.servers.start", async (params) => {
    const info = await runtime.mcp.start(params.id);
    runtime.events.emit("mcp/changed", { servers: runtime.mcp.listServers(), activeTools: runtime.mcp.activeTools() });
    return info;
  });
  registry.add("mcp.servers.stop", async (params) => ({ ok: await runtime.mcp.stop(params.id) }));
  registry.add("mcp.servers.reload", async () => {
    const result = await runtime.mcp.reload();
    runtime.events.emit("mcp/changed", { servers: result.servers, activeTools: result.activeTools });
    return result;
  });
  registry.add("mcp.tools.list", () => runtime.mcp.listTools());
  registry.add("mcp.tools.call", (params) => runtime.mcp.callTool(params.name, params.args));

  // --- Chat / agent ---------------------------------------------------------
  registry.add("chat.sessions", () => runtime.chat.list());
  registry.add("chat.newSession", (params) => runtime.chat.newSession(params.title, params.mode));
  registry.add("chat.history", (params) => runtime.chat.history(params.sessionId));
  registry.add("chat.send", (params) => runtime.chat.send(params));
  registry.add("chat.cancel", (params) => ({ ok: runtime.chat.cancel(params.sessionId) }));
  registry.add("agent.run", (params) => runtime.agent.run(params));
  registry.add("agent.interrupt", (params) => ({ ok: runtime.agent.interrupt(params.runId) }));
  registry.add("agent.approve", (params) => ({ ok: runtime.approvals.resolve(params.requestId, params.decision) }));
  registry.add("agent.pending", () => runtime.approvals.pending());
  registry.add("agent.lastRun", (params) => runtime.agent.lastRun(params.runId));
  registry.add("review.code", async (params) => {
    const started = Date.now();
    const scope = params.scope ?? params.path ?? "workspace";
    const target = params.path !== undefined ? await runtime.workspace.read(params.path) : undefined;
    const body = target !== undefined ? target.content.slice(0, 40_000) : "(ingen specifik fil — generellt review)";
    const result = await runtime.gateway.ask({
      role: "chat",
      messages: [
        { role: "system", content: "Du är kodgranskare. Återge HODT EN JSON-array av fynd: [{severity,file,line,title,detail,suggestion}]. severity är blocker|major|minor|nit." },
        { role: "user", content: `Granska ${scope}:\n${body}` },
      ],
    });
    const findings = parseFindings(result.text, params.path ?? scope);
    return { scope, findings, summary: result.text.slice(0, 4000), model: result.model, tookMs: Date.now() - started };
  });
  registry.add("tests.generate", async (params) => {
    if (!shouldCheckpoint(params.path)) throw HostError.badRequest(`Kan inte generera test för en genererad väg: ${params.path}`);
    const source = await runtime.workspace.read(params.path);
    const result = await runtime.gateway.ask({
      role: "chat",
      messages: [
        { role: "system", content: "Du skriver kördugliga tester. Returnera ENDAST filinnehållet i ett kodstaket." },
        { role: "user", content: `Skriv tester för ${source.path}:\n${source.content.slice(0, 40_000)}` },
      ],
    });
    const code = extractFencedCode(result.text);
    if (code === null) throw new HostError(ErrorCode.Internal, "Modellen returnerade ingen testfil i kodstaket.");
    const testPath = testPathFor(source.path);
    const checkpointId = await checkpointBeforeWrite(runtime, testPath, "agent", `test ${testPath}`);
    const written = await runtime.workspace.write(testPath, code, { source: "agent", label: "tests.generate" });
    return { files: [checkpointId === undefined ? written : { ...written, checkpointId }], summary: `Genererade ${testPath}.` };
  });
  registry.add("refactor.apply", async (params) => {
    const source = await runtime.workspace.read(params.path);
    const result = await runtime.gateway.ask({
      role: "agent",
      messages: [
        { role: "system", content: "Du refactorar kod och returnera SEARCH/REPLACE-block (<<<<<<< SEARCH / ======= / >>>>>>> REPLACE)." },
        { role: "user", content: `Refaktorera enligt: ${params.instruction}\n\nFil:\n${source.content.slice(0, 40_000)}` },
      ],
    });
    const patches = parseSearchReplaceBlocks(result.text);
    if (patches.length === 0) {
      return { diffs: [], applied: false };
    }
    const applied = applyPatches(source.content, patches);
    if (!applied.ok) {
      return { diffs: [], applied: false };
    }
    const checkpointId = await checkpointBeforeWrite(runtime, source.path, "agent", `refactor ${source.path}`);
    await runtime.workspace.write(source.path, applied.after, { source: "agent", label: checkpointId });
    const diff = unifiedDiff(source.path, source.content, applied.after);
    runtime.events.emit("agent/diff", { runId: "refactor", diffs: [diff] });
    return { diffs: [diff], applied: true };
  });

  // --- Autocomplete / inline edit ------------------------------------------
  registry.add("completion.fim", async (req: CompletionRequest) => {
    if (runtime.config.get("autocompleteEnabled") === false) {
      return { text: "", model: "", providerId: "", latencyMs: 0, source: "none", cached: false, skipped: "disabled" };
    }
    const result = await runtime.gateway.complete(req);
    // Viktigt: Ollama hedrar INTE `stop` i raw-läge (uppmätt) — beskär ALLTID på
    // clientsidan vid stopp-sekvenser, annars klistrar ghost-texten in hela funktioner.
    const { stops } = buildFimBody(req);
    const trimmed = trimFimCompletion(result.text, stops);
    return { ...result, text: trimmed };
  });
  registry.add("completion.configure", (params) => {
    const current = runtime.config.config.settings;
    const enabled = params.enabled ?? current.autocompleteEnabled;
    const debounceMs = params.debounceMs ?? current.autocompleteDebounceMs;
    const next = runtime.config.set({ autocompleteEnabled: enabled, autocompleteDebounceMs: debounceMs });
    runtime.events.emit("settings/changed", next);
    return { enabled: next.autocompleteEnabled, debounceMs: next.autocompleteDebounceMs };
  });
  registry.add("edit.inline", async (params) => {
    const started = Date.now();
    const source = await runtime.workspace.read(params.path);
    const selectionText = sliceRange(source.content, params.selection);
    const result = await runtime.gateway.ask({
      role: "agent",
      messages: [
        { role: "system", content: "Returnera SEARCH/REPLACE-block (<<<<<<< SEARCH / ======= / >>>>>>> REPLACE) för EXAKT den markerade regionen." },
        { role: "user", content: `Instruktion: ${params.instruction}\n\nFil (${source.path}):\n${source.content.slice(0, 40_000)}\n\nMarkerat:\n${selectionText}` },
      ],
    });
    const patches = parseSearchReplaceBlocks(result.text);
    const diffs: FileDiff[] = [];
    if (patches.length > 0) {
      const applied = applyPatches(source.content, patches);
      if (applied.ok) diffs.push(unifiedDiff(source.path, source.content, applied.after));
    }
    return { diffs, patches, model: result.model, latencyMs: result.latencyMs > 0 ? result.latencyMs : Date.now() - started };
  });
  registry.add("edit.apply", async (params) => {
    if (params.patches.length === 0) throw HostError.invalidParams("edit.apply behöver åtminstone en patch.");
    const source = await runtime.workspace.read(params.path);
    const applied = applyPatches(source.content, params.patches);
    if (!applied.ok) {
      throw HostError.invalidParams(`PATCH_MISS: ingen match för ${applied.failures.join(" | ")}`, { failures: applied.failures });
    }
    const checkpointId = await checkpointBeforeWrite(runtime, source.path, "ai-edit", `edit.apply ${source.path}`);
    const written = await runtime.workspace.write(source.path, applied.after, { source: "ai-edit", label: "edit.apply" });
    runtime.events.emit("fs/changed", { path: written.path, change: "change" });
    return checkpointId === undefined ? written : { ...written, checkpointId };
  });

  // --- Checkpoints ----------------------------------------------------------
  registry.add("checkpoint.list", (params) => runtime.checkpoints.list(params.limit));
  registry.add("checkpoint.create", async (params) => {
    const files = await runtime.checkpoints.currentFiles();
    return runtime.checkpoints.create(params.label, files, checkpointSourceFor(params.source ?? "user"));
  });
  registry.add("checkpoint.rollback", async (params) => {
    try {
      return await runtime.checkpoints.rollback(params.id);
    } catch (err) {
      if (err instanceof Error && err.message.toLowerCase().includes("checkpoint")) throw HostError.checkpointMissing(params.id);
      throw err;
    }
  });
  registry.add("checkpoint.diff", async (params) => {
    try {
      return await runtime.checkpoints.diff(params.id);
    } catch (err) {
      if (err instanceof Error && err.message.toLowerCase().includes("checkpoint")) throw HostError.checkpointMissing(params.id);
      throw err;
    }
  });

  // --- Röst (P1) / Vision (P1) — kodade offlinefel, aldrig kast eller hang ----
  registry.add("voice.status", () => {
    throw new HostError(ErrorCode.AiServiceOffline, "Röst (voice) är en P1-funktion — python-ai-service är inte igång. Aktivera ai-service för att använda röst.", { phase: "P1" });
  });
  registry.add("voice.transcribe", () => {
    throw new HostError(ErrorCode.AiServiceOffline, "Röst (voice.transcribe) är en P1-funktion — ai-service offline.", { phase: "P1" });
  });
  registry.add("voice.speak", () => {
    throw new HostError(ErrorCode.AiServiceOffline, "Röst (voice.speak) är en P1-funktion — ai-service offline.", { phase: "P1" });
  });
  registry.add("voice.startRecord", () => {
    throw new HostError(ErrorCode.AiServiceOffline, "Röstinspelning (voice.startRecord) är en P1-funktion — ai-service offline.", { phase: "P1" });
  });
  registry.add("voice.stopRecord", () => {
    throw new HostError(ErrorCode.AiServiceOffline, "Röstinspelning (voice.stopRecord) är en P1-funktion — ai-service offline.", { phase: "P1" });
  });
  registry.add("vision.capture", () => {
    throw new HostError(ErrorCode.NoModelAvailable, "Vision (vision.capture) är en P1-funktion — ingen VLM/skärmtjänst är konfigurerad.", { phase: "P1" });
  });
  registry.add("vision.analyze", () => {
    throw new HostError(ErrorCode.NoModelAvailable, "Vision (vision.analyze) är en P1-funktion — ingen VLM är tilldelad rollen vision.", { phase: "P1" });
  });
  registry.add("vision.ocr", () => {
    throw new HostError(ErrorCode.NoModelAvailable, "Vision (vision.ocr) är en P1-funktion — OCR-tjänsten (ai-service) är offline.", { phase: "P1" });
  });

  // --- Inställningar, palett, minne, logg ----------------------------------
  registry.add("settings.get", () => runtime.config.config.settings);
  registry.add("settings.set", (params) => {
    const next = runtime.config.set(params.patch);
    if (params.patch.approvalMode !== undefined) {
      runtime.approvals.setMode(params.patch.approvalMode);
    }
    if (params.patch.allowlist !== undefined) {
      runtime.approvals.setAllowlist(params.patch.allowlist);
    }
    runtime.events.emit("settings/changed", next);
    return next;
  });
  registry.add("settings.secrets", () => runtime.config.allSecretInfo());
  registry.add("settings.setSecret", (params) => {
    runtime.config.setSecret(params.name, params.value);
    return { ok: true, name: params.name };
  });
  registry.add("palette.commands", () => defaultCommands());
  registry.add("memory.log", (params) => runtime.memory.append(params.kind ?? "note", params.text));
  registry.add("memory.recent", (params) => runtime.memory.recent(params.limit));
  registry.add("log.tail", (params) => ({ path: logger.path, lines: logger.tail(params.lines) }));

  // --- Router ---------------------------------------------------------------
  const handlerFor = (method: MethodName) => registry.get(method);

  async function dispatch(request: DispatchInput): Promise<RpcResponse> {
    const id: RpcId = typeof request === "object" && request !== null && "id" in request ? (request.id as RpcId) : (Math.random().toString(36).slice(2) as RpcId);
    if (!isRpcRequest(request)) {
      return makeError(id, ErrorCode.BadRequest, "Förfrågan är ingen giltig JSON-RPC 2.0-request.");
    }
    const method = request.method;
    if (!isMethodName(method)) {
      logger.warn(`okänd metod via dispatch`, { method });
      return makeError(id, ErrorCode.MethodNotFound, `Metoden finns inte i protocol: ${method}`);
    }
    const handler = handlerFor(method);
    if (handler === undefined) {
      return makeError(id, ErrorCode.MethodNotFound, `Metoden har ingen handler i host: ${method}`);
    }
    try {
      const raw = await withTimeout(Promise.resolve(handler(request.params)), timeoutFor(method), () =>
        new HostError(ErrorCode.Internal, `${method} svarade inte inom ${String(timeoutFor(method))} ms och avbröts.`),
      );
      const hardened = hardenValue(raw, method);
      return makeResult(id, hardened);
    } catch (err) {
      const payload = toRpcError(err, method);
      logger.error(`dispatch-fel: ${method}`, { code: payload.code, message: payload.message });
      return makeError(id, payload.code as (typeof ErrorCode)[keyof typeof ErrorCode], payload.message, payload.data);
    }
  }

  async function invoke<M extends MethodName>(method: M, params: RpcRequest<M>["params"], id?: RpcId): Promise<RpcResponse> {
    return dispatch({ jsonrpc: "2.0", id: id ?? method, method, params });
  }

  return { registry, dispatch, invoke, names: registry.names() };
}

// ---------------------------------------------------------------------------
// Små hjälpfunktioner som bara dispatch behöver (rena, testbara, kastar aldrig)
// ---------------------------------------------------------------------------

/** Klipp ut ett rad/kolumn-intervall ur filinnehåll (för edit.inline-prompten). */
function sliceRange(content: string, range: { startLine: number; startColumn: number; endLine: number; endColumn: number }): string {
  const lines = content.split(/\r?\n/);
  const from = Math.max(0, range.startLine - 1);
  const to = Math.min(lines.length - 1, range.endLine - 1);
  if (to < from) return "";
  if (from === to) {
    const line = lines[from] ?? "";
    return line.slice(Math.max(0, range.startColumn - 1), Math.max(range.startColumn, range.endColumn));
  }
  const head = (lines[from] ?? "").slice(Math.max(0, range.startColumn - 1));
  const body = lines.slice(from + 1, to);
  const tail = (lines[to] ?? "").slice(0, Math.max(0, range.endColumn));
  return [head, ...body, tail].join("\n");
}

/** Parsa recensionsfynd ur modelltext (JSON-array, annars ett snällt single-fynd). */
function parseFindings(text: string, file: string): import("@nexus/protocol").ReviewFinding[] {
  const direct = /(\[[\s\S]*\])/m.exec(text);
  if (direct !== null && direct[1] !== undefined) {
    try {
      const parsed = JSON.parse(direct[1]) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((raw) => normalizeFinding(raw, file)).filter((f): f is import("@nexus/protocol").ReviewFinding => f !== null);
      }
    } catch {
      /* falla vidare till trivialt fallback-fynd */
    }
  }
  return [{ severity: "minor", file, title: "Modellens review", detail: text.slice(0, 2000) }];
}

function normalizeFinding(raw: unknown, fallbackFile: string): import("@nexus/protocol").ReviewFinding | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const severity = rec.severity;
  const allowed = ["blocker", "major", "minor", "nit"];
  const sev = allowed.includes(String(severity)) ? (String(severity) as import("@nexus/protocol").ReviewFinding["severity"]) : "minor";
  const title = typeof rec.title === "string" ? rec.title : "Fynd";
  const detail = typeof rec.detail === "string" ? rec.detail : title;
  const file = typeof rec.file === "string" ? rec.file : fallbackFile;
  const line = typeof rec.line === "number" ? rec.line : undefined;
  const suggestion = typeof rec.suggestion === "string" ? rec.suggestion : undefined;
  return { severity: sev, file, title, detail, ...(line !== undefined ? { line } : {}), ...(suggestion !== undefined ? { suggestion } : {}) };
}

/** Testfil-sökväg: xxx.test.ts / *.test.tsx / beside-speccing för övriga språk. */
function testPathFor(sourcePath: string): string {
  const dot = sourcePath.lastIndexOf(".");
  const base = dot > 0 ? sourcePath.slice(0, dot) : sourcePath;
  return `${base}.test.ts`;
}

/** Exponerar registrets kompletthetskontroll för tester. */
export function registryCompleteness(dispatcher: Dispatcher): { missing: MethodName[]; extra: MethodName[] } {
  return dispatcher.registry.diff(ALL_METHOD_NAMES);
}

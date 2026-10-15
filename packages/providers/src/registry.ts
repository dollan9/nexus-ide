/**
 * ProviderRegistry — FAS 3.1 + 3.2: många modeller samtidigt, en per uppgift.
 *
 * Grundidén: registret har ALDRIG bara en aktiv modell. chat, agent, autocomplete,
 * embeddings, vision och reasoning kan peka på sex olika leverantörer samtidigt, och
 * varje roll har en fallback-kedja. Om en modell är 429-begränsad eller offline går
 * anropet vidare till nästa länk och *varför* loggas — det är beviset UI:t visar.
 *
 * Registret känner inte till några hemligheter: det frågar bara en leverantör om
 * `hasKey` (BOOLEAN), aldrig efter värdet (R2).
 */

import {
  ALL_MODEL_ROLES,
  type CompletionRequest,
  type CompletionResult,
  type ModelEntry,
  type ModelRole,
  type ModelSource,
  type ProviderConfigInput,
  type ProviderInfo,
  type ProviderKind,
  type RoleAssignment,
} from "@nexus/protocol";
import {
  ProviderError,
  toProviderError,
  type FallbackAttempt,
} from "./errors";
import type {
  CatalogModel,
  ChatRequest,
  ChatResult,
  EmbeddingsRequest,
  EmbeddingsResult,
  ModelPullOutcome,
  PullProgressCallback,
  FetchLike,
  RandomFn,
  TimerFn,
  VisionAnswer,
  VisionRequest,
} from "./internal-types";
import type { NexusLogSink } from "./logging";
import { NullLogger } from "./logging";
import { AnthropicProvider } from "./adapters/anthropic";
import { GoogleProvider } from "./adapters/google";
import { OpenAiCompatibleProvider } from "./adapters/openai-compatible";
import { OllamaProvider } from "./adapters/ollama";
import type { Provider, ProviderContext, SecretReader } from "./provider";
import { classifySource } from "./source";

// ---------------------------------------------------------------------------
// Standardvärden per leverantörstyp
// ---------------------------------------------------------------------------

interface KindDefaults {
  readonly baseUrl: string;
  readonly keyEnvNames: string[];
  readonly model?: string;
}

const KIND_DEFAULTS: Record<ProviderKind, KindDefaults> = {
  nvidia: {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEnvNames: ["NVIDIA_API_KEY"],
    model: "moonshotai/kimi-k2-instruct",
  },
  openai: { baseUrl: "https://api.openai.com/v1", keyEnvNames: ["OPENAI_API_KEY"] },
  anthropic: { baseUrl: "https://api.anthropic.com", keyEnvNames: ["ANTHROPIC_API_KEY"] },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyEnvNames: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyEnvNames: ["OPENROUTER_API_KEY"] },
  groq: { baseUrl: "https://api.groq.com/openai/v1", keyEnvNames: ["GROQ_API_KEY"] },
  mistral: { baseUrl: "https://api.mistral.ai/v1", keyEnvNames: ["MISTRAL_API_KEY"] },
  ollama: { baseUrl: "http://127.0.0.1:11434", keyEnvNames: [] },
  vllm: { baseUrl: "http://127.0.0.1:8000/v1", keyEnvNames: [] },
  lmstudio: { baseUrl: "http://127.0.0.1:1234/v1", keyEnvNames: [] },
  llamacpp: { baseUrl: "http://127.0.0.1:8080/v1", keyEnvNames: [] },
  custom: { baseUrl: "http://127.0.0.1:8000/v1", keyEnvNames: ["CUSTOM_API_KEY"] },
};

/** Inbyggda leverantörer som UI:n startar med (FAS 3.2 — inga hårdkodade nycklar). */
export function builtinProviderConfigs(): ProviderConfigInput[] {
  return [
    {
      id: "nvidia",
      label: "NVIDIA NIM",
      kind: "nvidia",
      baseUrl: KIND_DEFAULTS.nvidia.baseUrl,
      apiKeyEnvName: "NVIDIA_API_KEY",
      model: KIND_DEFAULTS.nvidia.model,
      enabled: true,
    },
    {
      id: "ollama",
      label: "Ollama (lokalt)",
      kind: "ollama",
      baseUrl: KIND_DEFAULTS.ollama.baseUrl,
      enabled: true,
    },
    {
      id: "openai",
      label: "OpenAI",
      kind: "openai",
      baseUrl: KIND_DEFAULTS.openai.baseUrl,
      apiKeyEnvName: "OPENAI_API_KEY",
      enabled: false,
    },
    {
      id: "anthropic",
      label: "Anthropic",
      kind: "anthropic",
      baseUrl: KIND_DEFAULTS.anthropic.baseUrl,
      apiKeyEnvName: "ANTHROPIC_API_KEY",
      enabled: false,
    },
    {
      id: "google",
      label: "Google Gemini",
      kind: "google",
      baseUrl: KIND_DEFAULTS.google.baseUrl,
      apiKeyEnvName: "GOOGLE_API_KEY",
      enabled: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// Typer registret returnerar
// ---------------------------------------------------------------------------

/** "Vilken modell svarar den här gången?" — hela kedjan med sandhet om källan. */
export interface ResolvedModel {
  readonly role: ModelRole;
  readonly providerId: string;
  readonly model: string;
  readonly chain: string[];
  readonly source: ModelSource;
  readonly isLocal: boolean;
  readonly hasKey: boolean;
}

export interface RoleCallReport {
  readonly role: ModelRole;
  readonly attempts: FallbackAttempt[];
  readonly ok: boolean;
  readonly providerId: string;
  readonly model: string;
  readonly source: ModelSource;
  readonly tookMs: number;
  readonly degraded?: string;
}

export type ModelScope = "all" | "local" | "cloud";

export interface RegistryOptions {
  readonly context?: Partial<ProviderContext>;
  readonly logSink?: NexusLogSink;
  readonly secrets?: SecretReader;
  readonly fetchImpl?: FetchLike;
  readonly timer?: TimerFn;
  readonly random?: RandomFn;
  readonly timeoutMs?: number;
  /**
   * Sista utvägen i R5-kedjan (moln → lokal → stub → fel). host matar den med en
   * StubProvider så UI:t alltid får ett ärligt "stub"-svare istället för en krasch.
   */
  readonly lastResort?: Provider;
  readonly onRoleChanged?: (roles: RoleAssignment[]) => void;
  readonly onReport?: (report: RoleCallReport) => void;
}

interface Entry {
  readonly provider: Provider;
  config: ProviderConfigInput;
  models: ModelEntry[];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ProviderRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly order: string[] = [];
  private readonly roleMap = new Map<ModelRole, RoleAssignment>();
  private readonly reports = new Map<ModelRole, RoleCallReport>();
  private readonly lastResort?: Provider;
  private readonly context: Partial<ProviderContext>;
  private readonly onRoleChanged?: (roles: RoleAssignment[]) => void;
  private readonly onReport?: (report: RoleCallReport) => void;
  private readonly logSink: NexusLogSink;

  constructor(options: RegistryOptions = {}) {
    this.context = {
      ...(options.context ?? {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.timer !== undefined ? { timer: options.timer } : {}),
      ...(options.random !== undefined ? { random: options.random } : {}),
      ...(options.secrets !== undefined ? { secrets: options.secrets } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      logSink: options.logSink ?? new NullLogger(),
    };
    this.logSink = options.logSink ?? new NullLogger();
    this.lastResort = options.lastResort;
    this.onRoleChanged = options.onRoleChanged;
    this.onReport = options.onReport;
  }

  // --- Livscykel ----------------------------------------------------------

  /** Direkt registroring av en färdig adapter (test-dockor, specialadapter). */
  register(provider: Provider, config?: ProviderConfigInput): ProviderInfo {
    const entry: Entry = {
      provider,
      config: config ?? { label: provider.label, kind: provider.kind, baseUrl: provider.baseUrl, enabled: provider.enabled },
      models: seedEntries(provider),
    };
    this.entries.set(provider.id, entry);
    if (!this.order.includes(provider.id)) this.order.push(provider.id);
    this.log("info", `provider registrerad: ${provider.id} (${provider.kind}, source=${provider.source})`);
    return this.infoOf(entry);
  }

  /**
   * Skapa/uppdatera en leverantör från UI-dIALOG (FAS 3.2 f) och returnera
   * ProviderInfo. `apiKey` konsumereras för att bygga adapter — den returneras
   * aldrig och loggas aldrig (R2).
   */
  upsert(config: ProviderConfigInput): ProviderInfo {
    const id = (config.id ?? slug(config.label) ?? config.kind).trim();
    const kind = config.kind;
    const baseUrl = config.baseUrl.length > 0 ? config.baseUrl : KIND_DEFAULTS[kind].baseUrl;
    const envNames = KIND_DEFAULTS[kind].keyEnvNames;
    const apiKeyEnvName = config.apiKeyEnvName ?? envNames[0];
    const merged: ProviderConfigInput = {
      ...config,
      id,
      kind,
      baseUrl,
      apiKeyEnvName,
      enabled: config.enabled ?? true,
      models: config.models ?? (config.model !== undefined ? [config.model] : defaultModelsFor(kind)),
    };
    const existing = this.entries.get(id);
    const provider = buildProvider(merged, this.context, apiKeyEnvName);
    if (existing !== undefined) {
      // Behåll modellcachen från den gamla om den nya ännu inte listat.
      const cached = existing.models;
      this.entries.set(id, { provider, config: merged, models: cached.length > 0 && provider.toInfo().models.length === 0 ? cached : seedEntries(provider) });
      this.log("info", `provider uppdaterad: ${id}`);
    } else {
      this.entries.set(id, { provider, config: merged, models: seedEntries(provider) });
      this.order.push(id);
      this.log("info", `provider tillagd: ${id} (${kind})`);
    }
    // En roll som pekade på en borttagen/ändrad provider valideras om.
    this.pruneRoles();
    return this.infoOf(this.mustGet(id));
  }

  remove(id: string): boolean {
    const existed = this.entries.delete(id);
    const at = this.order.indexOf(id);
    if (at >= 0) this.order.splice(at, 1);
    if (existed) {
      for (const [role, assignment] of [...this.roleMap.entries()]) {
        if (assignment.providerId === id) this.roleMap.delete(role);
      }
      this.emitRoles();
      this.log("info", `provider borttagen: ${id}`);
    }
    return existed;
  }

  get(id: string): Provider | undefined {
    return this.entries.get(id)?.provider;
  }

  list(): ProviderInfo[] {
    return this.order.map((id) => this.infoOf(this.mustGet(id)));
  }

  /**
   * `model.pull` (FAS 3.2 h): ref på formen `providerId/modell` (modellnamn får ha
   * slash) och progress i exakt `model/pull_progress`-formen. Leverantörer utan pull
   * (moln) svarar med ett ärligt meddelande i stället för att kasta.
   */
  async pullModel(ref: string, onProgress?: PullProgressCallback): Promise<ModelPullOutcome> {
    const parsed = this.splitRef(ref, "");
    const provider = parsed.providerId.length > 0 ? this.entries.get(parsed.providerId)?.provider : undefined;
    if (provider === undefined) {
      const message = `okänd leverantör i ref ${ref} — välj en installerad lokal provider`;
      this.log("warn", message, { ref });
      return { ref, ok: false, message };
    }
    if (provider.pull === undefined) {
      const message = `${provider.label} har ingen hämtning (molnmodell — kör den direkt eller hämta en lokal modell)`;
      this.log("info", message, { ref, providerId: provider.id });
      return { ref, ok: false, message };
    }
    return provider.pull(parsed.model, onProgress);
  }

  /** Aggregerad modellkatalog (FAS 3.2 h — NVIDIA-valsbar katalog + lokala). */
  models(scope: ModelScope = "all"): ModelEntry[] {
    const out: ModelEntry[] = [];
    for (const id of this.order) {
      const entry = this.entries.get(id);
      if (entry === undefined) continue;
      for (const model of entry.models) {
        const sourced = model.source === "stub" ? "stub" : classifySource(entry.provider.baseUrl) === "local" ? "local" : model.source;
        if (scope === "local" && sourced !== "local") continue;
        if (scope === "cloud" && sourced === "local") continue;
        out.push({
          ...model,
          source: sourced,
          roles: ALL_MODEL_ROLES.filter((role) => {
            const assignment = this.roleMap.get(role);
            return assignment !== undefined && assignment.providerId === id && assignment.model === model.id;
          }),
        });
      }
    }
    return out;
  }

  /** Hämtar modellister från alla (eller en) leverantör; degraderar tyst vid offline. */
  async refreshModels(id?: string): Promise<ModelEntry[]> {
    const targets = id !== undefined ? [this.mustGet(id)] : this.order.map((key) => this.mustGet(key));
    for (const entry of targets) {
      try {
        entry.models = await entry.provider.listModels();
        this.log("debug", `modeller hämtade för ${entry.provider.id}: ${entry.models.length}`);
      } catch (err) {
        const failure = toProviderError(err, { message: `modellistan for ${entry.provider.id} kunde inte hämtas`, providerId: entry.provider.id });
        this.log("warn", `${failure.message} — behåller känd cache`, {
          providerId: entry.provider.id,
          errorClass: failure.errorClass,
          code: failure.code,
        });
      }
    }
    return this.models("all");
  }

  async catalog(): Promise<CatalogModel[]> {
    const out: CatalogModel[] = [];
    const seen = new Set<string>();
    for (const id of this.order) {
      const provider = this.entries.get(id)?.provider;
      if (provider === undefined || !provider.enabled) continue;
      try {
        const list = await (provider.catalog?.() ?? Promise.resolve([] as CatalogModel[]));
        for (const model of list) {
          const ref = `${id}/${model.id}`;
          if (seen.has(ref)) continue;
          seen.add(ref);
          out.push(model);
        }
      } catch (err) {
        const failure = toProviderError(err, { message: `katalog för ${id} kunde inte hämtas`, providerId: id });
        this.log("warn", failure.message, { providerId: id, errorClass: failure.errorClass });
      }
    }
    return out;
  }

  // --- Roller -------------------------------------------------------------

  setRole(role: ModelRole, providerId: string, model: string, fallbackChain?: string[]): RoleAssignment {
    const provider = this.entries.get(providerId)?.provider;
    const source: ModelSource = provider?.source ?? "none";
    const chain = normalizeChain(fallbackChain ?? [], providerId, model);
    const assignment: RoleAssignment = { role, providerId, model, fallbackChain: chain, source };
    this.roleMap.set(role, assignment);
    const entry = this.entries.get(providerId);
    if (entry !== undefined && !entry.models.some((m) => m.id === model)) {
      // Rollen pekar på en modell listan än så länge inte innehåller: foga den, så
      // model.list och UI-detaljerna aldrig visar en roll utan sin modell.
      entry.models = [...entry.models, entry.provider.entryFor(model)];
    }
    this.emitRoles();
    this.log("info", `roll ${role} → ${providerId}/${model} (kedja ${chain.length})`, { role, providerId, model, source });
    return assignment;
  }

  roles(): RoleAssignment[] {
    return ALL_MODEL_ROLES.map((role) => this.roleMap.get(role)).filter((role): role is RoleAssignment => role !== undefined);
  }

  byRole(role: ModelRole): Provider | null {
    const assignment = this.roleMap.get(role);
    if (assignment === undefined) return null;
    const provider = this.entries.get(assignment.providerId)?.provider;
    if (provider === undefined || !provider.enabled) return null;
    return provider;
  }

  /**
   * "Vilken modell svarar?" — den enda sanna upplösningen för en roll.
   * Returnerar null om ingen kandidat finns; anropet blir då NoModelAvailable.
   */
  resolve(role: ModelRole): ResolvedModel | null {
    const candidates = this.candidatesFor(role);
    const first = candidates[0];
    if (first === undefined) return null;
    return {
      role,
      providerId: first.provider.id,
      model: first.model,
      chain: candidates.map((c) => `${c.provider.id}/${c.model}`),
      source: first.provider.source,
      isLocal: first.provider.isLocal,
      hasKey: first.provider.hasKey,
    };
  }

  /** Alla kandidater i fallande ordning, redan filtrerade på enabled + nyckel. */
  candidatesFor(role: ModelRole): { provider: Provider; model: string }[] {
    const assignment = this.roleMap.get(role);
    if (assignment === undefined) return [];
    const out: { provider: Provider; model: string }[] = [];
    const push = (providerId: string, model: string): void => {
      const provider = this.entries.get(providerId)?.provider;
      if (provider === undefined || !provider.enabled) return;
      if (out.some((c) => c.provider.id === providerId && c.model === model)) return;
      out.push({ provider, model });
    };
    push(assignment.providerId, assignment.model);
    for (const ref of assignment.fallbackChain) {
      const parsed = this.splitRef(ref, assignment.providerId);
      push(parsed.providerId, parsed.model);
    }
    return out;
  }

  /** Värd till HostHealth.modelReady — roll har en användbar modell just nu. */
  modelReady(): Record<ModelRole, boolean> {
    const out = {} as Record<ModelRole, boolean>;
    for (const role of ALL_MODEL_ROLES) out[role] = this.resolve(role) !== null;
    return out;
  }

  lastReport(role: ModelRole): RoleCallReport | undefined {
    return this.reports.get(role);
  }

  allReports(): RoleCallReport[] {
    return [...this.reports.values()];
  }

  // --- Anrop med fallback-kedja -------------------------------------------

  callForRole(role: "chat" | "agent" | "reasoning", req: ChatRequest): Promise<ChatResult>;
  callForRole(role: "autocomplete", req: CompletionRequest): Promise<CompletionResult>;
  callForRole(role: "embeddings", req: string[] | EmbeddingsRequest): Promise<EmbeddingsResult>;
  callForRole(role: "vision", req: VisionRequest): Promise<VisionAnswer>;
  async callForRole(
    role: ModelRole,
    req: ChatRequest | CompletionRequest | string[] | EmbeddingsRequest | VisionRequest,
  ): Promise<ChatResult | CompletionResult | EmbeddingsResult | VisionAnswer> {
    const candidates = this.candidatesFor(role);
    if (candidates.length === 0) throw this.noModelError(role);

    const attempts: FallbackAttempt[] = [];
    const startedAll = Date.now();
    let lastError: ProviderError | undefined;

    for (const candidate of candidates) {
      const attemptStart = Date.now();
      try {
        const value = await this.invoke(role, candidate.provider, candidate.model, req);
        const attempt: FallbackAttempt = {
          providerId: candidate.provider.id,
          model: candidate.model,
          ok: true,
          tookMs: Date.now() - attemptStart,
          attempts: attempts.length + 1,
          source: candidate.provider.source,
          reason: attempts.length === 0 ? "första valet svarade" : "föll på en senare länk i kedjan",
        };
        attempts.push(attempt);
        this.publishReport(role, attempts, true, candidate.provider.id, candidate.model, candidate.provider.source, Date.now() - startedAll, attempts.length > 1 ? "fallback" : undefined);
        return value;
      } catch (err) {
        const failure = toProviderError(err, {
          message: `${role} mot ${candidate.provider.id}/${candidate.model} misslyckades`,
          source: candidate.provider.source,
          providerId: candidate.provider.id,
          model: candidate.model,
        });
        lastError = failure;
        const reason =
          failure.errorClass === "rate_limited"
            ? `429 rate limited (HTTP ${failure.httpStatus ?? "?"}) — byter till nästa modell i kedjan`
            : failure.errorClass === "timeout"
              ? `timeout — byter till nästa modell i kedjan`
              : `${failure.errorClass} — byter till nästa modell i kedjan`;
        attempts.push({
          providerId: candidate.provider.id,
          model: candidate.model,
          ok: false,
          tookMs: Date.now() - attemptStart,
          attempts: attempts.length,
          httpStatus: failure.httpStatus,
          code: failure.code,
          errorClass: failure.errorClass,
          message: failure.message,
          reason,
          source: candidate.provider.source,
        });
        this.log("warn", `${role}: ${reason}`, {
          role,
          providerId: candidate.provider.id,
          model: candidate.model,
          errorClass: failure.errorClass,
          code: failure.code,
          httpStatus: failure.httpStatus,
        });
      }
    }

    // R5: sista utvägen är en ärlig stub (om host konfigurerat en), aldrig en krasch.
    if (this.lastResort !== undefined && this.lastResort.enabled) {
      const attemptStart = Date.now();
      try {
        const value = await this.invoke(role, this.lastResort, this.lastResort.preferredModel ?? "stub", req);
        const model = this.lastResort.preferredModel ?? "stub";
        attempts.push({
          providerId: this.lastResort.id,
          model,
          ok: true,
          tookMs: Date.now() - attemptStart,
          attempts: attempts.length + 1,
          source: this.lastResort.source,
          reason: "ingen riktig modell nås — svar från test-docka (stub)",
        });
        this.publishReport(role, attempts, true, this.lastResort.id, model, "stub", Date.now() - startedAll, "stub");
        return value;
      } catch (err) {
        const failure = toProviderError(err, { message: "reserve-dockan svarade inte", providerId: this.lastResort.id });
        attempts.push({
          providerId: this.lastResort.id,
          model: this.lastResort.preferredModel ?? "stub",
          ok: false,
          tookMs: Date.now() - attemptStart,
          attempts: attempts.length,
          errorClass: failure.errorClass,
          code: failure.code,
          message: failure.message,
          reason: "reserve-dockan kunde heller inte svara",
          source: this.lastResort.source,
        });
        lastError = failure;
      }
    }

    this.publishReport(
      role,
      attempts,
      false,
      attempts[0]?.providerId ?? "none",
      attempts[0]?.model ?? "none",
      "none",
      Date.now() - startedAll,
    );
    throw new ProviderError({
      message:
        lastError === undefined
          ? `Ingen modell kunde svara för rollen ${role}`
          : `Ingen modell kunde svara för rollen ${role}: ${lastError.message}`,
      errorClass: "no_model",
      source: "none",
      attempts,
      cause: lastError,
    });
  }

  /**
   * Streaming med fallback FÖRE första token. Efter att en ström öppnats gör vi inga
   * omförsök — det skulle duplicera text.
   */
  async *streamForRole(role: ModelRole, req: ChatRequest): AsyncGenerator<string> {
    const candidates = this.candidatesFor(role);
    if (candidates.length === 0) throw this.noModelError(role);
    const attempts: FallbackAttempt[] = [];
    const startedAll = Date.now();
    let lastError: ProviderError | undefined;

    for (const candidate of candidates) {
      const attemptStart = Date.now();
      try {
        const iterator = candidate.provider.stream(withModel(req, candidate.model))[Symbol.asyncIterator]();
        const first = await iterator.next();
        attempts.push({
          providerId: candidate.provider.id,
          model: candidate.model,
          ok: true,
          tookMs: Date.now() - attemptStart,
          attempts: attempts.length + 1,
          source: candidate.provider.source,
          reason: attempts.length === 0 ? "stream öppnad på första valet" : "stream öppnad efter fallback",
        });
        if (!first.done && first.value !== undefined) yield first.value;
        for (;;) {
          const next = await iterator.next();
          if (next.done === true) break;
          if (next.value !== undefined) yield next.value;
        }
        this.publishReport(role, attempts, true, candidate.provider.id, candidate.model, candidate.provider.source, Date.now() - startedAll);
        return;
      } catch (err) {
        const failure = toProviderError(err, {
          message: `stream ${candidate.provider.id}/${candidate.model} öppnades inte`,
          source: candidate.provider.source,
          providerId: candidate.provider.id,
          model: candidate.model,
        });
        lastError = failure;
        attempts.push({
          providerId: candidate.provider.id,
          model: candidate.model,
          ok: false,
          tookMs: Date.now() - attemptStart,
          attempts: attempts.length,
          httpStatus: failure.httpStatus,
          code: failure.code,
          errorClass: failure.errorClass,
          message: failure.message,
          reason: `${failure.errorClass} — provar nästa modell i kedjan`,
          source: candidate.provider.source,
        });
        this.log("warn", `${role}: stream fallback`, {
          role,
          providerId: candidate.provider.id,
          errorClass: failure.errorClass,
        });
      }
    }

    this.publishReport(role, attempts, false, attempts[0]?.providerId ?? "none", attempts[0]?.model ?? "none", "none", Date.now() - startedAll);
    throw new ProviderError({
      message: `Ingen modell kunde streama för rollen ${role}${lastError === undefined ? "" : `: ${lastError.message}`}`,
      errorClass: "no_model",
      source: "none",
      attempts,
      cause: lastError,
    });
  }

  private async invoke(
    role: ModelRole,
    provider: Provider,
    model: string,
    req: ChatRequest | CompletionRequest | string[] | EmbeddingsRequest | VisionRequest,
  ): Promise<ChatResult | CompletionResult | EmbeddingsResult | VisionAnswer> {
    switch (role) {
      case "chat":
      case "agent":
      case "reasoning":
        return provider.chat(withModel(req as ChatRequest, model));
      case "autocomplete":
        return provider.complete(req as CompletionRequest, model);
      case "embeddings":
        return provider.embeddings({ ...(Array.isArray(req) ? { texts: req } : (req as EmbeddingsRequest)), model });
      case "vision":
        return provider.vision(withModel(req as VisionRequest, model));
      default:
        throw new ProviderError({
          message: `okänd roll ${String(role)}`,
          errorClass: "bad_request",
          source: provider.source,
          providerId: provider.id,
          model,
        });
    }
  }

  /**
   * Ref-format i en kedja: `<providerId>/<model>`. Modellnamn har själva slash
   * (qwen/quake, llama3.1:8b, moonshotai/kimi-k2-instruct), därför delar vi bara om
   * prefixet faktiskt är en känd leverantör — annars är hela ref:en ett modellnamn
   * hos den tilldelade leverantören.
   */
  private splitRef(ref: string, defaultProviderId: string): { providerId: string; model: string } {
    const split = ref.indexOf("/");
    if (split <= 0) return { providerId: defaultProviderId, model: ref };
    const head = ref.slice(0, split);
    if (this.entries.has(head)) return { providerId: head, model: ref.slice(split + 1) };
    return { providerId: defaultProviderId, model: ref };
  }

  private noModelError(role: ModelRole): ProviderError {
    return new ProviderError({
      message: `Ingen modell är tilldelad rollen ${role}. Välj en i Settings → Models.`,
      errorClass: "no_model",
      source: "none",
    });
  }

  private publishReport(
    role: ModelRole,
    attempts: FallbackAttempt[],
    ok: boolean,
    providerId: string,
    model: string,
    source: ModelSource,
    tookMs: number,
    degraded?: string,
  ): void {
    const report: RoleCallReport = { role, attempts, ok, providerId, model, source, tookMs, ...(degraded === undefined ? {} : { degraded }) };
    this.reports.set(role, report);
    this.onReport?.(report);
  }

  private synthetic(entry: Entry, model: string): ModelEntry {
    return entry.provider.entryFor(model);
  }

  private infoOf(entry: Entry): ProviderInfo {
    const info = entry.provider.toInfo();
    const models = entry.models.length > 0 ? entry.models.map((m) => m.id) : info.models;
    return { ...info, models };
  }

  private mustGet(id: string): Entry {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      throw new ProviderError({ message: `okänd provider ${id}`, errorClass: "not_found", source: "none", providerId: id });
    }
    return entry;
  }

  private pruneRoles(): void {
    let changed = false;
    for (const [role, assignment] of [...this.roleMap.entries()]) {
      const provider = this.entries.get(assignment.providerId);
      if (provider === undefined) {
        this.roleMap.delete(role);
        changed = true;
        continue;
      }
      const chain = assignment.fallbackChain.filter((ref) => {
        const parsed = this.splitRef(ref, assignment.providerId);
        return parsed.providerId === assignment.providerId || this.entries.has(parsed.providerId);
      });
      if (chain.length !== assignment.fallbackChain.length) {
        this.roleMap.set(role, { ...assignment, fallbackChain: chain });
        changed = true;
      }
    }
    if (changed) this.emitRoles();
  }

  private emitRoles(): void {
    this.onRoleChanged?.(this.roles());
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void {
    this.logSink.log({ fas: "FAS 3", modul: "providers:registry", level, message, meta, at: Date.now() });
  }
}

// ---------------------------------------------------------------------------
// Hjälpfunktioner
// ---------------------------------------------------------------------------

export function buildProvider(config: ProviderConfigInput, context: Partial<ProviderContext>, apiKeyEnvName?: string): Provider {
  const options = {
    id: config.id ?? slug(config.label) ?? config.kind,
    label: config.label,
    kind: config.kind,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    apiKeyEnvName: apiKeyEnvName ?? config.apiKeyEnvName,
    model: config.model,
    models: config.models,
    capabilities: config.capabilities,
    enabled: config.enabled ?? true,
    builtin: config.id !== undefined && BUILTIN_IDS.has(config.id),
    context,
  };
  switch (config.kind) {
    case "ollama":
      return new OllamaProvider(options);
    case "anthropic":
      return new AnthropicProvider(options);
    case "google":
      return new GoogleProvider(options);
    default:
      return new OpenAiCompatibleProvider(options);
  }
}

const BUILTIN_IDS = new Set(["nvidia", "ollama", "openai", "anthropic", "google", "groq", "openrouter", "mistral", "vllm", "lmstudio", "llamacpp"]);

function normalizeChain(chain: string[], providerId: string, model: string): string[] {
  const out: string[] = [];
  for (const raw of chain) {
    const ref = raw.trim();
    if (ref.length === 0) continue;
    const full = ref.includes("/") ? ref : `${providerId}/${ref}`;
    if (full === `${providerId}/${model}`) continue;
    if (!out.includes(full)) out.push(full);
  }
  return out;
}

function defaultModelsFor(kind: ProviderKind): string[] {
  const fallback = KIND_DEFAULTS[kind].model;
  return fallback === undefined ? [] : [fallback];
}

function seedEntries(provider: Provider): ModelEntry[] {
  return provider.toInfo().models.map((id) => provider.entryFor(id));
}

function withModel<T extends { model?: string }>(req: T, model: string): T {
  return { ...req, model };
}

function slug(label: string): string | undefined {
  const cleaned = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length === 0 ? undefined : cleaned;
}

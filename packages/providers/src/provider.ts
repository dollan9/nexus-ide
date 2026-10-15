/**
 * Provider-gränssnittet + gemensam bas för adapters.
 *
 * Kontraktet är medvetet litet: en provider *kan* saker (capabilities) och varje method
 * antingen levererar eller kastar en ProviderError med rätt ErrorCode. Aldrig ett rått fel.
 *
 * Basen äger allt tråkiga: url-hygien, nyckelläsning (utan att aldrig spara värdet),
 * timeout/retry-context, `probe()`-malen och `ModelEntry`-bygget.
 */

import type {
  CompletionRequest,
  CompletionResult,
  ModelEntry,
  ModelSource,
  ProbeResult,
  ProviderCapability,
  ProviderInfo,
  ProviderKind,
} from "@nexus/protocol";
import { ErrorCode } from "@nexus/protocol";
import { ProviderError, toProviderError, truncate } from "./errors";
import {
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT_MS,
  FAST_RETRY,
  type HttpDeps,
  type HttpRequestSpec,
  type RetryPolicy,
  requestJson,
} from "./http";
import type {
  CatalogModel,
  ChatRequest,
  ChatResult,
  EmbeddingsRequest,
  EmbeddingsResult,
  FetchLike,
  ModelPullOutcome,
  PullProgressCallback,
  RandomFn,
  TimerFn,
  VisionAnswer,
  VisionRequest,
} from "./internal-types";
import { NullLogger, ProviderLogger, type NexusLogSink } from "./logging";
import { classifySource, sourceForResponse } from "./source";

/** Läsare av hemligheter. host implementerar den mot .env + config-lagret. */
export interface SecretReader {
  read(name: string): string | undefined;
}

export interface ProviderContext {
  readonly fetchImpl: FetchLike;
  readonly logSink: NexusLogSink;
  readonly timer: TimerFn;
  readonly random: RandomFn;
  readonly secrets: SecretReader;
  readonly timeoutMs: number;
  readonly retry: RetryPolicy;
  readonly streamRetry: RetryPolicy;
}

export interface ProviderOptions {
  readonly id: string;
  readonly label: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  /** Skickas ALDRIG ut ur provider-lagret; bara { isSet } läckar till UI (R2). */
  readonly apiKey?: string;
  readonly apiKeyEnvName?: string;
  readonly model?: string;
  readonly models?: string[];
  readonly catalogModels?: CatalogModel[];
  readonly capabilities?: ProviderCapability[];
  readonly enabled?: boolean;
  readonly builtin?: boolean;
  readonly timeoutMs?: number;
  readonly retry?: RetryPolicy;
  readonly context?: Partial<ProviderContext>;
  /** Test-dockor MÅSTE sätta "stub" — annars ljuger vi om beviset. */
  readonly sourceOverride?: ModelSource;
  readonly extraHeaders?: Record<string, string>;
  /** Sann när nyckel inte krävs för att katalogen ens ska gå att hämta (NVIDIA öppen /models). */
  readonly catalogWithoutKey?: boolean;
}

/** Det enhetliga modellagrets kontrakt (FAS 3.1). */
export interface Provider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly label: string;
  readonly baseUrl: string;
  readonly capabilities: ProviderCapability[];
  readonly isLocal: boolean;
  readonly hasKey: boolean;
  readonly enabled: boolean;
  /** "local" | "cloud" | "stub" — sanningen om vad som svarar. */
  readonly source: ModelSource;
  listModels(): Promise<ModelEntry[]>;
  chat(req: ChatRequest): Promise<ChatResult>;
  stream(req: ChatRequest): AsyncIterable<string>;
  /** Rå FIM-completion för autocomplete (FAS 7.6). `model` är den upplösta kedje-modellen. */
  complete(req: CompletionRequest, model?: string): Promise<CompletionResult>;
  /** Tar antingen den enkla text-arrayen eller en fullständig begäran. */
  embeddings(input: string[] | EmbeddingsRequest): Promise<EmbeddingsResult>;
  vision(req: VisionRequest): Promise<VisionAnswer>;
  probe(): Promise<ProbeResult>;
  /** Katalogposter som finns hos leverantören men ännu inte lokalt (FAS 3.2 h). */
  catalog?(): Promise<CatalogModel[]>;
  /** Hämta en modell (Ollama pull / katalogval). Progress matching model/pull_progress. */
  pull?(ref: string, onProgress?: PullProgressCallback): Promise<ModelPullOutcome>;
  /** ProviderInfo som åker ut till UI — aldrig ett nyckelvärde. */
  toInfo(): ProviderInfo;
  /** Modellnamnet som används när anroparen inte valt något. */
  readonly preferredModel: string | undefined;
  /** Bygger en ModelEntry för ett modellnamn (registrering utan nätverk). */
  entryFor(model: string): ModelEntry;
  /** Upprep efter config ändrats. */
  setEnabled(enabled: boolean): void;
  refreshModels(): Promise<ModelEntry[]>;
}

/** Standard-capabilities per leverantörstyp; overridas av config. */
export function defaultCapabilities(kind: ProviderKind): ProviderCapability[] {
  switch (kind) {
    case "ollama":
      return ["chat", "stream", "tools", "complete", "fim", "embeddings", "vision"];
    case "anthropic":
      return ["chat", "stream", "tools", "vision"];
    case "google":
      return ["chat", "stream", "tools", "embeddings", "vision"];
    case "vllm":
    case "llamacpp":
      return ["chat", "stream", "tools", "complete", "fim", "embeddings", "vision"];
    case "lmstudio":
      return ["chat", "stream", "complete", "fim", "embeddings", "vision"];
    case "nvidia":
    case "openai":
    case "openrouter":
    case "groq":
    case "mistral":
    case "custom":
      return ["chat", "stream", "tools", "complete", "embeddings", "vision"];
    default:
      return ["chat", "stream"];
  }
}

export abstract class BaseProvider implements Provider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly label: string;
  readonly baseUrl: string;
  readonly capabilities: ProviderCapability[];
  readonly builtin: boolean;
  readonly sourceOverride?: ModelSource;
  readonly extraHeaders: Record<string, string>;
  readonly catalogWithoutKey: boolean;
  readonly timeoutMs: number;
  readonly retry: RetryPolicy;
  readonly streamRetry: RetryPolicy;

  protected readonly context: ProviderContext;
  protected readonly logger: ProviderLogger;
  private readonly inlineApiKey?: string;
  private enabledFlag: boolean;
  private preferredModelRaw?: string;
  private staticModels: string[];
  private catalogModels: CatalogModel[];
  private lastProbeValue?: ProbeResult;
  private modelCache: ModelEntry[] = [];

  constructor(options: ProviderOptions) {
    this.id = options.id;
    this.kind = options.kind;
    this.label = options.label;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.builtin = options.builtin ?? false;
    this.sourceOverride = options.sourceOverride;
    this.extraHeaders = options.extraHeaders ?? {};
    this.catalogWithoutKey = options.catalogWithoutKey ?? false;
    // Config-lagret (via context) kan ange en global timeout; per-provider-värde vinner.
    this.timeoutMs = options.timeoutMs ?? options.context?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = options.retry ?? options.context?.retry ?? DEFAULT_RETRY;
    this.streamRetry = FAST_RETRY;
    this.capabilities = options.capabilities ?? defaultCapabilities(options.kind);
    this.enabledFlag = options.enabled ?? true;
    this.preferredModelRaw = options.model;
    this.staticModels = options.models ?? (options.model !== undefined ? [options.model] : []);
    this.catalogModels = options.catalogModels ?? [];
    this.inlineApiKey = options.apiKey;
    this.envName = options.apiKeyEnvName;
    this.context = {
      fetchImpl: options.context?.fetchImpl ?? globalFetch(),
      logSink: options.context?.logSink ?? new NullLogger(),
      timer: options.context?.timer ?? defaultTimer,
      random: options.context?.random ?? Math.random,
      secrets: options.context?.secrets ?? envSecrets,
      timeoutMs: this.timeoutMs,
      retry: this.retry,
      streamRetry: this.streamRetry,
    };
    this.logger = new ProviderLogger(this.context.logSink, { modul: `providers:${this.id}` });
  }

  // --- Yta som alla adapters delar ---------------------------------------

  get isLocal(): boolean {
    return classifySource(this.baseUrl) === "local";
  }

  get hasKey(): boolean {
    return this.readKey() !== undefined;
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  setEnabled(enabled: boolean): void {
    this.enabledFlag = enabled;
  }

  get source(): ModelSource {
    return sourceForResponse(this.baseUrl, this.sourceOverride);
  }

  get preferredModel(): string | undefined {
    return this.preferredModelRaw ?? this.staticModels[0];
  }

  entryFor(model: string): ModelEntry {
    return this.entry(model);
  }

  toInfo(): ProviderInfo {
    return {
      id: this.id,
      label: this.label,
      kind: this.kind,
      baseUrl: this.baseUrl,
      isLocal: this.isLocal,
      hasKey: this.hasKey,
      keyEnvName: this.apiKeyEnvName(),
      enabled: this.enabledFlag,
      builtin: this.builtin,
      models: this.staticModels.slice(),
      capabilities: this.capabilities.slice(),
      lastProbe: this.lastProbeValue,
    };
  }

  async refreshModels(): Promise<ModelEntry[]> {
    const models = await this.listModels();
    this.modelCache = models;
    this.staticModels = models.map((m) => m.id);
    if (this.preferredModelRaw === undefined) this.preferredModelRaw = models[0]?.id;
    return models;
  }

  protected cachedModels(): ModelEntry[] {
    return this.modelCache;
  }

  /** Uppdaterar modellcachen + den konfigurerade listan efter en framgångsrik katalog. */
  protected setModelCache(list: ModelEntry[]): void {
    this.modelCache = list;
    if (list.length > 0) this.staticModels = list.map((entry) => entry.id);
    if (this.preferredModelRaw === undefined) this.preferredModelRaw = list[0]?.id;
  }

  protected catalogEntries(): CatalogModel[] {
    return this.catalogModels;
  }

  protected httpDeps(extra: { retry?: RetryPolicy; source?: ModelSource } = {}): HttpDeps {
    return {
      fetchImpl: this.context.fetchImpl,
      logger: this.logger,
      timer: this.context.timer,
      timeoutMs: this.timeoutMs,
      retry: extra.retry ?? this.retry,
      providerId: this.id,
      source: extra.source ?? this.source,
    };
  }

  /** Kört ett JSON-anrop med leverantörens headrar och felkontext. */
  protected json<T>(spec: HttpRequestSpec, opts: { retry?: RetryPolicy } = {}): Promise<T> {
    const headers = { ...this.authHeaders(), ...this.extraHeaders, ...(spec.headers ?? {}) };
    return requestJson<T>({ ...spec, headers }, this.httpDeps({ retry: opts.retry }));
  }

  protected abstract authHeaders(): Record<string, string>;

  /**
   * probe() — malen, aldrig en rå anrop. Alla adapters implementerar `ping()` och
   * får här timeout, latencemätning och felmappning till `NoModelAvailable`.
   */
  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    if (!this.enabledFlag) {
      const result: ProbeResult = {
        ok: false,
        latencyMs: 0,
        source: "none",
        error: "leverantören är avstängd i inställningarna",
      };
      this.lastProbeValue = result;
      return result;
    }
    if (this.sourceOverride !== "stub" && !this.isLocal && !this.hasKey && !this.catalogWithoutKey) {
      const result: ProbeResult = {
        ok: false,
        latencyMs: 0,
        source: "none",
        error: `ingen API-nyckel satt (${this.apiKeyEnvName() ?? "okänd nyckel"}). Konfigureras i Settings → Models.`,
      };
      this.lastProbeValue = result;
      return result;
    }
    try {
      const outcome = await this.ping();
      const result: ProbeResult = {
        ok: true,
        latencyMs: Date.now() - started,
        model: outcome.model,
        sample: truncate(outcome.sample ?? "", 200),
        httpStatus: outcome.httpStatus ?? 200,
        source: this.source,
      };
      this.lastProbeValue = result;
      this.logger.info(`probe ok (${result.latencyMs}ms, source=${result.source})`, {
        providerId: this.id,
        model: result.model,
      });
      return result;
    } catch (err) {
      const failure = toProviderError(err, {
        message: `probe av ${this.label} misslyckades`,
        source: this.source,
        providerId: this.id,
      });
      const result: ProbeResult = {
        ok: false,
        latencyMs: Date.now() - started,
        httpStatus: failure.httpStatus,
        source: "none",
        error: failure.message,
      };
      this.lastProbeValue = result;
      this.logger.warn(`probe misslyckades: ${failure.message}`, {
        providerId: this.id,
        code: ErrorCode.NoModelAvailable,
        errorClass: failure.errorClass,
      });
      return result;
    }
  }

  /** Adapterns faktiska livetest: katalog och/eller ett litet chat-anrop. */
  protected abstract ping(): Promise<{ model?: string; sample?: string; httpStatus?: number }>;

  /** Bygger en ModelEntry med enhetlig ref och sann source. */
  protected entry(model: string, extra: Partial<Omit<ModelEntry, "id" | "ref" | "providerId" | "providerLabel" | "source" | "capabilities" | "roles">> = {}): ModelEntry {
    return {
      id: model,
      ref: `${this.id}/${model}`,
      providerId: this.id,
      providerLabel: this.label,
      source: this.source,
      capabilities: this.capabilities.slice(),
      roles: [],
      ...extra,
    };
  }

  // --- Nyckelhantering ---------------------------------------------------

  protected apiKeyEnvName(): string | undefined {
    return this.envName;
  }

  readonly envName: string | undefined;

  protected readKey(): string | undefined {
    if (this.inlineApiKey !== undefined && this.inlineApiKey.length > 0) return this.inlineApiKey;
    if (this.envName === undefined) return undefined;
    const value = this.context.secrets.read(this.envName);
    return value === undefined || value.length === 0 ? undefined : value;
  }

  // --- Capabilities-hjälp ------------------------------------------------

  protected requireCapability(capability: ProviderCapability): void {
    if (this.capabilities.includes(capability)) return;
    throw new ProviderError({
      message: `${this.label} stöder inte ${capability} (konfigurerade capabilities: ${this.capabilities.join(", ")})`,
      errorClass: "unsupported",
      source: this.source,
      providerId: this.id,
    });
  }

  protected modelOr(requested: string | undefined): string {
    const model = requested ?? this.preferredModel;
    if (model === undefined || model.length === 0) {
      throw new ProviderError({
        message: `${this.label}: ingen modell vald — sätt en modell i Settings → Models`,
        errorClass: "no_model",
        source: this.source,
        providerId: this.id,
      });
    }
    return model;
  }

  /**
   * Capabilities är ett löfte till användaren: en leverantör utan `tools` får aldrig
   * ens se verktygslistan, för annars ber den den att göra något den inte kan.
   */
  protected withCapabilities(req: ChatRequest): ChatRequest {
    if (req.tools === undefined || req.tools.length === 0) return req;
    if (this.capabilities.includes("tools")) return req;
    this.logger.debug(`${this.label}: capabilities saknar tools — verktygslistan skickas inte`, {
      providerId: this.id,
      tools: req.tools.length,
    });
    return { ...req, tools: undefined, toolChoice: undefined };
  }

  protected logChatStart(model: string, req: ChatRequest): number {
    const started = Date.now();
    this.logger.debug(`chat → ${model}`, {
      providerId: this.id,
      source: this.source,
      messages: req.messages.length,
      tools: req.tools?.length ?? 0,
      images: countImages(req),
    });
    return started;
  }

  protected buildCompletionResult(text: string, model: string, started: number): CompletionResult {
    return {
      text,
      model,
      providerId: this.id,
      latencyMs: Date.now() - started,
      source: this.source,
      cached: false,
    };
  }

  protected notImplemented(method: string): ProviderError {
    return new ProviderError({
      message: `${this.label} har ingen implementering av ${method}`,
      errorClass: "unsupported",
      source: this.source,
      providerId: this.id,
    });
  }

  /**
   * Default-FIM för OpenAI-kompatibla adapters: `/v1/completions` med markeringar.
   * Ollama override:ar med `raw:true` och `prompt`/`suffix`, vilket är det som gäller
   * för de lokala modellerna vi faktiskt kör autocomplete mot.
   */
  async complete(req: CompletionRequest, model?: string): Promise<CompletionResult> {
    this.requireCapability("complete");
    return this.completeViaCompletionsEndpoint(req, model);
  }

  protected abstract completeViaCompletionsEndpoint(req: CompletionRequest, model?: string): Promise<CompletionResult>;

  /** Konfigurerade modeller (från .env/UI) — fallet när katalogsak inte är nåbar. */
  protected configuredModels(): string[] {
    return this.staticModels.slice();
  }

  /**
   * Embeddings. Apian accepterar både den enkla `texts`-arrayen (briefen) och den
   * fullständiga begäran med modell och signal. Saknar adaptern embeddings ger den ett
   * tydligt fel i stället för en tyst tom array.
   */
  async embeddings(input: string[] | EmbeddingsRequest): Promise<EmbeddingsResult> {
    this.requireCapability("embeddings");
    const req: EmbeddingsRequest = Array.isArray(input) ? { texts: input } : input;
    if (req.texts.length === 0) {
      throw new ProviderError({
        message: `${this.label}: inga texter att embedda`,
        errorClass: "bad_request",
        source: this.source,
        providerId: this.id,
      });
    }
    return this.embeddingsImpl(req);
  }

  protected abstract embeddingsImpl(req: EmbeddingsRequest): Promise<EmbeddingsResult>;

  async vision(req: VisionRequest): Promise<VisionAnswer> {
    this.requireCapability("vision");
    return this.visionImpl(req);
  }

  protected abstract visionImpl(req: VisionRequest): Promise<VisionAnswer>;

  abstract listModels(): Promise<ModelEntry[]>;
  abstract chat(req: ChatRequest): Promise<ChatResult>;
  abstract stream(req: ChatRequest): AsyncIterable<string>;
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function joinUrl(base: string, path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${normalizeBaseUrl(base)}${suffix}`;
}

function countImages(req: ChatRequest): number {
  let n = 0;
  for (const turn of req.messages) n += turn.images?.length ?? 0;
  return n;
}

const defaultTimer: TimerFn = (ms) =>
  new Promise<unknown>((resolve) => {
    setTimeout(resolve, ms);
  });

const envSecrets: SecretReader = {
  read(name: string): string | undefined {
    const value: unknown = process.env[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  },
};

function globalFetch(): FetchLike {
  const impl: unknown = globalThis.fetch;
  if (typeof impl !== "function") {
    throw new ProviderError({
      message: " den här runtime:n har ingen fetch — injectera en via ProviderContext",
      errorClass: "internal",
      source: "none",
    });
  }
  return impl as FetchLike;
}

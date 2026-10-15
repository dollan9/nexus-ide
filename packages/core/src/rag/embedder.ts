/**
 * embedder.ts — embedding-strategier för RAG-kodbasminnet (FAS 3.5, P0:
 * "Degradering till deterministisk lokal embedder när ingen modell finns —
 * rapportera ärligt vilken engine som svarade").
 *
 * Tre nivåer, i den ordningen cascade:n provrar:
 *   1. ProviderEmbedder  — riktig modell via @nexus/providers (Ollama nomic-embed-text
 *      eller vilken OpenAI-kompatibel /v1/embeddings som helst).
 *   2. AiServiceEmbedder — Python-tjänstens /embed (kan vara kopplad till chroma).
 *   3. LocalHashEmbedder — deterministisk, zero-dependency hashing + BM25. Alltid
 *      tillgänglig, aldrig nätverk, aldrig en modell.
 *
 * ÄKTHET (CONVENTIONS.md "Äkthet i tester"): varje embedder håller reda på vad som
 * FAKTIST besvarade förra anropet (`answeredModel`, `answeredSource`). RagService
 * skriver de värdena rakt av in i RagStatus.embeddingsModel — inget "vi hade en
 * Ollama konfigurerad" som presenteras som om den svarat.
 */

import type { ModelSource, RagStatus } from "@nexus/protocol";
import type { Logger } from "../logger";

export type EmbedderKind = "provider" | "ai-service" | "local-hash" | "cascade";

/**
 * `engine` är den vector-store-engine som denna embedder normalt paras med:
 * ai-service implicerar chroma-vägen, allt annat implicerar vår JSONL-store.
 * RagService sätter ALDRIG RagStatus.engine från den här fältet ensam — den sätter
 * den utifrån vad som verkligen svarade (se indexer.ts).
 */
export interface Embedder {
  readonly name: string;
  readonly kind: EmbedderKind;
  readonly engine: RagStatus["engine"];
  /** Modellnamnet som besvarade FÖRRA anropet. "none" innan något lyckats. */
  readonly answeredModel: string;
  readonly answeredSource: ModelSource;
  embed(texts: string[]): Promise<number[][]>;
  /** Vektorbredden den senaste framgångsrika anropet producerade (0 innan första). */
  readonly dimension: number;
}

// =====================================================================
// Tokenisering + BM25 (den lokala lexikala sidan av hybrid-sökningen)
// =====================================================================

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "is", "are", "was", "for",
  "with", "that", "this", "it", "as", "at", "by", "be", "from", "har", "och", "att",
  "det", "den", "de", "som", "pa", "pa\u00e5", "med", "for", "om", "kan", "ska",
]);

/**
 * Identifier-medveten tokenisering: `parseJwtToken` → ["parse","jwt","token"] och
 * `authenticateUser` → ["authenticate","user"]. Det är avgörande för kod-sök —
 * queries är often skrivna som "authenticate user" medan koden heter `authenticateUser`.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const parts = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    // snake_case och SCREAMING_SNAKE måste också slås isär — kommentaren ovan lovar det, och
    // utan detta blir `parse_jwt_token` EN token som ingen naturlig-språkig fråga jamais matchar.
    .replace(/_+/g, " ")
    .split(/[^A-Za-z0-9]+/g);
  for (const part of parts) {
    if (part.length < 2) continue;
    const clean = part.toLowerCase();
    if (clean.length < 2) continue;
    if (STOPWORDS.has(clean)) continue;
    out.push(clean);
  }
  return out;
}

/** Sub-word n-grams (3-tecken) — ger partial match för stavning/prestfix. */
export function charNGrams(token: string, n = 3): string[] {
  if (token.length < n + 1) return [];
  const grams: string[] = [];
  for (let i = 0; i + n <= token.length; i++) grams.push(token.slice(i, i + n));
  return grams;
}

/** FNV-1a 32-bit — plattformsoberoende deterministisk hash (ingen dependency). */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * BM25 (Okapi) över indexets chunker. Lexicala sidan av hybrid-sökningen.
 *
 * Varför BM25 och inte bara token-overlap: kod-corpusar är extremt skeva — ett par
 * gemensamma identifierare (`user`, `token`, `auth`) annars dominerar. BM25:dens
 * df-baserade idf och längdenormering (b) dämpar just de vanliga termerna.
 */
export class Bm25Scorer {
  private readonly postings = new Map<string, Map<string, number>>();
  private readonly docLength = new Map<string, number>();
  private readonly k1: number;
  private readonly b: number;

  constructor(opts?: { k1?: number; b?: number }) {
    this.k1 = opts?.k1 ?? 1.5;
    this.b = opts?.b ?? 0.75;
  }

  add(id: string, text: string): void {
    const tokens = tokenize(text);
    this.docLength.set(id, tokens.length);
    const local = new Map<string, number>();
    for (const t of tokens) local.set(t, (local.get(t) ?? 0) + 1);
    for (const [term, tf] of local.entries()) {
      const list = this.postings.get(term) ?? new Map<string, number>();
      list.set(id, tf);
      this.postings.set(term, list);
    }
  }

  get size(): number {
    return this.docLength.size;
  }

  clear(): void {
    this.postings.clear();
    this.docLength.clear();
  }

  /** Returnerar id → rå BM25-poäng (0 utesluts inte — fusionen hanterar ranking). */
  scores(query: string, ids?: Iterable<string>): Map<string, number> {
    const out = new Map<string, number>();
    const limit = ids ? new Set(ids) : null;
    const terms = [...new Set(tokenize(query))];
    const docIds = [...this.docLength.keys()].filter((id) => (limit ? limit.has(id) : true));
    if (docIds.length === 0 || terms.length === 0) return out;
    const avg = docIds.reduce((acc, id) => acc + (this.docLength.get(id) ?? 0), 0) / docIds.length;
    const n = docIds.length;

    for (const term of terms) {
      const list = this.postings.get(term);
      if (!list) continue;
      const df = [...list.keys()].filter((id) => (limit ? limit.has(id) : true)).length;
      if (df === 0) continue;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (const id of docIds) {
        const tf = list.get(id) ?? 0;
        if (tf === 0) continue;
        const len = this.docLength.get(id) ?? 1;
        const norm = tf * (this.k1 + 1) / (tf + this.k1 * (1 - this.b + (this.b * len) / (avg || 1)));
        out.set(id, (out.get(id) ?? 0) + idf * norm);
      }
    }
    return out;
  }
}

// =====================================================================
// LocalHashEmbedder — offline-first, always works
// =====================================================================

export const LOCAL_HASH_DIMENSION = 256;

export class LocalHashEmbedder implements Embedder {
  readonly name = `local-hash-${LOCAL_HASH_DIMENSION}`;
  readonly kind = "local-hash" as const;
  readonly engine: RagStatus["engine"] = "jsonl-fallback";
  readonly dimension = LOCAL_HASH_DIMENSION;
  readonly answeredModel = this.name;
  readonly answeredSource: ModelSource = "none";

  /**
   * Deterministisk "embedding": token- och n-gram-hashning i ett fast register med
   * sub-linjär (log) term-frequency, sedan L2-normalisering. Ingen modell, inget
   * nätverk, ingen slump — samma text ger samma vektor för alltid. Källan till
   * cosinus-simile är alltså ord-delning, inte semantik; därför hybrid-sökning.
   */
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vectorOf(t));
  }

  vectorOf(text: string): number[] {
    const vec = new Float64Array(LOCAL_HASH_DIMENSION);
    const counts = new Map<string, number>();
    for (const token of tokenize(text)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
      for (const gram of charNGrams(token)) counts.set(`g:${gram}`, (counts.get(`g:${gram}`) ?? 0) + 1);
    }
    for (const [term, tf] of counts.entries()) {
      const bucket = fnv1a(term) % LOCAL_HASH_DIMENSION;
      // +1 eller -1-tecken fran en andra hash: minskar konsekvenserna av kollisioner.
      const sign = fnv1a(`sign:${term}`) % 2 === 0 ? 1 : -1;
      vec[bucket] = (vec[bucket] ?? 0) + sign * (1 + Math.log(tf));
    }
    return normalize(vec);
  }

  /** Lexikal poäng per id — statelös motsvarighet till den Bm25Scorer RagService håller. */
  lexical(query: string, docs: readonly { id: string; text: string }[]): Map<string, number> {
    const scorer = new Bm25Scorer();
    for (const d of docs) scorer.add(d.id, d.text);
    return scorer.scores(query);
  }
}

// =====================================================================
// ProviderEmbedder — riktig modell via @nexus/providers
// =====================================================================

export interface EmbeddingsRequestShape {
  readonly texts: string[];
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export interface EmbeddingsResultShape {
  readonly vectors: number[][];
  readonly model: string;
  readonly providerId: string;
  readonly source: ModelSource;
  readonly dimensions?: number;
}

/**
 * Strukturell minimiform av ProviderRegistry (se toolkits.ts: samma teknik for
 * att slippa koppla ihop testerna till kompilerad output fran @nexus/providers).
 * Verkliga registret uppfyller detta via sin `callForRole("embeddings", ...)` overload.
 */
export interface EmbeddingsRegistry {
  callForRole(role: "embeddings", req: EmbeddingsRequestShape): Promise<EmbeddingsResultShape>;
  resolve?(role: "embeddings"): { providerId: string; model: string; source: ModelSource } | null;
}

/** Adapter för ett enstaka Provider-objekt (används av host och av Ollama-beviset). */
export function registryFromProvider(provider: {
  id: string;
  readonly source?: ModelSource;
  readonly preferredModel?: string;
  embeddings(input: string[] | EmbeddingsRequestShape): Promise<EmbeddingsResultShape>;
}): EmbeddingsRegistry {
  return {
    callForRole: async (_role, req) => provider.embeddings({ texts: req.texts, model: req.model, signal: req.signal }),
    resolve: () => ({ providerId: provider.id, model: provider.preferredModel ?? provider.id, source: provider.source ?? "local" }),
  };
}

export class ProviderEmbedder implements Embedder {
  readonly kind = "provider" as const;
  readonly engine: RagStatus["engine"] = "jsonl-fallback";
  private model = "none";
  private source: ModelSource = "none";
  private dims = 0;
  private calls = 0;
  private lastError = "";

  constructor(
    private readonly registry: EmbeddingsRegistry,
    private readonly opts: { readonly model?: string; readonly batchSize?: number; readonly logger?: Logger; readonly label?: string } = {},
  ) {}

  get name(): string {
    const label = this.opts.label ?? "provider";
    return this.model === "none" ? `${label}:${this.opts.model ?? "roll-embeddings"}` : `${label}/${this.model}`;
  }

  get answeredModel(): string {
    return this.model;
  }

  get answeredSource(): ModelSource {
    return this.source;
  }

  get dimension(): number {
    return this.dims;
  }

  get embedCalls(): number {
    return this.calls;
  }

  get lastErrorMessage(): string {
    return this.lastError;
  }

  /** Kollar rollen först — ett register utan embeddings-modell ska ge omedelbar degradering, ingen timeout. */
  private resolveOrThrow(): void {
    const resolved = this.registry.resolve?.("embeddings");
    if (resolved === null) {
      throw new Error("Ingen embeddings-modell upplöst i provider-registret");
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    this.resolveOrThrow();
    const batchSize = Math.max(1, this.opts.batchSize ?? 16);
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const res = await this.registry.callForRole("embeddings", { texts: batch, model: this.opts.model });
      if (!Array.isArray(res.vectors) || res.vectors.length !== batch.length) {
        throw new Error(`Provider:${res.vectors?.length ?? 0} vektorer för ${batch.length} texter`);
      }
      for (const v of res.vectors) {
        if (!Array.isArray(v) || v.length === 0 || !v.every((n) => Number.isFinite(n))) {
          throw new Error("Provider svarte med en icke-numerisk vektor");
        }
      }
      this.model = res.model || this.opts.model || "provider-model";
      this.source = res.source;
      this.dims = res.dimensions ?? res.vectors[0]?.length ?? this.dims;
      this.calls += 1;
      this.lastError = "";
      vectors.push(...res.vectors);
    }
    return vectors;
  }
}

// =====================================================================
// AiServiceEmbedder — Python-tjänsten (kan vara chroma-parad)
// =====================================================================

/** Strukturell kopia av AiServiceClient — bara de metoder den här nivån behöver. */
export interface AiServiceEmbeddingsClient {
  embed(chunks: string[]): Promise<number[][]>;
  status?(): Promise<RagStatus>;
  health?(): Promise<{ ok: boolean }>;
}

export class AiServiceEmbedder implements Embedder {
  readonly kind = "ai-service" as const;
  /** chroma-vägen ligger bakom ai-service — men RagService verifierkar reachability separat. */
  readonly engine: RagStatus["engine"] = "chroma";
  readonly name: string;
  private model: string;
  private source: ModelSource = "none";
  private dims = 0;
  private probed = false;
  private readonly batchSize: number;
  calls = 0;
  lastError = "";

  constructor(
    private readonly client: AiServiceEmbeddingsClient,
    opts?: { readonly model?: string; readonly label?: string; readonly batchSize?: number },
  ) {
    this.model = opts?.model ?? "ai-service-embed";
    this.name = `${opts?.label ?? "ai-service"}:${this.model}`;
    this.batchSize = Math.max(1, opts?.batchSize ?? 64);
  }

  get answeredModel(): string {
    return this.model;
  }

  get answeredSource(): ModelSource {
    return this.source;
  }

  get dimension(): number {
    return this.dims;
  }

  get embedCalls(): number {
    return this.calls;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.probeOnce();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const vectors = await this.client.embed(batch);
      if (!Array.isArray(vectors) || vectors.length !== batch.length) {
        throw new Error(`ai-service /embed svarte med ${vectors?.length ?? 0} vektorer för ${batch.length} texter`);
      }
      for (const v of vectors) {
        if (!Array.isArray(v) || v.length === 0 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) {
          throw new Error("ai-service /embed returnerade en ogiltig vektor");
        }
      }
      this.dims = vectors[0]?.length ?? this.dims;
      this.calls += 1;
      this.lastError = "";
      out.push(...vectors);
    }
    this.source = "local";
    return out;
  }

  /** Försök en gång att få modellnamnet från tjänstens egen status — annars behåll konfigurerat namn. */
  private async probeOnce(): Promise<void> {
    if (this.probed) return;
    this.probed = true;
    if (!this.client.status) return;
    try {
      const st = await this.client.status();
      if (typeof st.embeddingsModel === "string" && st.embeddingsModel.length > 0) {
        this.model = st.embeddingsModel;
      }
    } catch {
      /* frivillig information — tjästen kan vara nere */
    }
  }
}

// =====================================================================
// Cascade — väljer bästa tillgängliga och BEVARAR vem som svarade
// =====================================================================

export interface EmbedAttempt {
  readonly kind: EmbedderKind;
  readonly name: string;
  readonly ok: boolean;
  readonly error?: string;
}

export class EmbedderCascade implements Embedder {
  readonly kind = "cascade" as const;
  readonly name: string;
  private attempts: EmbedAttempt[] = [];
  private served: Embedder | null = null;

  constructor(
    private readonly candidates: Embedder[],
    private readonly logger?: Logger,
  ) {
    const names = candidates.map((c) => c.kind).join(">");
    this.name = `cascade(${names || "empty"})`;
    if (candidates.length === 0) throw new Error("EmbedderCascade behöver minst en kandidat");
  }

  /** Vad som faktiskt besvarade förra anropet — "none" om cascade:n ännu inte prövats. */
  get engine(): RagStatus["engine"] {
    return this.served?.engine ?? "jsonl-fallback";
  }

  get answeredModel(): string {
    return this.served?.answeredModel ?? "none";
  }

  get answeredSource(): ModelSource {
    return this.served?.answeredSource ?? "none";
  }

  get dimension(): number {
    return this.served?.dimension ?? 0;
  }

  get servedBy(): Embedder | null {
    return this.served;
  }

  get lastAttempts(): EmbedAttempt[] {
    return [...this.attempts];
  }

  /** Återupptagbar: reordning av kandidater (t.ex. att Ollama startat) syns nästa anrop. */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    this.attempts = [];
    let lastError: unknown = null;
    for (const candidate of this.candidates) {
      try {
        const vectors = await candidate.embed(texts);
        if (vectors.length !== texts.length) throw new Error(`${candidate.name} returnerade fel antal vektorer`);
        this.attempts.push({ kind: candidate.kind, name: candidate.name, ok: true });
        this.served = candidate;
        return vectors;
      } catch (err) {
        lastError = err;
        this.attempts.push({
          kind: candidate.kind,
          name: candidate.name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        this.logger?.warn(`embedder ${candidate.kind} (${candidate.name}) svarade inte — degraderar`, {
          fas: "3.5",
          modul: "rag/embedder",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Lokal-hash kan i praktiken inte faila; hamnar vi här har något allvarligt
    // going fel (disk, minne). Vi kastar — att tyst returnera tomma vektorer
    // skulle ge ett index som ser friskt ut men aldrig träffar (R5: inga tysta lögner).
    const detail = this.attempts.map((a) => `${a.kind}:${a.error ?? "ok"}`).join(", ");
    throw lastError instanceof Error
      ? new Error(`Ingen embedder kunde besvara anropet (${detail})`, { cause: lastError })
      : new Error(`Ingen embedder kunde besvara anropet (${detail})`);
  }
}

/** Bygg kandidaterna i företrädesordning. Saknad nivå utesluts — inga fejk-objekt. */
export function buildEmbedderChain(opts: {
  providers?: EmbeddingsRegistry | null;
  aiService?: AiServiceEmbeddingsClient | null;
  logger?: Logger;
  embeddingsModel?: string;
}): Embedder[] {
  const chain: Embedder[] = [];
  if (opts.providers) {
    chain.push(new ProviderEmbedder(opts.providers, { model: opts.embeddingsModel, logger: opts.logger }));
  }
  if (opts.aiService) {
    chain.push(new AiServiceEmbedder(opts.aiService, { model: opts.embeddingsModel }));
  }
  // Always present — this is the offline-first guarantee.
  chain.push(new LocalHashEmbedder());
  return chain;
}

function normalize(vec: Float64Array | number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  const out = new Array<number>(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = norm > 0 ? (vec[i] ?? 0) / norm : 0;
  return out;
}

/** Cosinus-likhet mellan två vektorer; 0 vid dimensionmismatch eller nollvektor. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * indexer.ts — RagService: indexera, sök och rapportera (FAS 3.5, P0:
 * "Auto-indexering av hela kodbasen med lokala embeddings" + "Semantic search:
 * hitta funktionen som hanterar auth → rätt fil + radintervall").
 *
 * Hybrid hämtning — varför, inte bara hur:
 *   Ren cosinus över kod är svag. Embeddings (särskilt den deterministiska hash-
 *   embeddern som används när ingen modell finns) sorterar på ord- och n-gram-
 *   overlap, inte på mening: `authenticateUser` och `deauthenticateCache` hamnar
 *   nära varandra. Ren BM25 är tvärtom exakt men helt okunnig om synonymer —
 *   "function that logs a user in" hittar inte `signIn()` i en corpus utan det
 *   ordet. Därför融合eras de två listorna med Reciprocal Rank Fusion: RRF är
 *   skalfri, så vi behöver inte låtsas som att en cosinus-pool och en BM25-pool
 *   går att jämföra direkt. Ovanpå lägter en exakt-identifierare-bonus, för
 *   kodfrågor är ofta ett exakt symbolnamn och den signalen får inte utvattnas
 *   av rank-medelvärden.
 *
 * Återupptagbarhet: varje fil får en sha256 av innehållet i manifestet. En körning
 * som avbryts mitt i (krasch, abort, strömavbrott) har bara skrivit chunk-rader för
 * de filer vars manifestpost hann före — okompletta filer saknar hash och körs om,
 * kompletta filer hoppas över utan ett enda embed-anrop. Det är både resume- och
 * incremental-garantin, och den är testad (rag-index.test.ts).
 */

import * as path from "node:path";
import * as fsp from "node:fs/promises";
import type { EventTable, RagChunk, RagStatus } from "@nexus/protocol";
import type { Logger } from "../logger";
import type { WorkspaceService } from "../workspace";
import { chunkSource, estimateTokens, skipReason, type ChunkDraft, type ChunkerOptions } from "./chunker";
import {
  Bm25Scorer,
  buildEmbedderChain,
  EmbedderCascade,
  tokenize,
  type AiServiceEmbeddingsClient,
  type Embedder,
  type EmbeddingsRegistry,
  type EmbedAttempt,
  type EmbedderKind,
} from "./embedder";
import {
  ChromaIndex,
  contentHash,
  JsonlVectorStore,
  type ChromaBridge,
  type ChromaReport,
  type StoredChunk,
} from "./store";

export type RagProgressPayload = EventTable["rag/progress"];
export type RagPhase = RagProgressPayload["phase"];

export interface RagIndexOptions {
  /** true = kasta hash-jämförelsen och embedda allt igen. */
  readonly force?: boolean;
  readonly onProgress?: (p: RagProgressPayload) => void;
  readonly signal?: AbortSignal;
  readonly maxFiles?: number;
  readonly embedBatchSize?: number;
}

export interface RagIndexResult {
  readonly files: number;
  readonly chunks: number;
  readonly tookMs: number;
  readonly engine: RagStatus["engine"];
  /** Filers som hoppades över för att hashen redan stämmer (bevis för incremental). */
  readonly skipped: number;
  /** Antalet gånger embeddern faktiskt anropades under den här körningen. */
  readonly embedCalls: number;
  readonly embeddingsModel: string;
  readonly error?: string;
}

export interface RagDiagnostics {
  readonly embedderKind: EmbedderKind | "none";
  readonly embedderName: string;
  readonly embeddingsModel: string;
  readonly embeddingsSource: RagStatus["engine"] extends never ? never : import("@nexus/protocol").ModelSource;
  readonly storeEngine: RagStatus["engine"];
  readonly attempts: EmbedAttempt[];
  readonly chroma: ChromaReport | null;
  readonly dimension: number;
  readonly corrupted: boolean;
  readonly embedCalls: number;
  readonly lexicalDocuments: number;
}

export interface RagServiceOptions {
  /** Absolut workspace-rot. Allt indexeras relativt den. */
  readonly root: string;
  readonly workspace: WorkspaceService;
  readonly logger: Logger;
  readonly nexusDir?: string;
  readonly storeDir?: string;
  /** Framtvingad embedder (tester, eller när användaren valt en nivå). */
  readonly embedder?: Embedder;
  readonly providers?: EmbeddingsRegistry | null;
  /** AiServiceClient uppfyller båda: embeddings + chroma-index. */
  readonly aiService?: (ChromaBridge & AiServiceEmbeddingsClient) | null;
  readonly embeddingsModel?: string;
  readonly chunker?: ChunkerOptions;
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly chromaProbeTimeoutMs?: number;
  /** Sätts av host för att kunna skicka rag/progress som EventFrame. */
  readonly emit?: (name: "rag/progress", payload: RagProgressPayload) => void;
}

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_EMBED_BATCH = 24;
const RRF_K = 20;
const W_VECTOR = 0.5;
const W_LEXICAL = 0.5;
/** Bonus per exakt träffad identifierare — håller symbolnamn-frågor i täten. */
const EXACT_TOKEN_BOOST = 0.2;

interface ScannedFile {
  readonly rel: string;
  readonly abs: string;
  readonly language: string;
  readonly content: string;
  readonly hash: string;
  readonly bytes: number;
}

function toPosixRel(p: string): string {
  return p.split(path.sep).join("/");
}

export class RagService {
  private readonly rootAbs: string;
  private readonly nexusDirAbs: string;
  private readonly storeDirAbs: string;
  private readonly logger: Logger;
  private readonly workspace: WorkspaceService;
  private readonly store: JsonlVectorStore;
  private readonly embedder: Embedder;
  private readonly cascade: EmbedderCascade | null;
  private readonly chroma: ChromaIndex | null;
  private readonly chunkerOptions: ChunkerOptions;
  private readonly maxFilesDefault: number;
  private readonly maxFileBytes: number;
  private readonly emitEvent?: (name: "rag/progress", payload: RagProgressPayload) => void;
  private lexical: Bm25Scorer | null = null;
  private lexicalDirty = true;
  private lastStatus: RagStatus;
  private lastChroma: ChromaReport | null = null;
  private storeEngine: RagStatus["engine"] = "none";
  private indexing = false;
  private embedCallsTotal = 0;
  private dimensionRebuildDone = false;
  private chromaProbed = false;

  constructor(opts: RagServiceOptions) {
    this.rootAbs = path.resolve(opts.root);
    this.nexusDirAbs = path.resolve(opts.nexusDir ?? path.join(this.rootAbs, ".nexus"));
    this.storeDirAbs = path.resolve(opts.storeDir ?? path.join(this.nexusDirAbs, "rag"));
    this.logger = opts.logger;
    this.workspace = opts.workspace;
    this.store = new JsonlVectorStore({ dir: this.storeDirAbs, logger: opts.logger });
    this.chunkerOptions = opts.chunker ?? {};
    this.maxFilesDefault = opts.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.emitEvent = opts.emit;

    const chain = buildEmbedderChain({
      providers: opts.providers ?? null,
      aiService: opts.aiService ?? null,
      logger: opts.logger,
      embeddingsModel: opts.embeddingsModel,
    });
    if (opts.embedder) {
      this.embedder = opts.embedder;
      this.cascade = null;
    } else {
      this.cascade = new EmbedderCascade(chain, opts.logger);
      this.embedder = this.cascade;
    }
    this.chroma = opts.aiService ? new ChromaIndex(opts.aiService, opts.logger) : null;
    this.lastStatus = {
      engine: "none",
      indexedFiles: 0,
      chunks: 0,
      embeddingsModel: "none",
      indexing: false,
    };
  }

  /** Storens rot på disk — `.nexus/rag` om inget annat angivits. */
  get storePath(): string {
    return this.storeDirAbs;
  }

  get vectorStore(): JsonlVectorStore {
    return this.store;
  }

  // =====================================================================
  // Indexering
  // =====================================================================

  /**
   * Indexera (eller uppdatera) ett träd. Progress strömmas som `rag/progress`
   * i faserna scan → embed → store → done. Kastar aldrig: fel landar i
   * `result.error` + `status().error` och indexet behåller det som hunnit bli klart.
   */
  async index(root?: string, o: RagIndexOptions = {}): Promise<RagIndexResult> {
    const started = Date.now();
    const scanRoot = root ? path.resolve(root) : this.rootAbs;
    const relPrefix = this.relPrefixOf(scanRoot);
    const force = o.force === true;
    const report = (filesDone: number, total: number, chunks: number, phase: RagPhase): void => {
      const payload: RagProgressPayload = { filesDone, total, chunks, phase };
      try {
        o.onProgress?.(payload);
      } catch (err) {
        this.logger.warn("rag/progress onProgress kastade — strömmen avbryts inte", {
          fas: "3.5",
          modul: "rag/indexer",
          error: String(err),
        });
      }
      try {
        this.emitEvent?.("rag/progress", payload);
      } catch (err) {
        this.logger.warn("rag/progress emit kastade", { fas: "3.5", modul: "rag/indexer", error: String(err) });
      }
    };

    this.indexing = true;
    this.publishStatus({ indexing: true });
    let embedCalls = 0;
    let error: string | undefined;

    try {
      await this.store.load();
      if (this.store.corrupted) {
        this.logger.warn("RAG: store filades trasig — indexerar om berörda filer", {
          fas: "3.5",
          modul: "rag/indexer",
          store: this.storeDirAbs,
        });
      }

      report(0, 0, this.store.stats().chunks, "scan");
      const scanned = await this.scan(scanRoot, relPrefix, o.maxFiles ?? this.maxFilesDefault);
      const total = scanned.length;
      report(0, total, this.store.stats().chunks, "scan");

      let filesDone = 0;
      let indexedFiles = 0;
      let skipped = 0;
      let chunkCount = this.store.stats().chunks;

      for (const file of scanned) {
        if (o.signal?.aborted) {
          error = "avbruten av användaren";
          this.logger.info("RAG-indexering avbruten", { fas: "3.5", modul: "rag/indexer", filesDone, total });
          break;
        }
        filesDone += 1;

        if (!force && this.store.isCurrent(file.rel, file.hash)) {
          skipped += 1;
          report(filesDone, total, chunkCount, "store");
          continue;
        }

        const drafts = chunkSource({
          path: file.rel,
          language: file.language,
          content: file.content,
          options: this.chunkerOptions,
        });
        if (drafts.length === 0) {
          // Tom/okategoriserbar: filen registreras anyway med 0 chunker så att hashen
          // räknas och nästa körning hoppar över den (ingen omchunkning av tomma filer).
          await this.store.upsert([], { path: file.rel, hash: file.hash, bytes: file.bytes });
          report(filesDone, total, chunkCount, "store");
          continue;
        }

        const texts = drafts.map((d) => embedText(d));
        report(filesDone, total, chunkCount, "embed");
        const vectors = await this.embedBatched(texts, o.embedBatchSize ?? DEFAULT_EMBED_BATCH);
        embedCalls += 1;
        this.embedCallsTotal += 1;

        const stored: StoredChunk[] = drafts.map((d, i) => ({
          ...d,
          vector: vectors[i] ?? [],
        }));
        await this.store.upsert(stored, { path: file.rel, hash: file.hash, bytes: file.bytes });
        indexedFiles += 1;
        chunkCount = this.store.stats().chunks;
        report(filesDone, total, chunkCount, "store");
      }

      // Borttagna filer: chunker som finns i store men inte på disk måste bort,
      // annars svarar RAG på frågor om kod som inte längre finns.
      const removed = await this.pruneDeletedFiles(relPrefix, scanned);

      // Valfritt chroma-lyft — bara om Python-tjänsten faktiskt svarar.
      await this.maybeChroma(scanRoot);

      await this.store.flush();
      this.lexicalDirty = true;

      const stats = this.store.stats();
      this.storeEngine = this.chromaActive() && stats.chunks === 0 ? "chroma" : stats.chunks > 0 ? "jsonl-fallback" : this.chromaActive() ? "chroma" : "none";
      report(total, total, stats.chunks, "done");
      this.publishStatus({});
      this.logger.info("RAG-indexering klar", {
        fas: "3.5",
        modul: "rag/indexer",
        files: stats.files,
        chunks: stats.chunks,
        skipped,
        removed,
        indexedFiles,
        embedCalls,
        engine: this.storeEngine,
        embeddingsModel: this.embedder.answeredModel,
        tookMs: Date.now() - started,
      });

      return {
        files: stats.files,
        chunks: stats.chunks,
        tookMs: Date.now() - started,
        engine: this.storeEngine,
        skipped,
        embedCalls,
        embeddingsModel: this.embedder.answeredModel,
        error,
      };
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      // R5: aldrig en krasch ut till transporten. Indexet behåller det som hunnit bli.
      this.logger.error("RAG-indexering misslyckades — ofullständigt index kvarstår", {
        fas: "3.5",
        modul: "rag/indexer",
        error,
      });
      const stats = this.store.stats();
      this.storeEngine = stats.chunks > 0 ? "jsonl-fallback" : "none";
      this.publishStatus({ error });
      return {
        files: stats.files,
        chunks: stats.chunks,
        tookMs: Date.now() - started,
        engine: this.storeEngine,
        skipped: 0,
        embedCalls,
        embeddingsModel: this.embedder.answeredModel,
        error,
      };
    } finally {
      this.indexing = false;
      this.publishStatus({ indexing: false });
    }
  }

  /** Ta bort en fil ur indexet (används av host vid fs/changed unlink, och av tester). */
  async removeFile(rel: string): Promise<void> {
    await this.store.removeFile(toPosixRel(rel));
    this.lexicalDirty = true;
    const stats = this.store.stats();
    this.storeEngine = stats.chunks > 0 ? "jsonl-fallback" : "none";
    this.publishStatus({});
  }

  /**
   * Gå igenom workspacet på samma villkor som WorkspaceService (vars IGNORE_DIRS
   * styr vad vi ens ser — node_modules, dist, .git, .venv, .nexus osv).
   */
  private async scan(scanRoot: string, relPrefix: string, maxFiles: number): Promise<ScannedFile[]> {
    const out: ScannedFile[] = [];
    const nodes = await this.workspace.listTree(relPrefix.length > 0 ? relPrefix : undefined, 64);
    const queue = [...nodes];
    while (queue.length > 0 && out.length < maxFiles) {
      const node = queue.shift();
      if (!node) continue;
      if (node.kind === "dir") {
        for (const child of node.children ?? []) queue.push(child);
        continue;
      }
      const rel = toPosixRel(node.path);
      if (relPrefix.length > 0 && !rel.startsWith(relPrefix)) continue;
      const reason = skipReason({ path: rel, sizeBytes: node.size, maxFileBytes: this.maxFileBytes });
      if (reason) {
        this.logger.debug("Hoppade över fil vid RAG-scan", { fas: "3.5", modul: "rag/indexer", path: rel, reason });
        // Filen kan vara indexerad sedan tidigare (blev genererad/binär) — städa bort.
        if (this.store.hashOf(rel) !== undefined) await this.store.removeFile(rel);
        continue;
      }
      let abs: string;
      try {
        abs = this.workspace.resolve(rel);
      } catch {
        continue;
      }
      try {
        const file = await this.workspace.read(rel, this.maxFileBytes);
        if (file.truncated) continue;
        const contentReason = skipReason({ path: rel, content: file.content, sizeBytes: file.size, maxFileBytes: this.maxFileBytes });
        if (contentReason) {
          if (this.store.hashOf(rel) !== undefined) await this.store.removeFile(rel);
          continue;
        }
        out.push({
          rel,
          abs,
          language: file.language,
          content: file.content,
          hash: contentHash(file.content),
          bytes: file.size,
        });
      } catch (err) {
        this.logger.debug("Kunde inte läsa fil för RAG-index", {
          fas: "3.5",
          modul: "rag/indexer",
          path: rel,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }

  /** Filer i indexet som inte längre finns på disk (under samma rot). */
  private async pruneDeletedFiles(relPrefix: string, scanned: readonly ScannedFile[]): Promise<number> {
    const present = new Set(scanned.map((f) => f.rel));
    let removed = 0;
    for (const file of this.store.indexedFiles()) {
      if (relPrefix.length > 0 && !file.startsWith(relPrefix)) continue;
      if (present.has(file)) continue;
      await this.store.removeFile(file);
      removed += 1;
    }
    return removed;
  }

  private async embedBatched(texts: string[], batchSize: number): Promise<number[][]> {
    const size = Math.max(1, batchSize);
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += size) {
      const batch = texts.slice(i, i + size);
      const res = await this.embedder.embed(batch);
      if (res.length !== batch.length) {
        throw new Error(`Embedder ${this.embedder.name} gav ${res.length} vektorer för ${batch.length} texter`);
      }
      vectors.push(...res);
    }
    return vectors;
  }

  private relPrefixOf(scanRoot: string): string {
    if (scanRoot === this.rootAbs) return "";
    const rel = toPosixRel(path.relative(this.rootAbs, scanRoot));
    if (rel.startsWith("..") || path.isAbsolute(rel)) return "";
    return rel.length === 0 ? "" : `${rel}/`;
  }

  // =====================================================================
  // Sökning
  // =====================================================================

  /**
   * Naturlig-språks-fråga → RagChunk[] med fusionerad poäng.
   * Steg: embedda frågan → cosinus-lista → BM25-lista → RRF → exakt-boost.
   */
  async query(naturalQuery: string, k = 6): Promise<RagChunk[]> {
    const limit = Math.max(1, Math.min(50, Math.floor(k)));
    const question = naturalQuery.trim();
    if (question.length === 0) return [];

    const chromaHits = this.chromaActive() ? await this.chroma!.search(question, limit * 2) : [];
    const stats = this.store.stats();
    if (stats.chunks === 0) {
      // Inget lokalt index: chroma-svaret (om något) är allt vi har.
      return chromaHits.slice(0, limit).map((c) => ({ ...c }));
    }

    let queryVector: number[];
    try {
      queryVector = (await this.embedder.embed([question]))[0] ?? [];
    } catch (err) {
      this.logger.warn("RAG-sök: query-embedding misslyckades — lexikala träffar används", {
        fas: "3.5",
        modul: "rag/indexer",
        error: err instanceof Error ? err.message : String(err),
      });
      queryVector = [];
    }

    if (queryVector.length > 0 && stats.dimension > 0 && queryVector.length !== stats.dimension) {
      const rebuilt = await this.rebuildForNewDimension();
      if (rebuilt) {
        queryVector = (await this.embedder.embed([question]))[0] ?? [];
      }
    }

    const vectorList = queryVector.length > 0 ? await this.store.query(queryVector, Math.min(stats.chunks, limit * 6)) : [];
    const lexicalScores = this.lexicalScores(question);

    const fused = fuse(vectorList, lexicalScores, this.store.all(), limit * 3, new Set(tokenize(question)));
    const merged = mergeChroma(fused, chromaHits, limit);
    const localById = new Map(this.store.all().map((c) => [c.id, c]));
    return merged.map<RagChunk>((hit) => {
      const local = localById.get(hit.chunk.id);
      return {
        id: hit.chunk.id,
        path: hit.chunk.path,
        startLine: hit.chunk.startLine,
        endLine: hit.chunk.endLine,
        text: local?.text ?? hit.chunk.text,
        score: roundScore(hit.score),
        symbol: hit.chunk.symbol,
      };
    });
  }

  /** RagToolkit-kontrakten (verktyget rag_search) — samma sak som query(). */
  async search(query: string, k?: number): Promise<RagChunk[]> {
    return this.query(query, k ?? 6);
  }

  /**
   * Rank-fusion. Vektor- och lexikallistorna är inte på samma skala, så poängen
   * blandas EALDRIG direkt — RRF använder bara deras inbördes ordning.
   */
  private lexicalScores(question: string): Map<string, number> {
    const scorer = this.ensureLexicon();
    return scorer.scores(question);
  }

  private ensureLexicon(): Bm25Scorer {
    if (this.lexical && !this.lexicalDirty) return this.lexical;
    const scorer = new Bm25Scorer();
    for (const chunk of this.store.all()) {
      // Symbolnamnet räknas två gånger: en fråga om `authenticate` ska vinna på en
      // chunk vars symbol är authenticate även om brödtexten är kort.
      scorer.add(chunk.id, chunk.symbol ? `${chunk.symbol}\n${chunk.text}` : chunk.text);
    }
    this.lexical = scorer;
    this.lexicalDirty = false;
    return scorer;
  }

  /**
   * Om indexet byggdes med en embedder i en annan dimension (t.ex. provider svarade
   * i 768 och är borta nu → local-hash 256) är lagrade vektorer värdelösa. Vi bygger
   * om EN gång per process och loggar det — att tyst returnera fel träfflistor vore
   * en lögn om vad som faktiskt svarar.
   */
  private async rebuildForNewDimension(): Promise<boolean> {
    if (this.dimensionRebuildDone) {
      this.logger.warn("RAG: dimensionsmismatch kvarstår efter ombyggnad — lexikala träffar används", {
        fas: "3.5",
        modul: "rag/indexer",
      });
      return false;
    }
    this.dimensionRebuildDone = true;
    this.logger.warn("RAG: embeddern bytte dimension — indexet byggs om", {
      fas: "3.5",
      modul: "rag/indexer",
      stored: this.store.currentDimension,
      now: this.embedder.dimension,
    });
    await this.index(undefined, { force: true });
    this.dimensionRebuildDone = false;
    return true;
  }

  private chromaActive(): boolean {
    return this.chroma !== null && this.chroma.isReachable && this.storeEngine === "chroma";
  }

  /** Fråga ai-service en gång per process; sanningen sparas i lastChroma. */
  private async maybeChroma(scanRoot: string): Promise<void> {
    if (!this.chroma) return;
    if (!this.chromaProbed) {
      this.chromaProbed = true;
      this.lastChroma = await this.chroma.probe();
    }
    if (!this.chroma.isReachable) return;
    this.lastChroma = await this.chroma.index(scanRoot);
  }

  private publishStatus(patch: Partial<RagStatus>): void {
    const stats = this.store.stats();
    const engine: RagStatus["engine"] = patch.engine ?? this.deriveEngine(stats.chunks);
    this.lastStatus = {
      engine,
      indexedFiles: patch.indexedFiles ?? stats.files,
      chunks: patch.chunks ?? stats.chunks,
      embeddingsModel: patch.embeddingsModel ?? this.embedder.answeredModel,
      lastIndexedAt: patch.lastIndexedAt ?? this.lastStatus.lastIndexedAt ?? Date.now(),
      indexing: patch.indexing ?? this.indexing,
      error: patch.error ?? (patch.error === null ? undefined : this.lastStatus.error),
    };
  }

  /**
   * Engine-sanning: "chroma" endast om chroma-vägen faktiskt svarat, annars
   * "jsonl-fallback" om vårt eget index innehåller något, och "none" innan något
   * indexerats. Ingen av dessa värden väljs från config — bara från vad som svarat.
   */
  private deriveEngine(chunks: number): RagStatus["engine"] {
    if (this.chroma?.isReachable && this.lastChroma?.reachable) return "chroma";
    if (chunks > 0 || this.store.indexedFiles().length > 0) return "jsonl-fallback";
    return "none";
  }

  status(): RagStatus {
    this.publishStatus({});
    return this.lastStatus;
  }

  /** Allt som behövs för att vara ärlig i UI och i tests/RESULT.md. */
  diagnostics(): RagDiagnostics {
    const stats = this.store.stats();
    return {
      embedderKind: this.embedder.kind,
      embedderName: this.embedder.name,
      embeddingsModel: this.embedder.answeredModel,
      embeddingsSource: this.embedder.answeredSource,
      storeEngine: this.deriveEngine(stats.chunks),
      attempts: this.cascade ? this.cascade.lastAttempts : [],
      chroma: this.lastChroma,
      dimension: stats.dimension,
      corrupted: this.store.corrupted,
      embedCalls: this.embedCallsTotal,
      lexicalDocuments: this.lexical?.size ?? 0,
    };
  }

  /** Contexblocket chatten skickar med (FAS 3.5 "Top-k chunks automatiskt in i varje chat-fråga"). */
  async buildContextBlock(query: string, opts?: { k?: number; maxBytes?: number }): Promise<string> {
    const chunks = await this.query(query, opts?.k ?? 6);
    const { formatContextBlock } = await import("./context");
    return formatContextBlock(chunks, { maxBytes: opts?.maxBytes });
  }

  /** Top-k som { contextUsed, text } — detChatMessage contextUsed-fältet vill ha. */
  async buildChatContext(
    query: string,
    opts?: { k?: number; maxBytes?: number },
  ): Promise<{ used: RagChunk[]; text: string; bytes: number; dropped: number }> {
    const chunks = await this.query(query, opts?.k ?? 6);
    const { buildChatContextFromChunks } = await import("./context");
    return buildChatContextFromChunks(chunks, opts ?? {});
  }
}

// =====================================================================
// Fusion — fri funktion så den går att testa direkt
// =====================================================================

interface FusedHit {
  readonly chunk: StoredChunk;
  readonly score: number;
}

function fuse(
  vectorHits: readonly { chunk: StoredChunk; score: number }[],
  lexical: ReadonlyMap<string, number>,
  corpus: readonly StoredChunk[],
  take: number,
  queryTokens: ReadonlySet<string> = new Set(),
): FusedHit[] {
  const byId = new Map(corpus.map((c) => [c.id, c]));
  const ranks = new Map<string, { vector?: number; lexical?: number; vecScore: number; lexScore: number }>();

  vectorHits.forEach((hit, i) => {
    ranks.set(hit.chunk.id, { vector: i, vecScore: hit.score, lexScore: 0 });
  });

  const lexicalRanked = [...lexical.entries()].sort((a, b) => b[1] - a[1]);
  lexicalRanked.forEach(([id, score], i) => {
    const existing = ranks.get(id);
    if (existing) ranks.set(id, { ...existing, lexical: i, lexScore: score });
    else ranks.set(id, { lexical: i, vecScore: 0, lexScore: score });
  });

  const out: FusedHit[] = [];
  for (const [id, entry] of ranks.entries()) {
    const chunk = byId.get(id);
    if (!chunk) continue;
    const rrf =
      (entry.vector === undefined ? 0 : W_VECTOR / (RRF_K + entry.vector + 1)) +
      (entry.lexical === undefined ? 0 : W_LEXICAL / (RRF_K + entry.lexical + 1));
    out.push({ chunk, score: rrf + exactnessBonus(chunk, queryTokens), ...{} });
  }
  out.sort((a, b) => b.score - a.score || a.chunk.path.localeCompare(b.chunk.path) || a.chunk.startLine - b.chunk.startLine);
  return out.slice(0, Math.max(1, take));
}

/**
 * Exakt-identifierare-bonus. Kodfrågor är ofta ett ord ur identifierarspråket
 * (`authenticateUser`, `openConnectionPool`, `RagService`); BM25 fångar dem men RRF:n kan ändå
 * dränka träffen i semantiskt brus, så en verbatim-träff lyfts medvetet.
 *
 * Regeln är medvetat småaktig men ärlig: bara långa token (≥6 tecken, dvs identifierare och inte
 * vanliga ord) räknas, poängen mättas för att inte en enda förekomst ska köra över allt, och
 * dokument (markdown/txt) får en fjärdel av boosten. Anledningen till det sista är den faktiska
 * produkten: frågar utvecklaren "openConnectionPool database connections" vill hen ha KÄLLKODEN,
 * inte README-avsnittet som råkar nämna funktionen i en mening. Utan denna prior tappade
 * topplistan till docs/README.md — fångat av test, inte av en åsikt.
 */
function exactnessBonus(chunk: StoredChunk, queryTokens: ReadonlySet<string>): number {
  if (queryTokens.size === 0) return 0;
  const hay = chunk.text.toLowerCase();
  let hits = 0;
  for (const token of queryTokens) {
    if (token.length < 6) continue;
    if (hay.includes(token)) hits += 1;
  }
  if (hits === 0) return 0;
  const base = Math.min(EXACT_TOKEN_BOOST, hits * 0.05);
  const isDoc = /\.(md|markdown|txt|rst|adoc)$/i.test(chunk.path);
  return isDoc ? base * 0.25 : base;
}

function mergeChroma(local: readonly FusedHit[], chroma: readonly RagChunk[], limit: number): FusedHit[] {
  if (chroma.length === 0) return local.slice(0, limit);
  const merged: FusedHit[] = [];
  const seen = new Set<string>();
  for (const hit of local) {
    seen.add(hit.chunk.id);
    merged.push(hit);
  }
  chroma.forEach((c, i) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    merged.push({
      chunk: {
        id: c.id,
        path: c.path,
        startLine: c.startLine,
        endLine: c.endLine,
        text: c.text,
        symbol: c.symbol,
        kind: "symbol",
        vector: [],
      },
      // Chroma-träffar rankas efter sin egen poäng men ges ett RRF-liknande avstånd
      // så de inte tränger undan lokalt verifierade träffar.
      score: W_VECTOR / (RRF_K + i + 1) + Math.max(0, Math.min(1, c.score)) * 0.01,
    });
  });
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, limit);
}

function roundScore(score: number): number {
  return Math.round(score * 10000) / 10000;
}

/** Texten som går till embeddern: symbolnamnet förser chunk med sin egen identifierare. */
function embedText(draft: ChunkDraft): string {
  const header = `${draft.path}:${draft.startLine}-${draft.endLine}${draft.symbol ? ` ${draft.symbol}` : ""}`;
  return `${header}\n${draft.text}`;
}

export { estimateTokens };
export type { ChunkDraft, StoredChunk };
export { contentHash };
export { statSyncSafe };

/** liten helper — finns för host-integration; returnerar null om filen saknas. */
async function statSyncSafe(p: string): Promise<number | null> {
  try {
    const st = await fsp.stat(p);
    return st.size;
  } catch {
    return null;
  }
}

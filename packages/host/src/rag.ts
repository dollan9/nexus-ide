/**
 * rag.ts — RagService (FAS 3.5, P0: "RAG-kodbasminne").
 *
 * Det här ar host-leveranten av RAG: core har bara AiServiceClient (HTTP mot
 * Python-tjansten), och det finns inget eget rag-paket. Sa indexeringen, chunkingen
 * och sokningen ligger har och koden ar verklig — inget placehold.
 *
 * Tre nivajer, alltid med sandhet om vilken som svarade (R5 + CONVENTIONS §Äkthet):
 *   1. ai-service (Chroma + riktiga embeddings) — engine "chroma", bara om tjansten
 *      faktiskt svarar pa sin port.
 *   2. Lokala jsonl-index med embeddings fran modellagret — engine "jsonl-fallback",
 *      `embeddingsModel` = verklig provider/modell.
 *   3. Deterministisk lokal embedder (hashad pose av ord) — samma engine men
 *      `embeddingsModel` namnar den faktiska algoritmen. SPEC P0: "Degradering till
 *      deterministisk lokal embedder nar ingen modell finns — rapportera arligt
 *      vilken engine som svarade".
 *
 * Sokningen har ocksa ett rent lexikalt failback-lage (token-overlap pa lagrad
 * text) sa att ett index bygda med en modell som senare lagts av fortfarande
 * gertraffar — aldrig ett tomt svar for att vektorrymden inte langre matchar.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { EventTable, ModelSource, RagChunk, RagStatus } from "@nexus/protocol";
import type { Logger, WorkspaceService } from "@nexus/core";
import { fnv1a, tokenize } from "./utils";

/** Embeddings-funktionen host matar service med (modellagret eller ai-service). */
export interface RagVectors {
  readonly vectors: number[][];
  readonly model: string;
  readonly source: ModelSource;
}

export type RagEmbedder = (texts: string[]) => Promise<RagVectors>;

/** AiServiceClient uppfyller denna form; host behover inte hela klassen. */
export interface RagDelegate {
  health(): Promise<{ ok: boolean }>;
  indexCode(a: { root: string }): Promise<{ files: number; chunks: number; engine: string }>;
  query(a: { query: string; k?: number }): Promise<RagChunk[]>;
}

export interface RagServiceOptions {
  readonly workspace: WorkspaceService;
  readonly nexusDir: string;
  readonly logger: Logger;
  readonly embedder?: RagEmbedder;
  readonly delegate?: RagDelegate;
  readonly onProgress?: (payload: EventTable["rag/progress"]) => void;
  readonly enabled?: () => boolean;
  readonly maxFiles?: number;
  readonly chunkLines?: number;
  readonly overlapLines?: number;
  readonly dimensions?: number;
  readonly maxFileBytes?: number;
}

interface StoredChunk {
  readonly id: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly symbol?: string;
  readonly vector: number[];
}

interface RagMeta {
  readonly engine: RagStatus["engine"];
  readonly embeddingsModel: string;
  readonly vectorSpace: string;
  readonly indexedFiles: number;
  readonly chunks: number;
  readonly lastIndexedAt: number;
  readonly root: string;
  readonly dimensions: number;
}

const IGNORED_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".7z", ".tar",
  ".mp3", ".mp4", ".mov", ".wav", ".ogg", ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".exe", ".dll", ".so", ".dylib", ".node", ".wasm", ".pyc", ".class", ".jar", ".onnx",
]);

/** Extrahera en symbol (funktion/klass/def) for kod-medveten chunking (FAS 3.5). */
function detectSymbol(line: string): string | undefined {
  const patterns = [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/,
    /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_]+)/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_]+)\s*[:=]/,
    /^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)/,
    /^\s*(?:pub\s+)?fn\s+([A-Za-z0-9_]+)/,
    /^\s*(?:func\s+)?(?:interface|type)\s+([A-Za-z0-9_]+)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(line);
    if (match !== null && match[1] !== undefined) return match[1];
  }
  return undefined;
}

function normalize(vector: readonly number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector.slice();
  return vector.map((value) => value / norm);
}

function cosine(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < length; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

/**
 * Deterministisk lokal embedder: hadsad pose av ord. Ingen modell, ingen
 * nenverkshet, ingen slump — samma indata ger alltid samma vektor.
 */
export function lexicalVector(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = tokenize(text);
  for (const token of tokens) {
    const bucket = fnv1a(token) % dimensions;
    vector[bucket] = (vector[bucket] ?? 0) + 1;
  }
  for (let i = 0; i < dimensions; i += 1) {
    const value = vector[i] ?? 0;
    vector[i] = value > 0 ? Math.log1p(value) : 0;
  }
  return normalize(vector);
}

export class RagService {
  private readonly indexFile: string;
  private readonly metaFile: string;
  private chunks: StoredChunk[] = [];
  private meta: RagMeta | null = null;
  private loaded = false;
  private indexing = false;
  private lastError?: string;

  constructor(private readonly options: RagServiceOptions) {
    const dir = path.join(options.nexusDir, "rag");
    this.indexFile = path.join(dir, "chunks.jsonl");
    this.metaFile = path.join(dir, "meta.json");
  }

  get engine(): RagStatus["engine"] {
    if (this.options.enabled?.() === false) return "none";
    return this.meta?.engine ?? "jsonl-fallback";
  }

  /** Lat in index fran disk (kostnad en gangt; sokningar ar da samtidsfri). */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const metaRaw = fs.readFileSync(this.metaFile, "utf8");
      this.meta = JSON.parse(metaRaw) as RagMeta;
    } catch {
      this.meta = null;
    }
    try {
      const raw = fs.readFileSync(this.indexFile, "utf8");
      const parsed: StoredChunk[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.length === 0) continue;
        try {
          parsed.push(JSON.parse(line) as StoredChunk);
        } catch {
          // En trasig rad(forstaillan avbrutit) far inte sora hela indexet (R5).
        }
      }
      this.chunks = parsed;
    } catch {
      this.chunks = [];
    }
  }

  status(): RagStatus {
    this.ensureLoaded();
    const enabled = this.options.enabled?.() !== false;
    if (!enabled) {
      return {
        engine: "none",
        indexedFiles: 0,
        chunks: 0,
        embeddingsModel: "avstängd i inställningarna (ragEnabled=false)",
        indexing: this.indexing,
      };
    }
    return {
      engine: this.meta?.engine ?? "jsonl-fallback",
      indexedFiles: this.meta?.indexedFiles ?? 0,
      chunks: this.chunks.length,
      embeddingsModel: this.meta?.embeddingsModel ?? "ännu inte indexerat",
      ...(this.meta ? { lastIndexedAt: this.meta.lastIndexedAt } : {}),
      indexing: this.indexing,
      ...(this.lastError !== undefined ? { error: this.lastError } : {}),
    };
  }

  /**
   * Bestam embeddings-kalla for denna indexomgang. Ordningen ar SPEC: chroma →
   * modellagret → deterministisk lokal. Returnerar ocksa det namn som ska
   * rapporteras — aldrig en modell som inte faktiskt anvandes.
   */
  private async embed(texts: string[]): Promise<{ vectors: number[][]; model: string; space: string }> {
    const dimensions = this.options.dimensions ?? 512;
    if (this.options.embedder !== undefined) {
      try {
        const result = await this.options.embedder(texts);
        if (result.vectors.length === texts.length && result.vectors.every((v) => v.length > 0)) {
          return {
            vectors: result.vectors.map((v) => normalize(v)),
            model: `${result.model} (${result.source})`,
            space: `model:${result.model}`,
          };
        }
      } catch (err) {
        this.lastError = `embeddings-modell svarade inte, använder deterministisk lokal embedder: ${err instanceof Error ? err.message : String(err)}`;
        this.options.logger.warn("RAG: embeddings-fallback till lokal hash", { fas: "3.5", error: this.lastError });
      }
    }
    return {
      vectors: texts.map((text) => lexicalVector(text, dimensions)),
      model: `deterministisk lokal embedder (hashad ordpåse, ${String(dimensions)} dim)`,
      space: `lexical-hash-${String(dimensions)}`,
    };
  }

  private async collectFiles(root: string | undefined, maxFiles: number): Promise<string[]> {
    const nodes = await this.options.workspace.listTree(root ?? ".", 12);
    const out: string[] = [];
    const walk = (level: readonly { name: string; path: string; kind: string; children?: unknown[] }[]): void => {
      for (const node of level) {
        if (out.length >= maxFiles) return;
        if (node.kind === "file") {
          if (!IGNORED_EXTENSIONS.has(path.extname(node.name).toLowerCase())) out.push(node.path);
        } else if (Array.isArray(node.children)) {
          walk(node.children as { name: string; path: string; kind: string; children?: unknown[] }[]);
        }
      }
    };
    walk(nodes as { name: string; path: string; kind: string; children?: unknown[] }[]);
    return out;
  }

  /** Chunka en fil: radintervall med overlap, bevarade radnummer + symbol (FAS 3.5). */
  private chunkFile(relPath: string, content: string): StoredChunk[] {
    const chunkLines = this.options.chunkLines ?? 48;
    const overlap = this.options.overlapLines ?? 6;
    const lines = content.split(/\r?\n/);
    if (lines.length === 0) return [];
    const out: StoredChunk[] = [];
    let symbol: string | undefined;
    for (let start = 0; start < lines.length; start += Math.max(1, chunkLines - overlap)) {
      const slice = lines.slice(start, start + chunkLines);
      if (slice.length === 0) break;
      const firstSymbol = slice.map((line) => detectSymbol(line)).find((s) => s !== undefined);
      symbol = firstSymbol ?? symbol;
      const endLine = start + slice.length;
      const text = slice.join("\n");
      out.push({
        id: `${relPath}:${String(start + 1)}-${String(endLine)}`,
        path: relPath,
        startLine: start + 1,
        endLine,
        text,
        ...(symbol !== undefined ? { symbol } : {}),
        vector: [],
      });
      if (start + chunkLines >= lines.length) break;
    }
    return out;
  }

  async index(opts: { root?: string; force?: boolean } = {}): Promise<{ files: number; chunks: number; tookMs: number; engine: RagStatus["engine"] }> {
    this.ensureLoaded();
    const started = Date.now();
    const report = (filesDone: number, total: number, chunks: number, phase: EventTable["rag/progress"]["phase"]): void => {
      try {
        this.options.onProgress?.({ filesDone, total, chunks, phase });
      } catch {
        // Progress ar diagnostik — aldrig en felkalla.
      }
    };

    if (this.options.enabled?.() === false) {
      report(0, 0, 0, "done");
      return { files: 0, chunks: 0, tookMs: Date.now() - started, engine: "none" };
    }

    // 1) ai-service/Chroma nar den faktiskt svarar (ingen fejkad delegate).
    if (this.options.delegate !== undefined) {
      try {
        const probe = await this.options.delegate.health();
        if (probe.ok) {
          report(0, 0, 0, "scan");
          const outcome = await this.options.delegate.indexCode({ root: this.options.workspace.resolve(opts.root ?? ".") });
          this.meta = {
            engine: "chroma",
            embeddingsModel: `ai-service (${outcome.engine})`,
            vectorSpace: "chroma",
            indexedFiles: outcome.files,
            chunks: outcome.chunks,
            lastIndexedAt: Date.now(),
            root: opts.root ?? ".",
            dimensions: 0,
          };
          report(outcome.files, outcome.files, outcome.chunks, "done");
          return { files: outcome.files, chunks: outcome.chunks, tookMs: Date.now() - started, engine: "chroma" };
        }
      } catch (err) {
        this.lastError = `ai-service indexering misslyckades — indexerar lokalt: ${err instanceof Error ? err.message : String(err)}`;
        this.options.logger.warn(this.lastError, { fas: "3.5" });
      }
    }

    this.indexing = true;
    try {
      const maxFiles = this.options.maxFiles ?? 3000;
      const maxBytes = this.options.maxFileBytes ?? 512_000;
      const candidates = await this.collectFiles(opts.root, maxFiles);
      report(0, candidates.length, 0, "scan");

      const pending: StoredChunk[] = [];
      let filesRead = 0;
      for (const relPath of candidates) {
        try {
          const file = await this.options.workspace.read(relPath, maxBytes);
          if (file.size > maxBytes) continue;
          pending.push(...this.chunkFile(file.path, file.content));
        } catch {
          // Olasbar fil (lassad, saknad) — hoppa over, krascha aldrig.
        }
        filesRead += 1;
        if (filesRead % 40 === 0) report(filesRead, candidates.length, pending.length, "scan");
      }

      report(filesRead, candidates.length, pending.length, "embed");
      const texts = pending.map((chunk) => `${chunk.path}\n${chunk.symbol ?? ""}\n${chunk.text}`);
      const vectors: number[][] = [];
      let model = "";
      let space = "";
      const batchSize = 64;
      for (let offset = 0; offset < texts.length; offset += batchSize) {
        const batch = await this.embed(texts.slice(offset, offset + batchSize));
        if (offset === 0) {
          model = batch.model;
          space = batch.space;
        }
        vectors.push(...batch.vectors);
        report(filesRead, candidates.length, Math.min(texts.length, offset + batchSize), "embed");
      }

      const stored: StoredChunk[] = pending.map((chunk, index) => ({ ...chunk, vector: vectors[index] ?? [] }));
      this.chunks = opts.force === false && this.meta !== null && this.meta.vectorSpace === space
        ? [...this.chunks.filter((c) => !stored.some((s) => s.path === c.path)), ...stored]
        : stored;

      const meta: RagMeta = {
        engine: "jsonl-fallback",
        embeddingsModel: model,
        vectorSpace: space,
        indexedFiles: filesRead,
        chunks: this.chunks.length,
        lastIndexedAt: Date.now(),
        root: opts.root ?? ".",
        dimensions: vectors[0]?.length ?? 0,
      };
      this.meta = meta;
      this.writeIndex(meta);
      report(filesRead, candidates.length, this.chunks.length, "store");
      report(filesRead, candidates.length, this.chunks.length, "done");
      this.options.logger.info("RAG-index fardigt", {
        fas: "3.5",
        files: filesRead,
        chunks: this.chunks.length,
        embeddings: model,
        tookMs: Date.now() - started,
      });
      return { files: filesRead, chunks: this.chunks.length, tookMs: Date.now() - started, engine: "jsonl-fallback" };
    } finally {
      this.indexing = false;
    }
  }

  private writeIndex(meta: RagMeta): void {
    const dir = path.dirname(this.indexFile);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `.rag-tmp-${process.pid}-${Date.now()}`);
      const body = this.chunks.map((chunk) => JSON.stringify(chunk)).join("\n");
      fs.writeFileSync(tmp, `${body}\n`, "utf8");
      fs.renameSync(tmp, this.indexFile);
      fs.writeFileSync(this.metaFile, JSON.stringify(meta, null, 2), "utf8");
    } catch (err) {
      this.lastError = `kunde inte skriva RAG-index: ${err instanceof Error ? err.message : String(err)}`;
      this.options.logger.warn(this.lastError, { fas: "3.5" });
    }
  }

  async search(query: string, k?: number): Promise<RagChunk[]> {
    this.ensureLoaded();
    const top = k && k > 0 ? k : 5;
    if (this.options.enabled?.() === false) return [];

    // 1) Chroma/ai-service om indexet faktiskt ligger dar.
    if (this.meta?.engine === "chroma" && this.options.delegate !== undefined) {
      try {
        const chunks = await this.options.delegate.query({ query, k: top });
        if (chunks.length > 0) return chunks.slice(0, top);
      } catch (err) {
        this.options.logger.warn("RAG: ai-service-sökning svarade inte, söker lokalt", {
          fas: "3.5",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (this.chunks.length === 0) return [];

    // 2) Vektorsokning nar vektorrymden kan reproduceras for fragan.
    const queryVector = await this.vectorForQuery(query);
    const scored: RagChunk[] = [];
    if (queryVector !== null) {
      for (const chunk of this.chunks) {
        if (chunk.vector.length === 0 || chunk.vector.length !== queryVector.length) continue;
        scored.push({ ...toRagChunk(chunk), score: cosine(queryVector, chunk.vector) });
      }
    } else {
      // 3) Rent lexikalt lage — ingen vektor alls, bara lagrad text.
      for (const chunk of this.chunks) {
        scored.push({ ...toRagChunk(chunk), score: lexicalScore(query, chunk) });
      }
    }
    if (scored.length === 0) return [];
    scored.sort((a, b) => b.score - a.score);
    return scored.filter((chunk) => chunk.score > 0).slice(0, top);
  }

  /**
   * Frakturvektor for fragan i indexets egen vektorrymd. Lyckas inte modellagret
   * (offline efter indexeringen) returneras null och sokningen gor rent lexikalt.
   */
  private async vectorForQuery(query: string): Promise<number[] | null> {
    const space = this.meta?.vectorSpace ?? "";
    if (space.startsWith("lexical-hash-")) {
      return lexicalVector(query, this.meta?.dimensions ?? 512);
    }
    if (space.startsWith("model:") && this.options.embedder !== undefined) {
      try {
        const { vectors } = await this.options.embedder([query]);
        const result = vectors[0] ?? [];
        if (result.length === 0) return null;
        const match = this.chunks[0]?.vector.length ?? result.length;
        return result.length === match ? normalize(result) : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Rensa indexet (anvs av settings — och av tester som vill se en tom yta). */
  clear(): void {
    this.chunks = [];
    this.meta = null;
    this.loaded = true;
    try {
      if (fs.existsSync(this.indexFile)) fs.rmSync(this.indexFile, { force: true });
      if (fs.existsSync(this.metaFile)) fs.rmSync(this.metaFile, { force: true });
    } catch (err) {
      this.options.logger.warn("RAG: kunde inte rensa index", { fas: "3.5", error: String(err) });
    }
  }
}

function toRagChunk(chunk: StoredChunk): RagChunk {
  const base: RagChunk = {
    id: chunk.id,
    path: chunk.path,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    text: chunk.text,
    score: 0,
  };
  return chunk.symbol === undefined ? base : { ...base, symbol: chunk.symbol };
}

/** Token-overlap (0..1) med bonus for soksord i path/symbol. Utan vektorer. */
function lexicalScore(query: string, chunk: StoredChunk): number {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return 0;
  const chunkTokens = tokenize(chunk.text);
  const counts = new Map<string, number>();
  for (const token of chunkTokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  let hits = 0;
  for (const token of queryTokens) {
    const count = counts.get(token);
    if (count !== undefined) hits += Math.log1p(count);
  }
  const pathTokens = tokenize(chunk.path);
  const symbolTokens = tokenize(chunk.symbol ?? "");
  let bonus = 0;
  for (const token of queryTokens) {
    if (pathTokens.includes(token)) bonus += 0.5;
    if (symbolTokens.includes(token)) bonus += 0.75;
  }
  const length = Math.sqrt(Math.max(1, chunkTokens.length));
  return (hits + bonus) / length;
}

/**
 * store.ts — persistant vector-store för RAG (FAS 3.5, P0: "Vector DB (Chroma eller
 * JSONL-fallback) persistent under `.nexus/`").
 *
 * Två implementeringar med samma roll men olika garanti:
 *   JsonlVectorStore — vår egen, alltid tillgängliga fallback. Append-friendly JSONL
 *     plus en atomisk manifest med per-fil innehålls-hash. Det är den som gör indexet
 *     återupptagbart efter en krasch och det är den testerna kör mot.
 *   ChromaIndex — tunt skal på ai-service (/rag/index, /rag/query, /rag/status).
 *     Används BARA om tjänsten faktiskt svarar; RagService rapporterar då engine
 *     "chroma". Python behövs aldrig för att funktionen ska fungera.
 *
 * Varför JSONL och inte sqlite: den här miljön tål inga native-beroenden (node-pty
 * fick already bockas av av samma anledning), och en append-only fil är trivialt
 * återställbar för handen. Sökningen är linjär i minnet — för ett IDE-index på några
 * tusen chunks är det snabbare än att hålla en server igång.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { RagChunk, RagStatus } from "@nexus/protocol";
import type { ChunkDraft, ChunkKind } from "./chunker";
import { cosineSimilarity } from "./embedder";
import type { Logger } from "../logger";

/** Chunk med sin vektor — det som ligger på disk. */
export interface StoredChunk extends ChunkDraft {
  readonly vector: number[];
}

export interface QueryHit {
  readonly chunk: StoredChunk;
  readonly score: number;
}

export interface FileRecord {
  readonly hash: string;
  readonly chunks: number;
  readonly bytes: number;
  readonly indexedAt: number;
}

export interface StoreStats {
  readonly files: number;
  readonly chunks: number;
  readonly dimension: number;
  readonly engine: RagStatus["engine"];
  readonly corruptLines: number;
}

export interface LoadReport {
  readonly chunks: number;
  readonly files: number;
  readonly corruptLines: number;
  readonly manifestRepaired: boolean;
}

const STORE_VERSION = 1;
const CHUNKS_FILE = "chunks.jsonl";
const MANIFEST_FILE = "manifest.json";

/** sha256 av innehållet — grunden för både resume och incrementell indexering. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface ManifestShape {
  readonly version: number;
  readonly dimension: number;
  readonly updatedAt: number;
  readonly engine: RagStatus["engine"];
  readonly files: Record<string, FileRecord>;
}

/** Radtyp i chunks.jsonl: "c" = chunk, "x" = gravsten för hela filen. */
type LineRecord =
  | { readonly t: "c"; readonly f: string; readonly c: StoredChunk }
  | { readonly t: "x"; readonly f: string };

function isFiniteNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

function positiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

const KINDS: ChunkKind[] = ["symbol", "section", "document", "body", "window"];

function isChunkKind(value: unknown): value is ChunkKind {
  return typeof value === "string" && (KINDS as string[]).includes(value);
}

function writeAtomicSync(target: string, text: string): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.nexus-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, text, { encoding: "utf8" });
  fs.renameSync(tmp, target);
}

export class JsonlVectorStore {
  readonly engine: RagStatus["engine"] = "jsonl-fallback";
  private readonly dir: string;
  private readonly logger: Logger;
  private readonly chunks = new Map<string, StoredChunk>();
  private readonly files = new Map<string, FileRecord>();
  private readonly filePaths = new Map<string, Set<string>>();
  private dimension = 0;
  private corruptLines = 0;
  private manifestRepaired = false;
  private loaded = false;

  constructor(opts: { dir: string; logger: Logger }) {
    this.dir = path.resolve(opts.dir);
    this.logger = opts.logger;
  }

  get storeDir(): string {
    return this.dir;
  }

  /** Sann om senaste `load()` hittade trasiga rader eller manifest — RagService utlöser ombyggnad. */
  get corrupted(): boolean {
    return this.corruptLines > 0 || this.manifestRepaired;
  }

  private get chunksFile(): string {
    return path.join(this.dir, CHUNKS_FILE);
  }

  private get manifestFile(): string {
    return path.join(this.dir, MANIFEST_FILE);
  }

  /**
   * Läs och VALIDERA allt på disk. En trasig fil är ett normal tillstånd (krasch under
   * skrivning), aldrig ett undantag: rader som inte går att parsas kastas, drabbade
   * filer tappas ur manifestet och `corrupted` flaggas så att indexern bygger om dem.
   */
  async load(): Promise<LoadReport> {
    this.loaded = true;
    this.chunks.clear();
    this.files.clear();
    this.filePaths.clear();
    this.corruptLines = 0;
    this.manifestRepaired = false;

    let raw = "";
    try {
      raw = await fsp.readFile(this.chunksFile, "utf8");
    } catch {
      raw = "";
    }
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const pendingByFile = new Map<string, StoredChunk[]>();
    const corruptFiles = new Set<string>();

    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Trasig/avhuggen rad (typiskt en halv skrivning före kraschen).
        this.corruptLines += 1;
        continue;
      }
      const rec = parsed as { t?: unknown; f?: unknown; c?: unknown } | null;
      if (!rec || typeof rec.f !== "string") {
        this.corruptLines += 1;
        continue;
      }
      if (rec.t === "x") {
        this.dropFileFromMemory(rec.f);
        pendingByFile.delete(rec.f);
        this.files.delete(rec.f);
        continue;
      }
      if (rec.t !== "c") {
        this.corruptLines += 1;
        continue;
      }
      const c = rec.c as (Partial<StoredChunk> & { vector?: unknown }) | null;
      const valid =
        !!c &&
        typeof c.id === "string" &&
        c.path === rec.f &&
        typeof c.text === "string" &&
        positiveInt(c.startLine) &&
        positiveInt(c.endLine) &&
        (c.endLine as number) >= (c.startLine as number) &&
        isChunkKind(c.kind) &&
        isFiniteNumberArray(c.vector);
      if (!valid || !c || !c.path || !c.id || !c.vector) {
        this.corruptLines += 1;
        corruptFiles.add(rec.f);
        continue;
      }
      const vector = c.vector;
      if (this.dimension === 0) this.dimension = vector.length;
      else if (vector.length !== this.dimension) {
        // Blandade dimensioner = index från en annan embedder. Raden kastas, filen
        // byggs om med nuvarande embedder — aldrig blandas vektorer i samma search.
        this.corruptLines += 1;
        corruptFiles.add(rec.f);
        continue;
      }
      const stored: StoredChunk = {
        id: c.id,
        path: c.path,
        startLine: c.startLine as number,
        endLine: c.endLine as number,
        text: c.text,
        symbol: typeof c.symbol === "string" ? c.symbol : undefined,
        kind: c.kind,
        vector,
      };
      this.chunks.set(stored.id, stored);
      const bucket = pendingByFile.get(rec.f) ?? [];
      bucket.push(stored);
      pendingByFile.set(rec.f, bucket);
    }

    // Manifestet är den enda källan för "har den här filen redan samma hash?".
    let manifest: ManifestShape | null = null;
    let manifestMissing = false;
    try {
      const text = await fsp.readFile(this.manifestFile, "utf8");
      const parsed = JSON.parse(text) as unknown;
      if (isManifest(parsed)) manifest = parsed;
      else this.manifestRepaired = true;
    } catch (err) {
      manifestMissing = true;
      this.logger.debug("manifest saknas eller är trasig — återskapas från chunks.jsonl", {
        fas: "3.5",
        modul: "rag/store",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (manifest) {
      for (const [file, record] of Object.entries(manifest.files)) {
        const onDisk = pendingByFile.get(file);
        if (!onDisk || onDisk.length === 0) {
          // Manifestet lovar chunker som inte finns på disk → filen måste köras om.
          this.manifestRepaired = true;
          this.corruptedFile(file);
          continue;
        }
        this.files.set(file, record);
        this.filePaths.set(file, new Set(onDisk.map((c) => c.id)));
      }
      // Chunks utan manifestpost = krasch mellan append och manifest. Filen körs om;
      // raderna kastas nu så att omlöpet blir idempotent och utan dubletter.
      for (const [file, bucket] of pendingByFile.entries()) {
        if (this.files.has(file)) continue;
        this.corruptedFile(file);
        for (const c of bucket) this.chunks.delete(c.id);
      }
      if (manifest.dimension > 0 && this.dimension === 0) this.dimension = manifest.dimension;
    } else if (lines.length > 0) {
      // Utan läsbar manifest kan vi inte veta vilka filer som är hela — allt kastas
      // och indexet byggs upp från grunden (idempotent omstart, inga halvdana loven).
      this.manifestRepaired = true;
      for (const bucket of pendingByFile.values()) for (const c of bucket) this.chunks.delete(c.id);
      this.chunks.clear();
      this.dimension = 0;
    }
    for (const file of corruptFiles) {
      if (this.files.has(file)) {
        this.manifestRepaired = true;
        this.corruptedFile(file);
      }
    }

    if (this.corruptLines > 0 || this.manifestRepaired) {
      this.logger.warn("RAG-store: trasiga poster upptäckta — berörda filer byggs om", {
        fas: "3.5",
        modul: "rag/store",
        corruptLines: this.corruptLines,
        manifestRepaired: this.manifestRepaired,
        manifestMissing,
        dir: this.dir,
      });
    }
    return {
      chunks: this.chunks.size,
      files: this.files.size,
      corruptLines: this.corruptLines,
      manifestRepaired: this.manifestRepaired,
    };
  }

  private corruptedFile(file: string): void {
    this.dropFileFromMemory(file);
    this.files.delete(file);
  }

  private dropFileFromMemory(file: string): void {
    const ids = this.filePaths.get(file);
    if (ids) {
      for (const id of ids) this.chunks.delete(id);
      this.filePaths.delete(file);
      return;
    }
    for (const [id, chunk] of this.chunks.entries()) {
      if (chunk.path === file) this.chunks.delete(id);
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  /**
   * Skriv chunks FÖRST, sedan manifest. Ordningen är hela poängen med återupptagbar-
   * heten: kraschar det mellan stegen finns chunk-rader utan manifestpost, och nästa
   * körning kastar dem (se load()) och kör om filen. Kraschar det efter manifest är
   * allt skrivet. Tvärtom — manifest före chunks — skulle ge ett manifest som lovar
   * chunker som aldrig nådde disk, och filen hoppas över för alltid.
   */
  async upsert(
    chunks: readonly StoredChunk[],
    file?: { path: string; hash: string; bytes: number },
  ): Promise<void> {
    await this.ensureLoaded();
    if (chunks.length === 0 && !file) return;
    await fsp.mkdir(this.dir, { recursive: true });

    if (chunks.length > 0) {
      const payload = chunks
        .map((c) => JSON.stringify({ t: "c", f: c.path, c } satisfies LineRecord))
        .join("\n");
      await fsp.appendFile(this.chunksFile, `${payload}\n`, { encoding: "utf8" });
      const ids = new Set<string>();
      for (const c of chunks) {
        this.chunks.set(c.id, c);
        ids.add(c.id);
        if (this.dimension === 0) this.dimension = c.vector.length;
      }
      if (file) this.filePaths.set(file.path, ids);
    }

    if (file) {
      const record: FileRecord = {
        hash: file.hash,
        chunks: this.filePaths.get(file.path)?.size ?? 0,
        bytes: file.bytes,
        indexedAt: Date.now(),
      };
      this.files.set(file.path, record);
      await this.writeManifest();
    }
  }

  async removeFile(p: string): Promise<void> {
    await this.ensureLoaded();
    const known = this.files.has(p) || this.filePaths.has(p) || this.hasChunksOf(p);
    if (!known) return;
    this.dropFileFromMemory(p);
    this.files.delete(p);
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      await fsp.appendFile(this.chunksFile, `${JSON.stringify({ t: "x", f: p } satisfies LineRecord)}\n`, {
        encoding: "utf8",
      });
    } catch (err) {
      this.logger.warn("Kunde inte skriva gravsten för chunker", { fas: "3.5", modul: "rag/store", error: String(err) });
    }
    await this.writeManifest();
  }

  private hasChunksOf(p: string): boolean {
    for (const chunk of this.chunks.values()) if (chunk.path === p) return true;
    return false;
  }

  /** Cosinus-likhet över alla chunks — linjärt, i minnet, utan beroenden. */
  async query(vector: readonly number[], k: number): Promise<QueryHit[]> {
    await this.ensureLoaded();
    const limit = Math.max(1, Math.floor(k));
    if (vector.length === 0 || this.chunks.size === 0) return [];
    const scored: QueryHit[] = [];
    for (const chunk of this.chunks.values()) {
      const score = cosineSimilarity(vector, chunk.vector);
      if (score > 0) scored.push({ chunk, score });
    }
    scored.sort((a, b) => b.score - a.score || a.chunk.path.localeCompare(b.chunk.path));
    return scored.slice(0, limit);
  }

  all(): StoredChunk[] {
    return [...this.chunks.values()];
  }

  chunksOf(p: string): StoredChunk[] {
    const out: StoredChunk[] = [];
    for (const chunk of this.chunks.values()) if (chunk.path === p) out.push(chunk);
    return out.sort((a, b) => a.startLine - b.startLine);
  }

  indexedFiles(): string[] {
    return [...this.files.keys()].sort();
  }

  hashOf(p: string): string | undefined {
    return this.files.get(p)?.hash;
  }

  /** Sant om filen redan är indexerad med exakt detta innehåll (resume + incremental). */
  isCurrent(p: string, hash: string): boolean {
    return this.files.get(p)?.hash === hash;
  }

  stats(): StoreStats {
    return {
      files: this.files.size,
      chunks: this.chunks.size,
      dimension: this.dimension,
      engine: this.engine,
      corruptLines: this.corruptLines,
    };
  }

  get currentDimension(): number {
    return this.dimension;
  }

  /** Töm minne och filer — används före en framtvingad ombyggnad. */
  async clear(): Promise<void> {
    this.chunks.clear();
    this.files.clear();
    this.filePaths.clear();
    this.dimension = 0;
    this.corruptLines = 0;
    this.manifestRepaired = false;
    this.loaded = true;
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(this.chunksFile, "", { encoding: "utf8" });
    await this.writeManifest();
  }

  /**
   * Kompakt atomisk ombyggnad: hela tillståndet skrivs till en temp-fil som rename:as.
   * Gravstenar och dubletter försvinner — filen blir exakt det som finns i minnet.
   */
  async flush(): Promise<void> {
    const byFile = new Map<string, StoredChunk[]>();
    for (const chunk of this.chunks.values()) {
      const bucket = byFile.get(chunk.path) ?? [];
      bucket.push(chunk);
      byFile.set(chunk.path, bucket);
    }
    const lines: string[] = [];
    for (const [file, bucket] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      bucket.sort((a, b) => a.startLine - b.startLine);
      for (const c of bucket) lines.push(JSON.stringify({ t: "c", f: file, c } satisfies LineRecord));
    }
    writeAtomicSync(this.chunksFile, lines.length > 0 ? `${lines.join("\n")}\n` : "");
    await this.writeManifest();
  }

  private async writeManifest(): Promise<void> {
    const files: Record<string, FileRecord> = {};
    for (const [file, record] of [...this.files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) files[file] = record;
    const manifest: ManifestShape = {
      version: STORE_VERSION,
      dimension: this.dimension,
      updatedAt: Date.now(),
      engine: this.engine,
      files,
    };
    writeAtomicSync(this.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

function isManifest(value: unknown): value is ManifestShape {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.version !== "number" || typeof v.dimension !== "number") return false;
  if (typeof v.updatedAt !== "number") return false;
  const engine = v.engine;
  if (engine !== "chroma" && engine !== "jsonl-fallback" && engine !== "none") return false;
  const files = v.files;
  if (typeof files !== "object" || files === null) return false;
  for (const record of Object.values(files as Record<string, unknown>)) {
    if (typeof record !== "object" || record === null) return false;
    const r = record as Record<string, unknown>;
    if (typeof r.hash !== "string" || typeof r.chunks !== "number" || typeof r.bytes !== "number") return false;
    if (typeof r.indexedAt !== "number") return false;
  }
  return true;
}

// =====================================================================
// ChromaIndex — valfitt lyft, aldrig ett krav
// =====================================================================

/** Den delen av AiServiceClient som chroma-vägen behöver (strukturell, så tester kan fejka). */
export interface ChromaBridge {
  indexCode(a: { root: string }): Promise<{ files: number; chunks: number; engine: string }>;
  query(a: { query: string; k?: number }): Promise<RagChunk[]>;
  status(): Promise<RagStatus>;
  health?(): Promise<{ ok: boolean; error?: string }>;
}

export interface ChromaReport {
  readonly reachable: boolean;
  readonly engine: string;
  readonly chunks: number;
  readonly files: number;
  readonly error?: string;
}

/**
 * Chroma-vägen: om Python-tjänsten faktiskt svarar på /rag/index FÖREDRAGS den
 * (RagStatus.engine sätts till "chroma") men bara som extra träffkälla — JSONL-storen
 * förblir den lexikala grunden och reserven om Python faller under samtalsrundan.
 *
 * AVVIKELSE (dokumenterad): chroma-indexet är text-in/text-out över HTTP
 * (/rag/query tar en naturlig språkfråga, inte en vektor) och kan därför inte uppfylla
 * samma `query(vector, k)` som JsonlVectorStore. Att låtsas som att det kunde hade
 * dölja vilken engine som faktiskt svarade — därför en egen klass med egen signatur.
 */
export class ChromaIndex {
  private probed = false;
  private reachable = false;

  constructor(
    private readonly bridge: ChromaBridge,
    private readonly logger: Logger,
  ) {}

  get engine(): RagStatus["engine"] {
    return "chroma";
  }

  get isReachable(): boolean {
    return this.reachable;
  }

  /** Hälsa + status i ett kort försök med tidsgräns. Aldrig ett kast — R5. */
  async probe(timeoutMs = 1500): Promise<ChromaReport> {
    this.probed = true;
    try {
      if (this.bridge.health) {
        const h = await this.withTimeout(this.bridge.health(), timeoutMs);
        if (!h.ok) {
          this.reachable = false;
          return { reachable: false, engine: "none", chunks: 0, files: 0, error: h.error ?? "ai-service health ok=false" };
        }
      }
      const st = await this.withTimeout(this.bridge.status(), timeoutMs);
      this.reachable = true;
      return { reachable: true, engine: st.engine, chunks: st.chunks, files: st.indexedFiles, error: st.error };
    } catch (err) {
      this.reachable = false;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.debug("ai-service/chroma är inte reachable — JSONL-fallback används", {
        fas: "3.5",
        modul: "rag/store",
        error: message,
      });
      return { reachable: false, engine: "none", chunks: 0, files: 0, error: message };
    }
  }

  /** Be tjänsten bygga sitt eget index. Returnerar vad som hände, kastar aldrig. */
  async index(root: string): Promise<ChromaReport> {
    if (!this.probed) await this.probe();
    if (!this.reachable) return { reachable: false, engine: "none", chunks: 0, files: 0, error: "inte reachable" };
    try {
      const res = await this.bridge.indexCode({ root });
      return { reachable: true, engine: res.engine || "chroma", chunks: res.chunks, files: res.files };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.reachable = false;
      this.logger.warn("chroma /rag/index misslyckades — faller tillbaka till jsonl-fallback", {
        fas: "3.5",
        modul: "rag/store",
        error: message,
      });
      return { reachable: false, engine: "none", chunks: 0, files: 0, error: message };
    }
  }

  /** Text-sökning hos chroma. Tom lista vid alla fel — aldrig ett kast. */
  async search(query: string, k: number): Promise<RagChunk[]> {
    if (!this.reachable) return [];
    try {
      const chunks = await this.bridge.query({ query, k });
      return Array.isArray(chunks) ? chunks : [];
    } catch (err) {
      this.reachable = false;
      this.logger.warn("chroma /rag/query svarade inte — lokalt index används", {
        fas: "3.5",
        modul: "rag/store",
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    // En extra fångare gör att en senare rejection inte lämnar en obevakad
    // unhandled rejection om tidsgränsen hinner vinna tävlan.
    const guarded = promise.catch((err: unknown): never => {
      throw err;
    });
    guarded.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`ai-service svarar inte inom ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([guarded, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

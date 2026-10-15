/**
 * workspace.ts — WorkspaceService (FAS 2.4).
 *
 * Trädlista med ignore-regler, atomic read/write med CRLF-bevarande,
 * search via verkligt ripgrep-binär med pure-JS-fallback (samma SearchResponse),
 * languageOf för 50+ språk, och en resolve() som HÅRT blockerar rot-flykt.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import type { Checkpoint, FsFile, FsNode, SearchHit, SearchOptions, SearchResponse, WriteResult } from "@nexus/protocol";
import type { Logger } from "./logger";

const IGNORE_DIRS = new Set(["node_modules", "dist", ".git", ".venv", "release", ".nexus", "out", "build", "target"]);

/** Extention → språk. Måste täcka >= 50 distinkta språk (test verifierar). */
const EXT_LANGUAGES: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".json": "json",
  ".jsonc": "jsonc",
  ".json5": "json5",
  ".css": "css",
  ".scss": "scss",
  ".sass": "sass",
  ".less": "less",
  ".pcss": "postcss",
  ".html": "html",
  ".htm": "html",
  ".xhtml": "html",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
  ".md": "markdown",
  ".mdx": "mdx",
  ".markdown": "markdown",
  ".rst": "restructuredtext",
  ".py": "python",
  ".pyi": "python",
  ".ipynb": "jupyter",
  ".rb": "ruby",
  ".rake": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".sc": "scala",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".cs": "csharp",
  ".m": "objective-c",
  ".mm": "objective-cpp",
  ".php": "php",
  ".pl": "perl",
  ".pm": "perl",
  ".lua": "lua",
  ".r": "r",
  ".R": "r",
  ".jl": "julia",
  ".dart": "dart",
  ".groovy": "groovy",
  ".gradle": "groovy",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".fish": "shellscript",
  ".bat": "bat",
  ".cmd": "bat",
  ".ps1": "powershell",
  ".psm1": "powershell",
  ".psd1": "powershell",
  ".sql": "sql",
  ".mysql": "sql",
  ".pgsql": "sql",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".ini": "ini",
  ".cfg": "ini",
  ".properties": "properties",
  ".xml": "xml",
  ".xsl": "xslt",
  ".xslt": "xslt",
  ".svg": "xml",
  ".plist": "xml",
  ".tf": "terraform",
  ".tfvars": "terraform-vars",
  ".hcl": "hcl",
  ".proto": "protobuf",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".hs": "haskell",
  ".lhs": "haskell",
  ".elm": "elm",
  ".erl": "erlang",
  ".hrl": "erlang",
  ".ex": "elixir",
  ".exs": "elixir",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".fs": "fsharp",
  ".fsx": "fsharp",
  ".clj": "clojure",
  ".cljc": "clojure",
  ".cljs": "clojure",
  ".edn": "clojure",
  ".nim": "nim",
  ".zig": "zig",
  ".cr": "crystal",
  ".coffee": "coffeescript",
  ".hbs": "handlebars",
  ".handlebars": "handlebars",
  ".pug": "pug",
  ".jade": "pug",
  ".tex": "latex",
  ".cls": "latex",
  ".bib": "bibtex",
  ".adoc": "asciidoc",
  ".asc": "asciidoc",
  ".txt": "plaintext",
  ".text": "plaintext",
  ".vim": "viml",
  ".sol": "solidity",
  ".prisma": "prisma",
  ".v": "verilog",
  ".sv": "systemverilog",
  ".pas": "pascal",
  ".dpr": "pascal",
  ".inc": "pascal",
  ".adb": "ada",
  ".ads": "ada",
  ".asm": "assembly",
  ".s": "assembly",
  ".f90": "fortran",
  ".for": "fortran",
  ".cob": "cobol",
  ".cbl": "cobol",
  ".tcl": "tcl",
  ".pro": "prolog",
  ".swiftu": "swift",
  ".bzl": "starlark",
  ".bazel": "starlark",
  ".cmake": "cmake",
  ".dockerfile": "dockerfile",
  ".make": "makefile",
  ".mk": "makefile",
  ".csv": "csv",
  ".tsv": "tsv",
};

/** Exakta filnamn → språk (case-insensitive match på basename). */
const NAME_LANGUAGES: Record<string, string> = {
  "dockerfile": "dockerfile",
  "makefile": "makefile",
  "gnumakefile": "makefile",
  "cmakelists.txt": "cmake",
  ".gitignore": "gitignore",
  ".gitattributes": "gitattributes",
  ".gitconfig": "ini",
  ".env": "dotenv",
  ".editorconfig": "ini",
  "pkgbuild": "shellscript",
  "gemfile": "ruby",
  "rakefile": "ruby",
  "justfile": "just",
  "vagrantfile": "ruby",
  "jenkinsfile": "groovy",
  "jakefile": "javascript",
  "gruntfile.js": "javascript",
  "gulpfile.js": "javascript",
  ".babelrc": "jsonc",
  ".eslintrc": "jsonc",
  ".prettierrc": "jsonc",
  "license": "plaintext",
  "readme": "markdown",
  ".bashrc": "shellscript",
  ".zshrc": "shellscript",
  ".profile": "shellscript",
  "cmakelists": "cmake",
  "build.gradle": "groovy",
  "settings.gradle": "groovy",
  "podfile": "ruby",
};

/** Rengör och normalisera en glob till en RegExp (varken ** * ?). */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if ("\\^.[]$|+(){}".includes(ch as string)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp("^" + re + "$", "i");
}

function matchGlob(pattern: string | undefined, relPosix: string, baseName: string): boolean {
  if (!pattern) return false;
  const re = globToRegExp(pattern);
  return re.test(relPosix) || re.test(baseName) || (pattern.includes("/") && re.test("/" + relPosix));
}

/** Skyddet som avgör om en upplöst sökväg ligger innanför roten — ren funktion, testbar. */
export function isInsideRoot(rootAbs: string, targetAbs: string): boolean {
  const normalizedRoot = path.resolve(rootAbs);
  const normalizedTarget = path.resolve(targetAbs);
  if (normalizedTarget === normalizedRoot) return true;
  const rel = path.relative(normalizedRoot, normalizedTarget);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

export class WorkspaceService {
  private readonly root: string;
  private readonly logger: Logger;
  private readonly rootReal: string;

  constructor(opts: { root: string; logger: Logger }) {
    this.root = path.resolve(opts.root);
    this.logger = opts.logger;
    this.rootReal = this.safeRealpath(this.root);
  }

  private safeRealpath(p: string): string {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  }

  /** Absolut sökväg med hård rot-bevakning; kastar om målet flyr ur workspacet. */
  resolve(p: string): string {
    if (typeof p !== "string" || p.length === 0) {
      throw new Error("Tom sökväg");
    }
    const cleaned = p.replace(/\\/g, "/");
    const abs = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(this.root, cleaned);
    if (!isInsideRoot(this.root, abs)) {
      this.logger.warn("Sökvägsflykt blockerad", { fas: "2.4", attempt: p });
      throw new Error(`Sökvägen flyr ur workspacet: ${p}`);
    }
    // Skydd mot symlevl-flykt: följ verkliga länkar för eksisterande noder.
    const probe = this.existingAncestor(abs);
    if (probe) {
      const real = this.safeRealpath(probe);
      if (!isInsideRoot(this.rootReal, real)) {
        this.logger.warn("Symlevl-flykt blockerad", { fas: "2.4", attempt: p });
        throw new Error(`Sökvägen flyr ur workspacet via symlevl: ${p}`);
      }
    }
    return abs;
  }

  /** Närmsta eksisterande förfader (länkar kan bara följas om något finns på disk). */
  private existingAncestor(abs: string): string | null {
    let cur = abs;
    for (let guard = 0; guard < 64; guard++) {
      try {
        fs.lstatSync(cur);
        return cur;
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) return null;
        cur = parent;
      }
    }
    return null;
  }

  private relPosix(abs: string): string {
    return toPosix(path.relative(this.root, abs)) || ".";
  }

  async listTree(root?: string, depth?: number): Promise<FsNode[]> {
    const startAbs = root ? this.resolve(root) : this.root;
    const maxDepth = depth && depth > 0 ? depth : 4;
    return this.walkDir(startAbs, maxDepth);
  }

  private async walkDir(dir: string, remainingDepth: number): Promise<FsNode[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes: FsNode[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = this.relPosix(abs);
      if (entry.isDirectory()) {
        const children = remainingDepth > 1 ? await this.walkDir(abs, remainingDepth - 1) : [];
        nodes.push({ name: entry.name, path: rel, kind: "dir", children });
      } else if (entry.isFile()) {
        let size: number | undefined;
        try {
          size = (await fsp.stat(abs)).size;
        } catch {
          size = undefined;
        }
        nodes.push({ name: entry.name, path: rel, kind: "file", size });
      }
    }
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return nodes;
  }

  async read(p: string, maxBytes?: number): Promise<FsFile> {
    const abs = this.resolve(p);
    const stat = await fsp.stat(abs);
    const cap = maxBytes && maxBytes > 0 ? maxBytes : Number.POSITIVE_INFINITY;
    let truncated = false;
    let buffer: Buffer;
    if (stat.size > cap) {
      const fd = await fsp.open(abs, "r");
      try {
        buffer = Buffer.alloc(cap);
        await fd.read(buffer, 0, cap, 0);
      } finally {
        await fd.close();
      }
      truncated = true;
    } else {
      buffer = await fsp.readFile(abs);
    }
    return {
      path: this.relPosix(abs),
      content: buffer.toString("utf8"),
      language: this.languageOf(this.relPosix(abs)),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      truncated,
    };
  }

  /** Atomic temp+rename, CRLF-bevarande utifrån filens nuvarande radavslut. */
  async write(p: string, content: string, meta?: { source?: Checkpoint["source"]; label?: string }): Promise<WriteResult> {
    const abs = this.resolve(p);
    let existing = "";
    let exists = false;
    try {
      existing = await fsp.readFile(abs, "utf8");
      exists = true;
    } catch {
      exists = false;
    }
    const usesCrlf = exists && /\r\n/.test(existing) && !/\r\n/.test(content);
    const finalContent = usesCrlf ? content.replace(/\r?\n/g, "\r\n") : content;
    if (exists && finalContent === existing) {
      return { path: this.relPosix(abs), bytes: Buffer.byteLength(existing), created: false, unchanged: true };
    }
    const dir = path.dirname(abs);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.nexus-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fsp.writeFile(tmp, finalContent, { encoding: "utf8" });
    await fsp.rename(tmp, abs);
    this.logger.info("Fil skriven", { fas: "2.4", path: this.relPosix(abs), source: meta?.source, label: meta?.label });
    return {
      path: this.relPosix(abs),
      bytes: Buffer.byteLength(finalContent),
      created: !exists,
      unchanged: false,
    };
  }

  async createNode(p: string, kind: "file" | "dir"): Promise<WriteResult> {
    const abs = this.resolve(p);
    if (kind === "dir") {
      await fsp.mkdir(abs, { recursive: true });
      return { path: this.relPosix(abs), bytes: 0, created: true, unchanged: false };
    }
    let existed = true;
    try {
      await fsp.access(abs);
    } catch {
      existed = false;
    }
    if (!existed) {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, "", { encoding: "utf8" });
    }
    return { path: this.relPosix(abs), bytes: existed ? 0 : 0, created: !existed, unchanged: existed };
  }

  async rename(from: string, to: string): Promise<WriteResult> {
    const absFrom = this.resolve(from);
    const absTo = this.resolve(to);
    await fsp.mkdir(path.dirname(absTo), { recursive: true });
    await fsp.rename(absFrom, absTo);
    this.logger.info("Ompåkt", { fas: "2.4", from: this.relPosix(absFrom), to: this.relPosix(absTo) });
    return { path: this.relPosix(absTo), bytes: 0, created: false, unchanged: false };
  }

  async remove(p: string): Promise<void> {
    const abs = this.resolve(p);
    await fsp.rm(abs, { recursive: true, force: true });
    this.logger.info("Bortagen", { fas: "2.4", path: this.relPosix(abs) });
  }

  languageOf(p: string): string {
    const base = path.basename(p);
    const lower = base.toLowerCase();
    const byName = NAME_LANGUAGES[lower];
    if (byName) return byName;
    // Specialfall: Dockerfile.foo / .env.production
    if (lower.startsWith("dockerfile")) return "dockerfile";
    if (lower.startsWith(".env")) return "dotenv";
    if (lower.startsWith("makefile")) return "makefile";
    const ext = path.extname(lower);
    if (ext && EXT_LANGUAGES[ext]) return EXT_LANGUAGES[ext] as string;
    // Dubbelände .d.ts etc.
    if (lower.endsWith(".d.ts")) return "typescript";
    return "plaintext";
  }

  watch(cb: (e: { path: string; change: "add" | "change" | "unlink" }) => void): () => void {
    const watcher: FSWatcher = chokidarWatch(this.root, {
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      ignored: (target: string) => {
        const parts = toPosix(target).split("/");
        return parts.some((seg) => IGNORE_DIRS.has(seg));
      },
    });
    watcher.on("add", (p) => cb({ path: this.relPosix(p), change: "add" }));
    watcher.on("change", (p) => cb({ path: this.relPosix(p), change: "change" }));
    watcher.on("unlink", (p) => cb({ path: this.relPosix(p), change: "unlink" }));
    return () => {
      void watcher.close();
    };
  }

  async recent(limit = 10): Promise<FsFile[]> {
    const collected: { abs: string; mtimeMs: number; size: number }[] = [];
    const stack: string[] = [this.root];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (!dir) continue;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORE_DIRS.has(entry.name)) stack.push(abs);
        } else if (entry.isFile()) {
          try {
            const st = await fsp.stat(abs);
            collected.push({ abs, mtimeMs: st.mtimeMs, size: st.size });
          } catch {
            /* ignorera */
          }
        }
      }
    }
    collected.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const files: FsFile[] = [];
    for (const item of collected.slice(0, limit)) {
      try {
        files.push(await this.read(this.relPosix(item.abs), 64 * 1024));
      } catch {
        /* hoppa över oläsbar */
      }
    }
    return files;
  }

  // ---------------- Search ----------------

  /**
   * Upptack en verklig ripgrep-binar enligt specificerad prioritetsordning:
   * RG_PATH, NEXUS_RG_PATH, vanliga installatiosstallen, @vscode/ripgrep.
   * Vi ANTAR inte att rg finns — null ar ett giltigt svar (JS-fallback vantar).
   */
  findRipgrep(): string | null {
    const candidates: string[] = [];
    if (process.env.RG_PATH) candidates.push(process.env.RG_PATH);
    if (process.env.NEXUS_RG_PATH) candidates.push(process.env.NEXUS_RG_PATH);
    const home = os.homedir();
    candidates.push(
      "/usr/bin/rg",
      "/usr/local/bin/rg",
      path.join(home, ".cargo/bin/rg"),
      path.join(home, "scoop/shims/rg.exe"),
      "C:/Program Files/RipGrep/rg.exe",
      path.resolve(this.root, "node_modules/@vscode/ripgrep/bin/rg.exe"),
      path.resolve(this.root, "node_modules/@vscode/ripgrep/bin/rg"),
      path.resolve(this.root, "node_modules/@vscode/ripgrep-15.2.0/bin/rg"),
    );
    for (const c of candidates) {
      try {
        if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
      } catch {
        /* ignorera odugligt candidates */
      }
    }
    return null;
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResponse> {
    const started = Date.now();
    const rg = this.findRipgrep();
    if (rg) {
      try {
        return await this.searchRipgrep(rg, query, opts ?? {}, started);
      } catch (err) {
        this.logger.warn("ripgrep misslyckades — faller tillbaka till JS", { fas: "2.4", error: String(err) });
      }
    }
    return this.searchJs(query, opts ?? {}, started);
  }

  /**
   * Avvikelse (klarhet): tvingar en engine for att kunna jamfora ripgrep och
   * JS-fallback deterministiskt i tester. Soker inte om; kastar om rg saknas och
   * engine='ripgrep' begars. Vanliga anrop anvander search().
   */
  async searchWithEngine(query: string, opts: SearchOptions | undefined, engine: "ripgrep" | "js"): Promise<SearchResponse> {
    const started = Date.now();
    if (engine === "ripgrep") {
      const rg = this.findRipgrep();
      if (!rg) throw new Error("ripgrep hittades inte — kan inte köra vald engine");
      return this.searchRipgrep(rg, query, opts ?? {}, started);
    }
    return this.searchJs(query, opts ?? {}, started);
  }

  private async searchRipgrep(rgPath: string, query: string, opts: SearchOptions, started: number): Promise<SearchResponse> {
    const maxResults = opts.maxResults && opts.maxResults > 0 ? opts.maxResults : 2000;
    const args: string[] = ["--json", "--no-messages"];
    if (opts.isRegex !== true) args.push("--fixed-strings");
    if (opts.isCaseSensitive === true) args.push("--case-sensitive");
    else args.push("--ignore-case");
    if (opts.wholeWord) args.push("--word-regexp");
    for (const dir of IGNORE_DIRS) args.push("--glob", `!${dir}/`);
    if (opts.includeGlob) args.push("--glob", opts.includeGlob);
    if (opts.excludeGlob) args.push("--glob", `!${opts.excludeGlob}`);
    args.push("--", query, ".");

    const stdout = await this.runProcess(rgPath, args, this.root);
    const hits: SearchHit[] = [];
    let numFiles = 0;
    let truncated = false;
    const seenFiles = new Set<string>();
    for (const line of stdout.split(/\r?\n/)) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const obj = parsed as { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string }; submatches?: { match?: { text?: string }; start?: number }[] } };
      if (obj.type !== "match" || !obj.data) continue;
      const relRaw = obj.data.path?.text ?? "";
      // Normalisera till posit FIRST (rg kanreturnera backslash pa Windows),
      // sedan klipp det ledande "./" som sokvagen "." producerar.
      const rel = toPosix(relRaw).replace(/^\.\//, "");
      const lineText = (obj.data.lines?.text ?? "").replace(/\r?\n$/, "");
      const lineNo = obj.data.line_number ?? 1;
      seenFiles.add(rel);
      for (const sub of obj.data.submatches ?? []) {
        if (hits.length >= maxResults) {
          truncated = true;
          break;
        }
        const col = (sub.start ?? 0) + 1;
        hits.push({ path: rel, line: lineNo, column: col, preview: lineText.trim(), match: sub.match?.text ?? query });
      }
      if (truncated) break;
    }
    numFiles = seenFiles.size;
    this.logger.debug("ripgrep-sökning", { fas: "2.4", engine: "ripgrep", matches: hits.length });
    return {
      query,
      tookMs: Date.now() - started,
      numFiles,
      numMatches: hits.length,
      hits,
      truncated,
      engine: "ripgrep",
    };
  }

  private runProcess(bin: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let err = "";
      const child = spawn(bin, args, { cwd, windowsVerbatimArguments: false, env: process.env });
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
        if (stdout.length > 20 * 1024 * 1024) child.kill();
      });
      child.stderr?.on("data", (d: Buffer) => {
        err += d.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        // rg returnerar 1 när inga träffar — det är inte ett fel.
        if (code === 0 || code === 1) resolve(stdout);
        else reject(new Error(`rg exit ${code}: ${err.slice(0, 400)}`));
      });
    });
  }

  /** Pure-JS-walkern — samma SearchResponse-shape, stöder regex/case/word/glob/maxResults. */
  private async searchJs(query: string, opts: SearchOptions, started: number): Promise<SearchResponse> {
    const maxResults = opts.maxResults && opts.maxResults > 0 ? opts.maxResults : 2000;
    const flags = opts.isCaseSensitive === true ? "g" : "gi";
    let pattern: string;
    if (opts.isRegex === true) {
      pattern = opts.wholeWord ? `\\b(?:${query})\\b` : query;
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      pattern = opts.wholeWord ? `\\b${escaped}\\b` : escaped;
    }
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags);
    } catch {
      // Ogiltigt regex → använd den escapade literalen i stället för att kasta.
      regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    }

    const hits: SearchHit[] = [];
    const seenFiles = new Set<string>();
    let truncated = false;
    const stack: string[] = [this.root];
    outer: while (stack.length > 0) {
      const dir = stack.pop();
      if (!dir) continue;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (IGNORE_DIRS.has(entry.name)) continue;
          if (entry.name.startsWith(".")) continue;
          stack.push(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = this.relPosix(abs);
        const base = entry.name;
        if (base.startsWith(".")) continue;
        if (opts.includeGlob && !matchGlob(opts.includeGlob, rel, base)) continue;
        if (opts.excludeGlob && matchGlob(opts.excludeGlob, rel, base)) continue;
        let buffer: Buffer;
        try {
          const st = await fsp.stat(abs);
          if (st.size > 5 * 1024 * 1024) continue;
          buffer = await fsp.readFile(abs);
        } catch {
          continue;
        }
        if (looksBinary(buffer)) continue;
        const text = buffer.toString("utf8");
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const lineText = lines[i] ?? "";
          regex.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = regex.exec(lineText)) !== null) {
            if (hits.length >= maxResults) {
              truncated = true;
              break outer;
            }
            if (m[0].length === 0) {
              regex.lastIndex++;
              continue;
            }
            seenFiles.add(rel);
            hits.push({ path: rel, line: i + 1, column: m.index + 1, preview: lineText.trim(), match: m[0] });
          }
        }
      }
    }
    this.logger.debug("JS-sökning", { fas: "2.4", engine: "js-fallback", matches: hits.length });
    return {
      query,
      tookMs: Date.now() - started,
      numFiles: seenFiles.size,
      numMatches: hits.length,
      hits,
      truncated,
      engine: "js-fallback",
    };
  }

  async replaceInFiles(find: string, replace: string, opts?: SearchOptions): Promise<{ files: string[]; matches: number }> {
    const res = await this.search(find, { ...opts, maxResults: opts?.maxResults ?? 5000 });
    const byFile = new Map<string, SearchHit[]>();
    for (const hit of res.hits) {
      const arr = byFile.get(hit.path) ?? [];
      arr.push(hit);
      byFile.set(hit.path, arr);
    }
    const changed: string[] = [];
    let total = 0;
    for (const [rel, fileHits] of byFile.entries()) {
      const abs = this.resolve(rel);
      const content = await fsp.readFile(abs, "utf8");
      const flags = opts?.isCaseSensitive === true ? "g" : "gi";
      const literal = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(literal, flags);
      const updated = content.replace(re, replace);
      if (updated !== content) {
        await this.write(rel, updated);
        changed.push(rel);
        total += fileHits.length;
      }
    }
    return { files: changed, matches: total };
  }
}

/**
 * checkpoints.ts — CheckpointManager (FAS 7.2 + 2.4).
 *
 * En SKUGGA-git i <root>/.nexus/shadow med sin EGEN git-dir, så användarens
 * riktiga repo/HEAD/index ALDRIG rörts. Alla git-anrop går via child_process med
 * argument-array (ingen shell, inget shell-quoting av `&`), framåt-snak för sökvägar
 * och -c core.quotepath=false för unicode-filnamn.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createTwoFilesPatch, structuredPatch } from "diff";
import type { Checkpoint, FileDiff, DiffHunk } from "@nexus/protocol";
import type { Logger } from "./logger";

interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

interface ManifestEntry {
  id: string;
  label: string;
  source: Checkpoint["source"];
  createdAt: number;
  files: string[];
  shadowCommit: string;
  stats: { added: number; removed: number };
}

export class CheckpointManager {
  private readonly root: string;
  private readonly gitDir: string;
  private readonly logger: Logger;
  private manifest: ManifestEntry[] = [];
  private readonly manifestPath: string;
  private ready = false;

  constructor(opts: { root: string; nexusDir: string; logger: Logger }) {
    this.root = path.resolve(opts.root);
    this.gitDir = path.join(opts.nexusDir, "shadow");
    this.manifestPath = path.join(this.gitDir, "nexus-checkpoints.json");
    this.logger = opts.logger;
  }

  private posix(rel: string): string {
    return rel.split(path.sep).join("/");
  }

  private runGit(args: string[]): Promise<GitResult> {
    const full = ["--git-dir", this.gitDir, "--work-tree", this.root, "-c", "core.quotepath=false", "-c", "core.autocrlf=false", ...args];
    return new Promise((resolve, reject) => {
      const child = spawn("git", full, { cwd: this.root, windowsVerbatimArguments: false, env: process.env });
      const outChunks: Buffer[] = [];
      let stderr = "";
      child.stdout?.on("data", (d: Buffer) => outChunks.push(d));
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("error", (e) => reject(e));
      child.on("close", (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(outChunks), stderr }));
    });
  }

  /** Initierar skugg-git utan att röra användarens repo. */
  async ensure(): Promise<void> {
    if (this.ready) return;
    fs.mkdirSync(this.gitDir, { recursive: true });
    // Redan initierad?
    try {
      const probe = await this.runGit(["rev-parse", "--git-dir"]);
      if (probe.code === 0) {
        this.loadManifest();
        this.ready = true;
        return;
      }
    } catch {
      /* fortätt */
    }
    const init = await this.runGit(["init", "-q"]);
    if (init.code !== 0) {
      throw new Error(`Kunde inte initiera skugg-git: ${init.stderr}`);
    }
    await this.runGit(["config", "core.worktree", this.root]);
    await this.runGit(["config", "core.autocrlf", "false"]);
    this.loadManifest();
    this.ready = true;
    this.logger.info("Skugg-git redo", { fas: "7.2", gitDir: this.posix(path.relative(this.root, this.gitDir)) });
  }

  private loadManifest(): void {
    try {
      this.manifest = JSON.parse(fs.readFileSync(this.manifestPath, "utf8")) as ManifestEntry[];
    } catch {
      this.manifest = [];
    }
  }

  private saveManifest(): void {
    try {
      fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2), { encoding: "utf8" });
    } catch (err) {
      this.logger.warn("Kunde inte skriva checkpoint-manifest", { fas: "7.2", error: String(err) });
    }
  }

  count(): number {
    return this.manifest.length;
  }

  async list(limit?: number): Promise<Checkpoint[]> {
    await this.ensure();
    const ordered = [...this.manifest].reverse();
    const slice = limit && limit > 0 ? ordered.slice(0, limit) : ordered;
    return slice.map((e) => ({ ...e }));
  }

  async currentFiles(): Promise<string[]> {
    await this.ensure();
    const res = await this.runGit(["ls-files"]);
    if (res.code !== 0) return [];
    return res.stdout
      .toString("utf8")
      .split(/\r?\n/)
      .filter((l) => l.length > 0);
  }

  /** Skapar en checkpoint av de givna filerna;.returnerar Checkpoint med shadow-sha. */
  async create(label: string, files: string[], source: Checkpoint["source"]): Promise<Checkpoint> {
    await this.ensure();
    const cleaned = files.map((f) => this.posix(path.isAbsolute(f) ? path.relative(this.root, f) : f)).filter((f) => f.length > 0 && !f.startsWith(".."));

    // Stagea bara de angivna filerna (modifiering + radering), --force för att komma åt ignorerade.
    let stagedBytes = 0;
    if (cleaned.length > 0) {
      const add = await this.runGit(["add", "-A", "--force", "--", ...cleaned]);
      if (add.code !== 0) {
        this.logger.warn("git add misslyckades delvis", { fas: "7.2", stderr: add.stderr.slice(0, 300) });
      }
      for (const f of cleaned) {
        try {
          const abs = path.join(this.root, f.split("/").join(path.sep));
          if (fs.existsSync(abs) && fs.statSync(abs).isFile()) stagedBytes += fs.statSync(abs).size;
        } catch {
          /* raderad fil har ingen storlek */
        }
      }
    }

    const commit = await this.runGit([
      "-c",
      "user.name=NEXUS",
      "-c",
      "user.email=core@nexus.local",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      label,
    ]);
    if (commit.code !== 0) {
      throw new Error(`Kunde inte skapa checkpoint: ${commit.stderr.slice(0, 300)}`);
    }
    const shaRes = await this.runGit(["rev-parse", "HEAD"]);
    const sha = shaRes.stdout.toString("utf8").trim();

    const stats = await this.diffStatsAgainstParent(sha);
    const entry: ManifestEntry = {
      id: randomUUID(),
      label,
      source,
      createdAt: Date.now(),
      files: cleaned,
      shadowCommit: sha,
      stats,
    };
    this.manifest.push(entry);
    this.saveManifest();
    this.logger.info("Checkpoint skapad", { fas: "7.2", id: entry.id, sha, files: cleaned.length, bytes: stagedBytes });
    return { ...entry };
  }

  private async parentOf(sha: string): Promise<string | null> {
    const res = await this.runGit(["rev-parse", "--verify", "--quiet", `${sha}^`]);
    if (res.code !== 0) return null;
    return res.stdout.toString("utf8").trim();
  }

  private async blobAt(rev: string, rel: string): Promise<Buffer | null> {
    const res = await this.runGit(["cat-file", "-p", `${rev}:${this.posix(rel)}`]);
    if (res.code !== 0) return null;
    return res.stdout;
  }

  private async diffStatsAgainstParent(sha: string): Promise<{ added: number; removed: number }> {
    const parent = await this.parentOf(sha);
    let added = 0;
    let removed = 0;
    const files = await this.filesInCommit(sha);
    for (const f of files) {
      const before = parent ? (await this.blobAt(parent, f))?.toString("utf8") ?? "" : "";
      const after = (await this.blobAt(sha, f))?.toString("utf8") ?? "";
      const patch = structuredPatch(f, f, before, after, "", "", { context: 3 });
      for (const hunk of patch.hunks) {
        for (const line of hunk.lines) {
          if (line.startsWith("+")) added++;
          else if (line.startsWith("-")) removed++;
        }
      }
    }
    return { added, removed };
  }

  private async filesInCommit(sha: string): Promise<string[]> {
    const res = await this.runGit(["ls-tree", "-r", "--name-only", sha]);
    if (res.code !== 0) return [];
    return res.stdout.toString("utf8").split(/\r?\n/).filter((l) => l.length > 0);
  }

  /** Returnerar verkliga FileDiff-objekt (via diff-paketet) för checkpointens ändringar. */
  async diff(id: string): Promise<FileDiff[]> {
    await this.ensure();
    const entry = this.manifest.find((e) => e.id === id);
    if (!entry) {
      throw new Error(`Checkpoint finns inte: ${id}`);
    }
    const parent = await this.parentOf(entry.shadowCommit);
    const diffs: FileDiff[] = [];
    for (const f of entry.files) {
      const before = parent ? (await this.blobAt(parent, f))?.toString("utf8") ?? "" : "";
      const after = (await this.blobAt(entry.shadowCommit, f))?.toString("utf8") ?? "";
      if (before === after) continue;
      const unified = createTwoFilesPatch(f, f, before, after, "", "", { context: 3 });
      const structured = structuredPatch(f, f, before, after, "", "", { context: 3 });
      const hunks: DiffHunk[] = structured.hunks.map((h) => ({
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        lines: h.lines,
      }));
      let added = 0;
      let removed = 0;
      for (const h of hunks) {
        for (const line of h.lines) {
          if (line.startsWith("+")) added++;
          else if (line.startsWith("-")) removed++;
        }
      }
      diffs.push({ path: f, unified, hunks, added, removed });
    }
    return diffs;
  }

  /** Återställer EXAKTA bytes för checkpointens filer (inkl. raderade → återskapade). */
  async rollback(id: string): Promise<{ restored: string[]; checkpoint: Checkpoint }> {
    await this.ensure();
    const entry = this.manifest.find((e) => e.id === id);
    if (!entry) {
      throw new Error(`Checkpoint finns inte: ${id}`);
    }
    const restored: string[] = [];
    for (const f of entry.files) {
      const blob = await this.blobAt(entry.shadowCommit, f);
      const abs = path.join(this.root, f.split("/").join(path.sep));
      if (blob === null) {
        // Filen existerade inte i checkpointen → radera den om den finns nu.
        try {
          if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
        } catch {
          /* ignorera */
        }
        continue;
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, blob);
      restored.push(f);
    }
    this.logger.info("Checkpoint återställd", { fas: "7.2", id, restored: restored.length });
    return { restored, checkpoint: { ...entry } };
  }
}

#!/usr/bin/env node
/**
 * nexus-git.mjs — NEXUS-IDE:s egen git-MCP-server (FAS 4.3).
 *
 * Kör riktiga git-operationer via child_process.spawn mot den installerade
 * git-binären (ingen skalkommando-sammanfogning, ingen injection).
 * Läsverktygen är märkta readOnly:true via MCP-annotationer.
 *
 * Start:  node <absolut sökväg>/nexus-git.mjs --repo <worktree>
 *
 * Verktyg: status, diff, log, show, branch_list (read-only) + stage, commit.
 */

import { z } from "zod";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { errorResult, okResult, parseArgs, resolveWithinRoots, startStdioServer, trackChild } from "./nexus_mcp_lib.mjs";

const args = parseArgs(process.argv.slice(2));
const configuredRepo = args.flags["repo"]?.[0] ?? process.cwd();
const repoRoot = resolve(configuredRepo);
// NEXUS_MCP_SERVER_ID kan vara insatt av klienten (server-id fra mcp.json) sa
// stderr-righteln far tagg av den faktiska registernheten, inte bara skriptnamnet.
process.env.NEXUS_MCP_SERVER_ID ??= "nexus-git";

const gitBin = process.env.NEXUS_GIT_BIN ?? "git";

/**
 * Kör git med ett args-array (ALDRIG som en kommandosträng).
 * @param {string[]} gitArgs
 * @param {{ timeoutMs?: number, input?: string }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string, timedOut: boolean }>}
 */
function runGit(gitArgs, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  return new Promise((res) => {
    const child = trackChild(spawn(gitBin, ["-C", repoRoot, ...gitArgs], { shell: false, windowsHide: true }));
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      res({ code: -1, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      res({ code: timedOut ? -1 : (code ?? -1), stdout, stderr, timedOut });
    });
    if (options.input !== undefined && child.stdin) {
      child.stdin.end(options.input);
    }
  });
}

/**
 * Gemensamt felformat när git svarar icke-noll — texten är riktig, ingen tyst crash.
 * @param {{code:number,stdout:string,stderr:string,timedOut:boolean}} r
 */
function gitFailure(r) {
  if (r.timedOut) return "timeout: git-processen avbröts efter 20 s.";
  return `git exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 800)}`;
}

/**
 * Kontrollera att --repo pekar på ett riktigt worktree före första anropet.
 * @returns {Promise<string | null>} felmeddelande eller null
 */
async function verifyRepo() {
  if (!existsSync(repoRoot)) return `repo saknas: ${repoRoot}`;
  const probe = await runGit(["rev-parse", "--is-inside-work-tree"]);
  if (probe.code !== 0 || probe.stdout.trim() !== "true") {
    return `${repoRoot} är inget git-worktree (${gitFailure(probe)})`;
  }
  return null;
}

/**
 * Validera att ett sökvägsargument inte springer ut ur workträt.
 * @param {string} p
 * @returns {string | { error: string }}
 */
function guardPath(p) {
  try {
    const abs = resolveWithinRoots(isAbsolute(p) ? p : resolve(repoRoot, p), [repoRoot]);
    return abs.slice(repoRoot.length + 1).split("\\").join("/") || p;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** @param {(string | {error:string})[]} guarded */
function firstError(guarded) {
  for (const g of guarded) if (typeof g === "object") return g.error;
  return null;
}

/**
 * Tolkning av `git status --porcelain=v2 --branch -z`.
 *
 * Med -z ar poster NUL-separerade och sökvagen ar sista faltet i en post
 * (for typ 2 kommer originalsökvagen som NATT nästa NUL-post), sa filnamn med
 * mellanslag och flikar gar att tolka utan gissningar. Utan -z klistrar git
 * ihop R100-nytt-namn\tgammalt-namn pa samma rad, vilket inte ar tolkbart.
 *
 * @param {string} text rå stdout från git
 * @returns {{ branch: string|null, aheadBehind: string, staged: string[], unstaged: string[], untracked: string[], conflicts: string[] }}
 */
function parseStatusV2(text) {
  const chunks = text.split("\u0000");
  /** @type {string[]} */
  const staged = [];
  /** @type {string[]} */
  const unstaged = [];
  /** @type {string[]} */
  const untracked = [];
  /** @type {string[]} */
  const conflicts = [];
  let branch = null;
  let aheadBehind = "";

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    if (chunk === undefined || chunk.length === 0) continue;
    if (chunk.startsWith("# branch.head ")) {
      const name = chunk.slice("# branch.head ".length).trim();
      if (name.length > 0 && name !== "(unknown)") branch = name;
      continue;
    }
    if (chunk.startsWith("# branch.ab ")) {
      aheadBehind = chunk.slice("# branch.ab ".length).trim();
      continue;
    }
    if (chunk.startsWith("# ")) continue; // branch.oid, remoteRef, flush

    const fields = chunk.split(" ");
    const kind = fields[0] ?? "";
    const xy = fields[1] ?? "..";
    if (kind === "?") {
      // Ospårad: "? <sökväg>" — hela resten ar sokvagen, mellanslag inkluderade.
      untracked.push(chunk.slice(2).trim());
      continue;
    }
    if (kind === "!") continue; // ignorerad, visas bara med --ignored
    // Antal fasta falten fore sokvagen: 1 -> 8, 2 -> 9 (inkl. R100/C100), u -> 10.
    let pathIndex = 8;
    if (kind === "2") pathIndex = 9;
    else if (kind === "u") pathIndex = 10;
    const path = fields.slice(pathIndex).join(" ");
    if (path.length === 0) continue;

    if (kind === "u") {
      conflicts.push(path);
      unstaged.push(path);
      continue;
    }
    if (kind === "1" || kind === "2") {
      if (xy[0] !== "." && xy[0] !== "?") staged.push(path);
      if (xy[1] !== "." && xy[1] !== "?") unstaged.push(path);
      // Typ 2 har originalsökvagen i nästa NUL-post — hoppa över den så att den
      // inte räknas som en egen, extra ospårad fil.
      if (kind === "2") i += 1;
      continue;
    }
  }
  return { branch, aheadBehind, staged, unstaged, untracked, conflicts };
}

const pathArray = z.array(z.string()).min(1).describe("Filsökvägar relativa workträt.");

await startStdioServer({
  name: "nexus-git",
  version: "1.0.0",
  title: "NEXUS git",
  register: (server) => {
    server.registerTool(
      "status",
      {
        title: "Git status",
        description: "Arbeträdets status: gren, ahead/behind, staged/unstaged/untracked filer.",
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        _meta: { requiresApproval: false },
      },
      async () => {
        const repoError = await verifyRepo();
        if (repoError) return errorResult(repoError);
        const [porcelain, head] = await Promise.all([runGit(["status", "--porcelain=v2", "--branch", "-z"]), runGit(["rev-parse", "--abbrev-ref", "HEAD"])]);
        if (porcelain.code !== 0) return errorResult(gitFailure(porcelain));
        const parsed = parseStatusV2(porcelain.stdout);
        const branch = parsed.branch ?? (head.stdout.trim() || "HEAD");
        const clean = parsed.staged.length === 0 && parsed.unstaged.length === 0 && parsed.untracked.length === 0 && parsed.conflicts.length === 0;
        const raw = porcelain.stdout.split("\u0000").join("\n");
        return okResult(
          {
            repo: repoRoot,
            branch,
            aheadBehind: parsed.aheadBehind,
            clean,
            staged: parsed.staged,
            unstaged: parsed.unstaged,
            untracked: parsed.untracked,
            conflicts: parsed.conflicts,
            // `raw` ar samma data pa den formen manniskor (och testerna) kann
            // lesa — porcelain v2 med NUL som postavgransare ersatt med nyrad.
            raw,
          },
          `branch: ${branch}\n${clean ? "träd är rent" : `staged=${String(parsed.staged.length)} unstaged=${String(parsed.unstaged.length)} untracked=${String(parsed.untracked.length)} conflicts=${String(parsed.conflicts.length)}`}\n${raw}`,
        );
      },
    );

    server.registerTool(
      "diff",
      {
        title: "Git diff",
        description: "Unified diff. staged=true jämför index mot HEAD, annars arbetsträdet mot index.",
        inputSchema: { staged: z.boolean().optional().describe("Visa index-vs-HEAD istället för worktree-vs-index."), paths: z.array(z.string()).optional().describe("Begränsa till dessa sökvägar."), contextLines: z.number().int().min(0).max(50).optional().describe("Antal kontextlinjer.") },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        _meta: { requiresApproval: false },
      },
      async ({ staged, paths, contextLines }) => {
        const repoError = await verifyRepo();
        if (repoError) return errorResult(repoError);
        const scoped = paths ?? [];
        const guarded = scoped.map(guardPath);
        const bad = firstError(guarded);
        if (bad) return errorResult(bad);
        /** @type {string[]} */
        const cmd = ["diff", "--no-color", ...(staged ? ["--cached"] : []), ...(contextLines !== undefined ? [`-U${contextLines}`] : []), ...(scoped.length > 0 ? ["--"] : []), ...scoped];
        const r = await runGit(cmd);
        if (r.code !== 0 && r.code !== 1) return errorResult(gitFailure(r));
        return okResult({ staged: staged === true, text: r.stdout, files: r.stdout.split("diff --git ").filter((s) => s.trim().length > 0).map((s) => s.split("\n")[0] ?? "") }, r.stdout.trim() === "" ? "(ingen diff)" : r.stdout);
      },
    );

    server.registerTool(
      "log",
      {
        title: "Git log",
        description: "Senaste commitsen som JSON (hash, shortHash, författare, datum, ämne, body).",
        inputSchema: { limit: z.number().int().min(1).max(200).optional().describe("Antal commits, standard 20."), paths: z.array(z.string()).optional().describe("Historik för dessa sökvägar."), author: z.string().optional().describe("Filtrera på författare.") },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        _meta: { requiresApproval: false },
      },
      async ({ limit, paths, author }) => {
        const repoError = await verifyRepo();
        if (repoError) return errorResult(repoError);
        const guarded = (paths ?? []).map(guardPath);
        const bad = firstError(guarded);
        if (bad) return errorResult(bad);
        const n = limit ?? 20;
        const sep = "\u001e";
        /** @type {string[]} */
        const cmd = ["log", `-${n}`, `--format=%H${sep}%h${sep}%an${sep}%ae${sep}%aI${sep}%s${sep}%b${sep}`, ...(author ? [`--author=${author}`] : []), ...(paths && paths.length > 0 ? ["--", ...paths] : [])];
        const r = await runGit(cmd);
        if (r.code !== 0) return errorResult(gitFailure(r));
        const commits = r.stdout
          .split(`${sep}\n`)
          .filter((block) => block.trim().length > 0)
          .map((block) => {
            const f = block.split(sep);
            return { hash: f[0] ?? "", shortHash: f[1] ?? "", authorName: f[2] ?? "", authorEmail: f[3] ?? "", date: f[4] ?? "", subject: f[5] ?? "", body: (f[6] ?? "").trim() };
          });
        return okResult({ count: commits.length, commits }, commits.map((c) => `${c.shortHash} ${c.subject} (${c.authorName} ${c.date})`).join("\n") || "(ing commits)");
      },
    );

    server.registerTool(
      "show",
      {
        title: "Git show",
        description: "Visa en revision: metadata och valfritt diff-innehåll.",
        inputSchema: { rev: z.string().min(1).describe("Commit-ref, t.ex. HEAD eller 1a2b3c4."), paths: z.array(z.string()).optional().describe("Visa bara dessa filers diff."), asDiff: z.boolean().optional().describe("Medfölj diff (standard true).") },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        _meta: { requiresApproval: false },
      },
      async ({ rev, paths, asDiff }) => {
        const repoError = await verifyRepo();
        if (repoError) return errorResult(repoError);
        if (!/^[A-Za-z0-9_./~^@{}-]+$/.test(rev)) return errorResult(`ogiltigt rev: ${rev}`);
        const guarded = (paths ?? []).map(guardPath);
        const bad = firstError(guarded);
        if (bad) return errorResult(bad);
        const meta = await runGit(["show", "--no-color", "--format=fuller", ...(asDiff === false ? ["--no-patch"] : ["--stat"]), "--", ...(paths ?? [])].filter((s) => s !== undefined));
        if (meta.code !== 0) return errorResult(gitFailure(meta));
        let patch = "";
        if (asDiff !== false) {
          const p = await runGit(["show", "--no-color", "-p", rev, "--", ...(paths ?? [])]);
          patch = p.code === 0 ? p.stdout : "";
        }
        return okResult({ rev, meta: meta.stdout, patch }, `${meta.stdout}\n${patch}`.slice(0, 200_000));
      },
    );

    server.registerTool(
      "branch_list",
      {
        title: "Git branch list",
        description: "Lokala och fjärrgrenar samt vilken som är aktiv.",
        inputSchema: { includeRemote: z.boolean().optional().describe("Inkludera refs/remotes, standard true.") },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        _meta: { requiresApproval: false },
      },
      async ({ includeRemote }) => {
        const repoError = await verifyRepo();
        if (repoError) return errorResult(repoError);
        const r = await runGit(["branch", "-vv", "--no-color", ...(includeRemote === false ? [] : ["-a"])]);
        if (r.code !== 0) return errorResult(gitFailure(r));
        const rows = r.stdout
          .split("\n")
          .map((l) => l.replace(/\s+$/g, ""))
          .filter((l) => l.length > 0)
          .map((l) => ({ current: l.startsWith("*") || l.startsWith("+"), ref: l.replace(/^[*+\s]+/, "").split(" ")[0] ?? "", detail: l.replace(/^[*+\s]+/, "") }));
        return okResult({ branches: rows, current: rows.find((x) => x.current)?.ref ?? null }, r.stdout);
      },
    );

    server.registerTool(
      "stage",
      {
        title: "Git stage",
        description: "Addera givna filer till indexet. Skriver inte filinnehåll, bara index.",
        inputSchema: { paths: pathArray.describe("Filer att stagea (måste ligga i workträt)."), all: z.boolean().optional().describe("Använd git add -A i hela workträt i stället för att lista filer.") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        _meta: { requiresApproval: false },
      },
      async ({ paths, all }) => {
        const repoError = await verifyRepo();
        if (repoError) return errorResult(repoError);
        /** @type {string[]} */
        let targets = [];
        if (all === true) {
          targets = [];
        } else {
          const guarded = (paths ?? []).map(guardPath);
          const bad = firstError(guarded);
          if (bad) return errorResult(bad);
          targets = /** @type {string[]} */ (guarded.filter((x) => typeof x === "string"));
          if (targets.length === 0) return errorResult("ange minst en sökväg eller all=true");
        }
        const r = await runGit(["add", "-A", ...(all === true ? ["--"] : ["--", ...targets])]);
        if (r.code !== 0) return errorResult(gitFailure(r));
        const after = await runGit(["status", "--porcelain=v2"]);
        return okResult({ staged: targets.length === 0 ? "hela workträt" : targets, status: after.stdout }, `staged: ${targets.join(", ") || "-A"}`);
      },
    );

    server.registerTool(
      "commit",
      {
        title: "Git commit",
        description: "Skapa en commit av indexerade ändringar (signeras aldrig automatiskt).",
        inputSchema: { message: z.string().min(1).describe("Commit-meddelande."), paths: pathArray.optional().describe("Filer som stageas först, sedan commit."), allowEmpty: z.boolean().optional().describe("Tillåt tom commit.") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        _meta: { requiresApproval: true, risk: "medium" },
      },
      async ({ message, paths, allowEmpty }) => {
        const repoError = await verifyRepo();
        if (repoError) return errorResult(repoError);
        if (paths && paths.length > 0) {
          const guarded = paths.map(guardPath);
          const bad = firstError(guarded);
          if (bad) return errorResult(bad);
          const add = await runGit(["add", "-A", "--", .../** @type {string[]} */ (guarded.filter((x) => typeof x === "string"))]);
          if (add.code !== 0) return errorResult(gitFailure(add));
        }
        /** @type {string[]} */
        const cmd = ["commit", "--no-gpg-sign", ...(allowEmpty ? ["--allow-empty"] : []), "-m", message];
        const r = await runGit(cmd);
        if (r.code !== 0) return errorResult(gitFailure(r), { hint: "Saknar git user.name/user.email? Sätt dem i repo-config eller skicka dem via serverns env." });
        const head = await runGit(["rev-parse", "HEAD"]);
        return okResult({ committed: true, sha: head.stdout.trim(), output: r.stdout }, r.stdout);
      },
    );
  },
});

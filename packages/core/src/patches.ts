/**
 * patches.ts — SEARCH/REPLACE med fuzzy-fallback (FAS 7.3).
 *
 * applyPatches: exakt → trimmat → fuzzy (normalisera radslut + indragning + begränsad
 * likhet) → none. Retunerar per-patch matchtyp, failures och efter-text.
 * unifiedDiff + splitDiffToHunks via diff-paketet. applyPatchSet körs atomiskt:
 * antingen skrivs alla filer eller ingen.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createTwoFilesPatch } from "diff";
import type { DiffHunk, FileDiff, SearchReplacePatch } from "@nexus/protocol";

export type MatchKind = "exact" | "trimmed" | "fuzzy" | "none";

function normaliseEol(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Trimmar inledande/avslutande vartav rad och stryper inledande gemensam indragning. */
function normaliseIndent(text: string): string {
  const lines = normaliseEol(text).split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return "";
  const minIndent = Math.min(
    ...nonEmpty.map((l) => {
      const m = /^(\s*)/.exec(l);
      const indent = m?.[1];
      return indent ? indent.length : 0;
    }),
  );
  return lines.map((l) => l.slice(minIndent).replace(/\s+$/, "")).join("\n").trim();
}

/** Normaliserat Levenshtein-avstånd (avgränsat för långa texter). */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen > 6000) return Number.POSITIVE_INFINITY; // för stort för fuzzy — ge upp.
  const prev: number[] = new Array<number>(b.length + 1).fill(0);
  const cur: number[] = new Array<number>(b.length + 1).fill(0);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const left = cur[j - 1] ?? 0;
      const up = prev[j] ?? 0;
      const diag = (prev[j - 1] ?? 0) + cost;
      cur[j] = Math.min(left + 1, up + 1, diag);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j] ?? 0;
  }
  return prev[b.length] ?? Number.POSITIVE_INFINITY;
}

/**
 * Hittar ettintervall i haystack vars normaliserade text ligger inom
 * tröskel-likhet mot needle. Returnerar [start, end] i original-index eller null.
 */
function findFuzzyRange(haystack: string, needle: string, threshold: number): { start: number; end: number } | null {
  const hay = normaliseEol(haystack);
  const normNeedle = normaliseIndent(needle);
  if (normNeedle.length === 0) return null;
  const lines = hay.split("\n");
  // Index till varje rads start i den normaliserade texten.
  const starts: number[] = [];
  let acc = 0;
  for (const l of lines) {
    starts.push(acc);
    acc += l.length + 1;
  }
  const needleLineCount = normNeedle.split("\n").length;
  let best: { start: number; end: number; dist: number } | null = null;
  for (let i = 0; i + needleLineCount - 1 < lines.length; i++) {
    const candidateLines = lines.slice(i, i + needleLineCount);
    const candidate = normaliseIndent(candidateLines.join("\n"));
    if (candidate.length === 0) continue;
    const dist = editDistance(candidate, normNeedle);
    const ratio = 1 - dist / Math.max(candidate.length, normNeedle.length);
    if (ratio >= threshold && (!best || dist < best.dist)) {
      const start = starts[i] ?? 0;
      const endIdx = i + needleLineCount - 1;
      const end = (starts[endIdx] ?? 0) + (lines[endIdx]?.length ?? 0);
      best = { start, end, dist };
    }
  }
  if (!best) return null;
  return { start: best.start, end: best.end };
}

/** En single patch tillämpad på text. Returnerar ny text + matchtyp. */
function applyOne(content: string, patch: SearchReplacePatch): { after: string; kind: MatchKind } {
  const search = patch.search;
  const replace = patch.replace;
  const occ = patch.occurrences && patch.occurrences > 0 ? patch.occurrences : 1;

  // 1) exakt
  let idx = content.indexOf(search);
  if (idx >= 0) {
    return { after: replaceNth(content, search, replace, occ), kind: "exact" };
  }

  // 2) trimmat (ignorera inledande/avslutande mellanslag runt blocket)
  const trimmedSearch = search.replace(/^\s+/, "").replace(/\s+$/, "");
  if (trimmedSearch.length > 0) {
    // Sök efter ettintervall vars trimmade innehåll == trimmade search.
    const lines = content.split("\n");
    const searchLines = trimmedSearch.split("\n").map((l) => l.replace(/\s+$/, ""));
    for (let i = 0; i + searchLines.length - 1 < lines.length; i++) {
      const window = lines.slice(i, i + searchLines.length).map((l) => l.replace(/\s+$/, ""));
      // Tillåt att fönstret har extra indragning men samma trimmade radinnehåll.
      const sameTrimmed = window.every((l, k) => (l.trim() === (searchLines[k] ?? "").trim()) && (searchLines[k] ?? "").trim().length > 0);
      if (sameTrimmed) {
        const before = lines.slice(0, i).join("\n");
        const afterLines = lines.slice(i + searchLines.length).join("\n");
        const joined = (before.length > 0 ? before + "\n" : "") + replace + (afterLines.length > 0 ? "\n" + afterLines : "");
        return { after: joined, kind: "trimmed" };
      }
    }
  }

  // 3) fuzzy
  const fuzzy = findFuzzyRange(content, search, 0.82);
  if (fuzzy) {
    const after = content.slice(0, fuzzy.start) + replace + content.slice(fuzzy.end);
    return { after, kind: "fuzzy" };
  }

  return { after: content, kind: "none" };
}

function replaceNth(content: string, search: string, replace: string, count: number): string {
  if (count === 1) {
    const i = content.indexOf(search);
    if (i < 0) return content;
    return content.slice(0, i) + replace + content.slice(i + search.length);
  }
  // Ersätt `count` förekomster (eller så många som finns).
  let out = "";
  let cursor = 0;
  let done = 0;
  while (done < count) {
    const i = content.indexOf(search, cursor);
    if (i < 0) break;
    out += content.slice(cursor, i) + replace;
    cursor = i + search.length;
    done++;
  }
  out += content.slice(cursor);
  return out;
}

export function applyPatches(
  content: string,
  patches: SearchReplacePatch[],
): { ok: boolean; after: string; matched: MatchKind[]; failures: string[] } {
  let current = content;
  const matched: MatchKind[] = [];
  const failures: string[] = [];
  for (const patch of patches) {
    const res = applyOne(current, patch);
    matched.push(res.kind);
    if (res.kind === "none") {
      failures.push(patch.search.slice(0, 120));
    } else {
      current = res.after;
    }
  }
  return { ok: failures.length === 0, after: current, matched, failures };
}

/** Unified diff (path) mellan före/efter med korrekta hunks och räknade rader. */
export function unifiedDiff(p: string, before: string, after: string): FileDiff {
  const unified = createTwoFilesPatch(p, p, before, after, "", "", { context: 3 });
  const hunks = splitDiffToHunks(unified);
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return { path: p, unified, hunks, added, removed };
}

/** Parsa unified diff → DiffHunk[] (eget robust parser, hanterar flera filer/hunks). */
export function splitDiffToHunks(unified: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = unified.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const oldStart = Number(m[1]);
    const oldLines = m[2] !== undefined ? Number(m[2]) : 1;
    const newStart = Number(m[3]);
    const newLines = m[4] !== undefined ? Number(m[4]) : 1;
    i++;
    const body: string[] = [];
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (next.startsWith("@@") || next.startsWith("--- ") || next.startsWith("+++ ") || next.startsWith("diff ")) break;
      body.push(next);
      i++;
    }
    hunks.push({ oldStart, oldLines, newStart, newLines, lines: body });
  }
  return hunks;
}

export interface PatchFileInput {
  path: string;
  patches: SearchReplacePatch[];
}

export interface PatchFileResult {
  path: string;
  ok: boolean;
  matched: MatchKind[];
  failures: string[];
  before: string;
  after: string;
}

/**
 * Atomisk multi-fil-redigering (FAS 7.3): beräkna allt minnesbundet först;
 * skriv sedan bara om VARJE fil matchade. Annars skrivs ingen fil alls.
 */
export function applyPatchSet(
  root: string,
  files: PatchFileInput[],
): { ok: boolean; results: PatchFileResult[]; written: string[] } {
  const results: PatchFileResult[] = [];
  for (const f of files) {
    const abs = path.join(root, f.path.split("/").join(path.sep));
    let before = "";
    try {
      before = fs.readFileSync(abs, "utf8");
    } catch {
      results.push({ path: f.path, ok: false, matched: [], failures: ["fil saknas"], before: "", after: "" });
      continue;
    }
    const applied = applyPatches(before, f.patches);
    results.push({ path: f.path, ok: applied.ok, matched: applied.matched, failures: applied.failures, before, after: applied.after });
  }

  if (!results.every((r) => r.ok)) {
    return { ok: false, results, written: [] };
  }

  const written: string[] = [];
  for (const r of results) {
    const abs = path.join(root, r.path.split("/").join(path.sep));
    const usesCrlf = /\r\n/.test(r.before) && !/\r\n/.test(r.after);
    const finalContent = usesCrlf ? r.after.replace(/\r?\n/g, "\r\n") : r.after;
    fs.writeFileSync(abs, finalContent, { encoding: "utf8" });
    written.push(r.path);
  }
  return { ok: true, results, written };
}

/**
 * state/fuzzy.ts — fuzzy-match för kommandopalett (Ctrl+Shift+P) och filhittaren (Ctrl+P).
 *
 * Ren funktion, testad. Poängmodell: zusammenhängande match > glesa match, träff vid ord-/
 * sökvägsbörjan och vid skift i camelCase väger extra. Returnerar index så UI:t kan markera
 * bokstäverna i träffen.
 */

export interface FuzzyMatch {
  readonly score: number;
  readonly indices: readonly number[];
  readonly target: string;
}

const BONUS_SEQUENCE = 12;
const BONUS_BOUNDARY = 24;
const BONUS_PREFIX = 30;
const PENALTY_GAP = 3;
const PRUNE_MARGIN = 40;

interface BestSlot {
  score: number;
  indices: number[];
  found: boolean;
}

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, indices: [], target };
  if (target.length === 0) return null;

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // Snabb nekande prövning: alla tecken måste finnas, i ordning.
  let scan = 0;
  for (let ti = 0; ti < t.length && scan < q.length; ti += 1) {
    if (t[ti] === q[scan]) scan += 1;
  }
  if (scan < q.length) return null;

  const best: BestSlot = { score: Number.NEGATIVE_INFINITY, indices: [], found: false };
  const indices: number[] = [];

  const walk = (from: number, queryIndex: number, score: number, prevMatch: number): void => {
    if (queryIndex === q.length) {
      if (!best.found || score > best.score) {
        best.score = score;
        best.indices = [...indices];
        best.found = true;
      }
      return;
    }
    const needed = q.length - queryIndex;
    for (let i = from; i <= t.length - needed; i += 1) {
      if (t[i] !== q[queryIndex]) continue;
      const contiguous = prevMatch === i - 1;
      let add = 1;
      if (isBoundary(target, i)) add += BONUS_BOUNDARY;
      if (contiguous) add += BONUS_SEQUENCE;
      if (i === 0) add += BONUS_PREFIX;
      if (i > 0 && !contiguous) add -= Math.min(PENALTY_GAP, i - prevMatch - 1);
      if (isCaseStep(target, i)) add += 6;
      if (best.found && score + add < best.score - PRUNE_MARGIN) break;
      indices.push(i);
      walk(i + 1, queryIndex + 1, score + add, i);
      indices.pop();
    }
  };
  walk(0, 0, 0, -2);

  if (!best.found) return null;
  return { score: best.score, indices: best.indices, target };
}

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1];
  return prev === "/" || prev === "\\" || prev === "." || prev === "-" || prev === "_" || prev === " ";
}

function isCaseStep(text: string, index: number): boolean {
  if (index === 0) return false;
  const prev = text[index - 1];
  const cur = text[index];
  if (!prev || !cur) return false;
  return prev === prev.toLowerCase() && cur === cur.toUpperCase() && /[a-zA-Z]/.test(cur);
}

export interface Rankable {
  readonly text: string;
  readonly detail?: string;
}

/** Rangordning för palett/hittare: null-query = original ordning, i övrigt bäst poäng först. */
export function rank<T extends Rankable>(query: string, items: readonly T[], limit = 60): T[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return items.slice(0, limit);
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const direct = fuzzyMatch(query, item.text);
    const detail = item.detail ? fuzzyMatch(query, item.detail) : null;
    const score = bestOf(direct, detail);
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || a.item.text.localeCompare(b.item.text));
  return scored.slice(0, limit).map((entry) => entry.item);
}

function bestOf(a: FuzzyMatch | null, b: FuzzyMatch | null): number | null {
  if (a === null && b === null) return null;
  if (a === null) return b === null ? null : b.score - 8;
  if (b === null) return a.score;
  return Math.max(a.score, b.score - 8);
}

/** Markerar träffindex i en sträng för rendering (utan dangerouslySetInnerHTML). */
export function splitByIndices(text: string, indices: readonly number[]): { part: string; hit: boolean }[] {
  const set = new Set(indices);
  const out: { part: string; hit: boolean }[] = [];
  let buffer = "";
  let current: boolean | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const hit = set.has(i);
    if (current === null || hit === current) {
      buffer += text[i] ?? "";
      current = hit;
      continue;
    }
    out.push({ part: buffer, hit: current });
    buffer = text[i] ?? "";
    current = hit;
  }
  if (current !== null) out.push({ part: buffer, hit: current });
  return out;
}

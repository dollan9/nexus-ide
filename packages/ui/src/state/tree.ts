/**
 * state/tree.ts — filträdet. Bygger om `FsNode[]` från fs.listTree till platta rader som
 * komponenten kan rendera, med expanderad/laddad-tillstånd utan att duplicera noddata.
 *
 * Varför platta rader: ett träd med 20 000 noder får inte rendras som 20 000 React-noder.
 * flatten() ger en lista vi kan virtuella-lista och söka i, och den är ren → testbar.
 */
import type { FsNode } from "@nexus/protocol";

export interface TreeRow {
  readonly key: string;
  readonly path: string;
  readonly name: string;
  readonly kind: "file" | "dir";
  readonly depth: number;
  readonly expanded: boolean;
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly mayHaveChildren: boolean;
  readonly size: number;
}

export interface TreeState {
  /** Mappning katalog → barn. Root-nyckeln är "". */
  readonly children: Readonly<Record<string, FsNode[]>>;
  readonly expanded: ReadonlySet<string>;
  readonly loading: ReadonlySet<string>;
  readonly errors: Readonly<Record<string, string>>;
  readonly root: string;
}

export const ROOT_KEY = "";

export function initialTreeState(root = ""): TreeState {
  return { children: {}, expanded: new Set<string>(), loading: new Set<string>(), errors: {}, root };
}

/**
 * Normaliserar svaret från fs.listTree: både nästad (children ifyllt) och plan form.
 * Nästade barn registreras under sin förälders nyckel så expanderandet blir gratis.
 */
export function indexTreeNodes(
  state: TreeState,
  parentKey: string,
  nodes: readonly FsNode[],
): TreeState {
  const sorted = sortNodes(nodes);
  const children: Record<string, FsNode[]> = { ...state.children, [parentKey]: sorted };
  let next: TreeState = { ...state, children };
  for (const node of sorted) {
    if (node.kind === "dir" && node.children && node.children.length > 0) {
      next = indexTreeNodes(next, node.path, node.children);
    }
  }
  return next;
}

export function sortNodes(nodes: readonly FsNode[]): FsNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return naturalCompare(a.name, b.name);
  });
}

/** Naturlig sort: siffersegment jämförs numeriskt (fil2 före fil10). */
export function naturalCompare(a: string, b: string): number {
  const re = /(\d+|\D+)/g;
  const pa = a.match(re) ?? [a];
  const pb = b.match(re) ?? [b];
  const len = Math.min(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const sa = pa[i] ?? "";
    const sb = pb[i] ?? "";
    if (sa === sb) continue;
    const na = Number(sa);
    const nb = Number(sb);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return sa.toLowerCase() < sb.toLowerCase() ? -1 : 1;
  }
  return pa.length - pb.length;
}

export function setExpanded(state: TreeState, path: string, expanded: boolean): TreeState {
  const set = new Set(state.expanded);
  if (expanded) set.add(path);
  else set.delete(path);
  return { ...state, expanded: set };
}

export function toggleExpanded(state: TreeState, path: string): TreeState {
  return setExpanded(state, path, !state.expanded.has(path));
}

export function markLoading(state: TreeState, path: string, loading: boolean): TreeState {
  const set = new Set(state.loading);
  if (loading) set.add(path);
  else set.delete(path);
  return { ...state, loading: set };
}

export function setNodeError(state: TreeState, path: string, error: string | null): TreeState {
  const errors = { ...state.errors };
  if (error === null) delete errors[path];
  else errors[path] = error;
  return { ...state, errors };
}

export interface FlattenOptions {
  readonly showHidden: boolean;
  /** Filtrering på sökvägen (för höjd filterruta i filträdet). */
  readonly filter?: string;
}

export function flattenTree(state: TreeState, options: FlattenOptions): TreeRow[] {
  const rows: TreeRow[] = [];
  const filter = (options.filter ?? "").trim().toLowerCase();
  const walk = (key: string, depth: number): void => {
    const nodes = state.children[key];
    if (!nodes) return;
    for (const node of nodes) {
      if (!options.showHidden && node.name.startsWith(".") && depth > 0) continue;
      const expanded = node.kind === "dir" && state.expanded.has(node.path);
      rows.push({
        key: node.path,
        path: node.path,
        name: node.name,
        kind: node.kind,
        depth,
        expanded,
        loaded: node.kind === "dir" ? state.children[node.path] !== undefined : true,
        loading: node.kind === "dir" && state.loading.has(node.path),
        mayHaveChildren: node.kind === "dir",
        size: node.size ?? 0,
      });
      if (expanded) walk(node.path, depth + 1);
    }
  };
  walk(ROOT_KEY, 0);
  if (filter.length === 0) return rows;
  return rows.filter((row, index) => {
    if (matches(filter, row.path)) return true;
    // Håll föräldrar till träffar så att strukturen inte försvinner vid filtrering.
    for (let i = index - 1; i >= 0; i -= 1) {
      const candidate = rows[i];
      if (!candidate || candidate.depth >= row.depth) break;
      if (matches(filter, candidate.path)) return true;
    }
    return false;
  });
}

function matches(filter: string, path: string): boolean {
  return path.toLowerCase().includes(filter);
}

/** Sökväg relativ rot, för bro smulor och titel. */
export function relativeTo(root: string, path: string): string {
  if (!root) return path;
  const norm = (s: string): string => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root);
  const p = norm(path);
  if (p === r) return "";
  if (p.startsWith(`${r}/`)) return p.slice(r.length + 1);
  return p;
}

export function segmentsOf(relPath: string): string[] {
  return relPath.split("/").filter((segment) => segment.length > 0);
}

export function parentKeyOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const at = normalized.lastIndexOf("/");
  if (at <= 0) return ROOT_KEY;
  return normalized.slice(0, at);
}

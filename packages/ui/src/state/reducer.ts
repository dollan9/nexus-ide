/**
 * state/reducer.ts — flikarnas reducer. Ren, testad, inga bifeffekter.
 *
 * Dirty-tilstånd är kärnan: en flik är smutsig om nuvarande innehåll skiljer sig från det
 * som sparades senast. Öppna om, stäng, spara, dela och flytta till annan grupp uttrycks
 * som händelser så att test kan bevisa att överföringarna är korrekta.
 */

export type SplitMode = "none" | "row" | "column";
export type GroupId = "a" | "b";

export interface EditorTab {
  readonly path: string;
  readonly title: string;
  readonly language: string;
  readonly content: string;
  readonly savedContent: string;
  readonly dirty: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly group: GroupId;
  readonly mtimeMs: number;
  readonly truncated: boolean;
  readonly readOnly: boolean;
}

export interface EditorState {
  readonly tabs: EditorTab[];
  readonly activePath: string | null;
  readonly activeByGroup: Record<GroupId, string | null>;
  readonly split: SplitMode;
  readonly focus: GroupId;
  readonly maxTabsWarned: boolean;
}

export type EditorAction =
  | { type: "open/start"; path: string; group?: GroupId }
  | {
      type: "open/loaded";
      path: string;
      content: string;
      language: string;
      mtimeMs: number;
      truncated?: boolean;
      readOnly?: boolean;
    }
  | { type: "open/failed"; path: string; error: string }
  | { type: "content/change"; path: string; content: string }
  | { type: "tab/saved"; path: string; content: string; mtimeMs: number }
  | { type: "tab/external-change"; path: string; content: string; mtimeMs: number }
  | { type: "tab/close"; path: string }
  | { type: "tab/close-others"; path: string }
  | { type: "tab/close-saved" }
  | { type: "tab/close-all" }
  | { type: "tab/activate"; path: string }
  | { type: "tab/move"; path: string; group: GroupId }
  | { type: "tab/move-to-index"; path: string; index: number }
  | { type: "split/set"; mode: SplitMode }
  | { type: "split/toggle" }
  | { type: "group/focus"; group: GroupId }
  | { type: "editor/reset" };

export const MAX_TABS = 64;

export function initialEditorState(): EditorState {
  return {
    tabs: [],
    activePath: null,
    activeByGroup: { a: null, b: null },
    split: "none",
    focus: "a",
    maxTabsWarned: false,
  };
}

export function computeDirty(tab: EditorTab, content: string): boolean {
  if (tab.readOnly) return false;
  return content !== tab.savedContent;
}

function titleOf(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, "");
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || cleaned || path;
}

function placeholderTab(path: string, group: GroupId): EditorTab {
  return {
    path,
    title: titleOf(path),
    language: "plaintext",
    content: "",
    savedContent: "",
    dirty: false,
    loading: true,
    error: null,
    group,
    mtimeMs: 0,
    truncated: false,
    readOnly: false,
  };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "open/start": {
      const existing = state.tabs.find((tab) => tab.path === action.path);
      const group = action.group ?? "a";
      if (existing) {
        return {
          ...state,
          activePath: existing.path,
          activeByGroup: { ...state.activeByGroup, [group]: existing.path },
          focus: group,
        };
      }
      if (state.tabs.length >= MAX_TABS) {
        return { ...state, maxTabsWarned: true };
      }
      const tab = placeholderTab(action.path, group);
      const otherGroup: GroupId = group === "a" ? "b" : "a";
      const keepSecondary = state.split !== "none" && state.activeByGroup[otherGroup] !== null;
      return {
        ...state,
        tabs: [...state.tabs, tab],
        activePath: keepSecondary ? state.activePath : tab.path,
        activeByGroup: { ...state.activeByGroup, [group]: tab.path },
        focus: group,
      };
    }

    case "open/loaded": {
      const tabs = state.tabs.map((tab) =>
        tab.path === action.path
          ? {
              ...tab,
              content: action.content,
              savedContent: action.content,
              language: action.language || tab.language,
              dirty: false,
              loading: false,
              error: null,
              mtimeMs: action.mtimeMs,
              truncated: Boolean(action.truncated),
              readOnly: Boolean(action.readOnly),
            }
          : tab,
      );
      if (!tabs.some((tab) => tab.path === action.path)) {
        const loaded: EditorTab = {
          ...placeholderTab(action.path, "a"),
          content: action.content,
          savedContent: action.content,
          language: action.language || "plaintext",
          loading: false,
          mtimeMs: action.mtimeMs,
          truncated: Boolean(action.truncated),
          readOnly: Boolean(action.readOnly),
        };
        return {
          ...state,
          tabs: [...tabs, loaded],
          activePath: state.activePath ?? loaded.path,
          activeByGroup: { ...state.activeByGroup, a: loaded.path },
        };
      }
      return { ...state, tabs };
    }

    case "open/failed": {
      const tabs = state.tabs.map((tab) =>
        tab.path === action.path ? { ...tab, loading: false, error: action.error } : tab,
      );
      return { ...state, tabs };
    }

    case "content/change": {
      let changed = false;
      const tabs = state.tabs.map((tab) => {
        if (tab.path !== action.path) return tab;
        changed = true;
        return { ...tab, content: action.content, dirty: computeDirty(tab, action.content) };
      });
      return changed ? { ...state, tabs } : state;
    }

    case "tab/saved": {
      const tabs = state.tabs.map((tab) =>
        tab.path === action.path
          ? { ...tab, content: action.content, savedContent: action.content, dirty: false, mtimeMs: action.mtimeMs }
          : tab,
      );
      return { ...state, tabs };
    }

    // Extern ändring (fs/changed): spara aldrig över användarens osparade arbete tyst.
    case "tab/external-change": {
      const tabs = state.tabs.map((tab) => {
        if (tab.path !== action.path) return tab;
        if (tab.dirty) {
          return { ...tab, mtimeMs: action.mtimeMs, error: "ändrad på disk — din lokala kopia är kvar" };
        }
        return { ...tab, content: action.content, savedContent: action.content, dirty: false, mtimeMs: action.mtimeMs };
      });
      return { ...state, tabs };
    }

    case "tab/close":
      return closeTabs(state, [action.path]);

    case "tab/close-others":
      return closeTabs(state, state.tabs.filter((tab) => tab.path !== action.path).map((tab) => tab.path));

    case "tab/close-saved":
      return closeTabs(state, state.tabs.filter((tab) => !tab.dirty).map((tab) => tab.path));

    case "tab/close-all":
      return closeTabs(state, state.tabs.map((tab) => tab.path));

    case "tab/activate": {
      const tab = state.tabs.find((t) => t.path === action.path);
      if (!tab) return state;
      return {
        ...state,
        activePath: tab.path,
        focus: tab.group,
        activeByGroup: { ...state.activeByGroup, [tab.group]: tab.path },
      };
    }

    case "tab/move": {
      const tabs = state.tabs.map((tab) =>
        tab.path === action.path && tab.group !== action.group ? { ...tab, group: action.group } : tab,
      );
      const moved = tabs.find((tab) => tab.path === action.path);
      if (!moved) return state;
      const activeByGroup: Record<GroupId, string | null> = { ...state.activeByGroup };
      if (moved.group === action.group) activeByGroup[action.group] = moved.path;
      return {
        ...state,
        tabs,
        activeByGroup,
        focus: action.group,
        activePath: state.split === "none" ? moved.path : state.activePath,
        split: state.split === "none" && action.group === "b" ? "row" : state.split,
      };
    }

    case "tab/move-to-index": {
      const from = state.tabs.findIndex((tab) => tab.path === action.path);
      if (from < 0) return state;
      const tabs = [...state.tabs];
      const [moved] = tabs.splice(from, 1);
      if (!moved) return state;
      const target = Math.max(0, Math.min(tabs.length, action.index));
      tabs.splice(target, 0, moved);
      return { ...state, tabs };
    }

    case "split/set": {
      const activeByGroup: Record<GroupId, string | null> = { ...state.activeByGroup };
      if (activeByGroup.b === null && state.activePath && action.mode !== "none") {
        const candidate = state.tabs.find(
          (tab) => tab.path !== state.activePath && tab.group === "a",
        );
        if (candidate) activeByGroup.b = candidate.path;
      }
      if (action.mode === "none") activeByGroup.b = null;
      return { ...state, split: action.mode, activeByGroup, focus: action.mode === "none" ? "a" : state.focus };
    }

    case "split/toggle":
      return editorReducer(state, { type: "split/set", mode: state.split === "none" ? "row" : "none" });

    case "group/focus": {
      const path = state.activeByGroup[action.group];
      return { ...state, focus: action.group, activePath: path ?? state.activePath };
    }

    case "editor/reset":
      return initialEditorState();

    default:
      return state;
  }
}

function closeTabs(state: EditorState, paths: readonly string[]): EditorState {
  const doomed = new Set(paths);
  const tabs = state.tabs.filter((tab) => !doomed.has(tab.path));
  const activeByGroup: Record<GroupId, string | null> = { a: null, b: null };
  for (const group of ["a", "b"] as const) {
    const previous = state.activeByGroup[group];
    const inGroup = tabs.filter((tab) => tab.group === group);
    if (previous !== null && !doomed.has(previous)) {
      activeByGroup[group] = previous;
    } else {
      activeByGroup[group] = inGroup.length > 0 ? (inGroup[inGroup.length - 1]?.path ?? null) : null;
    }
  }
  let activePath = state.activePath;
  if (activePath === null || doomed.has(activePath)) {
    const preferred = activeByGroup[state.focus] ?? activeByGroup.a ?? activeByGroup.b;
    activePath = preferred ?? (tabs.length > 0 ? (tabs[tabs.length - 1]?.path ?? null) : null);
  }
  return {
    ...state,
    tabs,
    activePath,
    activeByGroup,
    maxTabsWarned: false,
    split: activeByGroup.b === null ? "none" : state.split,
  };
}

export function selectActiveTab(state: EditorState): EditorTab | null {
  return state.tabs.find((tab) => tab.path === state.activePath) ?? null;
}

export function tabsForGroup(state: EditorState, group: GroupId): EditorTab[] {
  return state.tabs.filter((tab) => tab.group === group);
}

export function dirtyTabs(state: EditorState): EditorTab[] {
  return state.tabs.filter((tab) => tab.dirty);
}

export { titleOf as tabTitleOf };

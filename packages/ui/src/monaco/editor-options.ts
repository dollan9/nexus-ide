/**
 * monaco/editor-options.ts — bygger Monacos options från NexusSettings + tema.
 * Ren funktion (ingen DOM), testad: kraven i P0 (folding, minimap, bracket matching,
 * indent guides, word wrap, ligaturer, multi-cursor) måste faktiskt synas i alternativen,
 * inte bara påstås i mallen.
 */
import type { IStandaloneEditorConstructionOptions } from "monaco-editor";
import type { TokenSet } from "../state/themes";

export interface EditorPreferences {
  readonly fontSize: number;
  readonly themeMonacoId: string;
  readonly wordWrap: boolean;
  readonly minimap: boolean;
  readonly stickyScroll: boolean;
  readonly renderWhitespace: "none" | "selection" | "boundary" | "all";
  readonly tabSize: number;
  readonly autoSave: boolean;
  readonly autoIndent: boolean;
}

export const DEFAULT_EDITOR_PREFERENCES: EditorPreferences = {
  fontSize: 13,
  themeMonacoId: "nx-nexus-midnight",
  wordWrap: false,
  minimap: true,
  stickyScroll: true,
  renderWhitespace: "selection",
  tabSize: 2,
  autoSave: false,
  autoIndent: true,
};

export function buildEditorOptions(
  prefs: EditorPreferences,
  tokens: TokenSet,
  extra: { readonly readOnly?: boolean } = {},
): IStandaloneEditorConstructionOptions {
  return {
    theme: prefs.themeMonacoId,
    value: "",
    fontSize: prefs.fontSize,
    fontFamily: tokens["font-mono"],
    fontLigatures: true,
    lineHeight: Math.round(prefs.fontSize * 1.55),
    letterSpacing: 0.2,
    // --- P0-editor-krav ---
    folding: true,
    foldingStrategy: "auto",
    showFoldingControls: "mouseover",
    minimap: { enabled: prefs.minimap, showSlider: "mouseover", renderCharacters: false, maxColumn: 90 },
    stickyScroll: { enabled: prefs.stickyScroll },
    matchBrackets: "always",
    autoClosingBrackets: "languageDefined",
    autoClosingQuotes: "languageDefined",
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: "active", indentation: prefs.tabSize > 0 ? "all" : "none" },
    wordWrap: prefs.wordWrap ? "on" : "off",
    multiCursorModifier: "ctrlCmd",
    multiCursorPaste: "full",
    links: true,
    colorDecorators: true,
    // --- kvalitet/lysning ---
    renderWhitespace: prefs.renderWhitespace,
    renderControlCharacters: true,
    renderLineHighlight: "all",
    highlightActiveIndentGuide: true,
    indentOnEmptyLine: prefs.autoIndent,
    autoIndent: prefs.autoIndent ? "full" : "none",
    detectIndentation: true,
    tabSize: prefs.tabSize,
    insertSpaces: true,
    trimAutoWhitespace: true,
    rulers: [80, 100, 120],
    smoothScrolling: true,
    cursorSmoothCaretAnimation: "on",
    cursorBlinking: "smooth",
    roundedSelection: true,
    padding: { top: 10, bottom: 10 },
    scrollbar: {
      verticalScrollbarSize: 12,
      horizontalScrollbarSize: 12,
      useShadows: false,
      scrollByLines: 2,
    },
    overviewRulerLanes: 3,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: false,
    glyphMargin: true,
    lineNumbersMinChars: 3,
    foldingGutter: true,
    extraEditorClassName: "nexus-editor",
    readOnly: extra.readOnly ?? false,
    automaticLayout: true,
    suggestSelection: "recentlyUsed",
    tabCompletion: "on",
    quickSuggestions: { other: true, comments: false, strings: true },
    inlineSuggest: { enabled: true },
    stickyScrollStickySizeStart: 22,
  };
}

/** Maps our language ids (host:ar fs.languageOf) till Monacos registrerade språk-id. */
const LANGUAGE_ALIAS: Readonly<Record<string, string>> = {
  javascriptreact: "javascript",
  typescriptreact: "typescript",
  "c++": "cpp",
  shellscript: "shell",
  "plain text": "plaintext",
  markdown: "markdown",
  jsonc: "json",
  yaml_: "yaml",
};

export function monacoLanguageOf(language: string | undefined): string {
  const raw = (language ?? "").trim().toLowerCase();
  if (raw.length === 0) return "plaintext";
  const alias = LANGUAGE_ALIAS[raw];
  if (alias) return alias;
  return raw;
}

/** Språkstöd för search/replace i settings: vilka filer som kan ha tabs-storlek. */
export function usesTabs(language: string): boolean {
  const lang = monacoLanguageOf(language);
  return lang === "makefile" || lang === "go" || lang === "git-rebase";
}

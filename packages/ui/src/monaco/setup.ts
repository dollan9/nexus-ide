/**
 * monaco/setup.ts — Monaco-miljön: web workers, teman, nyckelbindningar och typografi.
 *
 * Vite-grepnan: Monaco kräver workers för att fungera. Vi importerar ESM-byggets
 * worker-filer med Vites `?worker`-suffix (de blir riktiga worker-moduler i bygget) och
 * sätter `MonacoEnvironment.getWorker`. Fallback: en tyst blob-worker som svarar tomt —
 * editorn MÅSTE aldrig misslyckas med att montera; språktjänsterna degraderas men texten
 * går att redigera. (CONVENTIONS R5: appen får aldrig krascha.)
 */
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { BUILTIN_THEMES, type BuiltinTheme, type TokenSet } from "../state/themes";
import type { MonacoThemeData } from "../state/monaco-theme";

export interface MonacoWorkerDiagnostics {
  readonly installed: boolean;
  readonly fallback: boolean;
  readonly lastError: string | null;
}

let workersInstalled = false;
let fallbackUsed = false;
let lastWorkerError: string | null = null;
let themesRegistered = false;

export function setupMonacoWorkers(): MonacoWorkerDiagnostics {
  if (!workersInstalled) {
    workersInstalled = true;
    globalThis.MonacoEnvironment = {
      getWorker(_workerId: string, label: string): Worker {
        try {
          return createWorkerFor(label);
        } catch (err) {
          fallbackUsed = true;
          lastWorkerError = (err as Error).message;
          return createSilentBlobWorker();
        }
      },
    };
  }
  return { installed: workersInstalled, fallback: fallbackUsed, lastError: lastWorkerError };
}

function createWorkerFor(label: string): Worker {
  switch (label) {
    case "json":
      return new jsonWorker();
    case "css":
    case "scss":
    case "less":
      return new cssWorker();
    case "html":
    case "handlebars":
    case "razor":
      return new htmlWorker();
    case "typescript":
    case "javascript":
      return new tsWorker();
    default:
      return new editorWorker();
  }
}

/** Minimal worker som bara besvarar med tomma svar — håller Monaco vid liv utan riktiga workers. */
function createSilentBlobWorker(): Worker {
  const source = [
    "self.onmessage = (e) => {",
    "  const msg = e.data || {};",
    "  if (msg.type === 'vscode' && typeof msg.request === 'number') {",
    "    self.postMessage({ type: 'vscode', request: msg.request, responses: [] });",
    "  }",
    "};",
  ].join("\n");
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  return new Worker(url);
}

// ------------------------------------------------------------------
// Teman
// ------------------------------------------------------------------

/**
 * Vi färgsätter de vanligaste scopes ovanpå Monacos egen token-service (syntax highlightings
 * kommer från Monacos språkworkrar, inte från oss). bakgrundar/förgrunder hämtas från token-setet
 * så editor och chrome aldrig kan hamna på olika färger.
 */
function syntaxRules(t: TokenSet): monaco.editor.ITokenThemeRule[] {
  const hex = (value: string): string => value.replace("#", "");
  return [
    { token: "", foreground: hex(t["text"]), background: hex(t["bg"]) },
    { token: "comment", foreground: hex(t["text-faint"]), fontStyle: "italic" },
    { token: "keyword", foreground: hex(t["purple"]) },
    { token: "keyword.flow", foreground: hex(t["purple"]) },
    { token: "storage", foreground: hex(t["cyan"]) },
    { token: "string", foreground: hex(t["ok"]) },
    { token: "string.key.json", foreground: hex(t["accent-text"]) },
    { token: "string.value.json", foreground: hex(t["ok"]) },
    { token: "number", foreground: hex(t["warn"]) },
    { token: "constant", foreground: hex(t["warn"]) },
    { token: "type", foreground: hex(t["cyan"]) },
    { token: "type.identifier", foreground: hex(t["cyan"]) },
    { token: "function", foreground: hex(t["info"]) },
    { token: "delimiter", foreground: hex(t["text-dim"]) },
    { token: "operator", foreground: hex(t["text-dim"]) },
    { token: "invalid", foreground: hex(t["danger"]) },
  ];
}

const BASE_BY_BUILTIN: Record<BuiltinTheme, monaco.editor.BuiltinTheme> = {
  "nexus-midnight": "vs-dark",
  "nexus-light": "vs",
  "nexus-contrast": "hc-black",
};

export function registerBuiltinThemes(): void {
  if (themesRegistered) return;
  themesRegistered = true;
  for (const id of Object.keys(BUILTIN_THEMES) as BuiltinTheme[]) {
    const t = BUILTIN_THEMES[id];
    monaco.editor.defineTheme(monacoThemeIdFor(id), {
      base: BASE_BY_BUILTIN[id],
      inherit: true,
      rules: syntaxRules(t),
      colors: {
        "editor.background": t["bg"],
        "editor.foreground": t["text"],
        "editor.lineHighlightBackground": t["line-highlight"],
        "editor.selectionBackground": t["selection"],
        "editorIndentGuide.background1": t["border"],
        "editorIndentGuide.activeBackground1": t["border-strong"],
        "editorWidget.background": t["bg-elevated"],
        "editorSuggestWidget.background": t["bg-elevated"],
        "editorHoverWidget.background": t["bg-elevated"],
        "editorLineNumber.foreground": t["text-faint"],
        "editorCursor.foreground": t["accent"],
      },
    });
  }
}

/** Importerat VS Code-tema → Monaco-tema. Returnerar det Monaco-id som ska sättas. */
export function registerImportedTheme(id: string, data: MonacoThemeData): string {
  const monacoId = sanitizeThemeId(id);
  monaco.editor.defineTheme(monacoId, {
    base: data.base,
    inherit: data.inherit,
    rules: data.rules.map((rule) => ({
      token: rule.token,
      foreground: rule.foreground ? rule.foreground.replace("#", "") : undefined,
      background: rule.background ? rule.background.replace("#", "") : undefined,
      fontStyle: rule.fontStyle,
    })),
    colors: data.colors,
  });
  return monacoId;
}

function sanitizeThemeId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9\-_.:]/g, "-").slice(0, 80);
  return cleaned.length > 0 ? cleaned : "nx-imported";
}

export function monacoThemeIdFor(builtin: BuiltinTheme): string {
  return `nx-${builtin}`;
}

// ------------------------------------------------------------------
// App-kommandon som måste fungera även medan fokus ligger i editorn
// ------------------------------------------------------------------

export type NexusEditorCommand =
  | "nexus.commandPalette"
  | "nexus.fileFinder"
  | "nexus.inlineEdit"
  | "nexus.toggleTerminal"
  | "nexus.acceptGhost"
  | "nexus.dismissGhost"
  | "nexus.save"
  | "nexus.closeTab";

type CommandSink = (command: NexusEditorCommand) => void;

let sink: CommandSink | null = null;
let keybindingsInstalled = false;

export function setEditorCommandSink(next: CommandSink | null): void {
  sink = next;
}

const NEXUS_COMMAND_IDS: readonly NexusEditorCommand[] = [
  "nexus.commandPalette",
  "nexus.fileFinder",
  "nexus.inlineEdit",
  "nexus.toggleTerminal",
  "nexus.save",
  "nexus.closeTab",
  "nexus.acceptGhost",
  "nexus.dismissGhost",
];

export function registerNexusKeybindings(): void {
  if (keybindingsInstalled) return;
  keybindingsInstalled = true;
  const { KeyMod, KeyCode } = monaco;
  const rules: monaco.editor.IKeybindingRule[] = [
    { keybinding: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyP, command: "nexus.commandPalette" },
    { keybinding: KeyMod.CtrlCmd | KeyCode.KeyP, command: "nexus.fileFinder" },
    { keybinding: KeyMod.CtrlCmd | KeyCode.KeyK, command: "nexus.inlineEdit" },
    { keybinding: KeyMod.CtrlCmd | KeyCode.Backquote, command: "nexus.toggleTerminal" },
    { keybinding: KeyMod.CtrlCmd | KeyCode.KeyS, command: "nexus.save" },
    { keybinding: KeyMod.CtrlCmd | KeyCode.KeyW, command: "nexus.closeTab" },
    { keybinding: KeyCode.F1, command: "nexus.commandPalette" },
  ];
  for (const rule of rules) monaco.editor.addKeybindingRule(rule);

  for (const id of NEXUS_COMMAND_IDS) {
    monaco.editor.registerCommand(id, (_accessor: unknown) => {
      sink?.(id);
    });
  }
}

/** Typografi: ligaturer + fontstack från token-setet. Anropas av editorn via options. */
export function typographyOptions(tokens: TokenSet, fontSize: number): monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    fontSize,
    fontFamily: tokens["font-mono"],
    fontLigatures: true,
    lineHeight: Math.round(fontSize * 1.55),
  };
}

/** Init som måste köras före första monaco.editor.create(). Idempotent. */
export function ensureMonacoReady(): MonacoWorkerDiagnostics {
  const diagnostics = setupMonacoWorkers();
  registerBuiltinThemes();
  registerNexusKeybindings();
  return diagnostics;
}

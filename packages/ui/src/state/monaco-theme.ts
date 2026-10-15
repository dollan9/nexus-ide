/**
 * state/monaco-theme.ts — importerar VS Code-teman (TextMate-JSON) i Monaco och härleder
 * våra egna CSS-tokens ur dess `colors`. Det är mekanismen bakom "100+ teman": vilken
 * .json som helst ur det stora ekosystemet av VS Code-teman kan laddas vid runtime, antingen
 * genom att klistras in eller läsas från en fil via fs.read.
 *
 * Konverteringen är ren och validerad — felaktig JSON ger ett fel vi kan visa, aldrig en
 * krasch (CONVENTIONS R5).
 */
import type { TokenSet } from "./themes";

export type MonacoBase = "vs" | "vs-dark" | "hc-black" | "hc-light";

export interface MonacoThemeRule {
  readonly token: string;
  readonly foreground?: string;
  readonly background?: string;
  readonly fontStyle?: string;
}

export interface MonacoThemeData {
  readonly base: MonacoBase;
  readonly inherit: boolean;
  readonly rules: MonacoThemeRule[];
  readonly colors: Record<string, string>;
}

export interface ImportedTheme {
  readonly id: string;
  readonly label: string;
  readonly theme: MonacoThemeData;
  /** Våra --nx-*-tokens, härledda ur temat. */
  readonly tokens: Partial<TokenSet>;
  readonly warnings: string[];
}

export class ThemeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThemeParseError";
  }
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** VS Code-färgnyckel → vår token. Ordningen spelar roll: första träffen vinner. */
const COLOR_TO_TOKEN: readonly (readonly [string, keyof TokenSet])[] = [
  ["editor.background", "bg"],
  ["sideBar.background", "bg-panel"],
  ["activityBar.background", "bg-panel"],
  ["panel.background", "bg-panel"],
  ["menu.background", "bg-elevated"],
  ["editorWidget.background", "bg-elevated"],
  ["input.background", "bg-input"],
  ["list.hoverBackground", "bg-hover"],
  ["list.activeSelectionBackground", "bg-active"],
  ["editorIndentGuide.background1", "border"],
  ["widget.border", "border-strong"],
  ["editor.foreground", "text"],
  ["foreground", "text-dim"],
  ["descriptionForeground", "text-faint"],
  ["editor.selectionBackground", "selection"],
  ["editor.lineHighlightBackground", "line-highlight"],
  ["focusBorder", "accent"],
  ["button.background", "accent"],
  ["textLink.foreground", "accent-text"],
  ["editorError.foreground", "danger"],
  ["problemsErrorIcon.foreground", "danger"],
  ["editorWarning.foreground", "warn"],
  ["editorInfo.foreground", "info"],
  ["gitDecoration.addedResourceForeground", "ok"],
  ["gitDecoration.modifiedResourceForeground", "warn"],
  ["gitDecoration.deletedResourceForeground", "danger"],
];

const BASE_BY_TYPE: Record<string, MonacoBase> = {
  dark: "vs-dark",
  light: "vs",
  hc: "hc-black",
  hcLight: "hc-light",
};

export function parseVscodeTheme(raw: unknown): ImportedTheme {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ThemeParseError("temat måste vara ett JSON-objekt");
  }
  const rec = raw as Record<string, unknown>;
  const name = typeof rec["name"] === "string" && rec["name"].length > 0 ? rec["name"] : "Importerat tema";
  const typeRaw = typeof rec["type"] === "string" ? rec["type"] : "dark";
  const base = BASE_BY_TYPE[typeRaw] ?? (typeRaw === "hcBlack" ? "hc-black" : "vs-dark");

  const colors: Record<string, string> = {};
  const rawColors = rec["colors"];
  if (rawColors !== undefined && (typeof rawColors !== "object" || rawColors === null || Array.isArray(rawColors))) {
    throw new ThemeParseError("`colors` måste vara ett objekt av färgnyckel → #hex");
  }
  const warnings: string[] = [];
  if (rawColors && typeof rawColors === "object") {
    for (const [key, value] of Object.entries(rawColors as Record<string, unknown>)) {
      if (typeof value !== "string") {
        warnings.push(`struntade icke-sträng för ${key}`);
        continue;
      }
      const normalized = normalizeColor(value);
      if (normalized === null) {
        warnings.push(`okänd färgformat för ${key}: ${value}`);
        continue;
      }
      colors[key] = normalized;
    }
  }

  const rules: MonacoThemeRule[] = [];
  const tokenColors = rec["tokenColors"];
  if (tokenColors !== undefined) {
    if (!Array.isArray(tokenColors)) throw new ThemeParseError("`tokenColors` måste vara en array");
    for (const entry of tokenColors) {
      const rule = toMonacoRule(entry);
      if (rule) rules.push(rule);
    }
  }
  if (Object.keys(colors).length === 0 && rules.length === 0) {
    throw new ThemeParseError("temat innehåller varken `colors` eller `tokenColors` — inget att importera");
  }

  const tokens = deriveTokens(colors, base);
  return {
    id: `imported:${slug(name)}`,
    label: name,
    theme: { base, inherit: true, rules, colors },
    tokens,
    warnings,
  };
}

function toMonacoRule(entry: unknown): MonacoThemeRule | null {
  if (entry === null || typeof entry !== "object") return null;
  const rec = entry as Record<string, unknown>;
  const settings = rec["settings"];
  if (settings === null || typeof settings !== "object") return null;
  const s = settings as Record<string, unknown>;
  const scope = rec["scope"];
  const token =
    typeof scope === "string"
      ? scope
      : Array.isArray(scope)
        ? (scope.filter((x): x is string => typeof x === "string")[0] ?? "")
        : "";
  const foreground = typeof s["foreground"] === "string" ? normalizeColor(s["foreground"]) : undefined;
  const background = typeof s["background"] === "string" ? normalizeColor(s["background"]) : undefined;
  const fontStyle = typeof s["fontStyle"] === "string" ? s["fontStyle"] : undefined;
  if (!foreground && !background && !fontStyle) return null;
  const rule: MonacoThemeRule = { token: token || "" };
  if (foreground) return { ...rule, foreground, background: background ?? undefined, fontStyle };
  return { ...rule, background: background ?? undefined, fontStyle };
}

function normalizeColor(value: string): string | null {
  const trimmed = value.trim();
  if (HEX.test(trimmed)) {
    // Monaco vill ha #rrggbb (utan alpha) för foreground; 8-siffriga alpha tappas medvetet.
    if (trimmed.length === 9) return `#${trimmed.slice(1, 7)}`;
    if (trimmed.length === 4) {
      const r = trimmed[1];
      const g = trimmed[2];
      const b = trimmed[3];
      return `#${r ?? ""}${r ?? ""}${g ?? ""}${g ?? ""}${b ?? ""}${b ?? ""}`;
    }
    return trimmed;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(trimmed);
  if (rgb?.[1]) {
    const parts = rgb[1].split(/[,\s/]+/).filter((p) => p.length > 0);
    const nums = parts.slice(0, 3).map((p) => Number(p));
    if (nums.length === 3 && nums.every((n) => Number.isFinite(n))) {
      return `#${nums.map((n) => clamp255(n).toString(16).padStart(2, "0")).join("")}`;
    }
  }
  return null;
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function deriveTokens(colors: Record<string, string>, base: MonacoBase): Partial<TokenSet> {
  const out: Partial<TokenSet> = {};
  for (const [key, token] of COLOR_TO_TOKEN) {
    const value = colors[key];
    if (value) out[token] = value;
  }
  const darkish = base === "vs-dark" || base === "hc-black";
  if (!out["text-inverse"]) out["text-inverse"] = darkish ? "#0b0f17" : "#ffffff";
  if (!out["accent-text"]) out["accent-text"] = out["accent"] ?? (darkish ? "#a8c4ff" : "#1e40af");
  return out;
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Luminans från #rrggbb — används för att välja textfärg mot en importerad bakgrund. */
export function relativeLuminance(hex: string): number | null {
  const normalized = normalizeColor(hex);
  if (!normalized) return null;
  const r = parseInt(normalized.slice(1, 3), 16);
  const g = parseInt(normalized.slice(3, 5), 16);
  const b = parseInt(normalized.slice(5, 7), 16);
  if ([r, g, b].some((v) => Number.isNaN(v))) return null;
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function isDarkColor(hex: string): boolean {
  const lum = relativeLuminance(hex);
  return lum === null ? true : lum < 0.4;
}

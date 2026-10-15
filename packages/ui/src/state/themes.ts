/**
 * state/themes.ts — tokensystemet. Alla färger i UI:t är CSS-custom-properties; ingen
 * komponent får skriva en hex-kod. Tre inbyggda token-set (mörk "midnight" som standard,
 * ljus, hög kontrast) plus systemupplösning och användarens egen CSS.
 */

export type BuiltinTheme = "nexus-midnight" | "nexus-light" | "nexus-contrast";
export type ThemePreference = BuiltinTheme | "system";

export type TokenName =
  | "bg"
  | "bg-panel"
  | "bg-elevated"
  | "bg-hover"
  | "bg-active"
  | "bg-input"
  | "border"
  | "border-strong"
  | "text"
  | "text-dim"
  | "text-faint"
  | "text-inverse"
  | "accent"
  | "accent-soft"
  | "accent-text"
  | "ok"
  | "warn"
  | "danger"
  | "info"
  | "purple"
  | "cyan"
  | "selection"
  | "line-highlight"
  | "ghost-fg"
  | "shadow"
  | "font-ui"
  | "font-mono"
  | "radius"
  | "gap";

export type TokenSet = Record<TokenName, string>;

const SHARED: Pick<TokenSet, "font-ui" | "font-mono" | "radius" | "gap"> = {
  "font-ui":
    'Inter, "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", sans-serif',
  "font-mono":
    '"JetBrains Mono", "Cascadia Code", "Fira Code", Consolas, "SF Mono", Menlo, monospace',
  radius: "4px",
  gap: "8px",
};

export const NEXUS_MIDNIGHT: TokenSet = {
  bg: "#0b0f17",
  "bg-panel": "#111725",
  "bg-elevated": "#161d2d",
  "bg-hover": "#1c2438",
  "bg-active": "#223052",
  "bg-input": "#0e1420",
  border: "#1f293c",
  "border-strong": "#2f3d57",
  text: "#dce4f2",
  "text-dim": "#8fa0bd",
  "text-faint": "#5f6f8c",
  "text-inverse": "#0b0f17",
  accent: "#3d7bfd",
  "accent-soft": "#1b2a4d",
  "accent-text": "#a8c4ff",
  ok: "#3fbf87",
  warn: "#e0a33c",
  danger: "#ef5f6b",
  info: "#4aa8e8",
  purple: "#a882f0",
  cyan: "#3fc4c0",
  selection: "#1d3463",
  "line-highlight": "#141c2c",
  "ghost-fg": "#6c7f9e",
  shadow: "0 12px 32px rgba(0,0,0,0.55)",
  ...SHARED,
};

export const NEXUS_LIGHT: TokenSet = {
  bg: "#f6f7fb",
  "bg-panel": "#eceef5",
  "bg-elevated": "#ffffff",
  "bg-hover": "#e0e4f0",
  "bg-active": "#d3dcf2",
  "bg-input": "#ffffff",
  border: "#d3d8e6",
  "border-strong": "#b3bcd2",
  text: "#1a2233",
  "text-dim": "#4c5872",
  "text-faint": "#8290ab",
  "text-inverse": "#ffffff",
  accent: "#2563eb",
  "accent-soft": "#dbe6ff",
  "accent-text": "#1e40af",
  ok: "#15803d",
  warn: "#b45309",
  danger: "#c9252c",
  info: "#0e7490",
  purple: "#7c3aed",
  cyan: "#0891b2",
  selection: "#c7ddff",
  "line-highlight": "#eef2fb",
  "ghost-fg": "#8494b0",
  shadow: "0 12px 32px rgba(23,35,61,0.18)",
  ...SHARED,
};

/** Hög kontrast: inga gråtoner under WCAG AAA mot sin bakgrund, tydliga fokuskanter. */
export const NEXUS_CONTRAST: TokenSet = {
  bg: "#000000",
  "bg-panel": "#0a0a0a",
  "bg-elevated": "#141414",
  "bg-hover": "#1f1f1f",
  "bg-active": "#2b2b2b",
  "bg-input": "#000000",
  border: "#7a7a7a",
  "border-strong": "#ffffff",
  text: "#ffffff",
  "text-dim": "#e6e6e6",
  "text-faint": "#c8c8c8",
  "text-inverse": "#000000",
  accent: "#4da3ff",
  "accent-soft": "#0b2f55",
  "accent-text": "#bcdcff",
  ok: "#5ee39a",
  warn: "#ffd166",
  danger: "#ff8f98",
  info: "#7fd8ff",
  purple: "#d6b3ff",
  cyan: "#7ff0ea",
  selection: "#2f6bb0",
  "line-highlight": "#1a1a1a",
  "ghost-fg": "#d8d8d8",
  shadow: "0 0 0 1px #ffffff",
  ...SHARED,
};

export const BUILTIN_THEMES: Record<BuiltinTheme, TokenSet> = {
  "nexus-midnight": NEXUS_MIDNIGHT,
  "nexus-light": NEXUS_LIGHT,
  "nexus-contrast": NEXUS_CONTRAST,
};

export const BUILTIN_THEME_IDS: readonly BuiltinTheme[] = [
  "nexus-midnight",
  "nexus-light",
  "nexus-contrast",
];

export const TOKEN_NAMES = Object.keys(NEXUS_MIDNIGHT) as TokenName[];

/** @nexus/protocol:s NexusSettings.theme känner bara dark|light|nexus-midnight. */
export function protocolThemeOf(id: BuiltinTheme): "dark" | "light" | "nexus-midnight" {
  if (id === "nexus-light") return "light";
  if (id === "nexus-midnight") return "nexus-midnight";
  // hög kontrast är ett mörkt set — host får veta mörk, UI:t behåller kontrast-lokalt
  return "dark";
}

export function themeFromProtocol(
  value: "dark" | "light" | "nexus-midnight" | undefined,
): ThemePreference {
  if (value === "light") return "nexus-light";
  if (value === "dark") return "system";
  return "nexus-midnight";
}

export function isBuiltinTheme(value: string): value is BuiltinTheme {
  return BUILTIN_THEME_IDS.includes(value as BuiltinTheme);
}

/** Upplösning av `system` — testbar eftersom preferensen injiceras, ingen matchMedia här. */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): BuiltinTheme {
  if (preference !== "system") return preference;
  return systemPrefersDark ? "nexus-midnight" : "nexus-light";
}

export function themeTokens(id: BuiltinTheme): TokenSet {
  return BUILTIN_THEMES[id];
}

export function tokensToCss(tokens: Readonly<Partial<TokenSet>>, scope = ":root"): string {
  const lines = Object.entries(tokens)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([name, value]) => `  --nx-${name}: ${String(value).trim()};`);
  return `${scope} {\n${lines.join("\n")}\n}`;
}

export interface SanitizedCss {
  readonly css: string;
  readonly rejected: string[];
}

/**
 * Custom CSS från settings är användardata som injiceras i dokumentet. Vi tar bort allt som
 * kan hämta resursers utifrån eller köra kod: @import, url(...), expression(), javascript:.
 * Resten av CSS:n är användarens — den skriver vi inte på.
 */
export function sanitizeCustomCss(input: string): SanitizedCss {
  const rejected: string[] = [];
  let css = input ?? "";
  const patterns: readonly { readonly label: string; readonly re: RegExp }[] = [
    { label: "@import", re: /@import[^;]*;?/gi },
    { label: "url()", re: /url\s*\([^)]*\)?/gi },
    { label: "expression()", re: /expression\s*\([^)]*\)?/gi },
    { label: "javascript:", re: /javascript\s*:[^;'")]*/gi },
    { label: "behavior", re: /behavior\s*:[^;}]*/gi },
  ];
  for (const pattern of patterns) {
    const found = css.match(pattern.re);
    if (found && found.length > 0) {
      rejected.push(`${pattern.label} (${found.length})`);
      css = css.replace(pattern.re, "");
    }
  }
  return { css: css.trim(), rejected };
}

/** Monotona skaleringar: UI:t använder bara dessa, aldrig godtyckliga px. */
export const SPACE = {
  xs: "4px",
  sm: "8px",
  md: "12px",
  lg: "16px",
  xl: "24px",
} as const;

/**
 * config.ts — ConfigStore + .env-parser (R2: ingen hemlighet lämnar lagret som värde).
 *
 * Miljöfilen läses i host-processen (aldrig renderer). Hemligheter exponeras bara
 * som { name, isSet, source } via SecretKeyInfo. Det finns MEDFLATEN ingen kodväg som
 * prentar ett hemligt värde — `secret()` är intern och returnerar aldrig värdet utåt.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelRole, NexusSettings, SecretKeyInfo } from "@nexus/protocol";

export interface NexusConfig {
  root: string;
  nexusDir: string;
  env: Record<string, string>;
  settings: NexusSettings;
  envFile: string;
}

/** Icke-sekreta standardinställningar; root fylls i av ConfigStore.load. */
export function defaultSettings(root: string): NexusSettings {
  return {
    theme: "nexus-midnight",
    fontSize: 14,
    workspaceRoot: root,
    agentMode: "agent",
    approvalMode: "ask",
    allowlist: ["pnpm test", "pnpm build", "git status", "git diff", "ls", "echo"],
    maxAgentSteps: 12,
    autocompleteEnabled: true,
    autocompleteDebounceMs: 250,
    speakResponses: false,
    voiceLanguage: "sv",
    whisperModel: "whisper-large-v3",
    eyesAutoVerify: true,
    ragEnabled: true,
    logLevel: "info",
    keybindings: {
      "palette.open": "Ctrl+Shift+P",
      "chat.open": "Ctrl+K",
      "file.open": "Ctrl+P",
      "completion.trigger": "Ctrl+Space",
      "terminal.toggle": "Ctrl+`",
      "help.focus": "F1",
    },
    roles: {
      chat: null,
      agent: null,
      autocomplete: null,
      embeddings: null,
      vision: null,
      reasoning: null,
    },
  };
}

/**
 * .env-parser — hanterar: kommentarer (#), blankrader, `export `-prefix,
 * enkel/dubbel quotes med escaper, CRLF och inline-kommentarer i okvotade värden.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else {
      // Okvotat: klipp bort inline-kommentar ( ` # ` måste föregås av mellanslag ).
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Skriver tillbaka ett nyckelvärde i .env-texten och BEHÅLLER alla andra rader och
 * kommentarer ordgrant (round-trip). Lägger till nyckeln sist om den saknas.
 */
export function setEnvValue(text: string, name: string, value: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let target = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const stripped = line.trim();
    if (stripped.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(stripped);
    if (m && m[1] === name) {
      target = i;
      break;
    }
  }
  const safeValue = /["\s]/.test(value) || value.length === 0 ? `"${value.replace(/"/g, '\\"')}"` : value;
  if (target >= 0) {
    const original = lines[target] ?? "";
    const exportPrefix = /^\s*export\s+/.test(original) ? "export " : "";
    const leading = /^(\s*)/.exec(original)?.[1] ?? "";
    lines[target] = `${leading}${exportPrefix}${name}=${safeValue}`;
    return lines.join(eol);
  }
  // Saknas: append på en ny rad, men bevara ev. avslutande tomrad.
  const trailingNewline = text.endsWith("\n") || text.endsWith("\r\n");
  const prefix = text.length > 0 && !trailingNewline ? eol : "";
  return `${text}${prefix}${name}=${safeValue}${eol}`;
}

const SECRET_PATTERN = /(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|_KEY)$/i;

function mask(value: string): SecretKeyInfo["masked"] {
  return value.length > 0 ? "****" : undefined;
}

export class ConfigStore {
  readonly config: NexusConfig;
  /** Källa per nyckelnamn — endast "env" | "dotenv"; aldrig värdet. */
  private readonly sources: Map<string, "env" | "dotenv"> = new Map();

  private constructor(config: NexusConfig, sources: Map<string, "env" | "dotenv">) {
    this.config = config;
    this.sources = sources;
  }

  static load(opts: { root: string; dotenvPaths?: string[] }): ConfigStore {
    const root = path.resolve(opts.root);
    const nexusDir = path.join(root, ".nexus");
    const dotenvPaths = opts.dotenvPaths && opts.dotenvPaths.length > 0 ? opts.dotenvPaths : [path.join(root, ".env")];
    const envFile = dotenvPaths[0] ?? path.join(root, ".env");

    const env: Record<string, string> = {};
    const sources = new Map<string, "env" | "dotenv">();

    // 1) .env-filer (dotenv-källa), senast skrivet vinner bland dotenv-värdena.
    for (const p of dotenvPaths) {
      let text = "";
      try {
        text = fs.readFileSync(p, "utf8");
      } catch {
        continue;
      }
      const parsed = parseEnv(text);
      for (const [k, v] of Object.entries(parsed)) {
        env[k] = v;
        sources.set(k, "dotenv");
      }
    }

    // 2) process.env överlagrar dotenv (riktiga miljövariänger har företräde).
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") {
        env[k] = v;
        sources.set(k, "env");
      }
    }

    // 3) settings.json i .nexus (om den finns), annars standarder.
    const settings = defaultSettings(root);
    const settingsFile = path.join(nexusDir, "settings.json");
    let mergedSettings: NexusSettings = settings;
    try {
      if (fs.existsSync(settingsFile)) {
        const onDisk = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as Partial<NexusSettings>;
        mergedSettings = {
          ...settings,
          ...onDisk,
          keybindings: { ...settings.keybindings, ...(onDisk.keybindings ?? {}) },
          roles: { ...settings.roles, ...(onDisk.roles ?? {}) },
          allowlist: onDisk.allowlist ?? settings.allowlist,
        };
      }
    } catch {
      // Skadad JSON → falla tillbaka till standard, krascha aldrig (R5).
    }

    return new ConfigStore({ root, nexusDir, env, settings: mergedSettings, envFile }, sources);
  }

  get<K extends keyof NexusSettings>(k: K): NexusSettings[K] {
    return this.config.settings[k];
  }

  set(patch: Partial<NexusSettings>): NexusSettings {
    const next: NexusSettings = {
      ...this.config.settings,
      ...patch,
      keybindings: { ...this.config.settings.keybindings, ...(patch.keybindings ?? {}) },
      roles: { ...this.config.settings.roles, ...(patch.roles ?? {}) },
    };
    (this.config as { settings: NexusSettings }).settings = next;
    const dir = path.join(this.config.root, ".nexus");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(next, null, 2), { encoding: "utf8" });
    } catch {
      // Kundi inte skriva — returnera ändå den i-minnes-uppdaterade inställningen.
    }
    return next;
  }

  /**
   * Intern läsning av ett miljövärde. Exponeras ALDRIG via publikt API; endast
   * provider-lagret (samma process) använder detta för att auktorisera anrop.
   */
  secret(name: string): string | undefined {
    const v = this.config.env[name];
    return v && v.length > 0 ? v : undefined;
  }

  secretInfo(name: string): SecretKeyInfo {
    const value = this.config.env[name];
    const isSet = typeof value === "string" && value.length > 0;
    const source = this.sources.get(name) ?? "config";
    return { name, isSet, source, masked: isSet ? mask(value as string) : undefined };
  }

  allSecretInfo(): SecretKeyInfo[] {
    const names = Object.keys(this.config.env)
      .filter((n) => SECRET_PATTERN.test(n))
      .sort();
    return names.map((n) => this.secretInfo(n));
  }

  /** Skriver hemligheten till .env, bevarar kommentarer, sätter 0600, ALDRIG loggad. */
  setSecret(name: string, value: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Ogiltigt miljönyckelnamn: ${name}`);
    }
    let text = "";
    try {
      text = fs.readFileSync(this.config.envFile, "utf8");
    } catch {
      text = `# NEXUS-IDE .env (auto-genererad)\n`;
    }
    const next = setEnvValue(text, name, value);
    fs.writeFileSync(this.config.envFile, next, { encoding: "utf8", mode: 0o600 });
    // Uppdatera i-minnes-miljön omedelbart så att anrop efteråt ser värdet.
    this.config.env[name] = value;
    this.sources.set(name, "dotenv");
  }

  roleAssignment(role: ModelRole): { providerId: string; model: string } | null {
    return this.config.settings.roles[role] ?? null;
  }
}

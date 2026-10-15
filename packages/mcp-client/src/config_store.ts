/**
 * McpConfigStore — läs/skriv av `mcp.json` (FAS 4.2).
 *
 * Regler som gäller (CONVENTIONS R2, hemligheter utan mjuk start):
 *   1. mcp.json får ALDRIG innehålla en riktig nyckel. Alla hemligheter write:s
 *      som `${ENV_VAR}` och läses från `.env` / processmiljön vid uppstart.
 *   2. Interpolation stöder `${NAMN}` i `command`, `args[]`, `env{}`, `headers{}`
 *      och `url`. Saknas variabeln blir servern `error` med namnet — aldrig tyst.
 *   3. Vid skrivning reverseras upplösta värden tillbaka till placeholder-form om
 *      de matchar en miljövariabel, och riktiga nyckelmönster avvisas hårt.
 *   4. UI-mutationerna (upsert/remove/toggle) är icke-förstörande: fel → disk och
 *      minnesläge lämnas orörda, ingen igångvarande server dör.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { McpServerConfig, McpTransport } from "@nexus/protocol";
import { McpConfigError, type McpStoreMutationResult, type ResolvedServer } from "./types";

/** Dokumentformatet i mcp.json. */
export interface McpConfigDocument {
  readonly version: number;
  readonly servers: readonly McpServerConfig[];
}

export interface McpConfigStoreOptions {
  /** Sökväg till mcp.json. Standard: $MCP_CONFIG_PATH annars <repoRoot>/mcp.json. */
  readonly filePath?: string;
  /** Repo-rot för inbyggda variabler. Standard: mappar uppåt till pnpm-workspace.yaml. */
  readonly repoRoot?: string;
  /** Arbetsyta för ${NEXUS_WORKSPACE_ROOT}. Standard: repoRoot (kan överstyras av env). */
  readonly workspaceRoot?: string;
  /** Miljön som interpoleras. Standard: process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Läs .env från repoRoot. Standard true (finns inte filen är det ett no-op). */
  readonly readDotEnv?: boolean;
}

/** `server.id` får inte innehålla namespace-separatorn `__` — kollision måste vara omöjlig.
 *
 * ASCII-mönstret är ETT BEGRÄNSNING MED VERKLEG ANLEDNING, inte slarv: id:t blir en del av
 * verktygsnamnet (`<serverId>__<tool>`) som skickas till modell-API:erna, och OpenAI liksom
 * Anthropic tillåter endast [A-Za-z0-9_-] i function-namn. Ett id med å/ä/ö skulle alltså
 * producera ett verktygsnamn som API:et avvisar. `label` är fri text och ska vara svenska.
 * (En tidigare version av denna fil hade ett buggfelt mönster som bara råkade förbjuda `__`
 * för icke-ASCII-id — testet "kollision måste vara omöjlig" fångade det.) */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TRANSPORTS: readonly McpTransport[] = ["stdio", "sse", "http"];
const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Mönster som är uppenbara riktiga nycklar — dessa får aldrig hamna på disk. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /\bsk-ant-[A-Za-z0-9_-]{12,}/,
  /\bnvapi-[A-Za-z0-9_-]{12,}/,
  /\bgh[pousr]_[A-Za-z0-9]{12,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bya2p_[A-Za-z0-9_-]{16,}/,
  /Bearer\s+[A-Za-z0-9._+\/=-]{24,}/i,
  /\bsq0atp-[0-9A-Za-z\-_]{22}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/**
 * Enkel .env-tolk: kommentarer, `export N=V`, enklare citattecken.
 * Ingen extern dependencies — vi vill inte ha en dotenv-loader i host-proessen.
 * @param text
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const name = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    const quote = value.charAt(0);
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      // Endast rad-kommentar utanför citat: "V=1   # kommentar".
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[name] = value;
  }
  return out;
}

/**
 * Är modulen körd som CommonJS finns __dirname; körd via Vite/vitest (ESM) kan
 * den saknas. Då används process.cwd() — alltid en katalog inuti workspacet.
 */
function safeModuleDir(): string {
  return typeof __dirname === "string" && __dirname.length > 0 ? __dirname : process.cwd();
}

/**
 * Hitta repo-rot: mappar uppåt från startpunkten tills pnpm-workspace.yaml ses.
 * @param from
 */
export function findRepoRoot(from: string): string {
  let current = resolve(from);
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = current.slice(0, current.lastIndexOf(sep));
    if (parent === current || parent.length === 0) return resolve(from);
    current = parent;
  }
}

/**
 * Är värdet ett hemligt mönster? Används både för in- och utlåsning.
 * @param value
 */
export function looksLikeSecret(value: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(value));
}

/**
 * Interpolera en sträng. Okända variabler samlas i `missing` och lämnas som
 * originaltext i värdet, så att valideringen kan spärra servern i stället för
 * att starta `node ${OBAND}.mjs`.
 */
export function interpolateString(value: string, env: Readonly<Record<string, string>>): { value: string; missing: string[] } {
  const missing: string[] = [];
  const out = value.replace(VAR_PATTERN, (whole: string, name: string) => {
    const replacement = env[name];
    if (replacement === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return whole;
    }
    return replacement;
  });
  return { value: out, missing };
}

/** Samla alla `${VAR}`-namn i en config. */
function referencedVars(server: McpServerConfig): string[] {
  const names = new Set<string>();
  const fields: string[] = [
    server.command ?? "",
    ...(server.args ?? []),
    server.url ?? "",
    server.cwd ?? "",
    ...Object.values(server.env ?? {}),
    ...Object.values(server.headers ?? {}),
  ];
  for (const field of fields) {
    for (const match of field.matchAll(VAR_PATTERN)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  return [...names];
}

/** Validera en serverconfig mot kontraktet; returnerar alla problem (tom = ok). */
export function validateServerConfig(server: unknown): string[] {
  const issues: string[] = [];
  if (typeof server !== "object" || server === null || Array.isArray(server)) {
    return ["server-objekt förväntas"];
  }
  const rec = server as Record<string, unknown>;
  const id = rec["id"];
  if (typeof id !== "string" || id.length === 0) issues.push("id: sträng krävs");
  else if (!ID_PATTERN.test(id)) issues.push(`id: ogiltigt format (${id}) — [A-Za-z0-9][A-Za-z0-9._-], max 64, aldrig "__" (id:t hamnar i verktygsnamnet som modell-API:t avvisar om det inte är ASCII)`);
  else if (id.includes("__")) issues.push(`id: får inte innehålla "__" (reserverad för namnrymd) (${id})`);

  const transport = rec["transport"];
  if (typeof transport !== "string" || !TRANSPORTS.includes(transport as McpTransport)) {
    issues.push(`transport: måste vara ${TRANSPORTS.join(" | ")}`);
  } else if (transport === "stdio") {
    const command = rec["command"];
    if (typeof command !== "string" || command.trim().length === 0) issues.push("stdio: command krävs");
    const url = rec["url"];
    if (typeof url === "string" && url.trim().length > 0) issues.push("stdio: url får inte användas");
  } else {
    const url = rec["url"];
    if (typeof url !== "string" || url.trim().length === 0) {
      issues.push(`${transport}: url krävs`);
    } else {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") issues.push(`url: bara http/https (${parsed.protocol})`);
      } catch {
        issues.push(`url: ogiltig URL (${url})`);
      }
    }
  }

  const args = rec["args"];
  if (args !== undefined) {
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) issues.push("args: måste vara en strängarray");
    // Ett tomt array är bara UI-brus (normaliseras bort fore disk) — ett icke-tomt
    // args till en http/sse-server är darremot ett verkligt formfel.
    else if (transport !== "stdio" && args.length > 0) issues.push("args: endast giltig för stdio");
  }
  for (const key of ["env", "headers"] as const) {
    const value = rec[key];
    if (value !== undefined) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        issues.push(`${key}: måste vara ett objekt av strängar`);
      } else {
        for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
          if (typeof raw !== "string") issues.push(`${key}.${name}: värdet måste vara en sträng`);
        }
      }
    }
  }
  if (rec["cwd"] !== undefined && typeof rec["cwd"] !== "string") issues.push("cwd: måste vara sträng");
  if (typeof rec["enabled"] !== "boolean") issues.push("enabled: boolean krävs");
  if (rec["label"] !== undefined && typeof rec["label"] !== "string") issues.push("label: måste vara sträng");
  if (rec["builtin"] !== undefined && typeof rec["builtin"] !== "boolean") issues.push("builtin: måste vara boolean");

  // Hård regel: inga literala hemligheter i konfigurationslagret.
  for (const field of [
    ["command", rec["command"]],
    ["url", rec["url"]],
    ["cwd", rec["cwd"]],
    ...Object.entries((rec["env"] as Record<string, unknown> | undefined) ?? {}).map(([k, v]) => [`env.${k}`, v]),
    ...Object.entries((rec["headers"] as Record<string, unknown> | undefined) ?? {}).map(([k, v]) => [`headers.${k}`, v]),
  ] as const) {
    const [name, value] = field;
    if (typeof value === "string" && looksLikeSecret(value)) issues.push(`${name}: ser ut som en riktig nyckel — använd ${"$"}{ENV_VARIABEL}`);
  }
  if (Array.isArray(args)) {
    for (const [index, a] of args.entries()) {
      if (typeof a === "string" && looksLikeSecret(a)) issues.push(`args[${index}]: ser ut som en riktig nyckel — sätt den i .env`);
    }
  }
  return issues;
}

/**
 * Läs/skriv-omslag för mcp.json. En instans per host-process.
 */
export class McpConfigStore {
  readonly filePath: string;
  readonly repoRoot: string;
  private readonly envFile: Record<string, string>;
  private readonly processEnv: Readonly<Record<string, string | undefined>>;
  private cache: McpServerConfig[] | null = null;

  constructor(options: McpConfigStoreOptions = {}) {
    this.repoRoot = resolve(options.repoRoot ?? findRepoRoot(safeModuleDir()));
    const env = options.env ?? (process.env as Readonly<Record<string, string | undefined>>);
    this.processEnv = env;
    this.envFile = options.readDotEnv === false ? {} : this.readDotEnvFiles();
    const configured = options.filePath ?? env["MCP_CONFIG_PATH"] ?? join(this.repoRoot, "mcp.json");
    this.filePath = isAbsolute(configured) ? configured : resolve(this.repoRoot, configured);
  }

  /** Miljön som interpolation använder: .env < process.env < inbyggda variabler. */
  private buildEnvMap(): Record<string, string> {
    const merged: Record<string, string> = { ...this.envFile };
    for (const [key, value] of Object.entries(this.processEnv)) {
      if (typeof value === "string") merged[key] = value;
    }
    const workspace = this.processEnv["NEXUS_WORKSPACE_ROOT"] ?? this.repoRoot;
    // Inbyggda, inte hemliga, variabler så defaults i mcp.json fungerar på vilken
    // maskin som helst utan att commita absoluta sökvägar.
    merged["NEXUS_REPO_ROOT"] ??= this.repoRoot;
    merged["NEXUS_WORKSPACE_ROOT"] ??= resolve(workspace);
    merged["NODE_EXECUTABLE"] ??= process.execPath;
    return merged;
  }

  private readDotEnvFiles(): Record<string, string> {
    const candidates = [join(this.repoRoot, ".env"), join(this.repoRoot, ".env.local")];
    const out: Record<string, string> = {};
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      try {
        Object.assign(out, parseDotEnv(readFileSync(path, "utf8")));
      } catch {
        // Korrupt .env: vi faller tillbaka till ren process.env, ingen krasch.
      }
    }
    return out;
  }

  /** Framgångsrikt upplösta värden för reversering till placeholder vid skrivning. */
  private reverseLookup(env: Readonly<Record<string, string>>): Map<string, string> {
    const map = new Map<string, string>();
    for (const [name, value] of Object.entries(env)) {
      if (value.length > 0 && !map.has(value)) map.set(value, `\${${name}}`);
    }
    return map;
  }

  /**
   * Läs dokumentet från disk och validera det. Kastar McpConfigError vid skadat
   * innehåll — UNLESS vi har ett känt bra läge i minnet sedan tidigare. Då är
   * disken det skadade (ex. en trasig skrivning) och vi degraderar till minnes-
   * läget i stället för att krascha hela MCP-laget (CONVENTIONS R5).
   */
  read(): readonly McpServerConfig[] {
    try {
      const servers = this.readUncached();
      this.cache = servers.map((s) => ({ ...s }));
      return this.cache;
    } catch (err) {
      if (this.cache !== null) return this.cache.map((s) => ({ ...s }));
      throw err;
    }
  }

  private readUncached(): McpServerConfig[] {
    if (!existsSync(this.filePath)) {
      throw new McpConfigError(`mcp.json saknas: ${this.filePath}`, ["fil saknas"]);
    }
    const text = (() => {
      try {
        return readFileSync(this.filePath, "utf8");
      } catch (err) {
        // Ex. katalog i stället för fil, eller åtkomstfel — alltid ett fångbart fel.
        throw new McpConfigError(`mcp.json kunde inte läsas: ${err instanceof Error ? err.message : String(err)}`, ["läsning"]);
      }
    })();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (err) {
      throw new McpConfigError(`mcp.json är inte giltig JSON: ${err instanceof Error ? err.message : String(err)}`, ["JSON-fel"]);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new McpConfigError("mcp.json måste vara ett objekt med { version, servers }", ["form"]);
    }
    const doc = parsed as Record<string, unknown>;
    const rawServers = doc["servers"];
    if (!Array.isArray(rawServers)) throw new McpConfigError("mcp.json: `servers` måste vara en array", ["form"]);
    const version = doc["version"];
    if (typeof version === "number" && version > 1) {
      throw new McpConfigError(`mcp.json: okänd version ${String(version)} (förväntad 1)`, ["version"]);
    }
    const issues: string[] = [];
    const out: McpServerConfig[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of rawServers.entries()) {
      const local = validateServerConfig(entry).map((m) => `servers[${index}] ${m}`);
      if (local.length > 0) {
        issues.push(...local);
        continue;
      }
      const server = entry as McpServerConfig;
      if (seen.has(server.id)) {
        issues.push(`servers[${index}]: dublett-id ${server.id}`);
        continue;
      }
      seen.add(server.id);
      out.push(normalizeServer(server));
    }
    if (issues.length > 0) throw new McpConfigError(`mcp.json validerar inte (${issues.length} fel)`, issues);
    return out;
  }

  /**
   * Skriv whole-listan atomiskt. Alltid validering + hemlighetsrensning före disk.
   * @param servers
   */
  write(servers: readonly McpServerConfig[]): void {
    const issues: string[] = [];
    const seen = new Set<string>();
    const env = this.buildEnvMap();
    const reverse = this.reverseLookup(env);
    const clean: McpServerConfig[] = [];
    for (const server of servers) {
      if (seen.has(server.id)) issues.push(`dubbelt id: ${server.id}`);
      seen.add(server.id);
      const diskForm = this.toDiskForm(server, reverse, issues);
      // Validera FORMEN SOM GÅR TILL DISK, inte indata: en inmatad nyckel som reverseras
      // till ${OPENAI_API_KEY} är inte längre en nyckel på disk. Att validera rådata först
      // (som det var byggt) fick en laglig reversal att se ut som ett fel.
      issues.push(...validateServerConfig(diskForm));
      clean.push(diskForm);
    }
    if (issues.length > 0) throw new McpConfigError(`vägrar skriva mcp.json (${issues.length} fel)`, issues);

    const doc: McpConfigDocument = { version: 1, servers: clean };
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
      renameSync(tmp, this.filePath);
    } catch (err) {
      // Ingen tmp-fil får lämnas kvar i användarens rot.
      try {
        unlinkSync(tmp);
      } catch {
        // går inte ta bort den heller — original fil är orörd, det viktiga.
      }
      throw new McpConfigError(`kunde inte skriva ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`, ["skrivning"]);
    }
    this.cache = clean.map((s) => ({ ...s }));
  }

  /**
   * Se till att inget hemligt värde följer med till disken: reversera kända
   * miljövariabler till `${NAMN}`, annars avvisa.
   */
  private toDiskForm(server: McpServerConfig, reverse: Map<string, string>, issues: string[]): McpServerConfig {
    const scrub = (field: string, value: string | undefined): string | undefined => {
      if (value === undefined) return undefined;
      const placeholder = reverse.get(value);
      if (placeholder !== undefined && !value.includes("${")) return placeholder;
      if (looksLikeSecret(value)) {
        issues.push(`${server.id}.${field}: innehåller en nyckel — flytta till .env och skriv ${"${ENV_VAR}"}`);
        return value;
      }
      return value;
    };

    const envOut: Record<string, string> = {};
    for (const [name, value] of Object.entries(server.env ?? {})) {
      const fixed = scrub(`env.${name}`, value);
      if (fixed !== undefined) envOut[name] = fixed;
    }
    const headersOut: Record<string, string> = {};
    for (const [name, value] of Object.entries(server.headers ?? {})) {
      const fixed = scrub(`headers.${name}`, value);
      if (fixed !== undefined) headersOut[name] = fixed;
    }
    const argsOut = (server.args ?? []).map((a, i) => scrub(`args[${i}]`, a) ?? a);
    const result: McpServerConfig = {
      ...server,
      command: scrub("command", server.command),
      url: scrub("url", server.url),
      cwd: scrub("cwd", server.cwd),
      args: argsOut,
      env: Object.keys(envOut).length > 0 ? envOut : undefined,
      headers: Object.keys(headersOut).length > 0 ? headersOut : undefined,
    };
    // `undefined`- och tom-fält skalas bort (args:[] for en http-server är ett
    // valideringsfel vid aterlasning) — normalizeServer är samma kanonisering
    // read() använder, sa disk och minne alltid star i formriktig overensstammelse.
    return normalizeServer(JSON.parse(JSON.stringify(result)) as McpServerConfig);
  }

  /**
   * Redacted vy för UI: samma serverlista men med miljö- och header-NAMN only,
   * aldrig värden. (SecretKeyInfo-mönstret.)
   */
  listForUi(): readonly { readonly server: McpServerConfig; readonly envNames: readonly string[]; readonly headerNames: readonly string[]; readonly isEnvComplete: boolean }[] {
    const env = this.buildEnvMap();
    return this.read().map((server) => {
      const names = referencedVars(server);
      return {
        server,
        envNames: names,
        headerNames: Object.keys(server.headers ?? {}),
        isEnvComplete: names.every((n) => env[n] !== undefined),
      };
    });
  }

  /** Interpolera en config till det som faktiskt startar processen / HTTP-anropet. */
  resolve(server: McpServerConfig): ResolvedServer {
    const env = this.buildEnvMap();
    const missing: string[] = [];
    const missingOptional: string[] = [];
    const fatal = (value: string | undefined): string | undefined => {
      if (value === undefined) return undefined;
      const r = interpolateString(value, env);
      missing.push(...r.missing);
      return r.value;
    };
    const resolvedEnv: Record<string, string> = {};
    for (const [name, raw] of Object.entries(server.env ?? {})) {
      const r = interpolateString(raw, env);
      // Saknas variabeln: uteslut nyckeln — servern får aldrig se "${VAR}" som värde.
      if (r.missing.length > 0) missingOptional.push(...r.missing);
      else resolvedEnv[name] = r.value;
    }
    const resolvedHeaders: Record<string, string> = {};
    for (const [name, raw] of Object.entries(server.headers ?? {})) {
      const r = interpolateString(raw, env);
      if (r.missing.length > 0) missingOptional.push(...r.missing);
      else resolvedHeaders[name] = r.value;
    }
    const args = (server.args ?? []).map((a) => {
      const r = interpolateString(a, env);
      missing.push(...r.missing);
      return r.value;
    });
    return {
      id: server.id,
      transport: server.transport,
      command: fatal(server.command),
      args,
      env: resolvedEnv,
      cwd: server.cwd !== undefined ? fatal(server.cwd) : undefined,
      url: fatal(server.url),
      headers: resolvedHeaders,
      missing: [...new Set(missing)],
      missingOptional: [...new Set(missingOptional)],
    };
  }

  /**
   * Nuvarande lista ur cachen (eller disk). En saknad mcp.json är här en TOM
   * lista, inte ett fel: settings-UI:t måste kunna lägga till sin första server
   * utan att filen finns än (ensureDefaults/write skapar den). read() förblir
   * strikt — det är API:t som ska rapportera "fil saknas".
   */
  private current(): McpServerConfig[] {
    if (this.cache === null) {
      try {
        this.cache = this.readUncached().map((s) => ({ ...s }));
      } catch (err) {
        if (err instanceof McpConfigError && err.issues.includes("fil saknas")) this.cache = [];
        else throw err;
      }
    }
    return this.cache.map((s) => ({ ...s }));
  }

  /**
   * Lägg till eller ersätt en server. Icke-förstörande: validering och skrivning
   * först, minnesläget återställs om nagot felar.
   */
  upsert(server: McpServerConfig): McpStoreMutationResult {
    const before = this.current();
    // Förkontrollen ger det vänliga meddelandet "ogiltig serverkonfiguration", men den får inte
    // döma en värdefull reversal: klistrar användaren in en nyckel som EXAKT matchar en miljövariabel
    // reverseras den till ${NAMN} på disk och är då ingen nycka alls. Validerar rådata först
    // förbjuds det enda tillåtna sättet att fylla i ett fält i UI:t.
    const candidate = this.toDiskForm(server, this.reverseLookup(this.buildEnvMap()), []);
    const issues = validateServerConfig(candidate);
    if (issues.length > 0) {
      this.cache = before;
      return { ok: false, servers: before, changed: false, error: `ogiltig serverkonfiguration: ${issues[0]}`, issues };
    }
    const next = before.filter((s) => s.id !== server.id);
    const replaced = before.some((s) => s.id === server.id);
    next.push(normalizeServer(server));
    try {
      this.write(next);
    } catch (err) {
      this.cache = before;
      const wrapped = err instanceof McpConfigError ? err : new McpConfigError(String(err));
      return { ok: false, servers: before, changed: false, error: wrapped.message, issues: wrapped.issues };
    }
    return { ok: true, servers: this.current(), changed: true, error: replaced ? undefined : "skapad" };
  }

  /** Ta bort en server. Okänt id = icke-förstörande no-op med ok:false. */
  remove(id: string): McpStoreMutationResult {
    const before = this.current();
    if (!before.some((s) => s.id === id)) {
      return { ok: false, servers: before, changed: false, error: `okänd server-id: ${id}` };
    }
    const next = before.filter((s) => s.id !== id);
    try {
      this.write(next);
    } catch (err) {
      this.cache = before;
      const wrapped = err instanceof McpConfigError ? err : new McpConfigError(String(err));
      return { ok: false, servers: before, changed: false, error: wrapped.message, issues: wrapped.issues };
    }
    return { ok: true, servers: this.current(), changed: true };
  }

  /** Sla på/av. Utan `enabled` inverters nuvarande lage. */
  toggle(id: string, enabled?: boolean): McpStoreMutationResult {
    const before = this.current();
    const index = before.findIndex((s) => s.id === id);
    if (index < 0) return { ok: false, servers: before, changed: false, error: `okänd server-id: ${id}` };
    const target = before[index];
    if (target === undefined) return { ok: false, servers: before, changed: false, error: `okänd server-id: ${id}` };
    const nextEnabled = enabled ?? !target.enabled;
    const next = [...before];
    next[index] = { ...target, enabled: nextEnabled };
    try {
      this.write(next);
    } catch (err) {
      this.cache = before;
      const wrapped = err instanceof McpConfigError ? err : new McpConfigError(String(err));
      return { ok: false, servers: before, changed: false, error: wrapped.message, issues: wrapped.issues };
    }
    return { ok: true, servers: this.current(), changed: true };
  }

  /**
   * Skriv standardkonfigurationen om filen saknas (används av setup_mcp.mjs och
   * av host:ens första start). Existerande fil lämnas ALWAYS i peace.
   */
  ensureDefaults(defaults: readonly McpServerConfig[]): { created: boolean; servers: readonly McpServerConfig[] } {
    if (existsSync(this.filePath)) {
      try {
        return { created: false, servers: this.read() };
      } catch {
        // Korrupt fil: vi overskriver INTE användarens data, utan lämnar fel till setup.
        return { created: false, servers: [] };
      }
    }
    this.write(defaults);
    return { created: true, servers: this.current() };
  }

  /** Alla `${VAR}`-namn som dokumentet refererar — för sekretessgenomgang i UI. */
  referencedEnvNames(): string[] {
    const names = new Set<string>();
    for (const server of this.current()) for (const n of referencedVars(server)) names.add(n);
    return [...names].sort();
  }
}

/** Normalisert lagringsform: always args/env/headers arrays/objects (inte undefined). */
export function normalizeServer(server: McpServerConfig): McpServerConfig {
  const out: McpServerConfig = {
    id: server.id,
    transport: server.transport,
    enabled: server.enabled,
    ...(server.label !== undefined ? { label: server.label } : {}),
    ...(server.builtin !== undefined ? { builtin: server.builtin } : {}),
    ...(server.command !== undefined ? { command: server.command } : {}),
    ...(server.args !== undefined && server.args.length > 0 ? { args: [...server.args] } : {}),
    ...(server.env !== undefined && Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {}),
    ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
    ...(server.url !== undefined ? { url: server.url } : {}),
    ...(server.headers !== undefined && Object.keys(server.headers).length > 0 ? { headers: { ...server.headers } } : {}),
  };
  return out;
}

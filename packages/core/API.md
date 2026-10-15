# NEXUS-IDE — `@nexus/core` public API (kontrakt mellan core-builder och host-builder)

Core_byggaren IMPLEMENTERAR detta. Host-byggaren KONSUMERAR detta. Inget namn får ändras tyst —
om en signatur måste ändras ändras den i BÅDA filerna och i denna dokument, i samma pass.

Allt nedan exporteras från `packages/core/src/index.ts`. CommonJS-bygge, TS strict, inga brytningar
mot `@nexus/protocol`-typerna (de återanvänds, de dupliceras inte).

```ts
// ---------- 1. Logger (R7: allt till debug.log, roterande) ----------
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  tail(lines?: number): string[];
  readonly path: string;
}
export function createLogger(opts: { logFile: string; level?: "debug"|"info"|"warn"|"error"; maxBytes?: number }): Logger;

// ---------- 2. Config + hemligheter (R2) ----------
export interface NexusConfig {
  root: string;                 // workspace-rot
  nexusDir: string;             // <root>/.nexus  (shadow git, checkpoints, minne)
  env: Record<string, string>;  // .env + process.env, mergerad
  settings: NexusSettings;      // från @nexus/protocol
  envFile: string;              // absolut sökväg till .env
}
export class ConfigStore {
  static load(opts: { root: string; dotenvPaths?: string[] }): ConfigStore;
  readonly config: NexusConfig;
  get<K extends keyof NexusSettings>(k: K): NexusSettings[K];
  set(patch: Partial<NexusSettings>): NexusSettings;          // persisteras till .nexus/settings.json
  secret(name: string): string | undefined;                    // ALDRIG exponerad utåt
  secretInfo(name: string): SecretKeyInfo;
  allSecretInfo(): SecretKeyInfo[];
  setSecret(name: string, value: string): void;                // skriver .env, 0600, aldrig loggat
  roleAssignment(role: ModelRole): { providerId: string; model: string } | null;
}

// ---------- 3. Workspace-filer (FAS 2.4) ----------
export class WorkspaceService {
  constructor(opts: { root: string; logger: Logger });
  listTree(root?: string, depth?: number): Promise<FsNode[]>;
  read(path: string, maxBytes?: number): Promise<FsFile>;
  write(path: string, content: string, meta?: { source?: Checkpoint["source"]; label?: string }): Promise<WriteResult>;
  createNode(path: string, kind: "file"|"dir"): Promise<WriteResult>;
  rename(from: string, to: string): Promise<WriteResult>;
  remove(path: string): Promise<void>;
  search(query: string, opts?: SearchOptions): Promise<SearchResponse>;   // ripgrep, js-fallback
  replaceInFiles(find: string, replace: string, opts?: SearchOptions): Promise<{files:string[];matches:number}>;
  languageOf(path: string): string;            // 50+ språk via ext + filnamn
  watch(cb: (e: {path: string; change: "add"|"change"|"unlink"}) => void): () => void;
  resolve(path: string): string;               // blockerar undanröjning ur root (viktigt för säkerhet)
  recent(limit?: number): Promise<FsFile[]>;
}

// ---------- 4. Checkpoints (FAS 7.2, shadow-repo) ----------
export class CheckpointManager {
  constructor(opts: { root: string; nexusDir: string; logger: Logger });
  ensure(): Promise<void>;                                  // initierar shadow git i <root>/.nexus
  create(label: string, files: string[], source: Checkpoint["source"]): Promise<Checkpoint>;
  list(limit?: number): Promise<Checkpoint[]>;
  rollback(id: string): Promise<{ restored: string[]; checkpoint: Checkpoint }>;
  diff(id: string): Promise<FileDiff[]>;
  currentFiles(): Promise<string[]>;
  count(): number;
}

// ---------- 5. SEARCH/REPLACE med fuzzy-fallback (FAS 7.3) ----------
export function applyPatches(content: string, patches: SearchReplacePatch[]):
  { ok: boolean; after: string; matched: ("exact"|"trimmed"|"fuzzy"|"none")[]; failures: string[] };
export function unifiedDiff(path: string, before: string, after: string): FileDiff;
export function splitDiffToHunks(unified: string): DiffHunk[];

// ---------- 6. Terminal (FAS 2.4 + 7.1) ----------
export class TerminalManager {
  constructor(opts: { root: string; logger: Logger; onOutput?: (termId: string, data: string) => void;
                     onExit?: (termId: string, code: number|null) => void });
  open(opts?: { cwd?: string; cols?: number; rows?: number }): Promise<{ termId: string; pid: number; shell: string }>;
  write(termId: string, data: string): void;
  resize(termId: string, cols: number, rows: number): void;
  close(termId: string): Promise<void>;
  /** Envister: fångar output och exitCode, används av agentverktyget run_terminal och av e2e T5. */
  exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number; env?: Record<string,string> }):
    Promise<{ stdout: string; stderr: string; exitCode: number; tookMs: number; timedOut: boolean }>;
  closeAll(): Promise<void>;
}

// ---------- 7. Godkännande (FAS 7.2) ----------
export class ApprovalBroker {
  constructor(opts: { mode: ApprovalMode; allowlist: string[]; logger: Logger });
  setMode(mode: ApprovalMode): void;
  needs(kind: ApprovalRequest["kind"], subject: string): boolean;
  request(partial: Omit<ApprovalRequest,"id"|"createdAt">): Promise<{ decision: "allow"|"deny"|"always"; approval: ApprovalRequest }>;
  resolve(requestId: string, decision: "allow"|"deny"|"always"): boolean;
  pending(): ApprovalRequest[];
}

// ---------- 8. Agentkärna (FAS 7.1) ----------
export interface AgentToolContext {
  workspace: WorkspaceService; checkpoints: CheckpointManager; terminals: TerminalManager;
  approvals: ApprovalBroker; providers: import("@nexus/providers").ProviderRegistry;
  mcp: { listTools(): Promise<McpToolInfo[]>; callTool(name: string, args: unknown): Promise<McpToolResult> } | null;
  voice?: VoiceToolkit; vision?: VisionToolkit; rag?: RagToolkit;
  logger: Logger; emit: (e: EventName, p: unknown) => void;
  mode: AgentMode; signal: AbortSignal;
}
export function buildCoreTools(ctx: AgentToolContext): AgentTool[];     // CORE_TOOLS från protocol
export class AgentKernel {
  constructor(ctx: AgentToolContext);
  run(goal: string, opts?: { mode?: AgentMode; paths?: string[]; maxSteps?: number }): Promise<AgentRunResult>;
  interrupt(runId: string): void;
}
export interface AgentTool {
  name: string; description: string; schema: JsonSchema; readOnly: boolean;
  run(args: unknown): Promise<{ ok: boolean; output: string; structured?: unknown }>;
}

// ---------- 9. Minne (FAS 7.4) ----------
export class MemoryLog {
  constructor(opts: { progressFile: string; decisionsFile: string });
  append(kind: "decision"|"note"|"result", text: string): Promise<{ id: string; path: string }>;
  recent(limit?: number): Promise<{ id: string; text: string; kind: string; at: number }[]>;
}

// ---------- 10. Kommandopalett (FAS 2.4) ----------
export function defaultCommands(): CommandDescriptor[];

// ---------- 11. ai-service-klient (FAS 5/6/3.5) ----------
export class AiServiceClient {
  constructor(opts: { baseUrl: string; timeoutMs?: number; logger?: Logger });
  health(): Promise<ServiceProbe>;
  transcribe(a: { audioBase64: string; format?: string; language?: string }): Promise<TranscriptResult>;
  speak(t: string, voice?: string): Promise<SpeakResult>;
  analyze(a: { imageBase64: string; prompt?: string }): Promise<VisionResult>;
  ocr(a: { imageBase64: string }): Promise<{ text: string; blocks: OcrBlock[]; engine: string }>;
  embed(chunks: string[]): Promise<number[][]>;
  indexCode(a: { root: string }): Promise<{ files: number; chunks: number; engine: string }>;
  query(a: { query: string; k?: number }): Promise<RagChunk[]>;
  status(): Promise<RagStatus>;
}
```

## Nedbrytningsregel (R5) — gäller alla ovan

Varje externa anrop fångas och blir ett välformaterat felobjekt, ALDRIG en krasch. Saknas modell eller
tjänst ska svaret bära `source: "none"` / `ok: false` och ett meddelande användaren förstår, så UI:t kan
visa "modell ej igång — starta Ollama eller ange en API-nyckel" i stället för att dö.

## Avvikelser & förtydliganden (implementerat av core-byggaren; inga publicerade namn ändrade)

- **AVVIKELSE — `AgentToolContext.providers`**: API-blocket ovan skriver `import("@nexus/providers").ProviderRegistry`.
  Eftersom `@nexus/providers` ännu bara exponerar en PLACEHOLDER (inga typ-exports) och testerna inte får importera
  dess kompilerade output, deklareras den strukturella typen `NexusProviderRegistry` i `src/toolkits.ts` och
  `AgentToolContext.providers` är av den typen. Fältnamnet `providers` är oförändrat; tackstruktur gör att den
  riktiga registret kan tilldelas så snart den exponerar `chat(req): Promise<ProviderChatResponse>` (+ valfri
  `isModelAvailable(role)`). Röst/vision/rag är likaså strukturella (`VoiceToolkit`/`VisionToolkit`/`RagToolkit`).
- **AVVIKELSE — PTY**: `node-pty` är inte en dependens (native-bygge misslyckas här). `TerminalManager` kör skal via
  `child_process` med rör. `resize()` är en dokumenterad no-op; interaktiva TUI-appar är begränsade. Allt icke-
  interaktivt (`exec`, kommandon, scripts) fungerar. Valet av skal exponeras i `open()`s `shell`-fält.
- **PÅFyllNAD (ej omdöpt)**: `ApprovalBroker`-konstruktorn tar valfri `timeoutMs` (ask-timeout→deny) och en
  `setEmit()`-koppling för `agent/approval_required`. `WorkspaceService` har extra `findRipgrep()` och
  `searchWithEngine(query, opts, "ripgrep"|"js")` for deterministisk engine-jamforelse; vanligt anrop ar `search()`.
- **PÅFyllNAD**: `TerminalManager.isPidAlive(pid)` exponeras for orphan-testet. `MemoryLog.readProgressBlock()` for
  att verifiera blockisolering. `attachMcpTools` ar `async` (listTools ar ett lonfte) och returnerar `Promise<AgentTool[]>`.


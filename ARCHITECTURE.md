# NEXUS-IDE — ARCHITECTURE.md

Systemdesign, processgränss, dataflöden, säkerhetsmodell och nedbrytningsstrategi.
Senast uppdaterad: 2026-10-15 (P0-bygget). Reglerna för vad som byggs i vilken ordning står i
`SPEC.md` + `AGENTS.md`; byggreglerna i `CONVENTIONS.md`; det kördbara kontraktet i
`packages/protocol/src/index.ts`.

## 1. Överbild

NEXUS-IDE är en lokal, användarägd AI-IDE. Inga nycklar lämnar maskinen utom till den endpoint
användaren själv valt. Tre körprocesser + en valfri Python-tjänst:

```mermaid
graph TB
  subgraph Electron["apps/desktop — Electron"]
    subgraph Main["main-process (Node)"]
      HOST["@nexus/host<br/>createHost + dispatch"]
      CORE["@nexus/core<br/>AgentKernel · Workspace · Checkpoints · Terminal · Approvals"]
      PROV["@nexus/providers<br/>ProviderRegistry (roll-fördelning)"]
      MCP["@nexus/mcp-client<br/>McpServerManager + tool-registry"]
      AIC["@nexus/core AiServiceClient"]
      HOST --> CORE --> PROV
      CORE --> MCP
      CORE --> AIC
    end
    subgraph Rnd["renderer (Chromium)"]
      UI["@nexus/ui<br/>Monaco · filträd · flikar · AI-panel · terminal · palett"]
      BR["HostBridge (valjer transport)"]
      UI --> BR
    end
    BR -- "ipcRenderer ↔ ipcMain.handle" --> HOST
    PRE["preload.ts<br/>contextIsolated, snar yta"] -.→ BR
  end
  subgraph Proc["Separate processer"]
    SRV["scripts/mcp-servers/*.mjs<br/>filesystem · git · terminal · web  (stdio)"]
    PY["apps/ai-service (FastAPI :7955)<br/>STT · TTS · VLM · OCR · embeddings · RAG"]
    OLL["Ollama :11434 (lokala modeller)"]
    LLM["LLM:edpoint<br/>NVIDIA NIM · OpenAI · custom · vLLM · LM Studio"]
  end
  MCP -- stdio/SSE/HTTP --> SRV
  AIC -- HTTP JSON --> PY
  PROV -- "OpenAI-compat / native" --> OLL
  PROV -- "chat · stream · tools" --> LLM
  PY -. "mss-skärmdump, whisper, piper" .-> OLL
```

**Princippet:** logiken bor i host-processen, aldrig i renderer. Renderer är en rent visuell klient
som bara kan göra det protokollet tillåter. Därför kan samma UI köras i Electron, i en webbläsare
eller i Playwright — utan att någon kod ändras.

## 2. Varför tre transporters en dispatch

`@nexus/host` exponerar exakt två saker: `dispatch(req) → res` och en event-flärd. Två skal wrapper
den: `createIpcHandler` för Electron, och `startWsServer` (127.0.0.1:7946) för webbläsarläge och
e2e. Transport är en detalj. Konsekvensen blir att P0-gaten T1–T8 kör **samma** kodväg som användaren
får, med undantaget fönsterhanteringen i Electron-self.

Ramarna är JSON-RPC-liknande:

```
{ jsonrpc:"2.0", id, method:"fs.write", params:{...} }              → request
{ jsonrpc:"2.0", id, result:{...}, protocolVersion }                → respons
{ jsonrpc:"2.0", id, error:{ code, message }, protocolVersion }     → fel (ErrorCode)
{ type:"event", name:"agent/tool_result", payload, ts }             → streaming
```

Metodtabellen (`MethodTable`) och eventtabellen (`EventTable`) är typade så att en felaktig params
eller ett saknat event är ett **överskridande** fel, inte ett runtime-uppdrag.

## 3. Lagren

| Lager | Paket | Ansvar | Kännetecken |
|---|---|---|---|
| Kontrakt | `packages/protocol` | typer, metod- och eventtabeller, felkoder, hjälpare | noll beroenden, byggd först |
| Vy | `packages/ui` | React-komponenter, Monaco-wrapper, xterm, teman, bryggdetektering | pratar bara via `HostBridge` |
| Skal | `apps/desktop` | Electron main/preload, fönster, ai-service-livscygel, paketering | ingen affärslogik |
| Bro | `packages/host` | implementerar varje metod i `ALL_METHOD_NAMES`, aggregerar hälsa | den enda platsen lager kastas ihop |
| Kärna | `packages/core` | ReAct-loop, verifierbara verktyg, checkpoint, konfig, logger, godkännande, RAG | testbar utan UI, utan nät |
| Modeller | `packages/providers` | enhetlig Provider + adapters + backoff/fallback + roll-fördelning | ingen lagrad nyckel, bara referens |
| Verktyg | `packages/mcp-client` | MCP-stdio/SSE/HTTP, server-manager, namespace-registrering | en död server sänker aldrig loopen |
| Röst/syn | `packages/voice`, `packages/vision` | klienter + mikrofon/skärm-fångst | P1 — finns som kodade fel redan |
| Python | `apps/ai-service` | Whisper, Piper, VLM/OCR, embeddings, Chroma | valfri; allt degraderar utan den |

## 4. Agent-loopen (P0)

```
goal ─→ plan (modell) ─→ [thought] ─→ tool_call ─→ approval? ─→ utför ─→ checkpoint?
          ↑                                                              │
          └────────────── observe (tool_result i konversationen) ←───────┘
                                  … max N steg …
          └────────────────────→ reflect → agent/done (filesChanged, toolCalls, checkpoints)
```

Verktygsgive: `CORE_TOOLS` från protokollet (read_file, write_file, edit_file, list_dir,
search_regex, run_terminal, git_op, web_fetch, screenshot_analyze, transcribe, add_checkpoint,
rollback, rag_search, suggest_next_step) plus **alla** MCP-verktyg med namnrymden
`<serverId>__<tool>`. Kollision är strukturellt omöjlig.

Säkerhet i loopen: varje skrivning → checkpoint i shadow-git; varje terminalkommando →
`ApprovalBroker` (ask | allowlist | auto); varje avslag → `ErrorCode.ApprovalDenied`, aldrig en hängande
loop; `AbortController` bryter både modell-strömmen och verktyget; `maxSteps` begränsar kolsvinn.

## 5. Modellager och roll-fördelning

En `ProviderRegistry` håller flera providers **samtidigt** och löser per roll: chat, agent,
autocomplete, embeddings, vision, reasoning. Det betyder att autocomplete kan gå mot en lokal 1,5B
medan chat går mot NVIDIA NIM och embeddings mot Ollama — utan lås. Fallback-kedjan per roll gör att
en 429 flyttar till nästa modell och **antecknar varför** i svaret.

Källor som stöds: NVIDIA NIM (`https://integrate.api.nvidia.com/v1`), Ollama (`:11434`, native),
vLLM (`:8000/v1`), LM Studio (`:1234/v1`), llama.cpp (`:8080/v1`), valfri OpenAI-kompatibel endpoint,
samt OpenAI/Anthropic/Google/OpenRouter/Groq/Mistral/xAI/DeepSeek.

**Nyckelhantering:** nycklar finns bara i `.env` (och write via settings-UI). Config-lagret exponerar
aldrig värden — bara `{name, isSet, source}`. Loggen maskerar `sk-`, `nvapi-`, `Bearer` **innan** raden
skrivs till disk. Det är testat, inte bara päskadat.

## 6. RAG-minnet

```
Workspace ─→ code-aware chunker (def/class/function/markdown-headings + fönsterfallback)
        ─→ Embedder (Provider > AiService > LocalHash, vald efter tillgänglighet)
        ─→ VectorStore (.nexus/rag, per-innehållshash ⇒ inkrementell och återupptagbar)
fråga ─→ hybrid: BM25-liknande lexikell + cosine → fused top-k → kontextblock till modellen
```

Offline-lödet är medvetet: utan modeller och utan Python-tjänst indexeras ändå kodbasen av en
deterministisk lokal embedder, och `RagStatus.engine` rapporterar **sant** vilket som svarade.

## 7. Checkpoints och rollback

Shadow-git har egen `--git-dir` under `<root>/.nexus/shadow` och egen `--work-tree`. Användarens
riktiga indeks, HEAD och status **rörs aldrig** (det är ett test, inte en intention). En checkpoint
sparar fillista, byte-statistik och commit-sha; rollback är byte-identisk; diff per checkpoint visas
i AI-panelen före apply.

## 8. Nedbrytning (R5) — appen får aldrig krascha

```
moln-LLM (riktig nyckel)
  → lokal Ollama        → vLLM/LM Studio/llama.cpp
    → ai-service        → Chrome WebSpeech/mediarecorder (P1)
      → deterministisk stub  → ErrorCode.NoModelAvailable med text till användaren
```

Varje steg sätter `source: local | cloud | stub | none`. GPU/RAM-brist ger mindre modell, inte död app.
Saknad Docker, saknad tesseract, saknad nyckel är dokumenterade förhållanden, inte undantag.

## 9. Lagring på disk

```
nexus-ide/
├── .env                    # hemligheter (gitignoread)
├── mcp.json                # MCP-servrar, ${ENV}-interpolering
├── debug.log               # roterande, maskerad
├── PROGRESS.md             # logs per fas
└── <workspace>/.nexus/
    ├── shadow/             # checkpoint-git (användarens repo orört)
    ├── rag/                # jsonl-vektorer eller chroma-persist
    ├── settings.json       # UI-inställningar
    └── pids/               # ai-service + ugnar som stoppas korrekt
```

## 10. Prestandabudget

Cold start < 5 s (renderer och host parallellt, ai-service startas i bakgrunden och är inte blockerande).
Autocomplete < 500 ms med 300 ms debounce, abort av stale requests, och lokal 1–3B-modell.
Chat first-token < 2 s. Minne < 10 GB. Terminal utan node-pty (pipor) — ett dokumenterat, inte dolt,
undantag: interaktiva TUI-appar är begränsade men pipe-körning, capture och exit-koder är exakta.

## 11. Förkastade alternativ (och varför Critique vanns)

| Alternativ | Förkastat eftersom |
|---|---|
| Forka Void Editor (FAS 2.1) | Upstream är arkerad och tar inga bidrag; basen är VS Code 1.99.3; provider-IO ligger i electron-main bakom IPC och kan inte återanvändas processfristående. Se `blueprints/VOID_ASSESSMENT.md`. |
| Kilo Code / Continue som bas | Samma problem: AI-flödet är bundet till deras extension-livscykel, och MCP/reggistry-arkitekturen är inte vår. |
| Node-pty för terminal | Nativerbygge som inte fungerar i den här Windows-miljön; child_process ger pålitlig capture och exit-kod. |
| easyocr/pytesseract | PyTorch (multipla GB, ~5 GB ledig RAM) respektive systembinär som saknas. RapidOCR ONNX är pip-installbar och självbärande. |
| ChromaDB som hård krav | Tungt beroende; JSONL-vektorstore räcker och gör offline-läget möjligt. Chroma används när Python-tjänsten finns. |
| Mocka hela provider-lagret i e2e | Grinden måste ägas av orchestatorn och köra riktig fil-IO, riktig terminal, riktig MCP-stdio. Stubbar gör bara textgenereringen deterministisk, och det står i BEVIS-kolumnen. |

## 12. P3 — backlog som BARA ARKITEKTUR (byggs ej nu)

**Marketplaces (plugin, modell, prompt, agent).** Rest-katalog + signerad paket-OCI-artefakt,
lokalt lås för installerade versioner, `PackageRegistry`-gränssnitt som liknar MCP:s server-config
men med `manifest.json` (id, version, engines, permissions). Transaktionell install/rollback över
`.nexus/packages`. Betalning ligger utanför appen (BYOK-princippet).

**Plugin-SDK (P2) som föregångare.** Ett plugin är en MCP-server + en UI-bidragsmanifest. Redan nu är
det en mall i `templates/mcp-server-ts` — SDK:t blir den formella paketeringen av samma koncept.

**VR/AR-input.** Ingen egen implementering. Gränssnittet finns redan: ett eventflöde (`voice/partial`,
`vision/result`) som en XR-bryggare kan fylla. Anteckning: kräver egen `SpatialBridge` som
`HostBridge`-implementering — arkitekturen håller, men P0/P1 har inte use case.

**Quantum-mode.** Backlog-anteckning: en `Provider`-adapter som pratar mot en kvantsimulator (external
tjänst) och en egen `AgentMode` med krets-DSL. Ingen kod skrivs; rollen är att dokumentera att
provider-lagret kan rymma det utan ändring i kärnan.

**AI-rollerna (CTO / PM / Designer / QA / DevOps / Security / Researcher).** Modell-neutral
rollspek: `{ id, systemPrompt, tillåtna verktyg, approvals, output-format }` ovanpå befintlig
`AgentKernel`. Allt som behövs finns redan — verktygsurval per roll och en promptmall. Ritas som
`RoleSpec[]` i konfiguration; byggs inte nu eftersom det inte är en P0/P1-funktion.

## 13. Vad som är känt och obestämt (ingen dolt)

* Electron-fönstret i sig är inte testat av e2e-sviten (sviten kör browser-läge mot samma host);
  det verifieras i FAS 9 med en verklig skärmdump.
* Lokal NIM i Docker är dokumenterad men inte körbar här (Docker saknas, och NIM:s egna
  minimumkrav överskrider 10 GB VRAM för de aktuella modellerna).
* NVIDIA-siffror för rate limits/credits finns inte i de hämtade sidorna och therefore rapporteras
  som overifierade (se `blueprints/NVIDIA_INTEGRATION.md`).
* Interaktiv terminal (vim, TUI) är begränsad utan PTY — pipe-läget är det testade.

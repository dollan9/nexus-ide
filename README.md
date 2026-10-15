# NEXUS-IDE

> **Läsordning för AI-agenter:** `AGENTS.md` (permanent arbetsordning + resursbudget) →
> `SPEC.md` (krav + prioriterad backlog P0–P3) → `PROGRESS.md` (bevis per fas) →
> `packages/protocol/src/index.ts` (gränssnittet) → `CONVENTIONS.md` (byggregler) →
> `packages/core/API.md` → `RESUME.md` (var vi är just nu).
> Bocka aldrig av en feature utan ett kommando som bevisar den — Regel 6.
>
> **Status i denna push:** FAS 0–4 är mätta och gröna (enhets-tester: providers 123, core 91,
> mcp-client 89). P0-grinden `pnpm e2e` (T1–T8) är skriven och körbar men ännu INTE grön —
> host-assembly och Electron-skalet färdigbyggs just nu. Lita på tabellen i `tests/RESULT.md`,
> inte på denna mening, när du bedömer vad som faktiskt fungerar.

En AI-programmeringsplattform du **äger**: egna API-nycklar, egna nedladdade modeller, full MCP-support,
röst in/ut, skärmläsning och en agent som planerar, skriver, refaktorar, debuggar, kör terminal — med
checkpoint och rollback för varje ändring. Inte en klient till någon annans tjänst.

Arbetsordningen står i [`AGENTS.md`](AGENTS.md), kraven i [`SPEC.md`](SPEC.md), varje fas med bevis i
[`PROGRESS.md`](PROGRESS.md), designen i [`ARCHITECTURE.md`](ARCHITECTURE.md) och testresultaten i
[`tests/RESULT.md`](tests/RESULT.md).

## Krav

| Vad | Minimum | Notera |
|---|---|---|
| Node.js | >= 20 | testad på v24.19 |
| pnpm | 10 | `npm i -g pnpm` (corepack kräver admin på Windows) |
| Git | valfri | checkpoint-motorn är en shadow-git |
| Python | 3.11 | bara för röst/vision (P1) |
| GPU | frivillig | RTX 3080 10 GB testad; utan GPU körs CPU-modeller |
| Docker | **behövs inte** | lokal NIM är dokumenterad men inte körd här |

## Installera

```bash
cd nexus-ide
pnpm install
cp .env.example .env          # fyll i de nycklar du har — allt annat är valfritt
bash scripts/setup_ai_service.sh   # P1: röst + vision (valfritt för P0)
bash scripts/install_models.sh     # lokala modeller via Ollama (detekterar VRAM automatiskt)
```

## Köra

```bash
pnpm build
pnpm start                    # Electron-fönstret (ai-service startas automatiskt om den finns)
```

Utan Electron-fönster, för utveckling och test:

```bash
pnpm dev                      # vite-renderer + host på ws://127.0.0.1:7946
```

## Testa

```bash
pnpm -r test                  # alla enhetstester (vitest)
pnpm e2e                      # P0-gaten T1–T8 (Playwright mot verklig host + byggd renderer)
node scripts/make_result.mjs  # förnyar tests/RESULT.md
```

## Konfigurera dina egna modeller

Modell-manager i appen (eller `provider.*` över protokoll) hanterar samtidigt:

| Källa | Endpoint |
|---|---|
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` + `NVIDIA_API_KEY` |
| Ollama (lokalt) | `http://localhost:11434` |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234/v1` |
| llama.cpp server | `http://localhost:8080/v1` |
| Valfri OpenAI-kompatibel | klistra in base-URL + nyckel + modell i UI |
| OpenAI / Anthropic / Google / OpenRouter / Groq / Mistral / xAI / DeepSeek | preset + nyckel |

Varje **roll** kan ha sin egen modell: chat, agent, autocomplete, embeddings, vision, reasoning.
Autocomplete kan alltså köra en lokal 1,5B medan chat går mot NIM — utan konflikt. Rate-limit
försöker nästa modell i kedjan och skriver varför.

**Nycklar bor bara i `.env`.** Aldrig i koden, aldrig i loggen (maskerering sker innan write), aldrig
som värden ut ur config-lagret — UI ser bara `inställd: ja/nej`.

## MCP — alla verktyg

`mcp.json` i roten styr servrarna; stöd för `stdio`, `SSE` och `streamable HTTP`.
Inbyggda från start: `nexus-filesystem`, `nexus-git`, `nexus-terminal`, `nexus-web`
(`scripts/mcp-servers/*.mjs`), och du kan lägga till obegränsat med egna via UI:t eller mallarna i
`templates/mcp-server-ts/` respektive `templates/mcp-server-py/`.
Alla verktyg från alla anslutna servrar hamnar automatiskt i agent-loopen med namnet
`<serverId>__<tool>` — statusraden visar "Aktiva verktyg: N".

Miljövariabler i `mcp.json` skrivs som `${NVIDIA_API_KEY}` och interpoleras först i processen, så
mcp.json aldrig innehåller en nyckel.

## Röst (P1) och vision (P1)

* `/transcribe` — faster-whisper (GPU om det ryms, annars CPU-int8), svenska och 25+ språk.
* `/speak` — Piper lokalt, edge-tts som fallback; appen säger aldrig att Piper svarade om det var edge-tts.
* Skärmdump — hel skärm / aktivt fönster / editor-vy.
* `/analyze` — lokal VLM (LLaVA/Qwen-VL via Ollama) → NIM VLM → OCR (RapidOCR) som sista utväg.
* Eyes-mode: agenten begär själv skärmdump efter körning och ser resultatet.

## Checkpoint och rollback

Varje AI-skrivning tar en snapshot i `<rot>/.nexus/shadow` — ett eget git-repo som **aldrig** rör ditt
riktiga index eller HEAD. Rollback-knappen återställer byte-identiskt. Diff visas före apply.

## terminal och godkännande

`ApprovalBroker` har tre lägen: `ask` (fråga varje gång), `allowlist` (förvalda kommandon), `auto`.
Alla kommandon har tidsgräns, fångad stdout/stderr och exit-kod, och inga föräldralösa processer lämnas.
Obs: utan node-pty är interaktiva TUI-program (vim, less) begränsade — pipe-läget är det som är testat.

## Felsökning

1. `tail -50 nexus-ide/debug.log` — allt loggas roterande och maskerat.
2. `bash scripts/test_ai_service.sh` — är Python-tjänsten vid liv?
3. `curl -s http://127.0.0.1:11434/api/tags` — svarar Ollama?
4. Statusraden i appen: modell per roll, VRAM, antal aktiva MCP-verktyg, index-status.
5. `pnpm e2e` köper om hela kedjan och skriver `tests/RESULT.md`.

## NVIDIA-guide

Se [`blueprints/NVIDIA_INTEGRATION.md`](blueprints/NVIDIA_INTEGRATION.md): hur du skapar en API-nyckel,
hur NIM:s OpenAI-kompatibla endpoint används med streaming och tool-calling, och hur du kör NIM lokalt på
egen GPU. Hämtad live-katalog med 81 modeller ligger i [`blueprints/nvidia_models.json`](blueprints/nvidia_models.json).

## Licenser och credits

* MIT för NEXUS-IDE.
* Monaco Editor (MIT, Microsoft), React (MIT), xterm.js (MIT), Electron (MIT), simple-git, diff,
  chokidar, Zod, Model Context Protocol SDK (MIT).
* Python-sidan: FastAPI, faster-whisper (MIT), CTranslate2, Piper (MIT), RapidOCR (Apache-2.0), mss,
  ChromaDB.
* Ingen kod from Void Editor eller Continue.dev togs med — se `blueprints/VOID_ASSESSMENT.md` för varför
  forken avråddes (upstream arkerad, provider-IO bakom electron-main IPC).

## Kända begränsningar (ärlig lista)

* Lokal NIM i Docker är dokumenterad men inte verifierad (Docker saknas; NIM:s owna minimum överskrider
  10 GB VRAM för aktuella modeller).
* NVIDIA:s rate-limit/credit-siffror fanns inte i de hämtade dokumentsidorna och rapporteras som overifierade.
* Interaktiv terminal utan PTY.
* P2/P3 (multiplayer, plugin-SDK, webb/mobil, marketplaces, VR/AR, AI-roller) är inte byggda — P3 är
  arkitekturteckningar i ARCHITECTURE.md, i enlighet med prioritetsreglerna.

## Nästa 5 förbättringar

1. Lyft P1 till grönt: röst in/ut + vision + inline-edit Ctrl+K + diff-view + git-UI + testgenerator.
2. PTY-stöd (node-pty förinstallerad binär per plattform) så interaktiva program blir fullgoda.
3. Verklig NIM/Ollama-VLM i Eyes-mode med visual regression mellan körningar.
4. Elektron-forshning: `pnpm dist` till signade installers för win/mac/linux + auto-updater.
5. Roll-spec för AI-CTO/PM/Designer som konfiguration ovanpå AgentKernel (P3-ritning → P2-bygge).

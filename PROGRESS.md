# PROGRESS — NEXUS-IDE

## FAS 1 — Blueprints

Leverans skapad 2026-10-15 (UTC). Alla filer nedan har skrivits till disk, och deras
byte-storlekar är mätta med `find -printf "%s"` efter det att skrivningen avslutats — inte
uppskattade.

Inga vägar utanför `nexus-ide/blueprints/` skrevs, med ett enda undantag: denna
`PROGRESS.md`, som uppgiften uttryckligen förskrev. `packages/`, `apps/` och alla
`package.json` är orörda.

### 1. Filer som skapats

| Fil (relativt `nexus-ide/`) | Byte | Innehåll |
|---|---|---|
| `blueprints/raw/nvidia-solutions-ai.md` | 7 093 | Fetched text från NVIDIA AI-solutionsöversikten |
| `blueprints/raw/build-nvidia-models.md` | 8 474 | Modellkatalog med beskrivningar, inkl. sekundär `explore/discover`-del |
| `blueprints/raw/nvidia-api-keys.md` | 3 737 | API-nyckelsidan (inloggningsskyddad) + den dokumenterade vägen till nyckel |
| `blueprints/raw/nvidia-nim.md` | 17 986 | NIM-landning + ordagranna `docker run`-kommandon, systemkrav, tool-calling/MCP (sekundärkällor) |
| `blueprints/raw/nvidia-nim-api-reference.md` | 16 844 | NIM REST-API-referens, komplett endpointinventarie + exempel |
| `blueprints/raw/mcp-spec.md` | 37 882 | MCP-specifikation och arkitektur (FAS 4.1-referensmaterial) |
| `blueprints/raw/mcp-transport-stdio-sse-http.md` | 15 923 | Transportbindning: stdio, Streamable HTTP, SSE, sessionshantering |
| `blueprints/nvidia_models.json` | 17 799 | Levande modellkatalog + härledda delmängder + verifierad fallback-lista |
| `blueprints/NVIDIA_INTEGRATION.md` | 34 973 | Svenskspråkig: nyckel, endpoint, rate limits, lokal NIM, RTX 3080-analys |
| `blueprints/VOID_ASSESSMENT.md` | 31 162 | FAS 2.1-utredning med mätta kommandon och rekommendation |
| `PROGRESS.md` | 10 726 | Denna fil (våxt under skrivandet) |

Totalt **10 filer** under `blueprints/`, sammanlagt **191 873 byte** (mätt med
`find blueprints -type f -printf "%s"` och summerat med `awk`).

### 2. HTTP-status faktiskt sett

Ingen fil påstår en HTTP-status som inte faktiskt settits. Varje `raw/`-fil bär status i sitt
YAML-huvud. Sammanfattning:

| URL | HTTP | Extraktion |
|---|---|---|
| https://www.nvidia.com/en-us/solutions/ai/ | **200** | webfetch |
| https://build.nvidia.com/models | **200** | webfetch |
| https://build.nvidia.com/settings/api-keys | **200** (curl) / **404** (webfetch) | webfetch, inloggningsskyddad |
| https://build.nvidia.com/explore/discover | **200** | curl |
| https://build.nvidia.com/ | **200** | curl (statuskontroll) |
| https://developer.nvidia.com/nim | **200** | webfetch |
| https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html | **200** redirect-stub | curl → `reference/api-reference.html` (200) |
| .../get-started/index.html, quickstart, prerequisites, installation | **200** | curl |
| .../reference/support-matrix.html | **200** | curl |
| .../advanced-use-cases/tool-calling-and-mcp.html | **200** | curl |
| .../resources/support-and-faq.html | **200** | curl |
| https://docs.nvidia.com/nim/large-language-models/latest/release-notes.html | **404** | curl — kunde inte hämtas |
| https://docs.nvidia.com/nim/large-language-models/latest/docker-invocation.html | **404** | curl — gissad URL, finns inte |
| https://modelcontextprotocol.io/ | **200** | curl (webfetch gav bara en sammanfattning) |
| https://modelcontextprotocol.io/specification/2025-06-18 | **200** | curl |
| https://modelcontextprotocol.io/specification/2025-06-18/basic/transports | **200** | webfetch + curl |
| https://modelcontextprotocol.io/specification/2026-07-28/basic/transports | **200** | curl |
| https://modelcontextprotocol.io/docs/learn/architecture | **200** | curl |
| https://integrate.api.nvidia.com/v1/models | **200** | curl, utan nyckel |

### 3. Vad som inte kunde hämtas — uttryckligt

* **`https://build.nvidia.com/settings/api-keys`**: `WebFetch` gaf **404**. `curl` gav **200** men
  enbart det klientrenderade skalet; efter HTML→text-extraktion återstod 508 tecken, enbart
  inloggning portalens text ("Sign In to Get Started with NVIDIA AI"). Försöket upprepades tre
  gånger med backoff, samma resultat varje gång. **Nyckelhanterings-UI:t kunde inte läsas.** De
  steg som dokumenterats i `NVIDIA_INTEGRATION.md` avsnitt 1 kommer därför ordagrant från
  `docs.nvidia.com` NIM Prerequisites och är märkta som sekundärkälla.
* **`docs.nvidia.com/.../api-reference.html`** (den URL som angavs i specen): `WebFetch` gav
  **inget innehåll alls** (`---`), och `curl` gav 200 med 99 byte — en
  `<meta http-equiv="Refresh">`-redirect-stub. Innehållet hämtades genom att följa stubben till
  `reference/api-reference.html`. Dokumenterat i filhuvudet.
* **`developer.nvidia.com/nim`** innehåller inga `docker run`-kommandon. Kommandoen i avsnitt 4 av
  `NVIDIA_INTEGRATION.md` är avskrivna från `get-started/quickstart.html`, inte från landing-sidan.
* **Rate limits / kreditmodell: kunde inte belägas.** Sökning efter `rate limit`, `RPM`, `credit`,
  `requests per minute` och `tokens per` över allt hämtat material gav **0 träffar**. De tal som nämns
  (40 RPM, ~1 000 credits) kommer från NVIDIA-forum och är uttryckligen klassificerade som obelagda.
* **Tool-calling mot `integrate.api.nvidia.com` kunde inte testas** — kräver giltig nyckel, som
  inte finns på maskinen. Overifierat, står angivet i avsnitt 2.4.
* **Lokal NIM kördes inte.** Se avsnitt 5 nedan.

### 4. Levande modellkatalog

* Endpoint: `https://integrate.api.nvidia.com/v1/models`
* **HTTP 200, totalt 81 modeller**, hämtat **utan API-nyckel**.
* `authenticated: false`. Bevis: samma path utan `Authorization` ger 200, medan ett
  `POST /v1/chat/completions` med ett kataloggiltigt id utan header ger **401**
  (`Header of type `authorization` was missing`). Katalogen är publikt, inference är det inte.
* Härledda mängder:
  * **coding / reasoning: 25** modeller
  * **vision: 20** modeller
  * **embed: 8** modeller (varav `nvidia/nvclip` är multimodal CLIP-style retrieval, inte en
    klassisk text-embedding)
* Klassificeringen bygger på id-mönster plus de modellbeskrivningar som faktiskt hämtades i
  `raw/`. Inget id i någon mängd är påhittat — varje post är assertad mot `/v1/models`-svaret
  innan filen skrevs.

### 5. Fallback-listan från specen: 1 av 6 stämmer

Verifierad id för id mot de 81 levande posterna (`existsInCatalog` ligger i JSON):

| id från användarens hand-lista | `existsInCatalog` |
|---|---|
| `meta/llama-3.1-70b-instruct` | **false** |
| `meta/llama-3.3-70b-instruct` | **false** (finns väl i NIM Support Matrix, men inte i `/v1/models`) |
| `nvidia/llama-3.1-nemotron-70b-instruct` | **true** |
| `mistralai/mixtral-8x22b-instruct-v0.1` | **false** — rätt id är `mistralai/mixtral-8x22b-v0.1` |
| `qwen/qwen2.5-coder-32b-instruct` | **false** — **inget** `qwen/*`-id alls i katalogen |
| `deepseek-ai/deepseek-r1` | **false** — `deepseek-ai` har bara `deepseek-coder-6.7b-instruct` och `deepseek-v4.1-flash` |

Det här är den viktigaste enskilda upptäckten i FAS 1: med felaktigt id svarar endpointen **404**,
inte ett auth-fel, så en felaktig fallback-lista ser ut som trasig routning. `packages/providers`
måste lösa id mot `GET /v1/models` i stället för att hårdkoda.

Ytterligare ett verkligt fynd: `POST /v1/embeddings` med `nvidia/nv-embedqa-e5-v5` gav **HTTP 410** —
modellen pensionerades 2026-08-25. Cachade kataloglistor behöver en TTL.

### 6. Maskinproven — mått, inte antaganden

| Mätning | Kommando | Resultat |
|---|---|---|
| GPU | `nvidia-smi --query-gpu=...` | `NVIDIA GeForce RTX 3080, 10240 MiB, driver 610.88` |
| Docker | `which docker` / `docker --version` | **saknas** — `docker: command not found` |
| Node | `node --version` | v24.19.0 |
| npm | `npm --version` | 11.17.0 |
| Python | `python --version` | 3.11.9 |
| OS | `cmd.exe /c ver` | Microsoft Windows [Version 10.0.26200.9711] |
| Fri disk C: | `df -h C:/` | 304 GB fritt av 930 GB |
| Ollama | `which ollama`, `ollama --version`, `ollama list` | binär finns, v0.35.0, **daemon körs inte** (port 11434 nekad) |

**Lokal NIM är dokumenterad men overifierad på den här maskinen**, och det står uttryckligen i
`NVIDIA_INTEGRATION.md` avsnitt 5. Ingen `docker run` har körts. Dessutom, enligt NIM:s egen
Support Matrix: **0 träffar** på `GeForce` i hela matrisen; dokumentationens enda uttalade
minimikrav är **24 GB GPU-minne för Llama 3.1 8B Instruct**, alltså mer än vad RTX 3080 har.
Rekommendationen i dokumentet är därför att den lokala vägen går via Ollama på den här hårdvaran,
och att NIM behålls som en backend som är kopplad men ännu inte verifierad för användare med större kort.

### 7. FAS 2.1 (Void) — beslut

**Forka inte `voideditor/void`.** Mätt evidence:

* `archived = True` via `api.github.com/repos/voideditor/void`
* README, ordagrant: "Void is now deprecated. Void is deprecated and no longer accepting
  contributions."
* Basen är VS Code **1.99.3** (`package.json` → `name: code-oss-dev, version: 1.99.3`),
  Electron `34.3.2` (`.npmrc`), Node låst till `20.18.2` (`.nvmrc`) — cirka 19 månader efter
  upstream den 2026-10-15. Senaste release `v1.3.4` från 2025-04-15.
* Licenc: **Apache-2.0** (`LICENSE.txt`), parallellt med `LICENSE-VS-Code.txt` och en
  `ThirdPartyNotices.txt` på 182 028 byte. `product.json` hävdar `licenseName: "MIT"`, vilket
  motsäger `LICENSE.txt`.
* Verklig omfattning (git trees API): **10 739 entries, 8 325 blobs, 136 475 856 byte**;
  `src/` 5 398 blobs; `extensions/` 2 163 blobs; **5 651 TS/TSX-filer**. Void's egen AI-avdelning:
  **100 filer, 1 106 111 byte**.
* Byggkrav enligt deras egen `HOW_TO_CONTRIBUTE.md`: Visual Studio 2022 med
  `Desktop development with C++` + `Node.js build tools` + MSVC v143/ATL/MFC, `node-gyp`,
  `build_from_source="true"`, och "~5 min" bara för Developer Mode-initialiseringen.
* Arkitekturerell blocking: provider-IO ligger i **`electron-main`**
  (`electron-main/llmMessage/sendLLMMessage.impl.ts`, 33 871 byte) och nås via IPC. NEXUS kärna är
  process-agnostisk och måste kunna köras utan Electron enligt `CONVENTIONS.md`. Det är en
  omritning av processgränsen, inte ett adapterbyte.
* Inget fullt clone gjordes. En blobless shallow clone (`--filter=blob:none --no-checkout`) tog
  **2 s / 541 KB**, men det mäter bara förhandlingen, inte workträd — och klonen togs bort
  (`voidprobe removed: YES`).

**Uppdraget går vidare på FAS 2.3: egen Electron + React + Monaco-skal i `apps/desktop`.** Void
behålls som läst referensmaterial (`editCodeService.ts` för strömmande diff, deras
`buildreact`/Tailwind-scoping, deras GitHub Actions för signering/auto-updatering), inte som
beroende.

## 2026-10-15T16:50 — STEG 1+2: SPEC.md och AGENTS.md laaste (orchestrator)
- `SPEC.md` 31 072 bytes: prioritetstabell P0/P1/P2/P3 + 95 checkboxes + **bilagan ordrant**,
  verifierad byte-identisk med `cmp` mot attachmentsfilen (sha256 cb429210da0b321e, 607 rader).
- `AGENTS.md` 4 878 bytes: de 6 permanenta reglerna + korda miljofakta (pnpm PATH, inga nycklar,
  Ollama staengs efter test, Void avraads) + resume-protokoll.
- Overstaende P0-port: e2e T1-T8 ar definition av P0-gaten och skrivs av orchestratorn, inte av
  byggarna (sjalvskattning ar inte ett gate).
- Byggare iganga parallellt: host, ui+desktop, mcp-client (finish), RAG i core. providers fran forut.

## 2026-10-15T17:00 — FAS 3 förstärkt: VERKLIGA lokala modeller (orchestrator)
- Ollama-demon startades av projektet (PID i `.nexus/pids/ollama.pid`) och **ska stängas** vid slutet
  (`scripts/stop_ollama.sh`). Användarens krav: inga kvarlämnade bakgrundstjänster.
- Redan lokala före detta uppdrag: `qwen3:14b` (9,28 GB), `qwen3:8b` (5,23 GB), `qwen3-vl:4b` (3,3 GB
  = vision, P1), `all-minilm`. `qwen2.5-coder:1.5b` hämtas nu (`.models-log`).
- Bevisade verkliga anrop (comm output verifierad, ingen gissning):
  * `POST /v1/chat/completions` qwen3:8b → `"content":"NEXUS OK"` (exakt som begärt, ~3 s).
    KVER: qwen3 returnerar ett extra `reasoning`-fält vid sidan av `content` — adaptern läsa `content`.
  * `POST /api/generate` qwen2.5-coder:1.5b `raw:true` med `prefix`/`suffix` → kod ` a + b;\n}` …
    men **`stop`-listan respekterades inte** av servern i raw-läge: svaret gick förbi `\n}\n`.
    ⇒ FIM-lagret MÅSTE klippa klient-side vid stopp-strängen (annars klistrar ghost-text ihop hela filen).
  * `POST /api/embed` all-minilm → vektor med dim 384 (verkliga embeddings, ingen stub).
- VRAM under test: 7 984 / 10 240 MiB med två modeller laddade.
- Beslut: P0-gaten kör verklig Ollama för rollerna chat/autocomplete/embeddings (`bevis=local`) och
  behåller deterministisk stub för agent-rollen, eftersom T4/T5 kraever exakt vald tool och verklig
  modell inte ar deterministisk. Om Ollama inte ar igang faller alla roller tillbaka till stubben och
  BEVIS-kolumnen sager `stub` — aldrig ljuget.
- Ny fil: `scripts/install_models.sh` (VRAM-automatik + retry + verifikation per modell),
  `scripts/stop_ollama.sh`, `scripts/verify_all.sh` (fas-for-fas-gate), `START-HÄR.md`, `README.md`,
  `ARCHITECTURE.md` (incl. P3 = arkitektur only).

## 2026-10-15T17:20 — SYSTEMKRASCH: rotorsak och permanent motmedel (Regel 7)
**Vad hände:** användarens maskin kraschade och startade om. Användaren: "min dator krashade för du
tog slut på ram eller vram". Det är korrekt — ett fel i min resurshantering, inte i deras hårdvara.
**Rotorsak (mätt, inte gissat):** jag startade Ollama-demonen och laddade `qwen3:8b` (5,23 GB) OCH
`qwen2.5-coder:1.5b`, med `qwen3:14b` (9,28 GB) åtkomlig, samtidigt som 5 parallella byggagenter körde
`tsc`+`vitest` på en maskin med 16 GB RAM (4,5–6 GB fri) och 10 GB VRAM. Uppmätt VRAM under testet:
**7 984 / 10 240 MiB**. Bokfört minne + multipla Node-processer utanför swap-budget = instabilitet.
**Åtgärd (permanenterad i AGENTS.md Regel 7):**
1. Högst 6 GB laddade modeller; `qwen3:14b` förbjuden under bygge/test utan uttrycklig opt-in.
2. `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_KEEP_ALIVE=120` i `.env`,
   `install_models.sh` och `applyOllamaLimits()` i e2e-harnessen.
3. `resourceGuard()` mäter fri VRAM/RAM + redan laddade modeller FÖRE att verklig modell väljs;
   säger den nej körs stubben och BEVIS-kolumnen skriver `stub` med orsaken. Aldrig ett antagande.
4. `pnpm -r build/test` körs nu med `--workspace-concurrency=1`.
5. `unloadOllamaModels()` i `close()` kastar ur modeller; Ollama är nu **avstängd** (8 433 MiB VRAM fri).
6. Max 3 parallella byggagenter (tidigare 5) — dokumenterat i Regel 7 punkt 6.
**Bevis på fixen:** `nvidia-smi` efter åtgärd: 1621 MiB used / 8433 MiB free. `curl :11434` → tyst.
**Kvalitet sänks inte:** P0:s modellbevis körs på `qwen2.5-coder:1.5b` (verklig lokal modell, ~1,1 GB)
i stället för 8b/14b — verkligt svar, mindre modell. Storleken är en resursfråga, inte en äkthetsfråga.

## 2026-10-15T20:55 — FAS 3.5 RAG fullbordad av orchestatorn (byggena avbröts av kraschen)
**I nuläge:** bygga byggraket-avbrott lämnade `packages/core/src/rag/` med 2 849 rader kod men
**inga tester och inga exports**, och `exactnessBonus()` var en tom skalpell (`void argument; return 0`)
löfte om exakt-identifierar-boost som aldrig implementerats.
**Åtgärder, i ordning:**
1. Typfel i RAG fixade (3): `hit: DeclHit | null` (TS7022), `vec[bucket] = (vec[bucket] ?? 0) + …`
   (TS2532, noUncheckedIndexedAccess), och fel typnamn importerat från fel modul
   (`AiServiceEmbeddingsCapableClient` från ./store → `AiServiceEmbeddingsClient` från ./embedder).
2. `RagService` + embedder/store/context exporters lagda i `src/index.ts` (avsnitt 12) — utan dem kunde
   host inte bygga RAG-kontext alls.
3. `tokenize()` delade inte `snake_case` (`parse_jwt_token` förblev EN token) — emot funcens egen
   dokumentation. Fixat med `.replace(/_+/g," ")`. Bevis: `tokenize("OPEN_CONNECTION_POOL")` →
   `["open","connection","pool"]`.
4. Implementerade `exactnessBonus()` på riktigt: bara token ≥6 tecken räknas, boost mättas
   (0,05 per träff, tak 0,2), och dokument (md/txt/rst/adoc) får 25 % av boosten. Motivering: en
   utvecklare som frågar "openConnectionPool database connections" vill ha källkoden, inte
   README-mentionen. Det var ett MÄTT fel (topplistan sa docs/README.md), inte en åsikt.
5. Skrev `test/rag.test.ts`: 17 tester — sanningsenliga radintervall (chunktexten finns faktiskt i
   filen på utlovade rader), inkrementell indexering bevisas med `embedCalls === 0` på andra körningen,
   force:true embadar om allt, edit av en fil embadar BARA den (3 < första), removeFile tar chunkerna
   utan att röra filen, korrupt JSONL detekteras och byggs om utan krasch, status/diagnostics säger
   SANT (`engine:"jsonl-fallback"`, `embedderKind:"local-hash"`), språkfråga och symbolfråga hittar
   auth-filen, databasfråga hittar pool-filen, markdown hittas, tom fråga/okänd fråga/tom katalog
   returnerar tomt, byte-budget respekteras, LocalHash är deterministisk och L2-normaliserad.
   Ett eget test i serien var fel (assertion på bara första chunken för en fil med flera) — korrigerat,
   inte produktfelet.
**Bevis (verkligt output, kört sekventiellt enligt Regel 7):**
```
=== build === exit=0
 Test Files  11 passed (11)
      Tests   91 passed (91)
```
**Kvar för P0-grinden:** host-assembly (createHost + dispatch + WS) och desktop-shell bygger nu av två
agenter; därefter `pnpm e2e` T1–T8. RAG bockas i SPEC.md först när T8 är grönt i RESULT.md (Regel 6).

## 2026-10-15T21:05 — FAS 4 MCP granskad och grön av orchestatorn
**Utgångsläge:** bygarens efterarbete avbröts av kraschen. 79/89 tester gröna, 10 röda i tre kluster.
**Vad jag faktiskt ändrade (och varför, med rotorsak — inte symptom):**
1. `test/fixtures/http_fixture.ts` — SSE transporten lades i sessionsmappen FÖRE `server.connect()`,
   men `SSEServerTransport` genererar sitt sessionId först inuti `start()` (som connect anropar).
   Nyckeln blev alltså `undefined` medan klienten POST:ade det riktiga id:et → "okänd sessionId".
   Flyttade registreringen efter connect och tog bort den andra, dubbla `start()`.
   → transportsenheten 7/7 grön (SSE och streamable HTTPPratar riktig wire mot riktig server).
2. `src/server_manager.ts` — `callTool` svarade "verktyg finns inte" på en AVSTÄNGD server, eftersom
   en sådan registrerar noll verktyg. Om namespace ändå pekar på en känd server är det sanna svaret
   "inte ansluten (status X)". Ordnat om kontrollerna; envist fel i UI:t hade lett jakten åt rätt håll.
3. `src/config_store.ts` `write()` — validerade rådata FÖRE reversal, så en nyckel som kunde
   reverseras till `${OPENAI_API_KEY}` dömdes som fel. Validerar nu formen som faktiskt går till disk.
4. `src/config_store.ts` `upsert()` — samma ordningsfel i förkontrollen; reverserear kända
   miljövariabler innan validering men behåller det vänliga "ogiltig serverkonfiguration"-meddelandet
   för riktiga formfel (t.ex. `fel__id`).
5. `mcp.json` — regenererad från `DEFAULT_MCP_SERVERS` via `node scripts/setup_mcp.mjs --force`
   (backup `mcp.json.backup-*`). Rotfilen hade driftat till `nexus-filesystem-local`, en stilla
   dubblett av vår egen server; den borttagna posten var överflödig.
**Ett av mina egna fel, rättat:** jag ändrade `ID_PATTERN` till att tillåta åäö i server-id. Det var
fel, och testet "kollision måste vara omöjlig" sa varför: id:t blir en del av verktygsnamnet
(`<id>__<verktyg>`) som OpenAI/Anthropic bara accepterar i [A-Za-z0-9_-]. Mönstret är återställt och
kommenterat med anledningen. I stället döpte jag om TEST-FIXTUREERNAS svenska id (träd→tree-host,
avstängd→disabled-host, växla→toggle-me, nyckelbärare→key-carrier, två→two) och lade kvar det
intentionella fallet som AVVISA å/ä/ö i id. `label` är fortfarande fri svenska.
**Upptäckt bifallen:** den gamla ASCII-endast-regeln avvisade `__` hos icke-ASCII-id av misstag, inte
av design — en latent invariant-krock som nu är explicit testad i stället.
**Bevis (sekventiellt, Regel 7):**
```
build-exit=0
 Test Files  10 passed (10)
      Tests   89 passed (89)
```
**P0-status nu:** protocol ✅ · providers 123 ✅ · core 91 ✅ · mcp-client 89 ✅ · host (byggs) ·
ui/desktop (byggs) · e2e T1–T8 (skrivet av mig, väntar på host+desktop) · ai-service = P1, ej prioriterat.

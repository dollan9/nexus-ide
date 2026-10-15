# AGENTS.md — PERMANENTA REGLER FÖR NEXUS-IDE

Detta är projektets arbetsordning. Varje agent (Qoder, delad builder, eller framtida session) lyder
dessa regler utan undantag. De ersätter inte `CONVENTIONS.md` (byggregler) eller
`packages/protocol/src/index.ts` (gränssnittskontrakt) — de styr **i vilken ordning** arbetet sker.

## Regel 1 — Läs ALLTID SPEC.md före kodning
Läs `SPEC.md` i roten före varje kodpass. Arbeta **ENDAST på högsta oavklarade prioritet**:
P0 → P1 → P2 → P3. Hitta första bocket `- [ ]` i den första inte klarade sektionen och gör den
sachen färdig. Inget "lite snabb P2 medan P0 ligger kvar".

## Regel 2 — Påbörja ALDRIG P1 förrän ALLA P0-acceptanstester är gröna
Gateddefinition: `pnpm e2e` (Playwright T1–T8) exit 0 **och** `pnpm -r test` exit 0 **och**
`tests/RESULT.md` visar ✅ för T1–T8 med ärlig `BEVIS`-kolumn. Ett enda rött P0-test stoppar allt P1-arbete.
P3 får aldrig implementeras alls — bara ritas i ARCHITECTURE.md.

## Regel 3 — Uppdatera PROGRESS.md efter varje fas. Markera klar feature som [x] i SPEC.md
Efter varje avslutad fas/feature: ändra `- [ ]` till `- [x]` i `SPEC.md` för just den raden, och
appendera ett stycke i `PROGRESS.md` med: vad som gjordes, **vilket kommando som bevisade det**,
utfallet, vad som är kvar, och eventuella avvikelser. Aldrig bocka av något utan kommando + output.

## Regel 4 — Felsök i loop (bygg → test → fixa) tills grönt. Fråga ALDRIG användaren
Sjävläkande loop: kör → läs fel → hitta rotorsak (symptomlappning är förbjuden) → fixa → kör om.
Max 5 försök per fel; upprepas samma fel en sjätte gång byt strategi/bibliotek och skriv varför i
PROGRESS.md. Nätverk: retry 3 ggr med backoff, sedan annan källa/spegel. GPU/RAM-brist: degradera till
mindre modell/CPU — appen får ALDRIG krascha. Fråga aldrig användaren om tekniska val; bästa beslutet
dokumenteras i PROGRESS.md. Enda undantaget: irreversibla eller delade åtgärder (push, deploy,
publicera, radera användardata, betala pengar) kräver uttryckligt medgivande.

## Regel 5 — API-nycklar ENDAST i .env. Terminal-kommandon kräver godkännande. Varje filändring = checkpoint
- Nycklar: only `.env` (+ settings-UI som skriver `.env`). `.env.example` är mallen. Inget värde får
  någonsin stå i kod, test-fixture, logg, undantagsmeddelande eller svar till renderer — endast
  `{ name, isSet }`. Maskering sker i logger BEFORE write.
- Terminal: varje kommando går genom `ApprovalBroker` (ask | allowlist | auto). Avslag ger
  `ErrorCode.ApprovalDenied`, aldrig en hängande loop. Okända kommandon frågas. Alltid tidsgräns.
- Checkpoint: varje skrivning från AI eller agent skapar en checkpoint i shadow-git under `.nexus/`
  (användarens riktiga repo-index och HEAD rörts ALDRIG). Rollback ska återställa byte-identiskt.

## Regel 6 — Varje feature ska ha e2e-test innan den bockas av
Inga `- [x]` utan test. Testet körden faktiska kodvägen (riktig host-process, riktig fil, riktigt
netwerkgränssnitt mot en stub där ingen nyckel finns). Gate som inte kan faila är inte ett gate: lägg
alltid ett negativt fall bredvid (saknad fil, offline provider, nekat kommande, ingen modell).
Ett test som går mot en stub får aldrig påstå att en riktig modell svarat — `source`-fältet
(`local | cloud | stub | none`) är den enda giltiga bevisnivån och rapporteras i `tests/RESULT.md`.

## Regel 7 — RESURSBUDGET (hård, infördes efter en systemkrasch 2026-10-15)
Maskinen kraschade under P0-bygget. Rotorsak: Ollama laddade **både** `qwen3:14b` (9,28 GB) och
`qwen3:8b` (5,23 GB) medan fem byggagenter och flera `tsc`-processer simultaneously körde på en maskin
med 16 GB RAM (ca 5 GB fri) och 10 GB VRAM. Minne som bokförs av en laddad modell är inte tillgängligt
för bygget — och Windows svänger inte bara om, det kan dö systemet. Användaren har uttryckligen som
policy att aldrig starta om sin dator.

Budget som varje agent måste följa (och varje gate måste kontrollera):
1. **Högst 6 GB VRAM modeller totalt.** `qwen3:14b` är FÖBUDEN under bygge/test. Standard under P0:
   `qwen2.5-coder:1.5b` (chat + autocomplete) och `all-minilm` (embeddings) ≈ 1,2 GB.
2. **En tung process i taget.** `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_NUM_PARALLEL=1`, och
   `pnpm -r build` körs med `--workspace-concurrency=1` när en modell är laddad.
3. **Guard före laddning.** Mät `nvidia-smi` fri VRAM och fri RAM och vägra modellväg om det är för tight —
  降级 till stubben och skriv `bevis=stub` med orsaken. `tests/e2e/helpers/harness.ts::resourceGuard()`.
4. **Laddning av modeller som ingen test behöver är förbjuden.** Ett `ollama pull` är billigt, en
   **laddning** är dyrt. Undvik att ringa modeller som inte är i `.env`-rollen.
5. **Kast av efter sig.** I slutet av varje svit: `POST /api/generate {"model":X,"keep_alive":0}` per
   laddad modell, sedan `scripts/stop_ollama.sh`. Kvarlämnade demoner är ett eget brott.
6. Fler än **3 parallella byggagenter** är inte tillåtet samtidigt (varje agent kör sina egna byggen).

## Körregler (miljöfakta som gäller nu — uppdatera när de ändras)
- Windows 11 build 26200 + Git Bash. RTX 3080 10 GB, 16 GB RAM (ca 5 GB ledig). Ingen Docker.
- pnpm 10.26 ligger i `~/AppData/Roaming/npm` och **inte** på standard-PATH:
  varje bash-anrop börjar med `export PATH="$HOME/AppData/Roaming/npm:$PATH"`.
- Inga API-nycklar finns i miljön (NVIDIA/OPENAI/ANTHROPIC/GOOGLE är tomma). NVIDIA:s modellkatalog på
  `https://integrate.api.nvidia.com/v1/models` är läsbar **utan** nyckel (81 modeller verifierat).
- Ollama 0.35.0 är installerad men demon körs inte. Starta den bara för ett test och **stäng den efteråt** —
  inga kvarlämnade bakgrundsprocesser är ett hårt användarkrav.
- Void Editor-forken är avrådd: upstream är arkerad och provider-IO ligger i electron-main bakom IPC
  (se `blueprints/VOID_ASSESSMENT.md`). Vi kör FAS 2.3: egen Electron + React + Monaco.
- Filsägsordning: en agent i taget per katalog. Delade filer (`SPEC.md`, `AGENTS.md`, `PROGRESS.md`,
  `packages/protocol/**`, rot-`package.json`, `pnpm-workspace.yaml`) ägs av orchestatorn.

## Resume
Ny session i detta projekt: läs `SPEC.md` (var vi är), `PROGRESS.md` (senaste bevis),
`.agent/ultra/status.json` (steg + uppgifter), `.agent/ultra/ledger.md` (auditspår),
`packages/protocol/src/index.ts` + `CONVENTIONS.md` + `packages/core/API.md` innan kod.
Fortsätt på första bocket — börja inte om från början.

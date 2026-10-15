# RESUME — efter omstart 2026-10-15 ~17:10

Datorn startades om mitt i P0-bygget. Fyra byggagenter kördes parallellt och avbröts **mitt i
filskrivningar**. Enligt `AGENTS.md` Regel 4 + /ultra resume-protokoll: lita inte på att avbrutet
arbete är helt — kontrollera på skivan, och känn igen det som redan är beprövat grönt.

## 1. Saker som REDAN är verifierade (behöver inte omgöras)

| Bevis | Kommando | Utfall |
|---|---|---|
| Node-beroenden installerade | `ls node_modules \| wc -l` → 377, markör `.install-done` | klart, **kör inte om pnpm install** |
| Playwright Chromium | `.pw-done` finns, "Chrome Headless Shell downloaded, EXIT=0" | klart, **kör inte om** |
| Lokala modeller | `qwen3:14b`, `qwen3:8b`, `qwen2.5-coder:1.5b`, `qwen3-vl:4b-instruct`, `all-minilm`, `nomic-embed-text` (`.models-done`, EXIT=0) | klart, **dra inga nya modeller** |
| Verklig chat bevisad | `POST /v1/chat/completions` qwen3:8b → `"NEXUS OK"` | bevisad |
| Verklig FIM bevisad | `POST /api/generate` qwen2.5-coder → kod, men **`stop` respekterades inte** → `trimFimCompletion` i providers klipper (finns + testad) | bevisad |
| Verkliga embeddings | `POST /api/embed` all-minilm → 384-dim vektor | bevisad |
| `@nexus/protocol` bygger | `pnpm --filter @nexus/protocol build` → exit 0 | bevisad |
| `@nexus/providers` | `pnpm --filter @nexus/providers test` → **123/123**, build exit 0 (körd av orchestatorn, inte bara av byggaren) | bevisad |
| `@nexus/core` (före RAG-tillsägg) | `pnpm --filter @nexus/core test` → **74/74** (byggarens rapport, ej omkörd av orchestatorn —Verifiera om) | byggarrapport |
| FAS 1 blueprints | 81 NVIDIA-modeller live utan nyckel; Void arkerad → FAS 2.3 | bevisad |
| FAS 0-gate | `bash scripts/verify_fas0.sh` → struktur + verktyg + dokument OK | bevisad (R2-deln är nu delad i `scripts/verify_no_secrets.sh`) |
| SPEC.md / AGENTS.md | bilagan byte-identisk i SPEC.md (sha256 cb429210da0b321e), 95 checkboxes | bevisad |
| E2E-materialet | stub-LLM smoke-körd: 6/6 endpoints, tool_call med `nexus-filesystem__…` fungerar efter regex-fix | bevisad |

## 2. Saker som är OAVSLUTADE / kan vara trasiga efter avbrottet

* `packages/host` — var vid ~1 146 rader, ingen build körd.
* `packages/ui` + `apps/desktop` — ui ~2 735 rader, **desktop var tom** (2 rader). Byggd renderer finns
  förmodligen inte → T1/T3/T7 kan inte köras förrän den bygger.
* `packages/mcp-client` — finishern höll på med `scripts/setup_mcp.mjs` + servrar; `mcp.json` kan saknas.
* `packages/core/src/rag/*` — ~1 945 rader skrivna av en avbruten agent; core har sannolikt **nya
  otestade filer** ovanpå de 74 gröna testerna.
* `apps/ai-service` — 3 885 rader Python men **inga setup-/test-skript** och inga pytest-filer. Är P1,
  får inte priorteras före P0-grinden.
* Halvskrivna filer: en avbruten write kan lämna trunkerad HTML/CSS/TS. Bygget avslöjar det.

## 3. exakt återupptag — i denna ordning

```bash
cd nexus-ide
export PATH="$HOME/AppData/Roaming/npm:$PATH"    # pnpm ligger INTE på standard-PATH

# 3.1 Vad överlevde omstarten? (snart, och ärligt)
bash scripts/verify_fas0.sh                       # FAS 0 ska vara grönt
pnpm --filter @nexus/protocol build && pnpm --filter @nexus/providers test
pnpm -r build 2>&1 | tail -40                     # visar vilka paket som är trasiga/halvskrivna

# 3.2 Kontrollera Ollama (se avsnitt 5) och starta vid behov
curl -s -m 3 http://127.0.0.1:11434/api/tags | head -c 80

# 3.3 Återuppta de avbrutna byggarna (samma filägar som tidigare, samma kontrakt)
#     host → packages/host,  ui+desktop → packages/ui + apps/desktop,
#     mcp  → packages/mcp-client + scripts/mcp-servers + mcp.json,
#     rag  → packages/core/src/rag + test/rag*
# 3.4 Kör grinden och felsök till grönt
pnpm e2e                                          # T1–T8
node scripts/make_result.mjs
bash scripts/debug_loop.sh                        # max 50 iterationer, byter strategi efter 5 samma fel
```

## 4. Grinden är P0 — och den äger orchestatorn

`tests/e2e/specs/p0.spec.ts` (T1, T1-neg, T2–T8) + `helpers/stub-llm.ts` + `helpers/harness.ts` +
`fixtures/corpus`. Inget P0-bock får bockas av i SPEC.md utan `pass` i `tests/RESULT.jsonl` med
BEVIS-kolumn (`local` verklig modell / `stub` deterministisk testserver / `cloud` riktig nyckel).
Rullning: chat/autocomplete/embeddings går mot **verklig Ollama** (bevis `local`) när den svarar;
agent-rollen går mot stubben för deterministiskt tool-val (bevis `stub`). Utan Ollama faller allt
till stub och kolumnen säger `stub` — aldrig något annat.

## 5. Bakgrundsprocesser — användarens krav

Användaren vill **inte** ha kvarlämnade demoner. Projektet startade Ollama (`.nexus/pids/ollama.pid`
är nu **stale** efter omstarten). Windows startar ofta Ollama själv vid boot. Vill du ha den av:
stäng från activityfältet eller `taskkill //IM ollama.exe //F`. Vill du ha den på (rekommenderas för
P0-bevisen `local`): låt den vara, eller `ollama serve`. Projektet lämnar inga andra egna processer
igång — `scripts/stop_ollama.sh` dödar endast en demon den själv startat.

## 6. Kontexter som annars försvinner

* Miljö: Windows 11 26200, Git Bash, i9-11900K, 16 GB RAM (~6 GB fri), RTX 3080 10 GB, 244 GB fri disk.
* Inga API-nycklar finns i miljön; NVIDIAs katalog är läsbar utan nyckel.
* node-pty används **inte** (native-bygge felar här) → terminal via child_process, pipor.
* ripgrep finns **inte** på PATH → `RG_PATH`/`NEXUS_RG_PATH` eller JS-fallback, båda testade.
* Docker saknas; pytesseract/easyocr är medvetet ersatta av rapidocr-onnxruntime.
* Void Editor är arkerad — ingen fork, egen Electron + React + Monaco (beslut D1).

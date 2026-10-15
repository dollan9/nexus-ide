# START-HÄR — tre kommandon

```bash
pnpm install
pnpm build
pnpm start
```

`pnpm start` öppnar NEXUS-IDE-fönstret. Python-tjänsten för röst och vision (P1) startas automatiskt av
desktop-appen om `apps/ai-service/.venv` finns; annars körs appen utan röst/vision och säger det öppet i
statusraden i stället för att krascha.

## Innan du kör: välj modeller

Du behöver **ingen** molnyckel för att komma igång — appen funkar mot lokala modeller.

```bash
bash scripts/install_models.sh          # detekterar VRAM, hämtar lämpliga modeller via Ollama
cp .env.example .env                    # fyll i NVIDIA_API_KEY / OPENAI_API_KEY om du vill ha molnet
```

Kontrollera att Ollama svarar: `curl -s http://127.0.0.1:11434/api/tags`
(verifierat på den här maskinen: `qwen3:8b`, `qwen2.5-coder:1.5b`, `qwen3-vl:4b`, `all-minilm`).

## Vilken knapp gör vad

| Tangent | Funktion |
|---|---|
| Ctrl+Shift+P / F1 | Kommandopalett |
| Ctrl+P | Fuzzy filhittare |
| Ctrl+Shift+F | Sök i hela workspacet (regex) |
| Ctrl+` | Terminal fram och tillbaka |
| Ctrl+Space | Manuell autocomplete (annars ghost-text automatiskt, Tab accepterar) |
| Ctrl+K | Inline-edit — P1, visar ärligt "inte aktiverad ännu" |

## Köra allt utan skärmbild (för CI eller felsökning)

```bash
pnpm dev           # renderer på http://127.0.0.1:5173 + host på ws://127.0.0.1:7946
pnpm -r test       # enhetstester
pnpm e2e           # P0-gaten T1–T8
node scripts/make_result.mjs
bash scripts/verify_all.sh
```

## Om något inte funkar

1. `tail -n 80 debug.log` — allt loggas dit, maskerat.
2. `bash scripts/verify_all.sh` — kör varje fas för sig och visar var kedjan bryts.
3. `pnpm --filter @nexus/ai-service start` och `curl -s localhost:7955/health` för röst/vision.
4. Statusraden i appen visar: modell per roll, VRAM, antal aktiva MCP-verktyg, index-status.
5. Kända begränsningar står listade sist i `README.md` och i `ARCHITECTURE.md` avsnitt 13.

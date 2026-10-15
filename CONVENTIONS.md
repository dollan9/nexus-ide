# NEXUS-IDE — byggkonventioner (obligatoriska för alla packages)

Detta är arbetskontraktet. Avvikelse = integration felar i FAS 8.

## Verktyg och format

- Node >= 20 (vi kör v24.19), pnpm-workspaces, TypeScript **strict** (se `tsconfig.base.json`).
- Alla `packages/*` och `apps/desktop/src/main` byggs till **CommonJS**:
  `"module": "CommonJS"`, `"type"` ej satt i package.json, output till `dist/`, `main: "dist/index.js"`.
  Renderer (`apps/desktop/src/renderer`) är **undantaget**: den bundleas av Vite som ESM och får aliasa
  in paketens `src/*.ts` direkt (så e2e slipper byggordning).
- Renderer och paket får INTE importera varandra via djupa sökvägar — bara via paketets `main`.
- Kommentarer och dokumentation på **svenska**. Identifierare och publiek API på engelska.
- Python: type hints överallt, `from __future__ import annotations`, `python -m mypy`-vänlig,
  `apps/ai-service/.venv` är den enda tillåtna miljön.

## Hemligheter (R2 — ingen mjuk start)

- Nya nyckelnamn = lägg till i `.env.example`.
- Aldrig hårdkoda `sk-...`, `nvapi-...`, bearer-token. Ingen test-fixture får innehålla en riktig nyckel;
  använd `sk-test-123` som är uppenbart falsk.
- Hemligheter får bara lämna config-lagret som `{ name, isSet }` (se `SecretKeyInfo`).
- `.env` läses i host-processen, aldrig i renderer (ingen `preload` som exporterar `process.env`).

## Fel och nedbrytning (R5 — appen får aldrig krascha)

- Ingen metod i host får kasta råa fel till transporten; alla blir `RpcResponse.error` med `ErrorCode`.
- All modell-/nät-/GPU-anrop har timeout + `.catch` och degraderar: moln → lokal → stub → `NoModelAvailable`
  med ett vettigt UI-meddelande.
- Varje extern reaktion loggas till `nexus-ide/debug.log` (roterande, via `@nexus/core` logger) med
  `fas`, `modul`, `nivå`, `meddelande`.

## Äkthet i tester (viktigast)

- Ett test som går grönt mot en stubb får **inte** påstå att en riktig modell svarade.
  Alla svar av typen modell bär `source: "local" | "cloud" | "stub" | "none"` (se `@nexus/protocol`)
  och `tests/RESULT.md` redovisar kolumnen `BEVIS` med det värdet.
- Vi startar Ollama och drar en verklig modell där det är möjligt. Processen vi startar skal vi också stänga.
- Ingen permanent bakgrundstjänst får lämnas igång i slutet av uppdraget (användaren har avvisat detta).

## Test av varje paket

- `pnpm --filter <pkg> test` måste köra riktiga assertions (inget `expect(true) === true`).
- Enhets tester i `<pkg>/test/*.test.ts` med vitest, `environment: "node"` (jsdom bara för `packages/ui`).
- Ett gate som inte kan faila är inte ett gate: lägg alltid ett negativt fall (saknad fil, felaktig JSON,
  offline provider) vid sidan av det positiva.

## Filsägsordning (delegering)

Ingen builder rör en fil utanför sin egen lista. Delade filer (`package.json` i roten,
`pnpm-workspace.yaml`, `packages/protocol/**`, `CONVENTIONS.md`) ägs av orchestratorn.

## Installationsordning

1. `corepack enable` (ger pnpm utan global npm-install).
2. `pnpm install` i roten (hämtar electron-binär + Monaco; vänta ut den, den är stor).
3. `python -m venv apps/ai-service/.venv` + `pip install -r requirements.txt` (kan köras parallellt).
4. Först då: byggnader och tester.

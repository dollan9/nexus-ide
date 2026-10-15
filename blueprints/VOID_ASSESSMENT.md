# Void-analys (FAS 2.1) — ska vi forka `voideditor/void` till `apps/desktop`?

**Frågan från specen:** fork av https://github.com/voideditor/void till `apps/desktop`, eller bygg
en egen Electron + React + Monaco-skal (FAS 2.3)?

**Kort svar: nej, forka inte Void. Beslutet är att gå vidare på FAS 2.3.**

Det här dokumentet innehåller mätta kommandon och deras riktiga utskrift, inte spekulation.
Allt nedan kördes på den här maskinen 2026-10-15 (ca 15:56–16:10 UTC). Ingen full klon gjordes;
se avsnitt 2.8 för vad som klonades och vad det kostade.

---

## 1. Anledningen väger tyngre än allt annat: Void är avvecklat och arkiverat

Två oberoende mått säger samma sak.

**1a. GitHub API, fältet `archived`:**

```text
=== REPO ===
full_name = voideditor/void
description = None
fork = False
html_url = https://github.com/voideditor/void
default_branch = main
language = TypeScript
size = 36065
stargazers_count = 28756
open_issues_count = 304
license = {'key': 'apache-2.0', 'name': 'Apache License 2.0', 'spdx_id': 'Apache-2.0', ...}
archived = True
disabled = False
pushed_at = 2026-06-02T22:03:55Z
created_at = 2024-09-11T02:37:00Z
updated_at = 2026-10-15T14:25:03Z
topics = ['chatgpt', 'claude', 'copilot', 'cursor', 'developer-tools', 'editor', 'llm',
          'open-source', 'openai', 'visual-studio-code', 'vscode', 'vscode-extension']
```

`archived = True`. Ett arkiverat repo på GitHub går inte att pusha till, issues stängs för
bidrag, och projektet är formellt dött.

**1b. `README.md`, ordagrant (via `Accept: application/vnd.github.raw`):**

```text
## Void is now deprecated.
Void is deprecated and no longer accepting contributions.
Thank you to everyone who contributed, both with lines of code and support from the community.
Void remains open source and is still one of the best references to use when forking VS Code.

## Download

To view a list of newer Void forks, see [Void Forks](http://github.com/voideditor/void-forks/).
...
If you're forking VS Code, you might still want to reference Void's logic, and see our
[Codebase Guide](https://github.com/voideditor/void/blob/main/VOID_CODEBASE_GUIDE.md) ...
```

Prosjektet pekar alltså självt bort från sig som bas: "**still one of the best references to
use when forking VS Code**" — en referenskälla, inte en stomme. Och för den som ändå vill ha en
levande Void-pekar det vidare till `voideditor/void-forks`.

Senaste utgivningarna bekräftar stillaståendet:

```text
=== RELEASES(notes) ===
type list count 3
v1.3.4 2025-04-15T09:54:04Z
v1.0.2 2025-03-22T20:50:53Z
v1.0.0 2025-01-19T00:43:09Z
```

Ingen release på ~18 månader. De tre sista commits:

```text
=== LAST COMMITS ===
b3166e7ef 2026-06-02T22:03:37Z | all repos
17e7a5b15 2026-01-12T09:57:57Z | Update README.md
f100db917 2026-01-12T09:25:52Z | Update README.md
```

Sista faktiska kodeändringen före archiveringen var i januari; juni-commiten meddelandet
"all repos" är avvecklingsarbetet. Repo:t har 28 756 stars och 304 öppna issues — ett stort
intresse som lades ner, inte ett projekt som dog långsamt av likgiltighet. Det innebär att
uppmärksammade buggar aldrig blir fixade uppströms.

---

## 2. Mätbevis: repos, filer och verktygedja

### 2.1 `git ls-remote` — repo:t finns, men grenarna är ett museum

```text
$ git ls-remote https://github.com/voideditor/void
b3166e7ef2aefbdfeb139445fdf248a561b85d4d        HEAD
c01b1e94887e16b2327bbe045e28863423604549        refs/heads/@andrewpareles/editor-insets
d857d548471b280a5b446b88672cb0b7642a9ad2        refs/heads/actual-editor-insets
2912d5cd89ae3bc46a9547ce52ba91e663976c91        refs/heads/add-checkpoints
22f02d3ed16229fa038778032350088a82d1588f        refs/heads/add-star-to-tabs
83c4a056420389c159a653dd241fa9da444e82fb        refs/heads/andrew/fix-mcp-styling-consistency
83c4a056420389c159a653dd241fa9da444e82fb        refs/heads/andrew/style-mcp-section
d1a05f6a84f4932dc4b52cb8f08d96892d2f6dd3        refs/heads/andrewpareles-patch-1
04fd13f473b674bc398865eabf75de186f342de2        refs/heads/andrewpareles-patch-2
182af950351d1cb4b991231dd4195e9b3b2fcdf1        refs/heads/andrewpareles/system-message-toggle
53d19d819c0b62bf64d9542792e0d53968d7d8d3        refs/heads/autocomplete
5257e9c82d4301a3e8ff733fa9d1bc7a0265ed8d        refs/heads/autocomplete-readd
4b9e2c2319ec7ccc5ee9c41be02c94de0f38074a        refs/heads/azure-fix
2f80c653d5d102a40ac3420256bb6de4728af7a4        refs/heads/certificates-settings
bf6ffb8d0586bfac66be3e8923c127c00b46bf43        refs/heads/codex/fix-cancelled-mcp-tool-appearing-in-chat
7550b96389435c8fe2c3c5bfaed46fc33358fe6a        refs/heads/config-improvements
4e392bee8ee9bde7fff8bfb03566e621b37cfffb        refs/heads/copy-icons
a29543e4a715a72b89ad74969857b993ad7e462a        refs/heads/ctrlk-diff-ui
de7aa669757bc80208417e2f3a810778872d1da4        refs/heads/dev
ffab60b4b86eebb544d8a80b2daf5c1996309cd1        refs/heads/diff-selections
(exit 0, listan fortsätter)
```

Repo:t existerar och är läsbart. Utskriften visar en lång rad experimentgrenar som aldrig
mergeades (`autocomplete-readd`, `copy-icons`, `diff-selections`, två identiska SHA för
`andrew/fix-mcp-styling-consistency` och `andrew/style-mcp-section`). Det är ett mönster av
avbrutet arbete, vilket är vad man förväntar sig av ett projekt som avbrutits.

### 2.2 `contents/` — det här är ett komplett VS Code-fork, inte en extension

```text
=== ROOT CONTENTS ===
dir .config / .configurations / .devcontainer / .eslint-plugin-local / .github / .idx
file .editorconfig 365
file .eslint-ignore 1584
file .git-blame-ignore-revs 955
file .gitattributes 167
file .gitignore 471
file .lsifrc.json 116
file .mailmap 265
file .mention-bot 153
file .npmrc 163
file .nvmrc 8
file .voidrules 878
file .vscode-test.js 4677
dir .vscode
file CodeQL.yml 1450
file HOW_TO_CONTRIBUTE.md 8065
file LICENSE-VS-Code.txt 1283
file LICENSE.txt 11350
file README.md 2980
file ThirdPartyNotices.txt 182028
file VOID_CODEBASE_GUIDE.md 9586
dir build
file cglicenses.json 38577
file cgmanifest.json 42875
dir cli
file eslint.config.js 46701
dir extensions
file package-lock.json 892108
file package.json 10747
file product.json 1670
dir remote
dir resources
dir scripts
dir src
dir test
file tsfmt.json 746
dir void_icons
```

`src/`, `build/`, `extensions/`, `remote/`, `cli/`, `gulpfile.js`, `cgmanifest.json`,
`ThirdPartyNotices.txt` — det är Microsofts `vscode`-monorepo i dess helhet, med Void som en
contrib-avdelning inuti. Det bekräftas av `product.json` och av README:

> This repo contains the full sourcecode for Void's Desktop app.
> Void is a fork of the [vscode](https://github.com/microsoft/vscode) repository.

### 2.3 `package.json` — stommen är VS Code 1.99.3, pakethanteraren är npm

```text
=== void package.json ===
name code-oss-dev version 1.99.3 private True
engines null
--- deps count 64 devDeps count 116
--- some devDeps ---
  @playwright/test ^1.50.0
  @types/node 20.x
  @types/react ^19.1.2
  @types/react-dom ^19.1.2
--- scripts (utdrag) ---
  buildreact    = cd ./src/vs/workbench/contrib/void/browser/react/ && node build.js && cd ../../../../../../../
  watchreact    = ... node build.js --watch ...
  compile       = node ./node_modules/gulp/bin/gulp.js compile
  watch-client  = node --max-old-space-size=8192 ./node_modules/gulp/bin/gulp.js watch-client
  watch-extensions = node --max-old-space-size=8192 ./node_modules/gulp/bin/gulp.js watch-extensions watch-extension-media
  electron      = node build/lib/electron
  compile-build = node ./node_modules/gulp/bin/gulp.js compile-build-with-mangling
  minify-vscode = node ./node_modules/gulp/bin/gulp.js minify-vscode
  smoketest     = node build/lib/preLaunch.js && cd test/smoke && npm run compile && node test/index.js
  monaco-compile-check = tsc -p src/tsconfig.monaco.json --noEmit
  tsec-compile-check   = node node_modules/tsec/bin/tsec -p src/tsconfig.tsec.json
  valid-layers-check     = node build/lib/layersChecker.js
  gulp          = node --max-old-space-size=8192 ./node_modules/gulp/bin/gulp.js
```

Mäta fakta att fasta:

* `name: "code-oss-dev"`, `version: "1.99.3"` → forkens bas är **VS Code 1.99.3**, publicerad i
  mars 2025. Som av 2026-10-15 ligger den alltså **cirka 19 månader efter** upstream.
* **npm**, inte pnpm: `package-lock.json` på 892 108 byte, ingen `pnpm-lock.yaml` i roten.
  NEXUS-IDE är en pnpm-workspace (`pnpm-workspace.yaml` finns i repo:ets rot). Ett fork av Void
  tvingar fram en annorlunda paketrot precis i den del av systemet där NEXUS integritet ligger.
* Byggpipeline = **gulp**, med `--max-old-space-size=8192` på tre vanliga kommandon: kompileringen
  är dokumenterat minneskrävande (8 GB heap).
* `engines` är `null` — ingen deklarerad Node-krav i `package.json`; låsningen ligger i `.nvmrc`.
* `@types/react 19.1.2`: Void använder alltså React 19, samma generation som NEXUS `packages/ui`.
  Det är den enda punkten där forkens teknikval faktiskt matchar våra.

### 2.4 `.nvmrc` och `.npmrc` — verktygskedjan är låst och byggs från källkod

```text
=== .nvmrc ===
20.18.2
=== .npmrc ===
disturl="https://electronjs.org/headers"
target="34.3.2"
ms_build_id="11161073"
runtime="electron"
build_from_source="true"
legacy-peer-deps="true"
timeout=180000
```

Direkt relevanta konsekvenser för den här maskinen, som mattes med `node --version` och
`npm --version`:

| Krav i Void | Värdet på den här maskinen | Status |
|---|---|---|
| Node `20.18.2` (`.nvmrc`) | Node `v24.19.0` | avvikelse, kräver nvm/volta per projekt |
| npm | npm `11.17.0` | ok |
| Electron `34.3.2`, headers från electronjs.org | — | överens, inte kontrollerat mot byggd binär |
| `build_from_source="true"` | kräver C++-verktyg för `node-gyp` | **inte uppfyllt**, se 2.5 |
| pnpm-workspace i NEXUS | `package-lock.json` i Void | konflikt |

`build_from_source="true"` är den ensak som gör Void-bygget besvärligt på Windows: native modulerna
kompilera mot Electron-headers lokalt, vilket drar in whole MSVC-verktygskedjan.

### 2.5 Byggkraven, ordagrant ur `HOW_TO_CONTRIBUTE.md`

```text
### b. Windows - Prerequisites

If you're using a Windows computer, first get Visual Studio 2022 (recommended) or
VS Build Tools (not recommended). ...
Go to the "Workloads" tab and select:
- `Desktop development with C++`
- `Node.js build tools`

Go to the "Individual Components" tab and select:
- `MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs (Latest)`
- `C++ ATL for latest build tools with Spectre Mitigations`
- `C++ MFC for latest build tools with Spectre Mitigations`

### c. Linux - Prerequisites
First, run `npm install -g node-gyp`. Then:
- Debian (Ubuntu, etc): `sudo apt-get install build-essential g++ libx11-dev libxkbfile-dev
  libsecret-1-dev libkrb5-dev python-is-python3`.

1. `git clone https://github.com/voideditor/void` to clone the repo.
2. `npm install` to install all dependencies.
3. Open Void or VSCode, and initialize Developer Mode (this can take ~5 min to finish, it's
   done when 2 of the 3 spinners turn to check marks)
4. Open the Void Developer Mode window:
   - Windows: `./scripts/code.bat`.
...
- Make sure you have Node version `20.18.2` (the version in `.nvmrc`).
```

Sammanfattning av vad ett Void-fork kräver, begränsat till vad som går att belägga:

* **Toolchain:** Visual Studio 2022 med C++-workloads (MSVC v143, ATL, MFC) på Windows — inte
  valfritt, dokumenterat som förutsättning. Plus `node-gyp`, Python 3.11 (finns: 3.11.9), Node
  20.18.2, och Electron 34.3.2 headers.
* **Tid:** projektet self-rapporterar "~5 min" för Developer Mode-initialiseringen i steg 3, och
  npm timeout är satt till 180 000 ms. Det är **inte** ett mått på ett kallt `npm install` plus en
  full `compile-build-with-mangling`; den siffran har jag inte mätt och låtsas inte vara en
  uppskattning. Ett totalt byggtid mått kräver att maskinen faktiskt byggs, vilket inte gjordes
  (avsnitt 2.8).
* **Disk:** det faktiska innehållet i repo:t mättes via git trees API (avsnitt 2.7). `node_modules` för en
  VS Code-fork **mättes inte** och anges därför inte som siffra här. 304 GB fritt på C: (mätt med
  `df -h C:/` → `930G 627G 304G 68%`) gör diskfrågan till det minst oroväckande problemet.
* **Patchning:** Void är en förgrening av `microsoft/vscode` på 1.99.3. Varje säkerhetsuppdatering,
  varje prestandaförbättring och varje ny upstream-API vi vill använda måste importeras manuellt
  genom ~19 månaders divergens, utan uppströms support (arkiverat). Notera dessutom att Void självt
  säger varför deras CI finns: _"You can copy our GitHub Actions to package, sign, and auto-update
  Void. **VS Code's build pipeline is private**, so this is normally very hard."_ Alltså:
  signering, auto-updatering och paketering blir vårt att underhålla, från grunden.

### 2.6 `product.json` — tre saker att notera

```text
"nameShort": "Void", "voidVersion": "1.4.9", "voidRelease": "0044",
"applicationName": "void", "dataFolderName": ".void-editor",
"licenseName": "MIT",
"licenseUrl": "https://github.com/voideditor/void/blob/main/LICENSE.txt",
"extensionsGallery": {
  "serviceUrl": "https://marketplace.visualstudio.com/_apis/public/gallery",
  "itemUrl": "https://marketplace.visualstudio.com/items" },
"builtInExtensions": [],
"linkProtectionTrustedDomains": [
  "https://voideditor.com", "https://voideditor.dev",
  "https://github.com/voideditor/void", "https://ollama.com" ]
```

1. `licenseName: "MIT"` **motsäger** repo:t faktiska `LICENSE.txt`, som är Apache-2.0 (avsnitt 3).
   Det är ett dokumenterat egenslag i forkens metadata och ett tecken på att den delen av forkens
   egendata inte var noggrant underhållen.
2. `extensionsGallery.serviceUrl` pekar på **Microsofts VS Code Marketplace**. Ett Vanilj-fork som
   behåller den länken hämtar extensioner från en marknad vars villkor inte tillåter
   third-party-klienter att använda den. Detta är en klassisk fälla för VS Code-forks och behöver
   bytas mot Open VSX eller en egen galleri — ett extra arbete som inte har något med AI att göra.
3. `linkProtectionTrustedDomains` innehåller `https://ollama.com` — Void var alltså redan
   Ollama-vänligt. Det bekräftar vår produktteori, men det är en inställning, inte kod vi behöver ärva.

`voidVersion 1.4.9` i `product.json` mot release-taggen `v1.3.4` visar att huvudgrenen låg före
den senaste publicerade builden — ytterligare ett tecken på att avvecklingen skedde mitt i arbete.

### 2.7 Verklig omfattning, mätt via git trees API

```text
$ curl -s ".../git/trees/main?recursive=1"
truncated= False entries= 10739
blobs= 8325
total blob bytes= 136475856
src blobs= 5398 src bytes= 76852267
extensions blobs= 2163
ts/tsx files= 5651
void contrib files= 100 void contrib bytes= 1106111
```

Siffror att ha i åtanke när vi väger fork mot egen skal:

* Ucheckat innehåll på disk: **8 325 filer, ~130 MiB** (summan av blob-storlekarna).
* `src/`: 5 398 filer, ~73 MiB — allt detta är kod vi ärver och måste underhålla för att få
  tag i det som faktiskt är Void.
* `extensions/`: 2 163 filer — hela extensionsbiblioteket följer med och måste byggas.
* **5 651 TypeScript/TSX-filer** som måste typkonsumeras varje gång något i kärnan ändras.
* Void's egen AI-layer: **100 filer, ~1.06 MiB**. Alltså: vi ärver ~130 MiB för att få tag på
  ~1 MiB intressant kod — och den 1 MiB är den vi avser att byta ut helt.

### 2.8 Klonkostnad — vad jag faktiskt provade, och vad det inte bevisar

```text
$ time git clone --depth 1 --filter=blob:none --no-checkout https://github.com/voideditor/void voidprobe
Cloning into 'voidprobe'...
clone_elapsed=2s
$ du -sh voidprobe
541K    voidprobe
```

Klart på 2 sekunder, 541 KB. **Det är inte ett mått på ett riktigt clone.** `--filter=blob:none`
hoppar över allt filinnehåll och `--no-checkout` skriva inga filer på disk, så mätningen säger
bara att GitHub tål en blobless förhandling snabbt. Ett fullt clone hade gett ~8 325 filer och
~130 MiB (avsnitt 2.7). Klonen togs bort direkt:

```text
$ rm -rf /tmp/voidprobe && [ -d /tmp/voidprobe ] && echo NO || echo YES
voidprobe removed: YES
```

Ett fullt clone gjordes alltså **inte**, och inget bygge gjordes. Bedömningen nedan vilar på
dokumentation, metadata och filstorlekar — inte på en genomförd build. Det är en ärlig begränsning.

---

## 3. Licens: Apache-2.0, och dess huvudförpliktelser

```text
=== LICENSE ===
name= LICENSE.txt path= LICENSE.txt
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/
   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION
   1. Definitions.
      "License" shall mean the terms and conditions for use, reproduction, and
      distribution as defined by Sections 1 through 9 of this document. ...
```

`spdx_id: Apache-2.0`, filen `LICENSE.txt` på 11 350 byte. Apache-2.0 är permissiv och compatibel
med en kommersiell, stängd NEXUS-IDE. Men den är **inte** "göm filhuvudet och var glad":

* **Filhuvuden.** Apache-2.0 sektion 4(b) kräver att derivat verk innehåller "notices that such
  file was modified", där originalverket stilla. Praktiskt: varje Void-fil vi beholdr bär ett
  modifieringsnotice. I en VS Code-fork med 8 325 filer är detta inte ett engångsjobb — det är en
  permanent regel i code review, och det gäller i första hand filerna vi *inte* skriver från
  grunden av.
* **`NOTICE`-fil.** Om originalverket innehåller en `NOTICE`-fil måste den följa med den
  distribuerade worken. Void innehåller `ThirdPartyNotices.txt` på **182 028 byte**, plus
  `cglicenses.json` (38 577) och `cgmanifest.json` (42 875). Varje upstream-sync flyttar dessa
  listor, och NEXUS måste hålla dem korrekta för varje distribuerad build.
* **Dubbel licens.** `LICENSE-VS-Code.txt` (1 283 byte) finns parallellt — Microsofts MIT för
  VS Code-delen — medan Void's egna bidrag är Apache-2.0, och `product.json` hävdar `MIT`. En fork
  ärver den förvirringen och måste reda ut den, för alltid, per fil.
* **Patentklausul.** Apache-2.0 ger ett uttryckligt patentlicens med retaliation-klausul. Det är
  en fördel mot MIT, men den gäller bara det material som licensierats under Apache — dvs. Void's
  egna bidrag, som aldrig kommer att uppdateras.
* **Trademarks.** Apache-2.0 sektion 6 ger ingen varumärkesrättighet. Namnen "Void", "VS Code",
  "Visual Studio" och marketplace-API:t är inte licensejade.

Slutsats om licensen: den blockerar inte. Den tvingar fram ett permanent, filgrannt
attribution-arbete som växer med varje upstream-sync — kostnad som betalas i evinnerlig tid för ett
uppströms som är arkiverat och därför bara kan syncas framåt, aldrig bakåt mot fixar.

---

## 4. Vad som måste modifieras för att stoppa in vår agentkärna i stället för Void's AI-tjänst

Void's AI-logik ligger i `src/vs/workbench/contrib/void/`. Mätt fördelning:

```text
file counts by area: {'browser': 67, 'common': 25, 'electron-main': 8}
react files: 35  react bytes: 369873
```

De 16 största av lagrets 100 filer, mätta via `git/trees/main?recursive=1` och sorterade
på storlek:

```text
   104205  browser/react/src/sidebar-tsx/SidebarChat.tsx
    89485  browser/editCodeService.ts
    67147  browser/chatThreadService.ts
    60007  browser/react/src/util/inputs.tsx
    57256  common/modelCapabilities.ts
    56813  browser/react/src/void-settings-tsx/Settings.tsx
    38129  common/prompt/prompts.ts
    33871  electron-main/llmMessage/sendLLMMessage.impl.ts
    33059  browser/autocompleteService.ts
    28645  browser/voidCommandBarService.ts
    26283  browser/convertToLLMMessageService.ts
    24049  browser/toolsService.ts
    22593  common/voidSettingsService.ts
    21329  browser/react/src/void-onboarding/VoidOnboarding.tsx
    18844  common/voidSettingsTypes.ts
    17381  browser/react/src/util/services.tsx
```

Notera nionde plats: `electron-main/llmMessage/sendLLMMessage.impl.ts`. Void's faktiska
provider-IO ligger i **Electron's main-process**, inte i workbench. Det är den posten som
avgör hela bedömningen, se avsnitt 4.1.

### 4.1 Den arkitekturerella blockingen: LLM-I/O bor i `electron-main`

Det finns en konkret, mätbar anledning till att ett fork inte passar oss, utöver det
allmänna skälet "vi vill äga vår kod". Void's faktiska providersamtal ligger i:

```text
dir electron-main            (8 filer)
  electron-main/llmMessage/sendLLMMessage.impl.ts   ~33.9 KB
common/sendLLMMessageService.ts   9 052 B
common/sendLLMMessageTypes.ts     6 625 B
common/refreshModelService.ts     8 078 B
```

Alltså: **provider-IO sker i Electron's main-process och nås via IPC**, vilket Void's egen README
bekräftar: _"Feel free to reference our architecture for using IPC and satisfying CSP."_

Det är i direkt konflikt med NEXUS-IDE:s grundläggande arkitekturval. Vår kärna bor i `packages/core`,
`packages/providers`, `packages/mcp-client`, `packages/protocol` som **process-agnostiska** paket:
samma kärna måste kunna köras (a) i skrivbordsappen, (b) i huvudprocessen, (c) i en CLI, och (d) i
enhets-test utan Electron alls. `CONVENTIONS.md` gör detta till en hård regel —

> All modell-/nät-/GPU-anrop har timeout + `.catch` och degraderar:
> moln → lokal → stub → `NoModelAvailable`
> Ett test som går grönt mot en stubb får **inte** påstå att en riktig modell svarade.

— och degraderingskedjan `moln → lokal → stub` inte kan köras i en main-process-IPC om kärnan ska
kunna testas utan Electron. För att få Void's AI-layer att använda vår kernel måste vi alltså
**flytta den mellan processer** och bygga om IPC-gränset, vilket i praktiken är att skriva om
`sendLLMMessage`-kedjan, `modelCapabilities.ts` (57 KB) och `refreshModelService.ts` — inte byta en
adapter.

### 4.2 Vad varje lager i lagret gör, och vad vi tvingas göra med det

| Void-modul (mätt fil) | Uppgift i Void | Åtgärd för NEXUS |
|---|---|---|
| `common/modelCapabilities.ts` (57 256 B) | hårdkodad tabell över vad varje provider-modell kan (tools, vision, kontext, strömning) | **Rivas.** NEXUS löser capabilities från `@nexus/providers` och från den levande katalog vi nu hämtar (`GET /v1/models`). Att behålla den innebär två sanningar om samma modell |
| `common/sendLLMMessageService.ts` + `sendLLMMessageTypes.ts` (15 677 B tillsammans) och `electron-main/llmMessage/sendLLMMessage.impl.ts` (~33.9 KB) | VOID's provider-lager; sitter i main-process, IPC-emballerat | **Ersättas** av `@nexus/providers`. Gränsförskjutning, inte signaturbyte |
| `common/mcpService.ts` (12 620 B), `common/mcpServiceTypes.ts` (6 997 B), `browser/toolsService.ts` (24 049 B), `common/toolsServiceTypes.ts` (4 046 B) | MCP-klient och tool-loop | **Ersättas** av `@nexus/mcp-client`. Vi behöver `blueprints/raw/mcp-transport-stdio-sse-http.md`-transporterna (stdio + Streamable HTTP) i vår egen klient, och NIM-dokumentationen säger explicit att MCP-handskakningen är klientens ansvar ("NIM LLM and VLM does not connect to MCP servers directly") — så vår gränsning är rätt, VOID's är inbyggd i workbench-DI och går inte att lyfta ut |
| `common/voidSettingsService.ts` (22 593 B) + `voidSettingsTypes.ts` (18 844 B) | alla inställningar, inkl. nycklar per provider | **Skrivas om** mot NEXUS-nyckelmodell (egen nyckel, egen profil, inget leverantörskonto). Nyckellagring är precis den integritet NEXUS-existensen bygger på |
| `common/voidModelService.ts` (3 053 B), `refreshModelService.ts` (8 078 B) | modell-listor och uppdatering | **Ersättas** av katalogslaget i `nvidia_models.json` + per-provider `/v1/models` |
| `common/prompt/prompts.ts` (38 129 B), `common/prompt/` | system- och uppgiftsprompts | **Ersättas** av vår prompt-lager. Att ärva deras prompts innebär att ärva deras produktbeslut |
| `browser/chatThreadService.ts` (67 147 B), `browser/editCodeService.ts` (89 485 B), `browser/autocompleteService.ts` (33 059 B), `browser/convertToLLMMessageService.ts` (26 283 B), `browser/voidCommandBarService.ts` (28 645 B) | agent-loop, diff-streaming, inline-completion, chat-messkonvertering, command bar | **Det här är den enda verkligt intressanta delen**, och den är den som sitter djupast i workbench-DI. Här ska vi **läsa och lära**, inte ärva |
| `browser/react/**` (35 filer, ~370 KB; störst `SidebarChat.tsx` 104 205 B) | React-panel med Tailwind | **Ersättas** av `@nexus/ui`. Byggpipeline kräver dessutom deras `npm run buildreact`-hak i gulp-pipelinen (se 2.3-skriptet) |
| `common/voidSCMTypes.ts`, `add-checkpoints`-grenen, `voidUpdateService.ts` (1 826 B) | checkpoint/SCM och auto-updatering | NEXUS egen checkpoint-logik; VOID's updater pekar på VOID's infrastrukturen och måste kastas |

### 4.3 Kostnaden av att behålla forkens skal

Förutom AI-lagret måste vi, per fil och per sync, hantera:

* **5 398 filer i `src/`** av VS Code-koden, varav vi inte äger någon upstream-resurs mer.
* **2 163 filer i `extensions/`** som måste byggas varje gång.
* **5 651 TS/TSX-filer** som typkontrolleras.
* En **gulp**-pipeline och **npm**-lås (`package-lock.json` 892 KB) som inte låter sig kombineras med
  NEXUS `pnpm-workspace.yaml` utan att vi driver två paketrot parallellt.
* Node 20.18.2 låst mot vår utvecklings-Nod 24.19.0.
* MSVC v143 + ATL + MFC på Windows för native-moduler (`build_from_source="true"`).
* Marketplace-länken i `product.json` som måste bytas.
* `ThirdPartyNotices.txt` (182 KB) som måste hållas sann.

**Sammanfattning:** för att få in vår kernel i Void måste vi röra i stort sett hela AI-lagret (100 filer,
~1.06 MiB) *och* leva med de övriga ~8 200 filerna för evigt, utan uppströms support, med en
19 månader gammal stomme.

### 4.4 Det Void faktiskt är bra för

Inte allt ska kastas. Void är, som README säger, en av de bästa referensimplementeringarna för att
forka VS Code, och tre saker är värda att **läsa och återimplementera**:

1. `editCodeService.ts` (89 KB): diff som streamar medan token landar — direkt relevant till vår
   agent-mode.
2. React-bygget inuti en VS Code-fork, med `buildreact` + Tailwind-scoping. Det löser ett
   känt problem vi får ändå.
3. Deras egna GitHub Actions för paketering, signering och auto-updatering — README: _"VS Code's
   build pipeline is private, so this is normally very hard"_. Det är den enda biten av Void som
   faktiskt sparar oss tid, och den kan kopieras utan att forka editor.

Regeln för detta: **referenskälla, inte beroende.**

---

## 5. Rekommendation

**Forka inte `voideditor/void`. Bygg FAS 2.3: egen Electron + React + Monaco-skal.**

Motiveringen, i den ordning skälen väger:

1. **Projektet är avvecklat och arkiverat.** `archived = True` och README:s "no longer accepting
   contributions" är inte en bedömning, det är repo-status. Ett fork av död kod är ett förvärv av
   skulder utan möjlighet till avbetalning uppströms.
2. **Stommen är 19 månader efter.** VS Code 1.99.3 (mars 2025) som bas den 2026-10-15, med senaste
   release v1.3.4 från 2025-04-15. Vi skulle börja med att själva patcha allt VS Code har
   fixat upstream under de där 19 månaderna, utan resurser och utan uppströms support.
3. **Vår AI-layer får inte plats i deras arkitektur.** Det här är inte en smakfråga: provider-IO ligger
   i `electron-main` bakom IPC (`electron-main/llmMessage/sendLLMMessage.impl.ts`,
   `common/sendLLMMessageService.ts`), capabilities är en hårdkodad 57 KB-tabell
   (`modelCapabilities.ts`), och inställningarna är cirka 41 KB inställningskod om provider-konton
   (`voidSettingsService.ts` + `voidSettingsTypes.ts`). NEXUS-kärnan är process-agnostiska paket med
   degraderingskedjan moln → lokal → stub → `NoModelAvailable`. Att få det ena att passa i det
   andra är en omritning av processgränsen, inte ett adapterbyte.
4. **Priset för skalens bekvämlighet är högt och betalas löpande.** 8 325 filer / ~130 MiB /
   5 651 TS-filer, en gulp + npm pipeline som motsäger `pnpm-workspace.yaml`, Node 20.18.2-låsning,
   MSVC/ATL/MFC för `build_from_source="true"`, och en `product.json` som pekar på Microsofts
   marketplace. Licensen är okej (Apache-2.0) men ålägger oss modifieringsnotice per fil och ett
   182 KB `ThirdPartyNotices`-arbete vid varje sync.
5. **Vi bygger redan den del som måste vara vår.** NEXUS har `packages/core`, `providers`, `mcp-client`, `protocol`,
   `ui`, `vision`, `voice`, `host` — kärnan, transporten och modell-lagret. Det enda fork hade
   sparar är Monaco-integration och editor-ytor, och det är den minsta delen av problemet.
6. **NEXUS löfte är just "user-owned".** Void's värde är editor-koden vi inte vill underhålla — men
   just den delen är det vi *tvungna* ärver för att få resten.

**Vad som görs i stället (FAS 2.3):** egen Electron + React + Monaco-skal, med
`@nexus/protocol` som enda gräns mellan skal och kärna. Det kostar oss Monaco-integration,
command palette och filträd i eget arbete, men det ger:

* en kernel som kan köras och testas utan Electron (vilket `CONVENTIONS.md` kräver),
* fri val av paketrot (pnpm workspace, Node 24),
* inget upstream-lag att synka, ingen licens-notice-transport,
* och full kontroll över var användarens nyckel, prompt och data landar — vilket är hela produkten.

Void's `editCodeService`, `buildreact`/Tailwind-scoping och deras GitHub Actions för
signering/auto-updatering **läses som referens** och återimplementeras där de är bättre än vårt
first-pass. Det är ett beslut som gör fork-utredningen omkullkastbar men inte värdelös.

### 5.1 Beslutet protokollförs

> **FAS 2.1-utredningen slutförd med nekande svar. Uppdraget går vidare på FAS 2.3: egen
> Electron + React + Monaco-skal i `apps/desktop`, mot `@nexus/*`-paketen. Void forkas inte.**
> Void's repo behålls som läst referensmaterial, inte som beroende.

---

## 6. Källor

Allt mätt via publike API:er utan token; inget material är hämtat från ett klonat worktree
(avsnitt 2.8: inget fullt clone gjordes).

* `git ls-remote https://github.com/voideditor/void` (exit 0)
* `curl -s https://api.github.com/repos/voideditor/void`
* `curl -s https://api.github.com/repos/voideditor/void/license`
* `curl -s https://api.github.com/repos/voideditor/void/contents/`
* `curl -s "https://api.github.com/repos/voideditor/void/commits?per_page=3"`
* `curl -s "https://api.github.com/repos/voideditor/void/releases?per_page=3"`
* `curl -s https://api.github.com/repos/voideditor/void/git/trees/main?recursive=1`
* `curl -s -H "Accept: application/vnd.github.raw" https://api.github.com/repos/voideditor/void/contents/{package.json,product.json,.nvmrc,.npmrc,README.md,HOW_TO_CONTRIBUTE.md}`
* `https://github.com/voideditor/void` — README, `VOID_CODEBASE_GUIDE.md`, `HOW_TO_CONTRIBUTE.md`
* Lokala mätvärden: `nvidia-smi`, `node --version`, `npm --version`, `python --version`,
  `which docker`, `docker --version`, `df -h C:/`, `cmd.exe /c ver`

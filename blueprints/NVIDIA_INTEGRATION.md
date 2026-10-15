# NVIDIA-integration för NEXUS-IDE

Dokumentet bygger uteslutande på det material som hämtades live den
**2026-10-15 (kl. ca 15:51–16:01 UTC)** och som ligger verifierbart i
[`blueprints/raw/`](./raw/). Allt som inte stod att läsa i det material eller inte gick att
mäta på den här maskinen markeras uttryckligen. Ingen modell-id, URL eller kommando i detta
dokument är påhittad.

Ansvarsutkrävande i kort form:

| Påstående | Grund |
|---|---|
| Nyckelkapabel HTTP-yta och felkoder | direkt mätt med `curl` mot `integrate.api.nvidia.com`, se avsnitt 2 |
| Steg för att skapa nyckel | ordagrant ur `docs.nvidia.com` NIM Prerequisites, se avsnitt 1 |
| `docker run`-kommandon | ordagrant ur NIM Quickstart, se avsnitt 4 |
| Krav på GPU-minne per modell | ordagrant ur NIM Prerequisites + Support Matrix, se avsnitt 4 |
| Rate limit / credits | **dokumenterades inte någonstans i hämtat material**, se avsnitt 3 |
| Lokal NIM på den här maskinen | **odokumenterat och overifierbart — Docker finns inte installerat**, se avsnitt 5 |

---

## 1. Att skapa en NVIDIA API-nyckel, steg för steg

### 1.1 Vad som faktiskt gick att hämta

Sidan `https://build.nvidia.com/settings/api-keys` är **inloggningsskyddad**, och de två
hämtningssätten var oense:

* `WebFetch` → **HTTP 404 Not Found**, utan innehåll.
* `curl -sL` → **HTTP 200**, 75 879 byte HTML — men bodyn är ett klientrenderat SPA-skal.
  efter HTML→text-extraktion återstår 508 tecken, och det enda innehållet är
  inloggningsportalens text, ordagrant:

  ```text
  ## Sign In to Get Started with NVIDIA AI

  - Free serverless APIs for development
   Accelerated by DGX Cloud

  - Self-Host on your GPU infrastructure
  - Continuous vulnerability fixes

  Next
  By proceeding, I agree to join the NVIDIA Developer Program and accept the
  NVIDIA Technology Access Terms of Use
  ```

Försöket upprepades tre gånger med backoff; alla tre gav samma skal. **Nyckelhanterings-UI:t
kunde alltså inte läsas**, och det var förväntat: det kräver en inloggad NVIDIA-session, och
den här maskinen har med flit ingen NVIDIA-nyckel och ingen session. Det är själva idén i
FAS 1 — nyckeln är användarens.

De faktiska, dokumenterade stegen finns därför i NIM-dokumentationen, inte i den gateda
SPA:an. De är återgivna ordagrant i
[`raw/nvidia-api-keys.md`](./raw/nvidia-api-keys.md).

### 1.2 Stegen

**Steg 1 — Medlemskap i NVIDIA Developer Program (krav, dokumenterat).**
NIM Prerequisites listar vad som krävs för att hämta och köra NIM-container:

> To download and deploy NIM containers, you need one of the following:
> * A free NVIDIA Developer Program membership.
> * An NVIDIA AI Enterprise license. To request a free 90-day evaluation license, refer to
>   Ways to Get Started With NVIDIA AI Enterprise and Activate Your NVIDIA AI Enterprise License.

SPA-skalet bekräftar samma villkor löpande: "By proceeding, I agree to join the NVIDIA
Developer Program and accept the NVIDIA Technology Access Terms of Use".

**Steg 2 — Logga in på build.nvidia.com.**
Rot- och katalogsidorna (`https://build.nvidia.com/`, `https://build.nvidia.com/models`) är
öppna och lämnade utan inloggning under detta arbete (HTTP 200, fullt modellinnehåll).
Navigeringen till `Settings → API Keys` kräver att man är inloggad; utan session landar man
i portalen ovan.

**Steg 3 — Öppna API Keys-sidan.**
URL:en är `https://build.nvidia.com/settings/api-keys`. NIM-dokumentationen refererar till
samma mål under namnet **"the Setup API Keys page"**, ordagrant:

> If you want to create an NGC Personal API key, do the following:
> * Generate the Personal API Key on the Setup API Keys page.

**Steg 4 — Välj vilka tjänster nyckeln gäller (det här steget missas ofta).**
Ordagrant ur dokumentationen:

> When creating the Personal API key, select at least NGC Catalog from the
> Services Included list. You can also include additional services if you want
> to use the same key for other purposes.

Utan `NGC Catalog` i `Services Included` kan nyckeln att autentisera men ändå nekas när den
används för att hämta modellartefakter.

**Steg 5 — Använd Personal API Key, aldrig en Legacy-nyckel.**
Dokumentationen har en varningstext som gäller direkt för NEXUS lokala väg:

> **Warning**
> Legacy API keys are not supported by NIM LLM and VLM. Always use a Personal API Key.

**Steg 6 — Spara nyckeln i användarens egen `.env`.**
Detta är NEXUS-konventionen, redan etablerad i repo:ets `.env.example`:

```ini
# NVIDIA NIM — nyckel skapas på https://build.nvidia.com/settings/api-keys
NVIDIA_API_KEY=
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
```

Regler som gäller i NEXUS och som följer av "user-owned"-premissen:

* Nyckeln lagras **aldrig** i repot, i build-artefakter, i loggar eller i telemetri.
* Den läses från miljövariabeln eller från OS-keyring, aldrig från en hårdkodad sträng.
* Vid saknad nyckel får NEXUS fortfarande katalogdata (avsnitt 2.1) och ska då visa
  "katalog utan nyckel"-läget i UI:t i stället för att faila hårt — i enlighet med
  repo:ets degradationsregel (`moln → lokal → stub → NoModelAvailable`).

### 1.3 Vilka nycklar som är vilka — en viktig distinktion

Hämtat material skiljer på två nyckelbehov som ofta blandas ihop:

| Ändamål | Nyckel | Behövs det? |
|---|---|---|
| Värd-inference via `integrate.api.nvidia.com/v1` | NVIDIA API-nyckel från build.nvidia.com | **Ja.** Mätt: utan `Authorization`-header ges HTTP 401 |
| Lista modeller via `/v1/models` | — | **Nej.** Mätt: HTTP 200 utan någon header |
| Hämta NIM-container-image från NGC | NGC Personal API Key | **I de flesta fall nej**, ordagrant: "For eligible public-catalog NIMs, `NGC_API_KEY` and Docker login are optional" |
| Hämta Production Branch-modeller (`-pb<N>`-suffix) eller NIM äldre än 2.0.10 | NGC Personal API Key | **Ja**, ordagrant ur Quickstart-note |
| Hämta modeller från Hugging Face i model-free NIM | `HF_TOKEN` | **Ja**, "Model-source credentials, such as `HF_TOKEN`, can still be required" |

Om prefixet på nyckelsträngen: hämtad dokumentation anger **inte** något prefix. I praktiken
ser NVIDIA-nycklar ut att börja på `nvapi-`, men det står inte i det material jag hämtade, så
NEXUS ska **inte** validera format — bara kräva att strängen är icke-tom. Jag mätte bara med en ogiltig dummy-sträng, som gav HTTP 403 (se 2.2). Jag
mätte inte ett aktivt nyckelformat, så NEXUS ska inte gissa sig till ett prefix.

---

## 2. Den OpenAI-kompatibla endpointen

Bas-URL för värd-inference: **`https://integrate.api.nvidia.com/v1`**

Detta är exakt det värdet som redan finns i repo:ets `.env.example` som
`NVIDIA_BASE_URL`, så NEXUS provider-lager behöver ingen ny markering.

### 2.1 Katalog utan nyckel — verifierat

`GET https://integrate.api.nvidia.com/v1/models` utan någon som helst header:

```http
HTTP/1.1 200 OK
Content-Type: application/json
Transfer-Encoding: chunked
Vary: Origin
```

Svaret har OpenAI-form: `{"object":"list","data":[{"id":"...","object":"model",
"created":...,"owned_by":"..."}]}` — 81 poster, fullständig lista i
[`nvidia_models.json`](./nvidia_models.json).

Det här är den enda NVIDIA-yta NEXUS kan anta vara alltid tillgänglig, även för en användare
som aldrig skaffat en nyckel. Provider-lagret ska använda den för att validera modell-id mot
verklighet i stället för att lita på hårkodade listor (se avsnitt 6 för varför det spelar roll).

### 2.2 Felbeteende mätt på riktiga anrop

Detta är den mest praktiskt värdefulla delen av dokumentet, för det är vad NEXUS provider-lager
faktiskt måste mappa in. Alla rader nedan är mätta med `curl` 2026-10-15, inte hämtade från docs.

| Scenario | HTTP | Svarstext (ordantligt) |
|---|---|---|
| `POST /v1/chat/completions`, ingen `Authorization`, giltigt modell-id | **401** | `Header of type \`authorization\` was missing` |
| `POST /v1/chat/completions`, `Authorization: Bearer <ogiltig>`, giltigt modell-id | **403** | `{"status":403,"title":"Forbidden","detail":"Authorization failed"}` |
| `POST /v1/chat/completions`, giltig struktur men utan `model`-fält | **400** | `{"error":{"message":"model field is required","type":"invalid_request_error","param":null,"code":"missing_required_field"}}` |
| `POST /v1/chat/completions`, okänt/utgånget modell-id | **404** | `404 page not found` |
| `GET /v1/chat/completions` (fel metod) | **405** | — |
| `GET /v1/models/<okänt>` | **404** | `Model does not exist by the name of nonexistent/model` |
| `POST /v1/embeddings`, modell `nvidia/nv-embedqa-e5-v5` | **410** | `{"type":"about:blank","title":"Gone","status":410,"detail":"The model 'nvidia/nv-embedqa-e5-v5' has reached its end of life on 2026-08-25T09:00:00Z and is no longer available."}` |
| `GET /v1/models` | **200** | katalog, ingen nyckel |

Två implikationer för koden:

1. **Modelluppslag sker före autentisering.** Ett felaktigt modell-id ger 404, inte 401. En
   404 från chat-endpointen betyder alltså "det här id:t är ingen routad modell", inte "behörighet
   saknas". Provider-lagret får inte tolka 404 som ett auth-fel — det är hela förklaringen till
   varför fallback-listan i avsnitt 6 måste valideras mot katalogen.
2. **401 och 403 är olika fel.** 401 = headern saknas (konfigurationsfel, NEXUS har aldrig bett
   om en nyckel). 403 = headern finns men nekas (nyckeln är ogiltig, utgången eller saknar
   rätt tjänst). UI:t måste skilja dem, annars ser användaren "fel nyckel" när det egentligen
   är "ingen nyckel ifyllt".
3. **410 är en reell tillstånd.** NVIDIA pensionerar modeller med hård deadline. En hårdkodad
   embed-modell kan sluta svara i produktion utan att NEXUS ändrat en rad. Cachade kataloglistor
   måste därför ha ett TTL-värde.

### 2.3 Headers och body-form för chat completions

```http
POST https://integrate.api.nvidia.com/v1/chat/completions
Authorization: Bearer ${NVIDIA_API_KEY}
Content-Type: application/json
Accept: application/json            # eller text/event-stream för streaming
```

Bodyn är standard OpenAI-form. NIM API Reference, ordagrant om `/v1/chat/completions`:
_"Multi-turn chat completions with message history. Supports streaming and tool calling."_

Streaming, med det exemplar som dokumentationen själv använder (för lokal NIM, samma kropp):

```bash
curl -s http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${MODEL_NAME}\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Explain transformers briefly.\"}],
    \"max_tokens\": 256,
    \"stream\": true
  }"
```

Streaming sker som **Server-Sent Events**. Dokumentationen säger uttryckligen om de tre huvud-
inference-endpointerna (`/v1/chat/completions`, `/v1/completions`, `/v1/responses`):
_"All three endpoints support streaming."_

Bildinmatning (skärmsyn, relevanti för FAS kring screen vision) har ett dokumenterat kropp-format
med `content` som array av `{"type":"text"}` och `{"type":"image_url","image_url":{"url":...}}`,
återgivet ordagrant i [`raw/nvidia-nim-api-reference.md`](./raw/nvidia-nim-api-reference.md).

Svarsformen är också dokumenterad och bär redan på verktygs-kall-stöd i strukturen. Exempelsvaret
från Quickstart innehåller, ordagrant:

```json
"message": {
  "role": "assistant",
  "content": "...",
  "refusal": null,
  "annotations": null,
  "audio": null,
  "function_call": null,
  "tool_calls": [],
  "reasoning": null
}
```

NEXUS agentkärna ska läsa `tool_calls` (och `reasoning`, som finns som fält även om semantiken
inte dokumenteras i hämtat material).

### 2.4 Verktygskall (tool-calling) — och MCP-slingan

Formatering: `tools`-arrayen i chat-completions-requesten, OpenAI form. För **lokal NIM** krävs
två vLLM-argument, ordagrant ur `tool-calling-and-mcp.html`:

> Tool calling requires two vLLM engine arguments: `--enable-auto-tool-choice` and a
> `--tool-call-parser` that matches your model.

| Argument | Beskrivning (ordantligt) |
|---|---|
| `--enable-auto-tool-choice` | "Allows the model to choose between generating text or calling a tool. Required for tool calling." |
| `--tool-call-parser <parser>` | "Built-in parser name for extracting tool calls from model output. Must match the model's tool calling format (for example, `llama3_json` for Llama 3.1 and 3.3)." |
| `--tool-parser-plugin <path>` | "Path to a custom tool-call parser file. ... Required only when no built-in parser fits your model." |

Dokumentationen varnar specifikt, ordagrant: _"Without these flags the server rejects
`"tool_choice": "auto"` with a 400 error."_

**Det här är den viktigaste arkitekturpunkt som hämtat material levererar.** NIM-dokumentationen
säger, ordagrant:

> NIM LLM and VLM does not connect to MCP servers directly. Your client application connects to
> MCP servers, converts tool definitions to the OpenAI tools format, and sends them in the `tools`
> array of a Chat Completions request.

Det är exakt den design NEXUS-IDE redan har valt: MCP-klienten lever i `packages/mcp-client`,
agentkärnan gör om MCP-tool-scheman till OpenAI `tools`, och modellen ser bara OpenAI-format.
Nexus behöver alltså **inte** få NIM att prata MCP — det är klientens jobb. Dokumentationen
bekräftar gränsningen, och noterar att vLLM tolererar ödesfält:

> MCP tool schemas converted to OpenAI format can include extra fields such as `strict` or
> `additionalProperties` that are not part of the core function definition schema. vLLM accepts
> these fields without error.

Detta gäller värd-API:t: verktygskall mot `integrate.api.nvidia.com` kunde **inte** mätas, eftersom
det kräver en giltig nyckel som den här maskinen inte har. Dokumentationen jag hämtade beskriver
tool-calling för container-URL:en `localhost:8000`. Kroppsformen är OpenAI-standard i båda fallen,
men NEXUS ska behandla "tool-calling mot värd-endpointen" som **overifierat tills en nyckel finns**,
och köra en riktig round-trip i det första manualtestet.

### 2.5 Endpointinventarie (ordantligt ur NIM API Reference)

| Endpoint | Beskrivning |
|---|---|
| `POST /v1/chat/completions` | "Multi-turn chat completions with message history. Supports streaming and tool calling." |
| `POST /v1/completions` | "Single-turn text completions." |
| `POST /v1/responses` | "Create a model response (OpenAI Responses API)." |
| `GET /v1/responses/{id}` / `POST /v1/responses/{id}/cancel` | hämta respektive avbryta strömmande svar |
| `POST /v1/messages` | "Anthropic-compatible messages endpoint." |
| `POST /v1/messages/count_tokens` | räknar token utan att köra inference |
| `GET /v1/models` | "List models currently loaded and available for inference." |
| `POST /tokenize`, `POST /detokenize` | token-omvandling |
| `POST /inference/v1/generate` | "Low-level token-in/token-out generation endpoint ... Requires vLLM 0.11.1 or later." |
| `POST /generative_scoring` | log-prob-baserad scoring, "Requires vLLM 0.20.0 or later." |
| `POST /v1/chat/completions/render`, `POST /v1/completions/render` | returnerar formaterad prompt utan inference |
| `GET /v1/health/live`, `GET /v1/health/ready` | lifecycle-/readiness-prober; ready kan svara `503` medan modellen laddas |
| `GET /v1/metadata`, `/v1/version`, `/v1/license`, `/v1/manifest`, `/v1/metrics` | NIM-administrationsytor, inklusive Prometheus-metrics |

Notera `/v1/messages`: NIM exponerar en **Anthropic-kompatibel** yta. NEXUS kan därför köra en
Claude-Code-liknande klient mot en lokal NIM utan att skriva om den. Dokumentationen säger
uttryckligen att `x-api-key` inte valideras lokalt: _"NIM does not validate the `x-api-key`
header. When you use Anthropic SDK clients, set the API key to any non-empty string that
satisfies the client."_

För den lokala NIM-cachen gäller också att `/v1/health/ready` är den korrekta readiness-boollen —
FAQ:en, ordagrant: _"A container can be live before the model is fully loaded, so
`/v1/health/ready` can return `503` during model download or initialization."_ NEXUS startsekvens
för en lokal provider måste därför pola `/v1/health/ready`, inte `/v1/health/live`, och
behandla 503 som "laddar" snarare än "död".

---

## 3. Rate limits och kreditmodell

**Ärligt svar: det kunde inte beläggas.** Jag sökte igenom allt hämtat material efter `rate limit`,
`requests per minute`, `RPM`, `credit` och `tokens per`. Träffar i dokumentation: **noll**.

Vad hämtat material faktiskt säger, ordagrant:

* `developer.nvidia.com/nim`: _"Get free access to NIM API endpoints for **unlimited prototyping**,
  powered by DGX Cloud. Your membership to the NVIDIA Developer Program enables NVIDIA-hosted
  NIM APIs and containers for development and testing (FAQ)."_
* `build.nvidia.com/explore/discover` (katalogkort): `Free serverless APIs for development`,
  `Free Endpoint`, `Downloadable / Free Endpoint`.

Alltså: dokumentationen marknadsför gratistillträde men publicerar inget tal på
förfrågningar per minut, inget tak för tokens, och ingen kreditbudget på den nivå jag kunde nå
utan inloggning. Ordet "unlimited prototyping" står i direkt kontrast till vad användare
rapporterar, vilket är en varningsflagga i sig — marknadsföringstext är inte en SLA.

**Ekonomisk modell, verifierad:** värd-NIM via API Catalog är gratis att prototypa med ("Free
Endpoint"), medan produktionsdrift med support och API-stabilitet hör till **NVIDIA AI Enterprise**
(_"When ready for production, get the assurance of security, API stability, and support that comes
with NVIDIA AI Enterprise"_). En fri 90-dagars utvärderingslicens finns att begära. Det är den
endast dokumenterade kommersiella tröskeln, och NEXUS behöver inte passera den.

**Ej officiell, av community rapporterad siffra.** Sökningen gav NVIDIA-forumtrådar där användare
referar till en standardgräns på **40 RPM** på gratistjänsten, och sekundärt material som nämner
ca 1 000 inferenskrediter:

* https://forums.developer.nvidia.com/t/api-rate-limit-increase-for-nvidia-nim/366043
* https://forums.developer.nvidia.com/t/request-for-nvidia-nim-api-rate-limit-increase-40-to-200-rpm/374542
* https://forums.developer.nvidia.com/t/api-credit-rate-limit-increase-request-for-build-nvidia-com-free-tier/382934

Jag klassificerar dessa som **obelagda**, av två skäl: de är communityinlägg och inte produkt-
dokumentation, och forumtrådarna bekräftar dessutom att gränsen är dynamisk — ett citat ur ett av
inläggen: _"This usually involves a rate limit that is dependent on model, use-case and the amount
of current overall traffic using the same access."_

**Konsekvens för NEXUS-IDE, och den enda hållbara designen:** koda inga fasta gränsvärden.
Provider-lagret ska

1. läsa och respektera `Retry-After` samt alla `X-RateLimit-*`-headers om sådana förekommer i
   svaret (ingen sån header syntes i den mätta 200-responsen på `/v1/models`),
2. tillämpa exponential backoff med jitter mot 429/5xx,
3. hålla en klientsidig token-bucket med ett **anpassningsbart** RPM-värde i inställningarna,
   defaultat lågt och dokumenterat som "uppskattning, ej officiellt",
4. se till att fel-410 (pensionerad modell) tolkas som "modellen finns inte längre", inte som
   överföringsfel — se 2.2.

Att sätta taket för lågt är billigt; att kasta bort användarens kvot i en agent-loop som
skickar tio samtidiga anrop är dyrt. Agentkärnans parallellisering måste därför vara
kvotmedveten från början.

---

## 4. Köra NIM lokalt på egen GPU

### 4.1 De verkliga kommandona (ordantligt ur NIM Quickstart)

Modell-specifik NIM (hämtar modellen vid första start):

```bash
export NIM_LLM_IMAGE=nvcr.io/nim/meta/llama-3.1-8b-instruct:2.0.13

docker run --gpus=all \
  -e NGC_API_KEY=$NGC_API_KEY \
  -v "$LOCAL_NIM_CACHE:/opt/nim/.cache" \
  -p 8000:8000 \
  ${NIM_LLM_IMAGE}
```

Model-free NIM (godtycklig modell från Hugging Face, med Namn för servering):

```bash
export NIM_LLM_MODEL_FREE_IMAGE=nvcr.io/nim/nvidia/model-free-nim:2.0.13

docker run --gpus=all \
  -e NIM_MODEL_PATH=$NIM_MODEL_PATH \
  -e NIM_SERVED_MODEL_NAME="openai/gpt-oss-20b" \
  -e HF_TOKEN=$HF_TOKEN \
  -v "$LOCAL_NIM_CACHE:/opt/nim/.cache" \
  -p 8000:8000 \
  ${NIM_LLM_MODEL_FREE_IMAGE}
```

Tool-calling aktiverat, alltså den form NEXUS agentläge skulle behöva:

```bash
docker run --gpus all \
  -e NIM_MODEL_PATH=hf://meta-llama/Llama-3.1-8B-Instruct \
  -p 8000:8000 \
  ${NIM_LLM_MODEL_FREE_IMAGE}:2.0.13 \
  nim-serve --enable-auto-tool-choice --tool-call-parser llama3_json
```

Sanitet av GPU-åtkomst inuti container, dokumenterat kontrollkommando:

```bash
docker run --rm --runtime=nvidia --gpus all ubuntu nvidia-smi
```

Dokumentationen lägger till två detaljer som spara tid:

> **Note** — The exact image tag varies depending on the container type and backend you intend to
> deploy. Set `${NIM_LLM_IMAGE}` and `${NIM_LLM_MODEL_FREE_IMAGE}` to the vLLM or SGLang image and
> tag for your model and GPU. **Check the Support Matrix for the image and version to use.**

> **Note** — An NGC API key is only required to download Production Branch (PB) models or NIMs
> released prior to NIM LLM and VLM version 2.0.10. PB releases are indicated by the `-pb<version>`
> suffix in the model name (for example, `llama-3.1-8b-instruct-pb6`).

Vid körning blir NIM en OpenAI-kompatibel server på `http://localhost:8000`, vilket redan matchar
repo:ets `.env.example`: `VLLM_BASE_URL=http://127.0.0.1:8000/v1`. NEXUS behöver ingen ny provider
för lokal NIM — samma OpenAI-kodväg räcker, och `/v1/models` på loopback ger det serverade id:t
(_"The `id` field in the response is the model name to use in your requests"_).

### 4.2 Dokumenterade systemkrav (ordantligt ur NIM Prerequisites)

| Krav | Specifikation |
|---|---|
| CPU | AMD64, ARM64 |
| GPU | "Any supported NVIDIA GPU" |
| Operativsystem | "Ubuntu 22.04 LTS or later recommended" |
| Container Toolkit | 1.14.0 or later |
| CUDA SDK | 12.9 or later |
| GPU-drivrutin | 580 or later |
| Docker | 24.0 or later |
| Åtkomst | Gratis NVIDIA Developer Program-medlemskap **eller** NVIDIA AI Enterprise-licens |

Om GPU-minne, ordagrant — och detta är kärnan i hela avsnittet:

> Different models require different minimum amounts of GPU memory. For example, **Llama 3.1 8B
> Instruct requires a minimum of 24GB of GPU memory.**

### 4.3 Vad som egentligen får plats i 10 GB — mätt på den här maskinen

Maskinen mättes med `nvidia-smi`, den antogs inte:

```text
name, memory.total [MiB], driver_version
NVIDIA GeForce RTX 3080, 10240 MiB, 610.88
```

**Drivrutinen är inte problemet.** 610.88 > det dokumenterade kravet 580.

**GPU-minnet är problemet, och det är inte en gråzon.** Det officiella kravet för den minsta
referensmodellen i NIM-dokumentationen är 24 GB. En RTX 3080 har 10 240 MiB = **10 GB**.
NIM:s officiellt verifierade profiler får alltså inte plats. Belägg från Support Matrix:

* `grep -c -i GeForce` över extraherad text från `support-matrix.html` → **0 träffar**. Inte ett enda GeForce-kort förekommer.
* Alla verifierade GPU-namn i hela matrisen, utan dubbletter:
  `NVIDIA-A100-80GB-PCIe`, `NVIDIA-A100-PCIE-40GB`, `NVIDIA-A100-SXM4-40GB`,
  `NVIDIA-A100-SXM4-80GB`, `NVIDIA-A10G`, `NVIDIA-B200`, `NVIDIA-B300-SXM6-AC`, `NVIDIA-GB10`,
  `NVIDIA-GB200`, `NVIDIA-GB300`, `NVIDIA-GB300-WS`, `NVIDIA-GH200-144G-HBM3e`,
  `NVIDIA-GH200-480GB`, `NVIDIA-H100-80GB-HBM3`, `NVIDIA-H100-NVL`, `NVIDIA-H100-PCIe`,
  `NVIDIA-H20-3e`, `NVIDIA-H200`, `NVIDIA-H200-NVL`, `NVIDIA-L40S`,
  `NVIDIA-RTX-PRO-4500-Blackwell-Server-Edition`, `NVIDIA-RTX-PRO-6000-Blackwell-Server-Edition`.
  Det minsta kort som förekommer är `NVIDIA-A10G`. Hämtad dokumentation anger inte
  minnesstorleken på något av korten, så talet om A10G:s 24 GB kommer utanför detta material
  och är en allmänt känd specifikation, inte ett belägg från NVIDIA-sidorna. De enda
  "RTX"-posterna är `RTX-PRO-4500/6000-Blackwell-Server-Edition`, alltså professionella
  serverkort — inte GeForce.
* Frånvaro av GeForce i matrisen är ett **negativt belägg** (att något saknas), inte ett
  uttalande från NVIDIA. Det stöds dock av dokumentationens egen positivrunda siffra: 8B kräver
  24 GB, och RTX 3080 har 10 GB.
* För `nvidia/nemotron-content-safety-reasoning-4b-experimental`, den minsta modellen med en
  verifierad profil, är listan `B200`, `GB200`, `H100-80GB-HBM3`, `H200`. Även en 4B-modell är
  alltså bara validerad på datacenter-kort.
* För störst: `deepseek-v4-pro-0813` har en fallback-profil som kräver _"more than 1,024 GB of
  aggregate GPU memory across eight GPUs"_, och _"disk space is approximately 831 GB"_.

Sammanfattad bedömning för RTX 3080 10 GB:

| modellstorlek | verifierade NIM-kort i Support Matrix (belagt) | ryms i 10 GB? |
|---|---|---|
| 4B | `B200`, `GB200`, `H100-80GB-HBM3`, `H200` | Nej. ~8 GB BF16-vikter är **min beräkning**, inte dokumenterat |
| 7–8B | dokumenterat minimum **24 GB GPU-minne**, ordagrant | **Nej** — uttryckligen omöjligt enligt dokumentationen |
| 12–14B | inte dokumenterat som par | Nej, extrapolerat ur 8B-siffran |
| 20–34B (`openai/gpt-oss-20b` finns i kataloglistan) | `NVIDIA-A10G`, `NVIDIA-L40S` | Nej. A10G är 24 GB — uppgift utanför hämtat material |
| 51–70B | minsta 40 GB-klass i matrisen (`NVIDIA-A100-PCIE-40GB`) | Nej |
| 120B+ | `> 1,024 GB aggregate` för fallback-profilen, ordagrant | Nej |

Endast raden 7–8B och kolumnen "verifierade NIM-kort" är direkt belagda i hämtat material.
De övriga minnesangivelerna är aritmetik eller allmänt känd hårdvaruspec, och är markerade som
det. Slutsatsen påverkas inte: dokumentationens eget enda uttalade minimikrav (24 GB för 8B) ligger
redan över 10 GB.

Aritmetiken bakom kolumnen "ryms i 10 GB" är värd att skriva ut, eftersom den är grunden för
NEXUS lokala modellpolicy: en 8B-modell i BF16 är 8 × 2 byte ≈ 16 GB rena vikter — det stämmer
med dokumentationens 24 GB-minimum när KV-cache och aktiveringar läggs till. Vid 4-bit
kvantisering blir samma modell ≈ 8 × 0.5 = 4 GB vikter, och 5 GB KV+overhead ryms i 10 GB.
Slutsatsen blir: **10 GB räcker väl för 7–8B-modeller i 4-bit — men bara via en runtime som
kan ladda kvantiserade vikter, vilket inte NIM:s verifierade profiler gör.**

### 4.4 Rekommendation för den lokala vägen på denna maskin

Lokal NIM är inte rätt väg för NEXUS på denna hårdvara. Rätt väg, redan dokumenterad och delvis
installerad: **Ollama** (`OLLAMA_BASE_URL=http://127.0.0.1:11434` finns i `.env.example`). Mätt
på maskinen:

```text
which ollama  -> /c/Users/jofin/AppData/Local/Programs/Ollama/ollama
ollama --version -> client version is 0.35.0
                   Warning: could not connect to a running Ollama instance
ollama list   -> Error: Head "http://127.0.0.1:11434/": dial tcp ...actively refused
```

Binäret finns alltså; daemonen körs inte. NEXUS lokala modell-slinga kan starta och stänga den
processen enligt vad `CONVENTIONS.md` redan föreskriver ("Vi startar Ollama och drar en verklig
modell där det är möjligt. Processen vi startar skal vi också stänga").

NIM lokalt blir intressant först om användare skaffar ett kort med ≥24 GB. Dokumentationen
pekar dessutom ut RTX AI PC som en officiell målgrupp för NIM (_"deployed on NVIDIA GPUs anywhere—
from RTX AI PCs, workstations, data centers, or the cloud"_), men Support Matrix validerar alltså
inget GeForce-kort i nuvarande version. Det är en verklig klyfta mellan marknadsföringspromise och
verifierad maskinvarulista, och NEXUS borde rapportera den för användaren i stället för att dölja den.

---

## 5. Docker finns inte på den här maskinen — hela avsnitt 4 är overifierat

Detta måste sägas rakt ut, eftersom det begränsar vad dokumentet faktiskt är värt.

```text
$ which docker
which: no docker in (/c/Users/jofin/.qoder/bin:... )
$ docker --version
/usr/bin/bash: line 1: docker: command not found
```

Innebörden:

* **Inget `docker run`-kommando i avsnitt 4 har körts.** Alla kommandon är avskrivna ordagrant
  från officiell NVIDIA-dokumentation (HTTP 200, hämtat 2026-10-15) men de är **dokumenterade,
  inte verifierade** på denna maskin.
* Avsnitt 4.3 VRAM-analys vilar på dokumentationens egna siffror (24 GB-minimum, verifierade
  GPU-listor) plus en utskriven aritmetik — den är alltså belagd men inte empirisk. Den har inte
  testats genom att starta en container och bli OOM:ad.
* Docker-kravet i avsnitt 4.2 (24.0+, Container Toolkit 1.14+, CUDA SDK 12.9+) är inte uppfyllt
  och kan inte bli uppfyllt på Windows 11 utan extra lager. NVIDIA skriver att
  "Container Toolkit" och "CUDA installation guide **for Linux**" är vägen, och att operativsystem
  utanför Ubuntu inte är officiellt validerat. Praktiskt innebär det NIM på denna maskin kräver
  WSL 2 + Docker Desktop med WSL 2-backend + NVIDIA Container Toolkit inne i WSL-distret.
  WSL finns på maskinen (PATH innehåller `/c/Program Files/WSL`), men den vägen är inte provad här.
* OS: `Microsoft Windows [Version 10.0.26200.9711]` — alltså Windows 11, inte i det dokumenterade
  och validerade supportområdet.

**Rekommendation för FAS 1→FAS 2:** flytta den lokala NIM-slingan ur "kommande milestone" och in i
"dokumenterad, kräver ny hårdvara". Bygg inte NEXUS lokala modellväg på Docker. Bygg den på
Ollama för 10 GB-maskinen, och håll NIM-provider-koden (samma OpenAI-väg, bara annan bas-URL och
port 8000) som en låst men odeparerad backend. Då får användare med ett A10G/H100/RTX PRO 6000
NIM utan extra arbete, utan att NEXUS utveckling någonsin blockeras av att Docker saknas på
utvecklingsmaskinen.

---

## 6. Modellkatalogen: varför fallback-listan i specen måste skrivas om

Detaljer och rådata i [`nvidia_models.json`](./nvidia_models.json). Användarens hand-lista från
specen verifierades id för id mot den levande katalogen (81 poster). Resultat:

| hand-listad id | finns i katalogen? | kommentar |
|---|---|---|
| `meta/llama-3.1-70b-instruct` | **Nej** | finns inte längre. Närmaste: `meta/llama-3.2-90b-vision-instruct`, `nvidia/llama-3.1-nemotron-70b-instruct` |
| `meta/llama-3.3-70b-instruct` | **Nej** | finns inte alls i `/v1/models` (värt att notera: **finns i NIM Support Matrix** som `llama-3.3-70b-instruct`, alltsåbart för lokal container men inte via den där endpointen) |
| `nvidia/llama-3.1-nemotron-70b-instruct` | **Ja** | den enda som stämde |
| `mistralai/mixtral-8x22b-instruct-v0.1` | **Nej** | rätt id är `mistralai/mixtral-8x22b-v0.1` — utan `-instruct` |
| `qwen/qwen2.5-coder-32b-instruct` | **Nej** | det finns **inget** `qwen/*`-id alls i `/v1/models`. `qwen-image` förekommer på katalogsidan men är en text-till-bild-modell |
| `deepseek-ai/deepseek-r1` | **Nej** | `deepseek-ai` har bara `deepseek-coder-6.7b-instruct` och `deepseek-v4.1-flash` |

**1 av 6 stämmer.** Det här är inte en petitess: med fel id ger endpointen HTTP 404 (avsnitt 2.2),
och en agent-loop som ser 404 kan tro att routningen är trasig i stället för att insetta att
modellnamnet är gammalt.

Två åtgärder följer direkt:

1. NEXUS får **inte** hårdkoda standardmodeller. `packages/providers` måste slå upp
   `GET /v1/models` (nyckelfri, 200, mätt) och löpa id:n mot verklighet, med cachning och TTL
   på grund av 410-pensionering.
2. `fallback`-sektionen i `nvidia_models.json` behålls i sin nuvarande form — med
   `existsInCatalog: false` markerat — som bevis och som utgångspunkt för en korrigerad lista.
   Verkliga, verifierade kandidater för NEXUS kod- och resonamangsbukett ur den levande katalogen:
   `nvidia/llama-3.1-nemotron-70b-instruct`, `nvidia/llama-3.1-nemotron-51b-instruct`,
   `mistralai/mixtral-8x22b-v0.1`, `mistralai/codestral-22b-instruct-v0.1`,
   `deepseek-ai/deepseek-coder-6.7b-instruct`, `deepseek-ai/deepseek-v4.1-flash`,
   `ibm/granite-34b-code-instruct`, `meta/codellama-70b`, `google/codegemma-1.1-7b`,
   `bigcode/starcoder2-15b`, `poolside/laguna-xs-2.1`, `openai/gpt-oss-20b`.
   Synliga id för bild-/skärmsyn: `meta/llama-3.2-11b-vision-instruct`,
   `meta/llama-3.2-90b-vision-instruct`, `microsoft/phi-3-vision-128k-instruct`,
   `nvidia/nemotron-3.5-super-vl-120b-a12b`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`.
   Embedding: `nvidia/llama-3.2-nv-embedqa-1b-v1`, `nvidia/nemotron-3-embed-1b`,
   `snowflake/arctic-embed-l`, `nvidia/nv-embedqa-mistral-7b-v2` — **inte** `nv-embedqa-e5-v5`,
   som är 410 GONE sedan 2026-08-25.

---

## 7. Källor

Endast URL:er som faktiskt hämtades och som ligger i `blueprints/raw/`:

| URL | HTTP | metod | fil |
|---|---|---|---|
| https://www.nvidia.com/en-us/solutions/ai/ | 200 | webfetch | `raw/nvidia-solutions-ai.md` |
| https://build.nvidia.com/models | 200 | webfetch | `raw/build-nvidia-models.md` |
| https://build.nvidia.com/settings/api-keys | 200 (curl) / 404 (webfetch) | båda, gated | `raw/nvidia-api-keys.md` |
| https://build.nvidia.com/explore/discover | 200 | curl | `raw/build-nvidia-models.md` (sekundär) |
| https://build.nvidia.com/ | 200 | curl | — (statuskontroll) |
| https://developer.nvidia.com/nim | 200 | webfetch | `raw/nvidia-nim.md` |
| https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html | 200 (redirect-stub) | curl | `raw/nvidia-nim-api-reference.md` |
| https://docs.nvidia.com/nim/large-language-models/latest/reference/api-reference.html | 200 | curl | `raw/nvidia-nim-api-reference.md` |
| .../get-started/index.html | 200 | curl | `raw/nvidia-nim.md` (sekundär) |
| .../get-started/quickstart.html | 200 | curl | `raw/nvidia-nim.md` (sekundär) |
| .../get-started/prerequisites.html | 200 | curl | `raw/nvidia-nim.md`, `raw/nvidia-api-keys.md` |
| .../get-started/installation.html | 200 | curl | hämtad, ej citerad |
| .../reference/support-matrix.html | 200 | curl | grep-belägg i avsnitt 4.3 |
| .../advanced-use-cases/tool-calling-and-mcp.html | 200 | curl | `raw/nvidia-nim.md` (sekundär) |
| .../resources/support-and-faq.html | 200 | curl | avsnitt 2.5 |
| https://integrate.api.nvidia.com/v1/models | 200 | curl | `nvidia_models.json` |
| https://modelcontextprotocol.io/ | 200 | curl | `raw/mcp-spec.md` |
| https://modelcontextprotocol.io/specification/2025-06-18 | 200 | curl | `raw/mcp-spec.md` |
| https://modelcontextprotocol.io/specification/2025-06-18/basic/transports | 200 | webfetch + curl | `raw/mcp-transport-stdio-sse-http.md` |
| https://modelcontextprotocol.io/specification/2026-07-28/basic/transports | 200 | curl | `raw/mcp-transport-stdio-sse-http.md` |
| https://modelcontextprotocol.io/docs/learn/architecture | 200 | curl | `raw/mcp-spec.md` |

Forumtrådarna i avsnitt 3 är länkade där de används och är uttryckligen klassificerade som
obelagd communityinfo, inte som dokumentation.

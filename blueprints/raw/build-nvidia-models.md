---
source: https://build.nvidia.com/models
fetched-at: 2026-10-15T16:06:48Z
fetch-window: 2026-10-15T15:51:00Z/2026-10-15T16:01:00Z
http-status: 200
extraction: webfetch
note: fetched-at is the moment this file was written from the live response; the actual HTTP round-trips happened inside fetch-window.
---

`curl -sL -o /dev/null -w "%{http_code}"` on this URL independently reported **200**.
The page is a client-rendered SPA, so `curl` yields an app shell rather than the catalog
prose; the descriptions below are the text `WebFetch` extracted from the rendered page.

Important scope note for NEXUS: this page is the **full NIM catalogue**, which is much
larger than the machine-readable list `GET https://integrate.api.nvidia.com/v1/models`
returns (81 ids — see `../nvidia_models.json`). Several entries described here (image,
video, audio, biology, simulation and physical-AI models) are **not** reachable through
that OpenAI-compatible text endpoint. Do not assume a model listed on this page can be
called as a chat model.

# NVIDIA API Catalog — model listings (WebFetch extract)

The page lists NVIDIA NIM inference microservices for GPU deployment.
Models include 3D Body Pose, Active Speaker Detection, and Background Noise Removal.

- **bevformer** provides multi-frame bird's-eye-view 3D perception for autonomous driving.
- **Boltz-2** predicts complex structures using Boltz-2.
- **canary-1b-asr** supports speech-to-text recognition and translation in multiple languages.
- **chatterbox-multilingual-tts** generates natural voices in 23 languages for agents.
- **conformer-ctc-asr** transcribes lower case Spanish with record-setting accuracy.
- **cosmos-transfer2.5-2b** generates physics-aware video world states from text prompts.
- **cosmos3-nano** generates images, videos, and action predictions with SynthID watermarking.
- **cosmos3-nano-reasoner** is a vision language model for physical world understanding.
- **cuopt** offers world-record accuracy for complex route optimization.
- **deepseek-v4.1-flash** is a 552B MoE model with native multimodal support.
- **diffdock** predicts the 3D structure of molecule-protein interactions.
- **diffusiongemma-26b-a4b-it** enables parallel token generation for real-time apps.
- **evo2** models integrate information over long genomic sequences.
- **eyecontact** estimates gaze angles and redirects them to be frontal.
- **fidelity, fluent, and simcenter-star-ccm+** run computational-fluid dynamics simulations.
- **FLUX.1-dev** is a state-of-the-art suite of image generation models.
- **FLUX.1-Kontext-dev** enables in-context image generation and editing.
- **FLUX.1-schnell** produces high-quality images at fast speeds.
- **flux.2-klein-4b** is a distilled image generation and editing model.
- **fourcastnet** predicts global atmospheric dynamics of weather variables.
- **gemma-4-31b-it** delivers frontier reasoning for coding and agentic workflows.
- **genmol** performs fragment-based molecular generation by discrete diffusion.
- **glm-5-3** is a 753B-parameter text MoE with sparse attention and FP8 weights.
- **glm-5-3-flash** is a multimodal 320B-total / 18B-active MoE model.
- **gpt-oss-20b** is a smaller MoE text-only LLM for efficient AI reasoning.
- **Kumo Relational** is a foundation model for prediction over structured data.
- **Kumo Tabular** is a tabular in-context learning model for classification.
- **laguna-xs-2.1** is an efficient 33B MoE for local agentic coding tasks.
- **LipSync** generates lip dubbing that syncs lips in video to input audio.
- **llama-3.1-nemoguard** models enhance safety and moderation capabilities of LLMs.
- **llama-3.2 vision-instruct** models excel in high-quality reasoning from images.
- **llama-guard-4-12b** classifies safety for input prompts and output responses.
- **llama-nemotron embed and rerank** models optimize retrieval and scoring.
- **magpie-tts** models generate natural and expressive voices in multiple languages.
- **megatron-1b-nmt** enables smooth global interactions in 36 languages.
- **molmim** performs controlled generation of molecules with specific properties.
- **msa-search** generates multiple sequence alignments from query sequences.
- **muse-glimmer-30b** is a multimodal reasoning model with tool-calling.
- **nemoguard-jailbreak-detect** protects from adversarial attempts.
- **nemoretriever-ocr** extracts text, layout, and structure from images.
- **nemotron-3-embed-1b** is a 1B embedding model for semantic search.
- **nemotron-3 nano omni** understands images, video, speech, and text.
- **nemotron-3 super and ultra** models are hybrid Mamba-Transformer MoEs.
- **nemotron-3.5 content-safety** detects unsafe and toxic content multilingually.
- **nemotron-3.5 lightning** is a fast MoE model for specialized agentic tasks.
- **nemotron-3.5 super vl** is an early-access reasoning model for multimodal workloads.
- **nemotron-asr-streaming** provides real-time speech recognition for English.
- **nemotron graphic elements and page elements** detect charts and tables.
- **nemotron-ocr v1 and v2** perform robust optical character recognition.
- **nemotron-parse** retrieves text and metadata from images.
- **nemotron-table-structure** detects charts, tables, and titles in documents.
- **nemotron-voicechat** is Nemotron 3 Voicechat.
- **openfold2** predicts protein 3D structures from amino acid sequences.
- **openfold3** predicts 3D structures of molecular complexes like proteins and DNA.
- **paddleocr** extracts table text and bounding boxes from images.
- **paligemma** comprehends text and visual inputs to produce informative responses.
- **parakeet ASR** models offer high accuracy for transcription in various languages.
- **proteinmpnn** predicts amino acid sequences for protein backbones.
- **qwen-image** is a text-to-image foundation model with multilingual rendering.
- **qwen-image-edit** handles multilingual text editing with subject consistency.
- **Relighting** re-illuminates people in video to match target lighting.
- **rfdiffusion** is a generative model of protein backbones for binder design.
- **riva-translate** models enable smooth global interactions in 36-37 languages.
- **spectre-x** runs large-scale electronics and chip design verification simulations.
- **stable-diffusion-3.5-large** is a popular text-to-image generation model.
- **Step 5 Preview** is a ~600B-total multimodal MoE with 1M context.
- **streampetr** offers efficient 3D object detection for autonomous driving.
- **Studio Voice** enhances low-quality speech to studio quality.
- **synthetic-video-detector** detects AI-generated synthetic videos.
- **TRELLIS** generates high-quality 3D assets from text or image inputs.
- **Video Super Resolution** upscales encoded or ST 2110 video to higher resolutions.

---

## SECONDARY SOURCE (same catalogue, server-rendered slice)

---
source: https://build.nvidia.com/explore/discover
fetched-at: 2026-10-15T16:12:41Z
http-status: 200
extraction: curl
---

532,380 bytes of HTML, 3,773 characters of extracted text. This is the slice that matters
commercially for NEXUS: every hosted entry is labelled **Free Endpoint**. No numeric rate
limit and no credit figure appears anywhere in the fetched HTML.

Extract, trimmed to the relevant block (the raw extract interleaves `NVIDIA` vendor tags
and nav items between the cards):

```text
## Discover

Discover

ExploreDiscover

WorkstationsRun on RTXRun on SparkRun on Station

ModelsReasoningVisionVisual DesignRetrievalSpeechPredictive AIBiologySimulationClimate & WeatherSafety & Moderation

IndustriesAutomotiveFinancial ServicesHealthcareIndustrialRobotics

## Start Building with your DGX Spark

Explore step-by-step playbooks, including setting up NemoClaw, your secure personal AI
agent. Start Now

## Featured Models

 View All
The leading open models built by the community, optimized and accelerated by NVIDIA's
enterprise-ready inference runtime.

### nemotron-3.5-super-vl-120b-a12b
Nemotron 3.5 Super early-access reasoning model for agentic, coding, tool-calling, and
multimodal workloads

### nemotron-3.5-lightning-30b-a3b
Fastest 30B A3B MoE model with leading domain accuracy for specialized agentic tasks
```

The extracted catalogue cards carry the labels `Free Endpoint` and
`Downloadable / Free Endpoint` (lines 133 and 147–173 of the extract). "Downloadable" is
the marker for a NIM that can also be self-hosted — the property NEXUS's local-model story
depends on.


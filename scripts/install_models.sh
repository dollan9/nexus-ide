#!/usr/bin/env bash
# scripts/install_models.sh — FAS 3.3: hämta lämpliga LOKALA modeller via Ollama.
# VRAM detekteras automatiskt och modellen skalas ner därefter (R5: aldrig krasch, bara lägre kvalitet).
# Kör om den: redan hämtade modeller hoppas över (ollama pull är idempotent, och vi kollar /api/tags först).
set -uo pipefail
export OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_NUM_PARALLEL=1
cd "$(dirname "$0")/.."

OLLAMA_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
say() { printf '\033[1;36m==\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mXX\033[0m %s\n' "$*"; }

# --- 1. Ollama finns? -----------------------------------------------------
if ! command -v ollama >/dev/null 2>&1; then
  fail "Ollama är inte installerad. Windows: winget install Ollama.Ollama   |  macOS/Linux: curl -fsSL https://ollama.com/install.sh | sh"
  exit 1
fi

# --- 2. Servern svarar? ---------------------------------------------------
if ! curl -s -m 3 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
  say "Ollama-demonen svarar inte — startar den i bakgrunden (PID-loggad, stopas av stop_ai_service.sh / nedan)"
  nohup ollama serve > .nexus/pids/ollama.log 2>&1 &
  echo $! > .nexus/pids/ollama.pid
  for _ in $(seq 1 30); do curl -s -m 2 "$OLLAMA_URL/api/tags" >/dev/null 2>&1 && break; sleep 2; done
fi
if ! curl -s -m 3 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
  fail "Kunde inte nå Ollama på $OLLAMA_URL efter 60 s."
  exit 1
fi

# --- 3. VRAM → modellstorlek ---------------------------------------------
VRAM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')
if [ -z "${VRAM_MB:-}" ]; then
  warn "Hittade ingen NVIDIA-GPU via nvidia-smi — kör utan GPU-acceleration."
  VRAM_MB=0
fi
# Regel 7: total budget för LADDADE modeller är 6 GB, och bara EN modell i taget.
# Stora modeller kräver uttrycklig opt-in (NEXUS_BIG_MODELS=1) — annars är valet det som inte kraschar.
if [ "${NEXUS_BIG_MODELS:-0}" = "1" ] && [ "$VRAM_MB" -ge 20000 ]; then CHAT="qwen3:14b"; CODE="qwen2.5-coder:7b"; VIS=""
elif [ "${NEXUS_BIG_MODELS:-0}" = "1" ] && [ "$VRAM_MB" -ge 12000 ]; then CHAT="qwen3:8b"; CODE="qwen2.5-coder:1.5b"; VIS=""
elif [ "$VRAM_MB" -ge  8000 ]; then CHAT="qwen2.5-coder:1.5b"; CODE="qwen2.5-coder:1.5b"; VIS=""
elif [ "$VRAM_MB" -ge  6000 ]; then CHAT="qwen2.5-coder:1.5b"; CODE="qwen2.5-coder:1.5b"; VIS=""
else                                  CHAT="qwen2.5-coder:1.5b"; CODE="qwen2.5-coder:1.5b"; VIS=""
fi
EMBED="all-minilm"

say "GPU VRAM: ${VRAM_MB} MiB  →  chat=$CHAT  autocomplete=$CODE  vision=${VIS:-ingen}  embeddings=$EMBED"

have() { curl -s -m 5 "$OLLAMA_URL/api/tags" | grep -q "\"name\":\"$1" ; }
pull() {
  local m="$1"
  if have "$m"; then say "finns redan: $m"; return 0; fi
  say "hämtar $m …"
  if ! ollama pull "$m"; then
    warn "misslyckades att hämta $m (retry 1)"
    sleep 3
    ollama pull "$m" || { fail "$m gick inte att hämta — hoppar över den"; return 1; }
  fi
}

# --- 4. Hämta -------------------------------------------------------------
FAILED=""
pull "$CHAT"    || FAILED="$FAILED $CHAT"
pull "$CODE"    || FAILED="$FAILED $CODE"
pull "$EMBED"   || FAILED="$FAILED $EMBED"
if [ -n "${VIS:-}" ]; then warn "vision avstängd av Regel 7 (NEXUS_BIG_MODELS=1 för att aktivera)"; pull "$VIS" || FAILED="$FAILED $VIS"; else warn "hoppar över vision-modell (för lite VRAM) — vision får OCR-vägen"; fi

# --- 5. Verifiera varje modell med ett riktigt anrop (FAS 0.4: bevisa, anta inte) ---
verify_chat() {
  curl -s -m 120 "$OLLAMA_URL/api/chat" -d "{\"model\":\"$1\",\"messages\":[{\"role\":\"user\",\"content\":\"Svara med exakt: NEXUS OK\"}],\"stream\":false}" \
    | grep -q "NEXUS OK" && say "chat-modell svarar: $1" || warn "chat-modell $1 gav inte förväntat svar"
}
verify_embed() {
  local dim; dim=$(curl -s -m 60 "$OLLAMA_URL/api/embed" -d "{\"model\":\"$1\",\"input\":\"test\"}" | tr -cd '[-,' | awk -F',' '{print NF}')
  [ "${dim:-0}" -gt 5 ] && say "embeddings svarar: $1" || warn "embeddings $1 gav ingen vektor"
}
verify_chat "$CHAT"
verify_embed "$EMBED"

say "Lokala modeller nu:"; curl -s -m 5 "$OLLAMA_URL/api/tags" | python -c "import sys,json;[print('   ',m['name'], round(m.get('size',0)/1e9,2),'GB') for m in json.load(sys.stdin)['models']]" 2>/dev/null

if [ -n "$FAILED" ]; then
  warn "Utelämnade modeller:$FAILED — appen fungerar ändå (degradering till det som finns), se ARCHITECTURE.md avsnitt 8"
  exit 2
fi
say "KLART. Sätt i .env: CHAT_MODEL=$CHAT, AUTOCOMPLETE_MODEL=$CODE, EMBEDDINGS_MODEL=$EMBED, VISION_MODEL=${VIS:-}"
say "Kom ihåg: vill du inte ha Ollama kvar i bakgrunden — bash scripts/stop_ollama.sh"

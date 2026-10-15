#!/usr/bin/env bash
# scripts/setup.sh — FAS 0.3: installera det som saknas, verifiera med versionskommando (0.4),
# retry 3 ggr med backoff och sedan alternativ metod (R4). Idempotent: kör om det när som helst.
#
# Säkerhetsregel: inga irreversibla systemärenden utan att säga till. Det här skriptet installerar
# bara verktyg i användarens egen profil (npm globals, venv, Ollama-modeller) — aldrig system-wide
# och aldrig med admin-krav. Det som kräver admin (Docker, corepack som skrivit i Program Files)
# rapporteras som hopp-over i stället för att fuska.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/AppData/Roaming/npm:$PATH"

OK=0; MISS=0; SKIP=0
say()  { printf '\033[1;36m==\033[0m %s\n' "$*"; }
good() { printf '\033[1;32mOK\033[0m  %s\n' "$*"; OK=$((OK+1)); }
bad()  { printf '\033[1;31mFR\033[0m  %s\n' "$*"; MISS=$((MISS+1)); }
skp()  { printf '\033[1;33m--\033[0m %s\n' "$*"; SKIP=$((SKIP+1)); }

retry() { # försök  backoff-kommando …
  local n=1 max=$1; shift
  until "$@"; do
    if [ $n -ge $max ]; then return 1; fi
    say "  misslyckades (försök $n/$max) — backoff $((n*3)) s och nytt försök"; sleep $((n*3)); n=$((n+1))
  done; return 0
}

# --- 1. Verktyg som Redan finns: verifiera, Installera inte ------------------------------------
for t in git node npm python ffmpeg curl; do
  if command -v $t >/dev/null 2>&1; then good "$t → $($t --version 2>&1 | head -1)"; else bad "$t saknas"; fi
done

# --- 2. pnpm (via npm global i användarprofilen, ingen admin) ---------------------------------
if command -v pnpm >/dev/null 2>&1; then
  good "pnpm → $(pnpm --version)"
else
  say "installerar pnpm i användarprofilen (npm -g, ingen admin)"
  if retry 3 npm install -g pnpm@10; then good "pnpm → $(pnpm --version)"; else bad "pnpm kunde inte installeras"; fi
fi

# --- 3. ripgrep: PATH är INTE ett krav (core hittar den annars) ---------------------------------
if command -v rg >/dev/null 2>&1; then good "rg → $(rg --version | head -1)"
else skp "rg finns inte på PATH — WorkspaceService.search använder RG_PATH/NEXUS_RG_PATH eller JS-fallback (testat båda)"
fi

# --- 4. Docker (valfritt i FAS 0.3) -------------------------------------------------------------
if command -v docker >/dev/null 2>&1; then good "docker → $(docker --version)"
else skp "docker saknas — lokal NVIDIA NIM är dokumenterad i blueprints/NVIDIA_INTEGRATION.md men inte körbar här"
fi

# --- 5. Ollama (lokala modeller) ---------------------------------------------------------------
if command -v ollama >/dev/null 2>&1; then
  good "ollama → $(ollama --version 2>&1 | tail -1)"
  if curl -s -m 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then good "Ollama-demonen svarar på :11434"
  else skp "Ollama-demonen svarar inte — kör: ollama serve  (eller bash scripts/install_models.sh som startar och stoppar den åt dig)"
  fi
else
  skp "ollama saknas — på Windows: winget install Ollama.Ollama (du kör det, jag installerar inte system-wide utan att be om lov)"
fi

# --- 6. Python-miljön för ai-service (P1) -------------------------------------------------------
if [ -d apps/ai-service/.venv ]; then good "ai-service .venv finns"; else skp "ai-service .venv saknas — krävs bara för röst/vision (P1): bash scripts/setup_ai_service.sh"; fi

# --- 7. Node-beroenden --------------------------------------------------------------------------
if [ -d node_modules ] && [ -d node_modules/electron ]; then good "node_modules installerad (electron finns)"
else say "kör pnpm install"; if retry 3 pnpm install; then good "pnpm install klar"; else bad "pnpm install misslyckades"; fi
fi

# --- 8. .env -----------------------------------------------------------------------------------
if [ -f .env ]; then good ".env finns (nycklar stannar här)"; else cp .env.example .env && say "skapa .env från .env.example — fyll i dina nycklar"; fi

# --- 9. Miljöns faktiska resurser -------------------------------------------------------------
say "maskin:"
powershell.exe -NoProfile -Command "\$os=Get-CimInstance Win32_OperatingSystem; Write-Output ('  RAM total '+[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB,1)+' GB, fri '+[math]::Round(\$os.FreePhysicalMemory/1MB,1)+' GB')" 2>/dev/null | tail -1
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | sed 's/^/  GPU /' || skp "ingen NVIDIA-GPU funnen"
df -h . 2>/dev/null | tail -1 | awk '{print "  disk tillgänglig här: "$4}'

printf '\n\033[1m=== FAS 0.4 ===\033[0m  OK: %s  saknas: %s  hoppat över (valfritt): %s\n' "$OK" "$MISS" "$SKIP"
if [ "$MISS" -gt 0 ]; then
  say "Gör så här för det som saknas och kör om skriptet. Appen startar ändå med det som finns (R5)."
  exit 1
fi
say "Allt obligatoriskt finns. Nästa steg: bash scripts/install_models.sh  och  pnpm build && pnpm start"

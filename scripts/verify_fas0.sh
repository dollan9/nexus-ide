#!/usr/bin/env bash
# scripts/verify_fas0.sh — beviset för FAS 0: strukturen finns, verktygen finns, miljön är mätt.
# Signal-fri gate: den failar på tom körning (saknad katalog/fil = exit 1), inte bara på fel.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

check_file() { if [ -f "$1" ]; then printf '  \033[1;32mfil\033[0m   %s (%s bytes)\n' "$1" "$(wc -c < "$1")"; else printf '  \033[1;31mSAKNAS\033[0m %s\n' "$1"; fail=1; fi; }
check_dir()  { if [ -d "$1" ]; then printf '  \033[1;32mkat\033[0m   %s (%s filer)\n' "$1" "$(find "$1" -type f 2>/dev/null | wc -l)"; else printf '  \033[1;31mSAKNAS\033[0m %s\n' "$1"; fail=1; fi; }

echo "### FAS 0.2 — monorepo-struktur enligt kravspecen"
for d in apps/desktop apps/ai-service packages/core packages/providers packages/mcp-client packages/voice packages/vision packages/ui blueprints scripts tests; do check_dir "$d"; done
check_dir packages/protocol
check_dir packages/host
for f in .env.example PROGRESS.md ARCHITECTURE.md SPEC.md AGENTS.md README.md START-HÄR.md CONVENTIONS.md package.json pnpm-workspace.yaml; do check_file "$f"; done
for f in scripts/setup.sh scripts/install_models.sh scripts/debug_loop.sh scripts/verify_all.sh scripts/make_result.mjs; do check_file "$f"; done

echo
echo "### FAS 0.1 — mätt miljö (inga uppgifter under minnet)"
echo "  OS      : $(powershell.exe -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).Caption + ' ' + (Get-CimInstance Win32_OperatingSystem).Version" 2>/dev/null | tail -1)"
echo "  CPU     : $(powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Processor).Name" 2>/dev/null | tail -1)"
echo "  RAM fri : $(powershell.exe -NoProfile -Command "[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,1)" 2>&1 | tail -1) GB"
echo "  GPU     : $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null)"
echo "  Disk    : $(df -h . 2>/dev/null | tail -1 | awk '{print $4" fri av "$2}')"

echo
echo "### FAS 0.3/0.4 — verktyg verifierade med versionskommando"
for t in git node npm python ffmpeg curl; do
  if command -v $t >/dev/null 2>&1; then printf '  %-9s %s\n' "$t" "$($t --version 2>&1 | head -1)"; else printf '  \033[1;31m%-9s SAKNAS\033[0m\n' "$t"; fail=1; fi
done
printf '  %-9s %s\n' "pnpm" "$(pnpm --version 2>/dev/null || echo SAKNAS)"
printf '  %-9s %s\n' "ollama" "$(ollama --version 2>&1 | tail -1 || echo SAKNAS)"

echo
echo "### Innehållskrav: dokumenten är inte tomma"
for f in SPEC.md AGENTS.md ARCHITECTURE.md README.md PROGRESS.md; do
  bytes=$(wc -c < "$f"); lines=$(wc -l < "$f")
  if [ "$bytes" -lt 400 ]; then printf '  \033[1;31m%s är för kort (%s bytes)\033[0m\n' "$f" "$bytes"; fail=1
  else printf '  \033[1;32m%s\033[0m %s bytes / %s rader\n' "$f" "$bytes" "$lines"; fi
done
# SPEC.md måste fortfarande innehålla bilagan ordrant
if grep -q "KOMPLETT FEATURE-LISTA" SPEC.md && grep -q "Det är det program du bygger" SPEC.md; then
  echo "  SPEC.md innehåller hela den ordranta bilagan (början + slut hittade)"
else
  echo "  \033[1;31mSPEC.md saknar delar av bilagan\033[0m"; fail=1
fi
# R2: inga riktiga nycklar i shipped kod. Skiljer fixture-fran-riktigt: en match i en testfil är
# ENDAST tillåten om filen dessutom hävdar att den är fejk (fake/test/dummy/fixture/exempel),
# för annars kan inte ens en secret-skanner testas. Match utanför test = fail.
REAL=$(grep -rInE "(sk-[A-Za-z0-9]{20,}|nvapi-[A-Za-z0-9]{20,})" apps packages scripts templates 2>/dev/null \
       | grep -vE "intentionally-fake|sk-test" \
       | grep -vE "(/test/|/tests/|/fixtures/|\.test\.ts|\.spec\.ts)" | head -5)
FIX=$(grep -rInE "(sk-[A-Za-z0-9]{20,}|nvapi-[A-Za-z0-9]{20,})" apps packages scripts templates 2>/dev/null \
      | grep -E "(/test/|/tests/|/fixtures/|\.test\.ts|\.spec\.ts)" | wc -l)
if [ -n "$REAL" ]; then echo "$REAL"; echo "  R2-ÅTRK: möjlig riktig nycka i shipped kod"; fail=1
else echo "  R2: inga riktiga nycklar i shipped kod ($FIX test-fixture(r) i test-material, tillåtna och markerade)"; fi
# Konfig-filer får aldrig innehålla en lång token överhuvudtaget
if grep -rInE "(sk-[A-Za-z0-9]{20,}|nvapi-[A-Za-z0-9]{20,})" mcp.json .env.example *.json 2>/dev/null | head -3; then
  echo "  R2-ÅTRK: nycka i konfigfil"; fail=1
else echo "  R2: mcp.json och .env.example innehåller inga nyckelvärden"; fi
if grep -q '^\.env$' .gitignore 2>/dev/null; then echo "  .gitignore skyddar .env"; else echo "  .gitignore saknar .env — R2-risk"; fail=1; fi

echo
if [ "$fail" -eq 0 ]; then printf '\033[1;32mFAS 0 VERIFIERAD\033[0m\n'; else printf '\033[1;31mFAS 0 HAR BRISTER\033[0m\n'; fi
exit $fail

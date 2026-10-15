#!/usr/bin/env bash
# scripts/verify_no_secrets.sh — R2-beviset, EN gång implementerat, kallat från alla gate:er.
# Skiljer test-fixture från riktig nycka: en match i test-material är tillåten bara om den är
# markerad som fejk; en match i shipped kod eller i en konfigfil är ett fail.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
SECRET_RE='(sk-[A-Za-z0-9]{20,}|nvapi-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})'
TESTPATH='(/test/|/tests/|\.test\.ts|\.spec\.ts|/fixtures/|/e2e/)'
FAKE='(intentionally-fake|sk-test|Sup3r|dummy|example|exempel|fixture|fake|Test)'

REAL=$(grep -rInE "$SECRET_RE" apps packages scripts templates 2>/dev/null | grep -vE "$TESTPATH" | head -8)
CFG=$(grep -rInE "$SECRET_RE" mcp.json .env.example *.json 2>/dev/null | head -5)
FIX=$(grep -rInE "$SECRET_RE" apps packages scripts templates 2>/dev/null | grep -E "$TESTPATH" | wc -l)
UNMARKED=$(grep -rInE "$SECRET_RE" apps packages scripts templates 2>/dev/null | grep -E "$TESTPATH" | grep -vE "$FAKE" | head -5)
ENVTRACKED=$(grep -c '^\.env$' .gitignore 2>/dev/null || echo 0)

if [ -n "$REAL" ]; then printf '  \033[1;31mRIKTIG NYCKEL I SHIPPED KOD:\033[0m\n%s\n' "$REAL"; fail=1
else printf '  \033[1;32mR2\033[0m shipped kod (apps/packages/scripts/templates) är fri från nyckelvärden\n'; fi

if [ -n "$CFG" ]; then printf '  \033[1;31mNYCKA I KONFIGFIL:\033[0m\n%s\n' "$CFG"; fail=1
else printf '  \033[1;32mR2\033[0m mcp.json/.env.example/*.json innehåller inga hemligheter\n'; fi

if [ -n "$UNMARKED" ]; then printf '  \033[1;31mFIXTURE UTAN FEJK-MARKÖR:\033[0m\n%s\n' "$UNMARKED"; fail=1
else printf '  \033[1;32mR2\033[0m %s test-fixture(r), alla explicit markerade som fejk\n' "$FIX"; fi

if [ "$ENVTRACKED" -ge 1 ] 2>/dev/null; then printf '  \033[1;32mR2\033[0m .gitignore skyddar .env\n'
else printf '  \033[1;31mR2\033[0m .env är inte ignorerad — risk att en nyckel committas\n'; fail=1; fi

# Hemligheter får aldrig ens kunna reacha renderer: preload får inte exportera process.env
if grep -rnE "process\.env" apps/desktop/src/preload* 2>/dev/null | grep -vE "^\s*\*|NODE_ENV" | head -3; then
  printf '  \033[1;31mpreload läcker process.env till renderer\033[0m\n'; fail=1
else printf '  \033[1;32mR2\033[0m preload exponerar inte process.env\n'; fi

[ "$fail" -eq 0 ] && printf '\033[1;32mR2 GOD\033[0m\n' || printf '\033[1;31mR2 FEL\033[0m\n'
exit $fail

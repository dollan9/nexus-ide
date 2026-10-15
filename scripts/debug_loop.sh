#!/usr/bin/env bash
# scripts/debug_loop.sh — FAS 8.1: den självläkande slingans motor.
#
# Vad den gör: kör en kommando-sekvens, extraher Fel-signatur, logga iteration, stoppa vid grönt,
# och flagga när SAMMA felreturnerat 5 gånger (då är det tid att byta strategi, inte att bulla mer).
# Den fixar inte koden av sig själv — rotorsak hittar en människa/agent. Den ser bara till att
# slingan har minne och ett tak, så vi inte loopar 200 gånger på samma idé.
#
# Användning:  bash scripts/debug_loop.sh                # bygg + enhetstester + e2e
#             bash scripts/debug_loop.sh "pnpm --filter @nexus/host test"
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/AppData/Roaming/npm:$PATH"

MAX_ITER="${MAX_ITER:-50}"
STATE=.nexus/debug-loop.state
LOG=debug-loop.log
mkdir -p .nexus
touch "$LOG"

if [ $# -gt 0 ]; then CMDS=("$@"); else CMDS=("pnpm -r build" "pnpm -r test" "pnpm e2e"); fi

iter=0
[ -f "$STATE" ] && iter=$(cat "$STATE")

sig() { # normalisera fel till en jämförbar signatur (tar bort tidsstämplar, siffror, sökvägar)
  grep -hiE "error|fail|✗|×|cannot|not found|timeout|expected" "$1" 2>/dev/null \
    | sed -E 's/[0-9]+//g; s#\\\\[^ ]*/##g; s/^\s+//; s/\s+$//' | sort -u | head -12 | md5sum | cut -c1-12
}

for ((i=0; i<MAX_ITER; i++)); do
  iter=$((iter+1)); echo "$iter" > "$STATE"
  RUNLOG=$(mktemp); echo "==== iteration $iter  $(date -u +%FT%TZ) ====" >> "$LOG"
  all_ok=1
  for c in "${CMDS[@]}"; do
    echo "  kör: $c"
    if timeout 1500 bash -c "$c" > "$RUNLOG.tmp" 2>&1; then
      tail -3 "$RUNLOG.tmp" | sed 's/^/    /'; cat "$RUNLOG.tmp" >> "$RUNLOG"
    else
      all_ok=0; cat "$RUNLOG.tmp" >> "$RUNLOG"
      { echo "  FEL i: $c"; tail -40 "$RUNLOG.tmp"; } >> "$LOG"
      break
    fi
    rm -f "$RUNLOG.tmp"
  done
  rm -f "$RUNLOG.tmp"

  if [ "$all_ok" -eq 1 ]; then
    echo "GRÖNT efter $iter iteration(er). Signatur nollställd." | tee -a "$LOG"
    echo 0 > "$STATE"; rm -f "$RUNLOG" .nexus/last-sig
    node scripts/make_result.mjs >> "$LOG" 2>&1 || true
    exit 0
  fi

  S=$(sig "$RUNLOG"); echo "$S" > .nexus/last-sig
  COUNT=$(grep -c "$S" .nexus/sigs 2>/dev/null || echo 0)
  echo "$S" >> .nexus/sigs
  COUNT=$((COUNT+1))
  printf '  fel-signatur %s (förekommit %s ggr)\n' "$S" "$COUNT" | tee -a "$LOG"
  if [ "$COUNT" -ge 5 ]; then
    { echo "=== SAMMA FEL 5 GÅNGAR — BYT STRATEGI (MAX_ITER nått för denna signatur) ==="
      grep -B2 -A12 "$S" "$LOG" | tail -40; } | tee -a "$LOG"
    rm -f "$RUNLOG"
    exit 3
  fi
  rm -f "$RUNLOG"
  sleep 2
done
echo "Nådde MAX_ITER=$MAX_ITER utan grön sling." | tee -a "$LOG"
exit 2

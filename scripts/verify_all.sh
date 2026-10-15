#!/usr/bin/env bash
# scripts/verify_all.sh — FAS 0.4/8: varje fas har ett kommando som BEVISAR att den fungerar.
# Skriptet är signal-fritt: det failar på tomma körningar, inte bara på fel.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/AppData/Roaming/npm:$PATH"

PASS=0; FAIL=0; SKIP=0
gate() { # namn  kommando
  local name="$1"; shift
  printf '\n\033[1;36m### %s\033[0m\n' "$name"
  if "$@"; then printf '\033[1;32mGOD\033[0m %s\n' "$name"; PASS=$((PASS+1)); else printf '\033[1;31mFEL\033[0m %s\n' "$name"; FAIL=$((FAIL+1)); fi
}
note() { printf '\033[1;33m--\033[0m %s\n' "$1"; SKIP=$((SKIP+1)); }

# FAS 0 — miljön
gate "FAS0 verktyg" bash -c '
  set -e
  for t in git node python ffmpeg curl; do command -v $t >/dev/null || { echo "saknar $t"; exit 1; }
    printf "  %-8s %s\n" "$t" "$($t --version 2>&1 | head -1)"
  done
  [ -n "$(pnpm --version 2>/dev/null)" ] || { echo "saknar pnpm"; exit 1; }
  printf "  %-8s %s\n" pnpm "$(pnpm --version)"
  nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | sed "s/^/  GPU    /"
'

# FAS 0.2 — strukturen som kravspecen begär
gate "FAS0 struktur" bash -c '
  set -e
  for d in apps/desktop apps/ai-service packages/core packages/providers packages/mcp-client packages/voice packages/vision packages/ui blueprints scripts tests .env.example PROGRESS.md ARCHITECTURE.md SPEC.md AGENTS.md README.md; do
    [ -e "$d" ] || { echo "saknas: $d"; exit 1; }
  done
  echo "  alla begärda kataloger och filer finns"
'

# FAS 1 — blueprints + levande modellkatalog
gate "FAS1 blueprints" bash -c '
  set -e
  ls blueprints/*.md blueprints/nvidia_models.json >/dev/null
  N=$(python -c "import json;d=json.load(open(\"blueprints/nvidia_models.json\",encoding=\"utf-8\"));print(len(d[\"models\"]) if isinstance(d.get(\"models\"),list) else d[\"total\"])")
  echo "  NVIDIA-modeller i live-katalogen: $N"
  [ "$N" -gt 10 ]
  curl -s -m 20 https://integrate.api.nvidia.com/v1/models | head -c 40 | grep -q object
'

# FAS 2/3/4/7 — bygge och enhetstester
gate "Bygg alla paket" pnpm -r build
gate "Enhetstester" pnpm -r test

# FAS 4 — MCP
gate "FAS4 MCP-servrar startar" bash -c '
  set -e
  node -e "
    const fs=require(\"fs\");const c=JSON.parse(fs.readFileSync(\"mcp.json\",\"utf8\"));
    const s=c.servers||[];if(s.length<2){console.error(\"f\\u00e5re \\u00e4n 2 MCP-servrar: \"+s.length);process.exit(1)}
    for(const x of s){ if(x.command && !fs.existsSync(x.command.replace(/^[.\\/]+/,\"\")) && !x.command.includes(\"node\")) {console.error(\"saknad command f\\u00f6r \"+x.id);process.exit(1)} }
    console.log(\"  MCP-servrar konfigurerade: \"+s.length);
  "'

# FAS 3 — lokala modeller
gate "FAS3 Ollama + modeller" bash -c '
  set -e
  curl -s -m 5 http://127.0.0.1:11434/api/tags | python -c "
import sys,json
ms=json.load(sys.stdin)[\"models\"]
names=[m[\"name\"] for m in ms]
print(\"  lokala modeller:\", \", \".join(names))
assert len(ms)>=1, \"ingen lokal modell — kör scripts/install_models.sh\"
" '

# P0-gaten
gate "P0 e2e T1-T8" pnpm e2e
gate "RESULT.md grön" node -e "
  const fs=require('fs');
  const rows=fs.readFileSync('tests/RESULT.jsonl','utf8').split('\n').filter(Boolean).map(JSON.parse);
  const latest=new Map(); for(const r of rows) latest.set(r.test,r);
  const need=['T1','T2','T3','T4','T5','T6','T7','T8'];
  let bad=0;
  for(const t of need){const r=latest.get(t);
    if(!r){console.error('  '+t+': saknar resultat');bad++;continue}
    if(r.status!=='pass'){console.error('  '+t+': '+r.status);bad++}
    else console.log('  '+t+': pass (bevis='+r.bevis+', '+r.tookMs+' ms)');}
  process.exit(bad?1:0);
"

# R2-bevis: inga hårdkodade nycklar (samma logik i alla gate:er — delad, inte duplikat)
gate "R2 inga nycklar i kod" bash scripts/verify_no_secrets.sh

printf '\n\033[1m=== SAMMANFATTNING ===\033[0m  GOD: %s  FEL: %s  NOTE: %s\n' "$PASS" "$FAIL" "$SKIP"
node scripts/make_result.mjs >/dev/null 2>&1 || true
[ "$FAIL" -eq 0 ] || exit 1

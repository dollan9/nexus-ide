#!/usr/bin/env bash
# scripts/stop_ollama.sh — stänger Ollama-processen SOM DETTA PROJEKT STARTADE.
# Användaren vill inte ha kvarlämnade bakgrundstjänster: den egna demonen dödas,
# men en Ollama som användaren redan hade igång rör vi inte.
set -uo pipefail
cd "$(dirname "$0")/.."
PIDF=.nexus/pids/ollama.pid

if [ ! -f "$PIDF" ]; then
  echo "Inget PID-fil — projektet startade ingen Ollama. (Procesen som kanske körs är din egen.)"
  pgrep -a ollama 2>/dev/null || tasklist 2>/dev/null | grep -i ollama || true
  exit 0
fi

PID=$(cat "$PIDF")
if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
  echo "Stänger Ollama som startades av NEXUS (PID $PID) …"
  taskkill //PID "$PID" //T //F 2>/dev/null || kill "$PID" 2>/dev/null || true
  sleep 1
fi
# efterlevande kontroller
if curl -s -m 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "Kvarvarande lyssnare på 11434 — listar processer:"
  powershell.exe -NoProfile -Command "Get-Process ollama -ErrorAction SilentlyContinue | Select-Object Id,ProcessName | Format-Table -AutoSize" 2>&1 | tail -6
  echo "(Vi dödar inte en demon vi inte startade. Kör sjalv: taskkill //IM ollama.exe //F om du vill.)"
  exit 2
fi
rm -f "$PIDF"
echo "Ollama är avstängd och port 11434 svarar inte. Inga kvarlämnade processer fr\\u00e5n projektet."

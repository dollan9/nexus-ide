# MCP-server-mall (Python, FastMCP-stil)

En komplett, körbar startpunkt för egna MCP-servrar i Python. `server.py`
innehåller fyra verktyg: `nexus_demo`, `add_numbers`, `server_info` och
`write_note` (det sista är markerat som godkännandekrävande).

## Köra

```bash
cd templates/mcp-server-py
python -m venv .venv
.venv/Scripts/activate          # Windows
source .venv/bin/activate       # macOS/Linux
pip install -r requirements.txt
python server.py                # pratar MCP på stdio
```

Det finns ingen Docker på den här arbetsmaskinen, så kärl-varianten är inte
aktuell — mallen kör direkt på den lokala Python-installationen.

## Verifierad status (viktigt för ärligheten)

**Ja, den här mallen kördes verkligen på arbetsmaskinen** och inte bara skrevs:

* Python `3.11.9` (lokal), `.venv` med `mcp==2.3.0` (pinnen i `requirements.txt`)
* NEXUS egen klient (`@nexus/mcp-client`, McpServerManager) anslöt via stdio,
  `tools/list` returnerade de fyra verktygen och `tools/call` svarade med riktig
  `structuredContent`: `{"ok":true,"sum":42}`, `{"ok":true,"greeting":"HEJ PYTHON FRÅN NEXUS-TEMPLATE-PY",...}`
* `write_note` skapade en fil inuti `NEXUS_NOTES_DIR` och vägrade utanför den
* efter `stopAll()` var Python-pid:t borta (kontrollerat med `tasklist`)

`.venv` finns Redan i den här mappen (87 MB, gitignored). Uppdatera med
`pip install -r requirements.txt` om du vill ha en nyare SDK.

## mcp 1.x vs 2.x

I `mcp` 2.x bytte `FastMCP` namn till `MCPServer`
(`mcp.server.mcpserver`). Samma dekorator-yta (`@server.tool(name=...,
description=..., annotations=..., meta=...)`). `server.py` importerar den som
finns, så den fungerar med både 2.x och en `mcp<2`-pin. `meta:` stöds bara i 2.x
— därför filtreras argumentet via `tool_kwargs()`/`inspect.signature` om du kör 1.x.

## Registrera i NEXUS-IDE

LÄgg till i `mcp.json` (eller via UI:t). Utan `.env`-variabeln fallerar
upplösningen mjukt — klienten utesluter nyckeln och servern startar ändå:

```json
{
  "id": "min-py-server",
  "label": "Min Python-server",
  "transport": "stdio",
  "command": "C:/Users/<den>/AppData/Local/Programs/Python/Python311/python.exe",
  "args": ["${NEXUS_REPO_ROOT}/templates/mcp-server-py/server.py"],
  "env": { "NEXUS_NOTES_DIR": "${NEXUS_WORKSPACE_ROOT}", "MIN_API_KEY": "${MIN_API_KEY}" },
  "enabled": true
}
```

Använd en absolut Python-sökväg (venvens `python.exe`) så att NEXUS inte måste
leta i PATH. Kontrollera utan att starta något: `node scripts/setup_mcp.mjs --check`.

## Regler som gäller för alla servrar

1. Logga på `stderr` — `stdout` är upptagen av JSON-RPC.
2. Sätt `annotations={"readOnlyHint": True}` på allt som inte skriver.
3. Farliga verktyg: `annotations={"destructiveHint": True}` och
   `meta={"requiresApproval": True, "riskLevel": "high"}` — NEXUS visar en
   godkännandeförfrågan innan anropet går ut.
4. Returtypen blir outputSchema i `structuredContent`. Använd `dict[str, Any]`
   om du returnerar blandade typer (annars tvingas `True` till `1`).
5. Hemliga nycklar: `os.environ`, aldrig i källkoden och aldrig i `mcp.json`.

# MCP-server-mall (TypeScript)

En komplett, körbar startpunkt för **egna** MCP-servrar i NEXUS-IDE. Paketet är en
del av pnpm-workspacet (`pnpm-workspace.yaml`) och är avsiktligt **inte** `private`,
så att du kan `pnpm pack`-a det eller publicera det till en egen registry.

## Köra

```bash
cd templates/mcp-server-ts
pnpm i
pnpm build          # tsc -> dist/index.js (CommonJS)
node dist/index.js  # pratar MCP på stdio och väntar på föräldern
```

Servern svarar på `initialize`, `tools/list` och `tools/call` via
`@modelcontextprotocol/sdk`. Två demo-verktyg finns där från start:

| Verktyg       | Argument                | Annotation | Beskrivning |
| ------------- | ----------------------- | ---------- | ----------- |
| `nexus_demo`  | `name?`, `shout?`       | read-only  | Hälsning + tidsstämpel i `structuredContent`. |
| `add_numbers` | `a`, `b` (båda krävda)  | read-only  | Summerar tal. Exemplifierar validering. |

## Registrera i NEXUS-IDE

Lägg in posten i `mcp.json` (använd UI:et under Inställningar → MCP, eller redigera
filen). Variablerna `${NODE_EXECUTABLE}`, `${NEXUS_REPO_ROOT}` och
`${NEXUS_WORKSPACE_ROOT}` löses upp av klienten utan att vara hemliga:

```json
{
  "id": "min-server",
  "label": "Min egen server",
  "transport": "stdio",
  "command": "${NODE_EXECUTABLE}",
  "args": ["${NEXUS_REPO_ROOT}/templates/mcp-server-ts/dist/index.js"],
  "enabled": true
}
```

Kontrollera utan att starta något:

```bash
node scripts/setup_mcp.mjs --check
```

## Egna verktyg

1. Registrera med `server.registerTool(namn, { description, inputSchema, annotations, _meta }, handler)`.
2. Svara med `content` (text för människor) **och** `structuredContent` (för agenten).
3. Fel i verktyget: returnera `{ content: [{ type: "text", text: "varför" }], isError: true }` —
   kasta inte, då tappar klienten bara anropet.
4. Sätt `annotations.readOnlyHint: true` för allt som inte skriver. Sätt
   `_meta.requiresApproval: true` för farliga åtgärder — NEXUS visar det som en
   godkännandeförfrågan innan anropet går ut.
5. Skriv **alltid** logg till `stderr`. `stdout` är reserverad för JSON-RPC.

## Hemligheter

En API-nyckel hör **aldrig** hemma i `mcp.json` eller i koden. Sätt den i `.env`
och referera den som `${MIN_API_KEY}` i `env`/`headers`. Klienten löser upp
variabeln när servern startas och vägrar skriva ut ett nyckelliknande värde till disk.

## Avslut

När NEXUS stänger av dig stängs din stdin — mallen fångar `end`/`close` samt
`SIGTERM`/`SIGINT` och anropar `process.exit(0)`. Inga kvarvarande processer.
Samma logik finns i `scripts/mcp-servers/nexus_mcp_lib.mjs` för våra produktservern.

## Python

Vill du hellre skriva servern i Python: se [`templates/mcp-server-py`](../mcp-server-py/README.md)
(FastMCP, `requirements.txt`). Docker finns inte på den här maskinen och Python-sökvägen
är dokumenterad men inte verifierad hitills.

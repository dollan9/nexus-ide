/**
 * DEFAULT_MCP_SERVERS — standardkonfigurationen som skrivs i `mcp.json` (FAS 4.2/4.3).
 *
 * Alla sökvägar och all miljö ges som `${VAR}`: filen får aldrig innehålla en
 * nyckel och den ska inte vara maskinspecifik. Variabler som inte är hemliga
 * (NODE_EXECUTABLE, NEXUS_REPO_ROOT, NEXUS_WORKSPACE_ROOT) löses upp av
 * McpConfigStore självt, så filen fungerar ur askan på vilken maskin som helst.
 *
 * `nexus-filesystem` är VÅR EGEN server (scripts/mcp-servers/nexus-filesystem.mjs) —
 * den är standard eftersom den kräver varken nätverk eller npx-cache och därför
 * fungerar offline och i CI. Den officiella @modelcontextprotocol/server-filesystem
 * ligger med som femte, avstängda, post: `nexus-filesystem-official`. Den är
 * verifierad på den här maskinen (14 verktyg via npx) men behöver npm-registret,
 * så den är ett val för användaren, inte ett beroende i testsviten.
 */

import type { McpServerConfig } from "@nexus/protocol";

const SCRIPTS = "${NEXUS_REPO_ROOT}/scripts/mcp-servers";

export const DEFAULT_MCP_SERVERS: readonly McpServerConfig[] = [
  {
    id: "nexus-filesystem",
    label: "Filer — NEXUS egen server (offline, jail + godkännande för skrivning)",
    transport: "stdio",
    command: "${NODE_EXECUTABLE}",
    args: [`${SCRIPTS}/nexus-filesystem.mjs`, "--root", "${NEXUS_WORKSPACE_ROOT}"],
    enabled: true,
    builtin: true,
  },
  {
    id: "nexus-git",
    label: "Git — status, diff, log, show, grenar, stage, commit",
    transport: "stdio",
    command: "${NODE_EXECUTABLE}",
    args: [`${SCRIPTS}/nexus-git.mjs`, "--repo", "${NEXUS_WORKSPACE_ROOT}"],
    enabled: true,
    builtin: true,
  },
  {
    id: "nexus-terminal",
    label: "Terminal — kör skalkommandon (farliga kommandon kräver godkännande)",
    transport: "stdio",
    command: "${NODE_EXECUTABLE}",
    args: [`${SCRIPTS}/nexus-terminal.mjs`, "--root", "${NEXUS_WORKSPACE_ROOT}"],
    enabled: true,
    builtin: true,
  },
  {
    id: "nexus-web",
    label: "Web — hämta URL utan nyckel (search_web kräver BRAVE_API_KEY i .env)",
    transport: "stdio",
    command: "${NODE_EXECUTABLE}",
    args: [`${SCRIPTS}/nexus-web.mjs`],
    env: { BRAVE_API_KEY: "${BRAVE_API_KEY}" },
    enabled: true,
    builtin: true,
  },
  {
    id: "nexus-filesystem-official",
    label: "Filer — officiella @modelcontextprotocol/server-filesystem (valfri, kräver nätverk)",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "${NEXUS_WORKSPACE_ROOT}"],
    enabled: false,
    builtin: true,
  },
];

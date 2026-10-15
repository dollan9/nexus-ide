/**
 * Egna typer för @nexus/mcp-client (FAS 4).
 *
 * Protokolltyperna kommer från @nexus/protocol — de läcker vi aldrig ut eller
 * duplicerar. Hit lägger vi bara det MCP-laget behöver UTAN att ändra kontraktet:
 * rikare verktygsmetadata (godkännande/destruktivitet) som UI:t och agentkärnan
 * kan läsa, medan `listTools()` ändå returnerar de renodlade `McpToolInfo[]`:na.
 */

import type {
  EventTable,
  JsonSchema,
  McpServerConfig,
  McpServerInfo,
  McpToolInfo,
  McpTransport,
} from "@nexus/protocol";

/** Eventnames klienten sänder, typed mot EventTable så payloaden inte kan drifta. */
export type McpEventName = "mcp/changed" | "mcp/log";

export type McpEventPayload<N extends McpEventName> = EventTable[N];

export type McpEventHandler<N extends McpEventName> = (payload: McpEventPayload<N>) => void;

/**
 * Verktyg i registret: McpToolInfo plus säkerhetsmetadata från serverns
 * annotations/_meta. `requiresApproval` kommer från `_meta.requiresApproval`
 * (våra egna servrar) eller att annotationen är destruktiv.
 */
export interface McpRegisteredTool extends McpToolInfo {
  readonly qualifiedName: string;
  readonly requiresApproval: boolean;
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly openWorld: boolean;
  readonly title?: string;
  readonly risk: "low" | "medium" | "high";
}

/** Rå verktygsdefinition som en server rapporterar den (tools/list). */
export interface McpToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations?: {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
  readonly _meta?: Record<string, unknown>;
}

/** Upplöst config (interpolation utförd) — det som faktiskt spawnas/bestas. */
export interface ResolvedServer {
  readonly id: string;
  readonly transport: McpTransport;
  readonly command?: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly cwd?: string;
  readonly url?: string;
  readonly headers: Record<string, string>;
  /**
   * Miljövariabler som `${NAMN}` refererade till i command/args/url/cwd men som
   * saknades. DÖDLIGT: servern kan inte startas och får status "error".
   */
  readonly missing: string[];
  /**
   * Saknade variabler i `env`/`headers`. INTE dödligt: nyckeln utesluts och
   * servern degraderar (t.ex. search_web utan BRAVE_API_KEY) — CONVENTIONS R5.
   */
  readonly missingOptional: string[];
}

/** Konfigurationsfel — fångas alltid, aldrig en rå krasch till UI:t (CONVENTIONS R5). */
export class McpConfigError extends Error {
  readonly issues: readonly string[];
  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "McpConfigError";
    this.issues = issues;
  }
}

/** Svar från de UI-vända muteringarna: aldrig förstörande vid fel. */
export interface McpStoreMutationResult {
  readonly ok: boolean;
  readonly servers: readonly McpServerConfig[];
  readonly changed: boolean;
  readonly error?: string;
  readonly issues?: readonly string[];
}

/** Callback som manager använder för att skicka events vidare (host → renderer). */
export type McpEventSink = <N extends McpEventName>(name: N, payload: McpEventPayload<N>) => void;

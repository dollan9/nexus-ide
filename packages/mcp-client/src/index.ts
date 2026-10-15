/**
 * @nexus/mcp-client — NEXUS-IDE:s MCP-lager (FAS 4).
 *
 * Publikt API (allts via paketets `main`, aldrig djupa sokvagar):
 *   McpConfigStore   las/skriv av mcp.json med ${ENV}-interpolation och sekretess
 *   McpServerManager alla servrar, dynamisk namespace-registry, events, stopAll
 *   McpConnection    en forbindelse per server (stdio | sse | streamable http)
 *
 * Host (FAS 7) bygger en manager i main-processen, prenumererar pa mcp/changed och
 * mcp/log och vidarebefodrar till renderer. SDK-typer lakas ALDRIG ut harifran —
 * allt som lämnas lagret är @nexus/protocol-typer eller vara egna.
 */

export const PACKAGE_NAME = "@nexus/mcp-client";

export {
  McpConfigStore,
  validateServerConfig,
  looksLikeSecret,
  parseDotEnv,
  interpolateString,
  findRepoRoot,
  normalizeServer,
} from "./config_store";
export type { McpConfigDocument, McpConfigStoreOptions } from "./config_store";

export {
  McpConnection,
  McpTimeoutError,
  DEFAULT_TIMEOUTS,
  withTimeout,
  killProcessTreeWin32,
  isPidAlive,
  waitForPidExit,
  makeToolResult,
} from "./mcp_connection";
export type { McpCallOutcome, McpConnectionHooks, McpTimeoutOptions, McpTransportKind } from "./mcp_connection";

export { McpServerManager, toRegistered } from "./server_manager";
export type { McpServerManagerOptions } from "./server_manager";

export { DEFAULT_MCP_SERVERS } from "./defaults";
export { ensureDefaultConfig } from "./setup";
export type { EnsureDefaultsResult } from "./setup";

export { McpConfigError } from "./types";
export type {
  McpEventName,
  McpEventHandler,
  McpEventPayload,
  McpEventSink,
  McpRegisteredTool,
  McpStoreMutationResult,
  McpToolDefinition,
  ResolvedServer,
} from "./types";

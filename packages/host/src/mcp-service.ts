/**
 * mcp-service.ts — godkännande-bridge runt @nexus/mcp-client (FAS 4.4 + 7.2).
 *
 * MCP-laget i sig isolerar fel och returnerar ALLTID ett McpToolResult. Det som
 * saknas dar är godkännandet: ett verktyg som skriver pa disk eller kör ett
 * kommando maste ga genom ApprovalBroker innan det narn processen (AGENTS.regel 5).
 * Därför ligger detta lagret i host — den enda platsen där bägge känner till
 * varandra — och anvands bade av mcp.tools.call (UI) och av agent-bryggan.
 *
 * Avslag ger ett valformulerat ok:false med ApprovalDenied-text, aldrig ett kast
 * och aldrig en hangande loop (brokerens timeout nekar).
 */

import { ErrorCode, type McpServerInfo, type McpToolInfo, type McpToolResult, type McpServerConfig } from "@nexus/protocol";
import type { ApprovalBroker, Logger } from "@nexus/core";
import type { McpRegisteredTool, McpServerManager } from "@nexus/mcp-client";
import type { EventBus } from "./events";

export interface McpServiceOptions {
  readonly manager: McpServerManager;
  readonly approvals: ApprovalBroker;
  readonly logger: Logger;
  readonly events: EventBus;
  /** Serverns riskmetadata är grunden; detta ger den sista försäkringsskiktet. */
  readonly enforceApprovals?: boolean;
}

export class McpService {
  constructor(private readonly options: McpServiceOptions) {}

  get manager(): McpServerManager {
    return this.options.manager;
  }

  listServers(): McpServerInfo[] {
    return this.options.manager.listServers();
  }

  listTools(): McpToolInfo[] {
    return this.options.manager.listTools();
  }

  toolInfo(qualifiedName: string): McpRegisteredTool | undefined {
    return this.options.manager.getTool(qualifiedName);
  }

  activeTools(): number {
    return this.options.manager.activeToolCount();
  }

  /**
   * Ett verktygansrop genom godkännandelagret. readOnly verktyg gar alltid
   * direkt — det är serverns egen annotationsflagga, inte var gissning.
   */
  async callTool(qualifiedName: string, args: unknown, meta?: { runId?: string }): Promise<McpToolResult> {
    const tool = this.options.manager.getTool(qualifiedName);
    if (tool === undefined) {
      return { ok: false, text: "", tookMs: 0, error: `verktyg finns inte: ${qualifiedName} (ToolNotFound)` };
    }
    const needsApproval = this.options.enforceApprovals === true && !tool.readOnly;
    if (needsApproval) {
      const outcome = await this.options.approvals.request({
        runId: meta?.runId ?? "mcp",
        kind: "mcp-tool",
        title: `Kör MCP-verktyg ${qualifiedName}`,
        args,
        risk: tool.risk,
      });
      if (outcome.decision === "deny") {
        this.options.logger.warn("MCP-verktyg nekades", { fas: "4.4", tool: qualifiedName, code: ErrorCode.ApprovalDenied });
        return {
          ok: false,
          text: "",
          tookMs: 0,
          error: `Godkännande nekades (ApprovalDenied): ${qualifiedName} kördes inte.`,
          structured: { approval: "denied", requiresApproval: true },
        };
      }
    }
    const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
    // `approved: true` här betyder "användaren har sagt ja" (eller att verktyget är
    // läsande) — managerns egen enforceApprovals är ett separat, frivilligt lager.
    const result = await this.options.manager.callTool(qualifiedName, record, { approved: true });
    this.options.events.emitLoose("mcp/log", { serverId: tool.serverId, line: `tools/call ${tool.localName} → ${result.ok ? "ok" : `fel: ${result.error ?? "okänt"}`}` });
    return result;
  }

  /** Starta alla aktiva servrar — används vid boot bara om autostart är påslaget. */
  async startAll(): Promise<McpServerInfo[]> {
    return this.options.manager.startAll();
  }

  async start(id: string): Promise<McpServerInfo> {
    return this.options.manager.start(id);
  }

  async stop(id: string): Promise<boolean> {
    return this.options.manager.stop(id);
  }

  async upsert(server: McpServerConfig): Promise<McpServerInfo> {
    return this.options.manager.upsert(server);
  }

  async remove(id: string): Promise<{ ok: boolean; error?: string }> {
    return this.options.manager.remove(id);
  }

  async reload(): Promise<{ servers: McpServerInfo[]; activeTools: number }> {
    return this.options.manager.reload();
  }

  async stopAll(): Promise<void> {
    await this.options.manager.stopAll();
  }
}

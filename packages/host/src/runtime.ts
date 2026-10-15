/**
 * runtime.ts — den sammankopplade host:en som alla handlers far arbeta emot.
 *
 * createHost() bygger denna exakt en gang. Allt som en metod behover ar har —
 * ingen handler importerar nagot lagret direkt, och ingen handler hall egen
 * state utom over sina egna service-objekt. Det ar den enda aningen varfor
 * dispatch(), WebSocket-bran och Electron-IPC:n kan vara samma kod.
 */

import type { ConfigStore, CheckpointManager, Logger, MemoryLog, WorkspaceService } from "@nexus/core";
import type { ProviderRegistry } from "@nexus/providers";
import type { ServiceProbe } from "@nexus/protocol";
import type { ProviderRegistry as _ProviderRegistry } from "@nexus/providers";
import type { VramProbe } from "./vram";
import type { AgentService } from "./agent-service";
import type { ChatService } from "./chat-service";
import type { EventBus } from "./events";
import type { McpService } from "./mcp-service";
import type { ModelGateway } from "./gateway";
import type { RagService } from "./rag";
import type { TerminalService } from "./terminal-service";
import type { ApprovalBroker } from "@nexus/core";
import type { CheckpointSource } from "./write-gate";

export interface AiProbeSource {
  health(): Promise<ServiceProbe>;
}

/**
 * Host lyfter fram ApprovalBroker:an med en enda extra metod — att satta en
 * frisk allowlist fran settings.set. Sjala allowlist-faltet ar privat i core, sa
 * varden (createHost) implementerar satta-metoden utan att ra pa nagot core-falte.
 * Allt annat ar oforandrat ApprovalBroker-beteende.
 */
export interface ApprovalGateway extends ApprovalBroker {
  setAllowlist(list: readonly string[]): void;
}

export interface HostRuntime {
  readonly root: string;
  readonly workspaceRoot: string;
  readonly nexusDir: string;
  readonly aiBaseUrl: string;
  readonly startedAt: number;
  readonly logger: Logger;
  readonly events: EventBus;
  readonly config: ConfigStore;
  readonly workspace: WorkspaceService;
  readonly checkpoints: CheckpointManager;
  readonly approvals: ApprovalGateway;
  readonly terminals: TerminalService;
  readonly providers: ProviderRegistry;
  readonly gateway: ModelGateway;
  readonly mcp: McpService;
  readonly rag: RagService;
  readonly memory: MemoryLog;
  readonly chat: ChatService;
  readonly agent: AgentService;
  readonly ai: AiProbeSource;
  readonly vram: VramProbe;
  /** Kalla till checkpoint-kallan for varje skrivning (write-gate). */
  readonly checkpointSourceFor: (kind: CheckpointSource) => "agent" | "user" | "ai-edit" | "terminal";
}

export type { _ProviderRegistry };

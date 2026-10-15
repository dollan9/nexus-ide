/**
 * agent-service.ts — körregister runt @nexus/core AgentKernel (FAS 7.1).
 *
 * AgentKernel äger ReAct-slingan (plan → act → observe → reflect) och producerar
 * redan alla agent/events. Host tillför det kärnan inte kan veta:
 *   - runId till anroparen OMEDELBART (agent.run svarar {runId}, resten kommer pä bussen)
 *   - AbortController per körning sa agent.interrupt faktiskt avbryter provider-förfrágan
 *   - de namespacade MCP-verktygen (via ModelGateway-bryggan) — kärnan bygger bara CORE_TOOLS
 *   - lastRun-lagringen (agent.lastRun ska kunna returnera en verklig AgentRunResult)
 *
 * runId: kärnan genererar sitt eget id överst i run(), före sin första await, och
 * skriver det pa ctx.runId (dokumenterat i core/API.md). Vi läser det direkt efter
 * anropet — och har dessutom en event-capture som fallback om implementationen
 * förändras. Avbrott fungerar i vilket fall eftersom ctx.signal är vår controller.
 */

import { randomUUID } from "node:crypto";
import { ErrorCode, type AgentMode, type AgentRunResult, type EventName } from "@nexus/protocol";
import { AgentKernel, type AgentToolContext, type RagToolkit } from "@nexus/core";
import type { Logger } from "@nexus/core";
import type { EventBus } from "./events";
import type { ModelGateway } from "./gateway";
import type { McpService } from "./mcp-service";
import type { RagService } from "./rag";
import { HostError } from "./errors";
import type { ApprovalBroker, CheckpointManager, TerminalManager, WorkspaceService } from "@nexus/core";

interface Running {
  readonly runId: string;
  readonly controller: AbortController;
  readonly started: number;
  kernel: AgentKernel | null;
  settled: boolean;
}

export interface AgentServiceOptions {
  readonly workspace: WorkspaceService;
  readonly checkpoints: CheckpointManager;
  readonly terminals: TerminalManager;
  readonly approvals: ApprovalBroker;
  readonly gateway: ModelGateway;
  readonly mcp: McpService;
  readonly rag: RagService;
  readonly logger: Logger;
  readonly events: EventBus;
  readonly defaultMode: () => AgentMode;
  readonly defaultMaxSteps: () => number;
  readonly lastRunCapacity?: number;
}

export class AgentService {
  private readonly running = new Map<string, Running>();
  private readonly finished = new Map<string, AgentRunResult>();
  private readonly capacity: number;
  /** Fallback-fångst av runId fran den forsta eventet som bär ett. */
  private capturedRunId: string | undefined;

  constructor(private readonly options: AgentServiceOptions) {
    this.capacity = options.lastRunCapacity ?? 40;
  }

  get isRunning(): boolean {
    return [...this.running.values()].some((entry) => !entry.settled);
  }

  get activeRunIds(): string[] {
    return [...this.running.entries()].filter(([, entry]) => !entry.settled).map(([id]) => id);
  }

  lastRun(runId: string): AgentRunResult | null {
    return this.finished.get(runId) ?? null;
  }

  get history(): AgentRunResult[] {
    return [...this.finished.values()];
  }

  /**
   * Startar en körning. Returnerar runId direkt; kärnan loopar i bakgrunden och
   * sander agent/plan, agent/step, agent/tool_call, agent/tool_result,
   * agent/checkpoint, agent/diff, agent/done och agent/error pa samma buss som
   * allt annat.
   */
  run(params: { goal: string; mode?: AgentMode; paths?: string[]; maxSteps?: number }): { runId: string } {
    const goal = params.goal.trim();
    if (goal.length === 0) throw HostError.invalidParams("agent.run behöver ett mål (goal).");

    const controller = new AbortController();
    const mode = params.mode ?? this.options.defaultMode();
    this.capturedRunId = undefined;

    const emit = (name: EventName, payload: unknown): void => {
      this.options.events.emitLoose(name, payload);
      const record = payload as { runId?: unknown };
      if (typeof record?.runId === "string" && this.capturedRunId === undefined) this.capturedRunId = record.runId;
    };

    const ragToolkit: RagToolkit = { search: (query, k) => this.options.rag.search(query, k) };

    const ctx: AgentToolContext = {
      workspace: this.options.workspace,
      checkpoints: this.options.checkpoints,
      terminals: this.options.terminals,
      approvals: this.options.approvals,
      providers: this.options.gateway,
      mcp: {
        listTools: async () => this.options.mcp.listTools(),
        callTool: async (name, args) => this.options.mcp.callTool(name, args, { runId: this.capturedRunId ?? "agent" }),
      },
      rag: ragToolkit,
      logger: this.options.logger,
      emit,
      mode,
      signal: controller.signal,
    };

    const kernel = new AgentKernel(ctx);
    const maxSteps = params.maxSteps && params.maxSteps > 0 ? params.maxSteps : this.options.defaultMaxSteps();

    // Kjarnans run() är synkron fram till sitt första await och sätter ctx.runId
    // dessforan — vi läser id:t direkt efter anropet, utan att vänta.
    const promise = kernel.run(goal, { mode, ...(params.paths !== undefined ? { paths: params.paths } : {}), maxSteps });
    const runId = ctx.runId ?? this.capturedRunId ?? randomUUID();
    const entry: Running = { runId, controller, started: Date.now(), kernel, settled: false };
    this.running.set(runId, entry);

    void promise
      .then((result) => {
        this.remember(result);
        this.options.logger.info("Agentkörning avslutad", {
          fas: "7.1",
          runId,
          ok: result.ok,
          steps: result.steps.length,
          filesChanged: result.filesChanged.length,
          tookMs: result.tookMs,
        });
      })
      .catch((err: unknown) => {
        // Kärnan kastar aldrig (R5) — fångar ändå, sa att en framtida regression
        // aldrig blir en ohandterad rejection som tyst sänker host-processen.
        const message = err instanceof Error ? err.message : String(err);
        this.options.logger.error("Agentkörning kastade oväntat", { fas: "7.1", runId, error: message });
        this.options.events.emit("agent/error", { runId, message, code: ErrorCode.Internal });
        this.remember({
          runId,
          ok: false,
          summary: `Agenten avbröts: ${message}`,
          filesChanged: [],
          steps: [],
          toolCalls: [],
          checkpoints: [],
          tookMs: Date.now() - entry.started,
        });
      })
      .finally(() => {
        entry.settled = true;
        this.running.delete(runId);
      });

    return { runId };
  }

  /** Avbryt en körning — abort-signalen går in i provider-fetchen, ingen halvfärdig fil. */
  interrupt(runId: string): boolean {
    const entry = this.running.get(runId);
    if (entry === undefined) {
      if (this.finished.has(runId)) return false;
      throw new HostError(ErrorCode.BadRequest, `Okänd eller redan avslutad körning: ${runId}`);
    }
    entry.kernel?.interrupt(runId);
    entry.controller.abort();
    this.options.logger.info("agent.interrupt begärd", { fas: "7.1", runId });
    return true;
  }

  private remember(result: AgentRunResult): void {
    this.finished.set(result.runId, result);
    while (this.finished.size > this.capacity) {
      const oldest = this.finished.keys().next();
      if (oldest.done === true) break;
      this.finished.delete(oldest.value);
    }
  }

  /** Avsluta allt — kallas fran host.close(). */
  abortAll(): void {
    for (const entry of this.running.values()) {
      entry.kernel?.interrupt(entry.runId);
      entry.controller.abort();
    }
    this.running.clear();
  }
}

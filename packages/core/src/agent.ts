/**
 * agent.ts — AgentKernel (FAS 7.1): plan → act → observe → reflect ReAct-loop.
 *
 * Real verktygsanropsprotokoll: skicka tools-schema, tolka returnerade tool_calls,
 * exekvera, mata tillbaka resultat, loopa tills modellen slutar eller maxSteps nar.
 * Emitterar agent/plan + agent/step + agent/tool_call + agent/tool_result +
 * agent/checkpoint + agent/diff + agent/done/agent/error per steg.
 * AbortSignal/interrupt() mitten i floden. [Debug]-, [Eyes]-, [Ask]-lagen.
 * Pa NoModelAvailable returneras ok:false med mansklig — ALDRIG ett kast.
 */

import { randomUUID } from "node:crypto";
import { CORE_TOOLS, ErrorCode, type AgentMode, type AgentRunResult, type AgentStep, type Checkpoint, type ToolCallRecord } from "@nexus/protocol";
import type { AgentToolContext, ProviderChatMessage, ProviderChatToolCall, ProviderChatResponse } from "./toolkits";
import { buildCoreTools, type AgentTool } from "./tools";

function isCheckpointLike(value: unknown): value is Checkpoint {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { shadowCommit?: unknown }).shadowCommit === "string" &&
    Array.isArray((value as { files?: unknown }).files)
  );
}

/** AgentStep har readonly-status; vi samlar mutabla utkast och mappar vid finish. */
interface StepDraft {
  index: number;
  title: string;
  status: AgentStep["status"];
  detail?: string;
  tool?: string;
}

function buildSystemPrompt(mode: AgentMode): string {
  const base =
    "Du är NEXUS-agenten. Arbeta i ett workspace med filer och en terminal. " +
    "Använd verktygen för att nå målet. Veta att varje filändring tar en checkpoint som går att återställa.";
  switch (mode) {
    case "ask":
      return base + " LÄGE=FRÅGA: svara och undersök ENDAST med läsande verktyg (read_file, list_dir, search_regex). Skriv eller redigera ALDRIG några filer.";
    case "debug":
      return base + " LÄGE=FELSÖK: följ metoden 1) reproducera 2) hypotes 3) instrumentera 4) riktad fix 5) verifiera. Lappa aldrig bara symtom.";
    case "eyes":
      return base + " LÄGE=ÖGON: efter att du kört något, kör screenshot_analyze och låt beskrivningen styga nästa steg.";
    case "voice":
      return base + " LÄGE=RÖST: målet kan komma från transkriberad tal; bekräfta innan du skriver.";
    default:
      return base + " LÄGE=AGENT: planera, gör en riktad ändring i taget, ta checkpoint och verifiera.";
  }
}

export class AgentKernel {
  private readonly ctx: AgentToolContext;
  private readonly controllers: Map<string, AbortController> = new Map();

  constructor(ctx: AgentToolContext) {
    this.ctx = ctx;
  }

  interrupt(runId: string): void {
    this.controllers.get(runId)?.abort();
  }

  async run(goal: string, opts?: { mode?: AgentMode; paths?: string[]; maxSteps?: number }): Promise<AgentRunResult> {
    const started = Date.now();
    const runId = randomUUID();
    const mode: AgentMode = opts?.mode ?? this.ctx.mode;
    const maxSteps = opts?.maxSteps && opts?.maxSteps > 0 ? opts.maxSteps : 12;

    const controller = new AbortController();
    this.controllers.set(runId, controller);
    // Lyssna pa den delade ctx-signalen sa att verten kan avbryta.
    const onAbort = () => controller.abort();
    if (typeof this.ctx.signal.addEventListener === "function") {
      this.ctx.signal.addEventListener("abort", onAbort);
    }

    // Koppla godkännande-emittering + kör-id for verktygen.
    this.ctx.approvals.setEmit(this.ctx.emit);
    this.ctx.runId = runId;

    const tools = buildCoreTools(this.ctx);
    const toolByName = new Map<string, AgentTool>();
    for (const t of tools) toolByName.set(t.name, t);

    const steps: StepDraft[] = [];
    const toolCalls: ToolCallRecord[] = [];
    const filesChanged = new Set<string>();
    const checkpointIds = new Set<string>();
    const collectedCheckpoints: Checkpoint[] = [];

    // Tillganglighet: ingen modell → ok:false, aldrig kast (R5).
    const noModelMsg = "Modell ej igång — starta Ollama eller ange en API-nyckel, försök sedan igen.";
    if (!this.ctx.providers || typeof this.ctx.providers.chat !== "function" || this.ctx.providers.isModelAvailable?.("agent") === false) {
      const result: AgentRunResult = {
        runId,
        ok: false,
        summary: noModelMsg,
        filesChanged: [],
        steps,
        toolCalls,
        checkpoints: [],
        tookMs: Date.now() - started,
      };
      this.ctx.emit("agent/error", { runId, message: noModelMsg, code: ErrorCode.NoModelAvailable });
      this.ctx.emit("agent/done", result);
      this.cleanup(runId, onAbort);
      return result;
    }

    const messages: ProviderChatMessage[] = [
      { role: "system", content: buildSystemPrompt(mode) },
      { role: "user", content: this.composeUserTurn(goal, opts?.paths) },
    ];

    this.ctx.emit("agent/plan", {
      runId,
      steps: [{ index: 0, title: `Plan för: ${goal}`, status: "pending" }],
    });

    let finalText = "";
    let aborted = false;

    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
      if (controller.signal.aborted) {
        aborted = true;
        break;
      }

      let turn: ProviderChatResponse;
      try {
        turn = await this.ctx.providers.chat({
          role: "agent",
          messages,
          tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.schema })),
          signal: controller.signal,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.ctx.emit("agent/error", { runId, message: msg, code: ErrorCode.Internal });
        const result = this.finish(runId, false, `Modellen avbröts: ${msg}`, filesChanged, steps, toolCalls, checkpointIds, started);
        this.ctx.emit("agent/done", result);
        this.cleanup(runId, onAbort);
        return result;
      }

      if (!turn.ok && turn.toolCalls.length === 0 && turn.text.length === 0) {
        // Modell svarade inte alls — hantera som NoModelAvailable utan kast.
        this.ctx.emit("agent/error", { runId, message: noModelMsg, code: ErrorCode.NoModelAvailable });
        const result = this.finish(runId, false, noModelMsg, filesChanged, steps, toolCalls, checkpointIds, started);
        this.ctx.emit("agent/done", result);
        this.cleanup(runId, onAbort);
        return result;
      }

      if (turn.text.length > 0) {
        this.ctx.emit("agent/thought", { runId, text: turn.text });
        this.ctx.emit("agent/token", { runId, text: turn.text });
      }

      const assistantMsg: ProviderChatMessage = {
        role: "assistant",
        content: turn.text,
        toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
      };
      messages.push(assistantMsg);

      const step: StepDraft = {
        index: stepIndex,
        title: turn.toolCalls.length > 0 ? `Kör ${turn.toolCalls.map((c) => c.name).join(", ")}` : turn.text.slice(0, 80) || "Svar",
        status: "running",
        tool: turn.toolCalls[0]?.name,
      };
      steps.push(step);
      this.ctx.emit("agent/step", { runId, index: stepIndex, status: "running", detail: step.title });

      if (turn.toolCalls.length === 0) {
        // Inga verktyg — detta är slutsvaret (reflektera → avsluta).
        step.status = "done";
        finalText = turn.text;
        this.ctx.emit("agent/step", { runId, index: stepIndex, status: "done" });
        break;
      }

      // Avbrott efter att vi fick tool_calls men innan exekvering:
      // utför ALDRIG halva arbetet — lämna filer orörda (no half-written).
      if (controller.signal.aborted) {
        step.status = "skipped";
        aborted = true;
        this.ctx.emit("agent/step", { runId, index: stepIndex, status: "skipped", detail: "Avbruten före exekvering" });
        break;
      }

      for (const call of turn.toolCalls) {
        const record = await this.executeTool(runId, call, toolByName, filesChanged, checkpointIds, collectedCheckpoints, controller.signal);
        toolCalls.push(record);
        messages.push({
          role: "tool",
          content: record.output,
          toolCallId: call.id,
          name: call.name,
        });
        // [Eyes]-läge: efter att ha kört något, ta en skärmbild och mata tillbaka.
        if (mode === "eyes" && (call.name === "run_terminal" || call.name === "git_op") && record.ok) {
          const eyeCall: ProviderChatToolCall = { id: randomUUID(), name: "screenshot_analyze", args: { target: "screen", prompt: "Beskriv vad som visas efter kommandot." } };
          const eyeRecord = await this.executeTool(runId, eyeCall, toolByName, filesChanged, checkpointIds, collectedCheckpoints, controller.signal);
          toolCalls.push(eyeRecord);
          messages.push({ role: "tool", content: eyeRecord.output, toolCallId: eyeCall.id, name: eyeCall.name });
          messages.push({ role: "user", content: `Ögonobservation: ${eyeRecord.output.slice(0, 500)}` });
        }
      }
      step.status = toolCalls.slice(-turn.toolCalls.length).every((r) => r.ok) ? "done" : "failed";
      this.ctx.emit("agent/step", { runId, index: stepIndex, status: step.status });
    }

    if (aborted && finalText.length === 0) {
      finalText = "Åtgärden avbröts användaren. Inga halvfärdiga filer lämnades.";
    }

    const ok = !aborted && toolCalls.every((t) => t.ok);
    const summary = finalText || (ok ? "Klart." : "Avbröts eller misslyckades.");
    const result = this.finish(runId, ok, summary, filesChanged, steps, toolCalls, checkpointIds, started, collectedCheckpoints);
    if (aborted) this.ctx.emit("agent/error", { runId, message: "Agentkörningen avbröts.", code: ErrorCode.BadRequest });
    this.ctx.emit("agent/done", result);
    this.cleanup(runId, onAbort);
    return result;
  }

  private async executeTool(
    runId: string,
    call: ProviderChatToolCall,
    toolByName: Map<string, AgentTool>,
    filesChanged: Set<string>,
    checkpointIds: Set<string>,
    collected: Checkpoint[],
    signal: AbortSignal,
  ): Promise<ToolCallRecord> {
    const started = Date.now();
    this.ctx.emit("agent/tool_call", { runId, callId: call.id, tool: call.name, args: call.args });
    const tool = toolByName.get(call.name);
    let ok = false;
    let output = "";

    if (signal.aborted) {
      ok = false;
      output = "Avbruten innan körning.";
    } else if (!tool) {
      ok = false;
      output = `Okänt verktyg: ${call.name} (ToolNotFound). Tillgängliga: ${CORE_TOOLS.join(", ")}.`;
    } else {
      try {
        const res = await tool.run(call.args);
        ok = res.ok;
        output = res.output;
        const s = res.structured as Record<string, unknown> | undefined;
        if (s) {
          if (typeof s.path === "string" && (call.name === "write_file" || call.name === "edit_file")) filesChanged.add(s.path);
          if (typeof s.preCheckpointId === "string") checkpointIds.add(s.preCheckpointId);
          if (typeof s.checkpointId === "string") checkpointIds.add(s.checkpointId);
          if (isCheckpointLike(s)) {
            checkpointIds.add((s as unknown as Checkpoint).id);
            collected.push(s as unknown as Checkpoint);
          }
        }
      } catch (e) {
        ok = false;
        output = e instanceof Error ? e.message : String(e);
      }
    }

    const tookMs = Date.now() - started;
    this.ctx.emit("agent/tool_result", { runId, callId: call.id, tool: call.name, ok, output: output.slice(0, 8000), tookMs });
    return { callId: call.id, tool: call.name, args: call.args, ok, output, tookMs };
  }

  private composeUserTurn(goal: string, paths?: string[]): string {
    let text = `Mål: ${goal}`;
    if (paths && paths.length > 0) {
      text += `\nFokuserade sökvägar: ${paths.join(", ")}`;
    }
    return text;
  }

  private finish(
    runId: string,
    ok: boolean,
    summary: string,
    filesChanged: Set<string>,
    steps: StepDraft[],
    toolCalls: ToolCallRecord[],
    checkpointIds: Set<string>,
    started: number,
    collected: Checkpoint[] = [],
  ): AgentRunResult {
    // Checkpoints som verktygen returnerade helhetatligen (add_checkpoint) + id:n
    // fran for-edit-checkpoints som bara har id (da hamtar vi vid behov annars).
    const known = new Map<string, Checkpoint>();
    for (const c of collected) known.set(c.id, c);
    const checkpoints: Checkpoint[] = [];
    for (const id of checkpointIds) {
      const c = known.get(id);
      if (c) checkpoints.push(c);
    }
    return {
      runId,
      ok,
      summary,
      filesChanged: [...filesChanged],
      steps,
      toolCalls,
      checkpoints,
      tookMs: Date.now() - started,
    };
  }

  private cleanup(runId: string, onAbort: () => void): void {
    this.controllers.delete(runId);
    if (typeof this.ctx.signal.removeEventListener === "function") {
      this.ctx.signal.removeEventListener("abort", onAbort);
    }
  }
}

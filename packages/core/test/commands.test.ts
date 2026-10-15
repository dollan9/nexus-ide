/**
 * commands.test.ts — defaultCommands() (FAS 2.4). Verifierar de verkliga
 * kommandot med UI-genvagar och grupper, och att inget id ar duplicerat.
 */

import { describe, it, expect } from "vitest";
import { defaultCommands } from "../src/commands";

describe("defaultCommands", () => {
  const cmds = defaultCommands();

  it("innehaller navgivande palett-kommandon med genvagar", () => {
    const byId = new Map(cmds.map((c) => [c.id, c]));
    expect(byId.get("palette.open")?.shortcut).toBe("Ctrl+Shift+P");
    expect(byId.get("chat.open")?.shortcut).toBe("Ctrl+K");
    expect(byId.get("file.open")?.shortcut).toBe("Ctrl+P");
    expect(byId.get("completion.trigger")?.shortcut).toBe("Ctrl+Space");
    expect(byId.get("terminal.toggle")?.shortcut).toBe("Ctrl+`");
    expect(byId.get("help.focus")?.shortcut).toBe("F1");
  });

  it("varje deskriptor har grupp och unik id (negativt: kollision testas)", () => {
    const ids = cmds.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of cmds) {
      expect(typeof c.title).toBe("string");
      expect(c.title.length).toBeGreaterThan(0);
      expect(typeof c.group).toBe("string");
    }
  });

  it("tacker verkliga funktioner: agent-lagen och checkpoints", () => {
    const groups = new Set(cmds.map((c) => c.group));
    expect(groups.has("Agent")).toBe(true);
    expect(groups.has("Checkpoints")).toBe(true);
    const ids = cmds.map((c) => c.id);
    expect(ids).toContain("agent.mode.debug");
    expect(ids).toContain("agent.mode.eyes");
    expect(ids).toContain("checkpoint.rollback");
  });

  it("returnerar ndeflerade 'when'-varden bara for kanda lägen", () => {
    const allowed = new Set(["editor", "terminal", "always", undefined]);
    for (const c of cmds) expect(allowed.has(c.when)).toBe(true);
  });
});

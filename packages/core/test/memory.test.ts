/**
 * memory.test.ts — MemoryLog (FAS 7.4). Skriver ALDRIG utfor sitt avgränsade
 * block i PROGRESS.md sa att orkestratorns sektioner bevaras.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { MemoryLog } from "../src/memory";
import { makeTempRoot, cleanupAllTemp } from "./helpers";

afterEach(() => cleanupAllTemp());

function mkLog(root: string): MemoryLog {
  return new MemoryLog({
    progressFile: path.join(root, "PROGRESS.md"),
    decisionsFile: path.join(root, ".agent-memory", "decisions.md"),
  });
}

describe("MemoryLog", () => {
  it("skapar PROGRESS.md med BARA mitt block nar filen saknas", async () => {
    const log = mkLog(makeTempRoot());
    const res = await log.append("note", "FAS 7 klar");
    const raw = fs.readFileSync(res.path, "utf8");
    expect(raw).toContain("<!-- nexus:core:begin -->");
    expect(raw).toContain("<!-- nexus:core:end -->");
    expect(raw).toContain("FAS 7 klar");
  });

  it("bevarar orkestratorns utomblocksinnehall vid append", async () => {
    const root = makeTempRoot();
    const progress = path.join(root, "PROGRESS.md");
    fs.writeFileSync(
      progress,
      "# PROGRESS\n\n## Annans sektion\nDetta far inte forsvinna.\n\n<!-- nexus:core:begin -->\n<!-- nexus:core:end -->\n",
      "utf8",
    );
    const log = mkLog(root);
    await log.append("result", "min rad");

    const raw = fs.readFileSync(progress, "utf8");
    expect(raw).toContain("Detta far inte forsvinna.");
    expect(raw).toContain("Annans sektion");
    // Min rad ligger INUTI blocket.
    const begin = raw.indexOf("<!-- nexus:core:begin -->");
    const end = raw.indexOf("<!-- nexus:core:end -->");
    const inner = raw.slice(begin, end);
    expect(inner).toContain("min rad");
    expect(inner).not.toContain("Annans sektion");
  });

  it("decision skrivs till decisions.md, note/result till PROGRESS.md", async () => {
    const root = makeTempRoot();
    const log = mkLog(root);
    const d = await log.append("decision", "Valde shadow-git");
    expect(d.path).toContain("decisions.md");
    expect(fs.existsSync(d.path)).toBe(true);

    const n = await log.append("note", "nagot");
    expect(n.path).toContain("PROGRESS.md");
  });

  it("recent aterger poster med id/text/kind/at fran bada filer", async () => {
    const log = mkLog(makeTempRoot());
    await log.append("decision", "beslut A");
    await log.append("note", "notering B");
    const recent = await log.recent(10);
    expect(recent.length).toBe(2);
    const kinds = recent.map((r) => r.kind).sort();
    expect(kinds).toEqual(["decision", "note"]);
    for (const r of recent) {
      expect(r.id.length).toBeGreaterThan(0);
      expect(typeof r.at).toBe("number");
      expect(typeof r.text).toBe("string");
    }
  });

  it("recent pa tom minnesbank ger tomt (negativt)", async () => {
    const log = mkLog(makeTempRoot());
    expect(await log.recent()).toEqual([]);
  });
});

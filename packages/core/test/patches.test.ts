/**
 * patches.test.ts — SEARCH/REPLACE exakt → trimmad → fuzzy → none (FAS 7.3),
 * unifiedDiff/splitDiffToHunks och atomisk applyPatchSet (alla eller inga).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { applyPatches, unifiedDiff, splitDiffToHunks, applyPatchSet } from "../src/patches";
import { makeTempRoot, cleanupAllTemp } from "./helpers";

afterEach(() => cleanupAllTemp());

describe("applyPatches", () => {
  it("exact-match nar sokorden finns ordgrant", () => {
    const content = "const x = 1;\nconst y = 2;\n";
    const res = applyPatches(content, [{ search: "const x = 1;", replace: "const x = 10;" }]);
    expect(res.ok).toBe(true);
    expect(res.matched[0]).toBe("exact");
    expect(res.after).toContain("const x = 10;");
  });

  it("trimmed-match nar bara indragning skiljer", () => {
    const content = "function f() {\n  return 1;\n}\n";
    // Sokrad har 4 mellanslag, filen har 2 → ej exakt men trimmat lika.
    const res = applyPatches(content, [{ search: "    return 1;", replace: "  return 42;" }]);
    expect(res.ok).toBe(true);
    expect(res.matched[0]).toBe("trimmed");
    expect(res.after).toContain("return 42;");
  });

  it("fuzzy-match vid ett litet stavfel", () => {
    const content = "const total = compute(a, b);\n";
    const res = applyPatches(content, [{ search: "const total = compute(a, c);", replace: "const total = compute(a, b) * 2;" }]);
    expect(res.ok).toBe(true);
    expect(res.matched[0]).toBe("fuzzy");
    expect(res.after).toContain("* 2");
  });

  it("none nar ingen match finns och texten ar otrolig (negativt)", () => {
    const content = "hello world\n";
    const res = applyPatches(content, [{ search: "completely unrelated zzz qqq content", replace: "X" }]);
    expect(res.ok).toBe(false);
    expect(res.matched[0]).toBe("none");
    expect(res.failures.length).toBe(1);
    expect(res.after).toBe(content); // oforandrad
  });

  it("flera patches: ok bara om Alla matchar", () => {
    const content = "a\nb\n";
    const okAll = applyPatches(content, [{ search: "a", replace: "1" }, { search: "b", replace: "2" }]);
    expect(okAll.ok).toBe(true);
    const oneBad = applyPatches(content, [{ search: "a", replace: "1" }, { search: "zzzz unrelated", replace: "9" }]);
    expect(oneBad.ok).toBe(false);
    expect(oneBad.failures.length).toBe(1);
  });
});

describe("unifiedDiff + splitDiffToHunks", () => {
  it("producerar hunks med korrekta rackningar", () => {
    const before = "line1\nline2\nline3\n";
    const after = "line1\nline2-changed\nline3\nline4\n";
    const diff = unifiedDiff("f.txt", before, after);
    expect(diff.path).toBe("f.txt");
    expect(diff.unified).toContain("@@");
    expect(diff.added).toBeGreaterThan(0);
    expect(diff.removed).toBeGreaterThan(0);
    expect(diff.hunks.length).toBeGreaterThanOrEqual(1);
    const parsed = splitDiffToHunks(diff.unified);
    expect(parsed.length).toBe(diff.hunks.length);
    expect(parsed[0]).toHaveProperty("oldStart");
  });

  it("tom diff for identiskt innehall ger inga hunks (negativt)", () => {
    const diff = unifiedDiff("same.txt", "abc\n", "abc\n");
    expect(diff.hunks.length).toBe(0);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
  });
});

describe("applyPatchSet — atomisk multi-fil", () => {
  it("skriver inga filer nar EN patch saknar match", () => {
    const root = makeTempRoot();
    const a = path.join(root, "a.txt");
    const b = path.join(root, "b.txt");
    fs.writeFileSync(a, "keep-a\n");
    fs.writeFileSync(b, "target-b\n");
    const res = applyPatchSet(root, [
      { path: "a.txt", patches: [{ search: "keep-a", replace: "CHANGED-A" }] },
      { path: "b.txt", patches: [{ search: "absent-qqq-zzz", replace: "X" }] },
    ]);
    expect(res.ok).toBe(false);
    expect(res.written).toEqual([]);
    // INGEN fil fick en halv skrivning — originalet ar orort.
    expect(fs.readFileSync(a, "utf8")).toBe("keep-a\n");
    expect(fs.readFileSync(b, "utf8")).toBe("target-b\n");
  });

  it("skriver Alla filer nar alla patcher matchar", () => {
    const root = makeTempRoot();
    fs.writeFileSync(path.join(root, "a.txt"), "one\n");
    fs.writeFileSync(path.join(root, "b.txt"), "two\n");
    const res = applyPatchSet(root, [
      { path: "a.txt", patches: [{ search: "one", replace: "ONE" }] },
      { path: "b.txt", patches: [{ search: "two", replace: "TWO" }] },
    ]);
    expect(res.ok).toBe(true);
    expect(res.written.sort()).toEqual(["a.txt", "b.txt"]);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("ONE\n");
    expect(fs.readFileSync(path.join(root, "b.txt"), "utf8")).toBe("TWO\n");
  });

  it("saknad fil i underlaget ger ok:false utan skrivningar (negativt)", () => {
    const root = makeTempRoot();
    fs.writeFileSync(path.join(root, "present.txt"), "x\n");
    const res = applyPatchSet(root, [
      { path: "present.txt", patches: [{ search: "x", replace: "y" }] },
      { path: "missing.txt", patches: [{ search: "a", replace: "b" }] },
    ]);
    expect(res.ok).toBe(false);
    expect(res.written).toEqual([]);
    expect(fs.readFileSync(path.join(root, "present.txt"), "utf8")).toBe("x\n");
  });
});

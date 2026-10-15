/**
 * checkpoints.test.ts — CheckpointManager (FAS 7.2).
 * Bevisar att skugg-giten ALDRIG ror användarens riktiga repo (HEAD/index/status)
 * och att rollback återställer BYTE-IDENTICAL innehall.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { CheckpointManager } from "../src/checkpoints";
import { createLogger } from "../src/logger";
import { makeTempRoot, cleanupAllTemp } from "./helpers";

afterEach(() => cleanupAllTemp());

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function mkManager(root: string): CheckpointManager {
  const logger = createLogger({ logFile: path.join(root, ".nexus", "debug.log"), level: "warn" });
  return new CheckpointManager({ root, nexusDir: path.join(root, ".nexus"), logger });
}

describe("CheckpointManager — isolering fran riktiga repot", () => {
  it("anvander användarens HEAD/index/status ororda efter checkpoints", async () => {
    const root = makeTempRoot();
    // Ignorera .nexus sa att skugg-repot inte polluterar riktiga repots status.
    fs.writeFileSync(path.join(root, ".gitignore"), ".nexus/\n", "utf8");
    fs.writeFileSync(path.join(root, "note.txt"), "ursprungligt\n", "utf8");
    git(root, ["init", "-q"]);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "baseline"]);

    const headBefore = git(root, ["rev-parse", "HEAD"]).trim();
    const statusBefore = git(root, ["status", "--porcelain"]);

    const mgr = mkManager(root);
    await mgr.ensure();
    const cp = await mgr.create("checkpoint A", ["note.txt"], "user");
    expect(cp.shadowCommit).toMatch(/^[0-9a-f]{7,40}$/);
    await mgr.create("checkpoint B", ["note.txt"], "agent");

    // Riktiga repot är helt orört.
    const headAfter = git(root, ["rev-parse", "HEAD"]).trim();
    const statusAfter = git(root, ["status", "--porcelain"]);
    expect(headAfter).toBe(headBefore);
    expect(statusAfter).toBe(statusBefore);
    expect(statusAfter.trim()).toBe("");

    // Skugg-repot har sina egna commits i sin egen git-dir.
    const shadowHead = git(root, ["--git-dir", path.join(root, ".nexus", "shadow"), "--work-tree", root, "rev-parse", "HEAD"]);
    expect(shadowHead.trim()).not.toBe(headBefore);
    expect(mgr.count()).toBe(2);
  });

  it("aterstaller BYTE-IDENTICAL innehall (inkl. unicode + CRLF)", async () => {
    const root = makeTempRoot();
    const mgr = mkManager(root);
    await mgr.ensure();

    const original = Buffer.from("linje1\r\nünïcode åäö ☃\r\nslut\r\n", "utf8");
    const abs = path.join(root, "data.txt");
    fs.writeFileSync(abs, original);

    const cp = await mgr.create("original", ["data.txt"], "user");

    // Filaedit som ödelägger det ursprungliga.
    fs.writeFileSync(abs, Buffer.from("KORRUPTERAD", "utf8"));
    expect(fs.readFileSync(abs).equals(original)).toBe(false);

    const res = await mgr.rollback(cp.id);
    expect(res.restored).toContain("data.txt");
    const after = fs.readFileSync(abs);
    expect(after.equals(original)).toBe(true); // exakta bytes

    // diff(id) ger verkliga FileDiff-objekt.
    const diffs = await mgr.diff(cp.id);
    expect(Array.isArray(diffs)).toBe(true);
    expect(diffs.length).toBeGreaterThanOrEqual(1);
    expect(diffs[0].hunks.length).toBeGreaterThanOrEqual(1);
  });

  it("kastar vid okand checkpoint-id (negativt)", async () => {
    const mgr = mkManager(makeTempRoot());
    await mgr.ensure();
    await expect(mgr.rollback("nope")).rejects.toThrow();
    await expect(mgr.diff("nope")).rejects.toThrow();
  });

  it("currentFiles + list återspeglar skugg-repots innehall", async () => {
    const root = makeTempRoot();
    const mgr = mkManager(root);
    await mgr.ensure();
    fs.writeFileSync(path.join(root, "tracked.txt"), "x\n", "utf8");
    await mgr.create("c", ["tracked.txt"], "user");
    const files = await mgr.currentFiles();
    expect(files).toContain("tracked.txt");
    const list = await mgr.list();
    expect(list.length).toBe(1);
    expect(list[0].label).toBe("c");
  });
});

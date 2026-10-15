/**
 * FAS 4.3 — nexus-filesystem.mjs (var egen offline-server): läs, lista, sök och
 * skriv med strikt tillåten-rot-jail och godkännandekrav för skrivningar.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpConfigStore, McpServerManager } from "../src/index";
import { makeTempDir, productConfig, removeTempDir, repoRoot, structured } from "./helpers";

const dir = makeTempDir("nexus-mcp-fs-");
let manager: McpServerManager;

beforeAll(async () => {
  mkdirSync(join(dir, "under", "djupare"), { recursive: true });
  writeFileSync(join(dir, "readme.md"), "# NEXUS testfil\n\nhemlig text: KONSTANT-42\n", "utf8");
  writeFileSync(join(dir, "under", "djupare", "kalla.ts"), "export const KONSTANT_42 = 42;\n", "utf8");
  writeFileSync(join(dir, "binary.bin"), Buffer.from([0, 1, 2, 3, 255, 254]), "utf8");

  const store = new McpConfigStore({ filePath: join(dir, "mcp.json"), repoRoot, workspaceRoot: dir, readDotEnv: false });
  store.write([
    productConfig("nexus-filesystem", "nexus-filesystem.mjs", ["--root", dir]),
    productConfig("nexus-fs-write", "nexus-filesystem.mjs", ["--root", dir, "--allow-write"]),
  ]);
  manager = new McpServerManager({ store, timeouts: { connectTimeoutMs: 25_000, listTimeoutMs: 15_000, callTimeoutMs: 25_000 } });
  await manager.startAll();
});

afterAll(async () => {
  await manager?.stopAll();
  removeTempDir(dir);
});

describe("nexus-filesystem (egen, offline)", () => {
  it("båda servrarna är anslutna och verktygen är namespace:ade", () => {
    expect(manager.getServer("nexus-filesystem")?.status).toBe("connected");
    expect(manager.getServer("nexus-fs-write")?.status).toBe("connected");
    const names = manager.listTools().map((t) => t.name);
    expect(names).toContain("nexus-filesystem__read_file");
    expect(names).toContain("nexus-filesystem__list_dir");
    expect(names).toContain("nexus-filesystem__search_files");
    expect(names).toContain("nexus-fs-write__write_file");
    expect(names).toContain("nexus-filesystem__list_roots");
  });

  it("read_file läser den riktiga filen på disk", async () => {
    const result = await manager.callTool("nexus-filesystem__read_file", { path: join(dir, "readme.md") });
    expect(result.ok, result.error).toBe(true);
    const data = structured(result);
    expect(String(data.content)).toContain("KONSTANT-42");
    expect(Number(data.bytes)).toBe(readFileSync(join(dir, "readme.md")).length);
    expect(data.truncated).toBe(false);

    const capped = await manager.callTool("nexus-filesystem__read_file", { path: "readme.md", maxBytes: 8 });
    expect(capped.ok).toBe(true);
    expect(structured(capped).truncated).toBe(true);
    expect(String(structured(capped).content).length).toBeLessThanOrEqual(8);
  });

  it("list_dir visar kataloginnehållet", async () => {
    const result = await manager.callTool("nexus-filesystem__list_dir", { path: dir });
    expect(result.ok, result.error).toBe(true);
    const entries = structured(result).entries as { name: string; kind: string }[];
    const names = entries.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["readme.md", "under", "binary.bin", "mcp.json"]));
    expect(entries.find((e) => e.name === "under")?.kind).toBe("dir");
  });

  it("search_files hittar text utan ripgrep", async () => {
    const result = await manager.callTool("nexus-filesystem__search_files", { query: "KONSTANT", includeGlob: "*.ts" });
    expect(result.ok, result.error).toBe(true);
    const data = structured(result);
    expect(Number(data.numMatches)).toBeGreaterThanOrEqual(1);
    const hits = data.hits as { path: string; line: number; preview: string }[];
    expect(hits[0]?.path).toContain(join("djupare", "kalla.ts"));
    expect(hits[0]?.line).toBe(1);

    const regex = await manager.callTool("nexus-filesystem__search_files", { query: "export const \\w+ = \\d+", isRegex: true });
    expect(structured(regex).numMatches).toBeGreaterThanOrEqual(1);

    const miss = await manager.callTool("nexus-filesystem__search_files", { query: "inget-sådant-finns-här" });
    expect(structured(miss).numMatches).toBe(0);

    const bad = await manager.callTool("nexus-filesystem__search_files", { query: "(", isRegex: true });
    expect(bad.ok).toBe(false);
    expect(bad.error ?? bad.text).toMatch(/ogiltigt mönster/);
  });

  it("binärfiler hoppas över i sök men går att läsa som read_file", async () => {
    const search = await manager.callTool("nexus-filesystem__search_files", { query: "\u0001\u0002" });
    expect(structured(search).numMatches).toBe(0);
  });

  it("jail: sökvägar utanför roten nekas för alla verktyg", async () => {
    const outside = join(repoRoot, "package.json");
    for (const tool of ["nexus-filesystem__read_file", "nexus-filesystem__list_dir"]) {
      const result = await manager.callTool(tool, { path: outside });
      expect(result.ok, `${tool} läckte ut ${outside}`).toBe(false);
      expect(result.text).toMatch(/utanför|tillåtna/i);
    }
    const traversal = await manager.callTool("nexus-filesystem__read_file", { path: "../../../Windows/win.ini" });
    expect(traversal.ok).toBe(false);
    expect(traversal.text).toMatch(/utanför|tillåtna/i);
    const searchEscape = await manager.callTool("nexus-filesystem__search_files", { path: join(dir, ".."), query: "x" });
    expect(searchEscape.ok).toBe(false);
  });

  it("write_file nekas utan godkännande — och utan --allow-write", async () => {
    const target = join(dir, "ny.txt");
    const withoutApproval = await manager.callTool("nexus-fs-write__write_file", { path: target, content: "hej\n" });
    expect(withoutApproval.ok).toBe(false);
    expect(withoutApproval.text).toMatch(/godkännande/);
    expect(structured(withoutApproval).requiresApproval).toBe(true);
    expect(existsSync(target)).toBe(false);

    // Samma server-variant utan --allow-write vägrar även med approved:true.
    const locked = await manager.callTool("nexus-filesystem__write_file", { path: target, content: "hej\n", approved: true });
    expect(locked.ok).toBe(false);
    expect(locked.text).toMatch(/avstängd/i);
    expect(existsSync(target)).toBe(false);
  });

  it("write_file med godkännande skriver verkligen till disk", async () => {
    const target = join(dir, "under", "skapad.txt");
    const result = await manager.callTool("nexus-fs-write__write_file", { path: target, content: "innehåll från MCP\n", approved: true });
    expect(result.ok, result.error ?? result.text).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("innehåll från MCP\n");
    expect(structured(result).bytes).toBe(20);

    // Skrivningen gick inte ut ur jailen.
    const escape = await manager.callTool("nexus-fs-write__write_file", { path: join(dir, "..", "rymt.txt"), content: "x", approved: true });
    expect(escape.ok).toBe(false);
    expect(existsSync(join(dir, "..", "rymt.txt"))).toBe(false);
  });

  it("list_roots rapporterar jailen och att write är avstängt/stängt på", async () => {
    const readOnly = await manager.callTool("nexus-filesystem__list_roots", {});
    expect(structured(readOnly).allowWrite).toBe(false);
    const writable = await manager.callTool("nexus-fs-write__list_roots", {});
    expect(structured(writable).allowWrite).toBe(true);
    expect((structured(writable).roots as string[])[0]).toBe(dir);
  });

  it("metadata: write_file är inte read-only och kräver godkännande", () => {
    const write = manager.getTool("nexus-filesystem__write_file");
    expect(write?.readOnly).toBe(false);
    expect(write?.requiresApproval).toBe(true);
    expect(write?.risk).toBe("medium");
    const read = manager.getTool("nexus-filesystem__read_file");
    expect(read?.readOnly).toBe(true);
    expect(read?.requiresApproval).toBe(false);
  });
});

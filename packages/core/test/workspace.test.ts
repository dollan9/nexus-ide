/**
 * workspace.test.ts — WorkspaceService (FAS 2.4).
 * languageOf >=50, hard rot-bevakning, unicode/mellanslag/&-sokvagar, atomic
 * CRLF-bevarande skrivning, och DUBBEL-ENGINE-sok som maste ge identiska matchset.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { WorkspaceService, isInsideRoot } from "../src/workspace";
import { createLogger } from "../src/logger";
import { makeTempRoot, cleanupAllTemp, findRealRg, normHits } from "./helpers";

afterEach(() => {
  cleanupAllTemp();
  delete process.env.RG_PATH;
});

function makeWs(root: string): WorkspaceService {
  // Logg under .nexus sa att soktesten aldrig traffar debug.log.
  const logger = createLogger({ logFile: path.join(root, ".nexus", "debug.log"), level: "warn" });
  return new WorkspaceService({ root, logger });
}

describe("languageOf", () => {
  it("kanner igen 50+ distinkta sprak via extension OCH filnamn", () => {
    const ws = makeWs(makeTempRoot());
    const samples = [
      "a.ts", "b.tsx", "c.js", "d.jsx", "e.mjs", "f.json", "g.jsonc", "h.css", "i.scss", "j.html",
      "k.vue", "l.svelte", "m.md", "n.py", "o.ipynb", "p.rb", "q.go", "r.rs", "s.java", "t.kt",
      "u.swift", "v.c", "w.cpp", "x.cs", "y.php", "z.lua", "aa.r", "ab.jl", "ac.dart", "ad.scala",
      "ae.sh", "af.bat", "ag.ps1", "ah.sql", "ai.yaml", "aj.toml", "ak.ini", "al.xml", "am.tf",
      "an.proto", "ao.graphql", "ap.hs", "aq.erl", "ar.ex", "as.ml", "at.fs", "au.clj", "av.zig",
      "aw.tex", "ax.sol", "ay.prisma", "az.v",
      "Dockerfile", "Makefile", "CMakeLists.txt", ".gitignore", ".env", "PKGBUILD", "Gemfile", ".editorconfig",
    ];
    const langs = new Set<string>();
    for (const s of samples) {
      const lang = ws.languageOf(s);
      expect(lang, `förväntade icke-plaintext för ${s}`).not.toBe("plaintext");
      langs.add(lang);
    }
    expect(langs.size).toBeGreaterThanOrEqual(50);
  });

  it("returnerar plaintext for okand extension (negativt)", () => {
    const ws = makeWs(makeTempRoot());
    expect(ws.languageOf("archive.unknownext99")).toBe("plaintext");
  });
});

describe("resolve — rot-bevakning", () => {
  it("blockerar ../-traversering och absolut sokvag utanfor rot", () => {
    const root = makeTempRoot();
    const ws = makeWs(root);
    expect(() => ws.resolve("../../etc/passwd")).toThrow();
    expect(() => ws.resolve(path.join(root, "..", "sibling"))).toThrow();
    // En giltig relativ sokvag ok.
    expect(ws.resolve("src/a.ts").startsWith(root)).toBe(true);
  });

  it("skyddsgissningen (isInsideRoot) blockerar symlevls-flykt direkt (symlevl EPERM har)", () => {
    const root = makeTempRoot();
    // Symlevl kan inte skapas pa detta fillsystem (EPERM) — provvaktar therefore
    // skyddsfunktionen direkt, vilket ar den samma logik resolve() anvander.
    const escape = path.join(root, "..", "evil", "x");
    expect(isInsideRoot(root, path.resolve(escape))).toBe(false);
    expect(isInsideRoot(root, path.join(root, "ok", "file"))).toBe(true);
    expect(isInsideRoot(root, root)).toBe(true);
  });

  it("later unicode, mellanslag och & i sokvagar (Windows-falla)", async () => {
    const root = makeTempRoot();
    const ws = makeWs(root);
    const tricky = path.join("mapp med rum", "rysk & åäö ünïcode.txt");
    const res = await ws.write(tricky, "innehåll & special");
    expect(res.path).toContain("åäö");
    const back = await ws.read(tricky);
    expect(back.content).toBe("innehåll & special");
  });
});

describe("write/read/create/rename/remove", () => {
  it("bevarar CRLF nar LF skrivs over en CRLF-fil, och lamnar ingen tempfil", async () => {
    const root = makeTempRoot();
    const ws = makeWs(root);
    const rel = "win.ts";
    const abs = ws.resolve(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "a\r\nb\r\n", "utf8");
    await ws.write(rel, "x\ny\n", { source: "user" });
    const raw = fs.readFileSync(abs, "utf8");
    expect(raw).toContain("\r\n");
    expect(raw.replace(/\r\n/g, "\n")).toBe("x\ny\n");
    // Ingen tempfil ligger kvar.
    const leftovers = fs.readdirSync(path.dirname(abs)).filter((f) => f.startsWith(".nexus-tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("reporterar truncated vid maxBytes", async () => {
    const root = makeTempRoot();
    const ws = makeWs(root);
    await ws.write("big.txt", "0123456789ABCDEF");
    const small = await ws.read("big.txt", 5);
    expect(small.truncated).toBe(true);
    expect(small.content).toBe("01234");
    expect(small.size).toBe(16);
  });

  it("kaster vid lasning av saknad fil (negativt)", async () => {
    const ws = makeWs(makeTempRoot());
    await expect(ws.read("finns-inte.txt")).rejects.toThrow();
  });

  it("skapar, byter namn och tar bort noder", async () => {
    const root = makeTempRoot();
    const ws = makeWs(root);
    await ws.createNode("dir", "dir");
    await ws.createNode(path.join("dir", "f.txt"), "file");
    await ws.rename(path.join("dir", "f.txt"), path.join("dir", "g.txt"));
    const tree = await ws.listTree("dir", 2);
    expect(tree.some((n) => n.name === "g.txt")).toBe(true);
    expect(tree.some((n) => n.name === "f.txt")).toBe(false);
    await ws.remove(path.join("dir", "g.txt"));
    const after = await ws.listTree("dir", 2);
    expect(after.find((n) => n.name === "g.txt")).toBeUndefined();
  });
});

describe("listTree — ignore-regler", () => {
  it("exkluderar node_modules, dist och .git fran tradet", async () => {
    const root = makeTempRoot();
    const ws = makeWs(root);
    await ws.write(path.join("node_modules", "pkg", "index.js"), "x");
    await ws.write(path.join("dist", "bundle.js"), "x");
    await ws.write(path.join("src", "app.ts"), "x");
    const tree = await ws.listTree(undefined, 5);
    const names = tree.map((n) => n.name);
    expect(names).toContain("src");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain("dist");
  });
});

describe("search — ripgrep och JS-fallback maste enig", () => {
  it("bada engines ger identiska matchset pa samma korpus", async () => {
    const rg = findRealRg();
    if (!rg) throw new Error("Ingen verklig ripgrep tillganglig — kan inte jamforela bada engines");
    process.env.RG_PATH = rg;

    const root = makeTempRoot();
    const ws = makeWs(root);
    await ws.write("src/a.ts", "const NEEDLE = 1;\nexport const NEEDLE2 = 2;\n");
    await ws.write("src/b.ts", "// NEEDLE i kommentar\n");
    await ws.write("keep.txt", "inget att hitta har\n");
    // node_modules MUST uteslutas av bada engines.
    await ws.write("node_modules/junk.ts", "NEEDLE i node_modules\n");

    const opts = { isRegex: false, isCaseSensitive: false };
    const rgRes = await ws.searchWithEngine("NEEDLE", opts, "ripgrep");
    const jsRes = await ws.searchWithEngine("NEEDLE", opts, "js");

    expect(rgRes.engine).toBe("ripgrep");
    expect(jsRes.engine).toBe("js-fallback");
    expect(normHits(rgRes.hits)).toEqual(normHits(jsRes.hits));
    expect(normHits(jsRes.hits).length).toBe(3); // 2 i a.ts + 1 i b.ts
    expect(normHits(jsRes.hits).join(" ")).not.toContain("node_modules");
    expect(jsRes.numFiles).toBe(rgRes.numFiles);
  });

  it("honorerar maxResults och includeGlob (negativt: 0 traffar i fel glob)", async () => {
    const root = makeTempRoot();
    const ws = makeWs(root);
    await ws.write("a.ts", "NEEDLE NEEDLE NEEDLE NEEDLE\n");
    const limited = await ws.searchWithEngine("NEEDLE", { maxResults: 2 }, "js");
    expect(limited.hits.length).toBe(2);
    expect(limited.truncated).toBe(true);
    const none = await ws.searchWithEngine("NEEDLE", { includeGlob: "*.md" }, "js");
    expect(none.numMatches).toBe(0);
  });

  it("JS-fallback anvands nar ingen rg finns (negativt: RVAG till oduglig binar)", async () => {
    const root = makeTempRoot();
    process.env.RG_PATH = path.join(root, "does-not-exist-rg");
    const ws = makeWs(root);
    await ws.write("x.txt", "hej HANDBOLL hej");
    const res = await ws.search("HANDBOLL");
    expect(res.engine).toBe("js-fallback");
    expect(res.numMatches).toBe(1);
  });
});

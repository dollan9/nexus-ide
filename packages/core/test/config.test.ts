/**
 * config.test.ts — .env-parser, round-trip med kommentarer, hemlighetsskydd (R2),
 * rodkning i debug.log (R7). Alltid ett negativt fall vid sidan om det positiva.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ConfigStore, parseEnv, setEnvValue } from "../src/config";
import { createLogger } from "../src/logger";
import { makeTempRoot, cleanupAllTemp } from "./helpers";

afterEach(() => cleanupAllTemp());

describe("parseEnv", () => {
  it("tolkar citat, kommentarer, blankrader, export-prefix och CRLF", () => {
    const text = [
      "# en kommentar",
      "",
      'PLAIN=hello',
      'QUOTED="with spaces"',
      "SINGLE='single val'",
      "export EXPORTED=yes",
      'ESCAPED="line\\nnl"',
      "INLINE=value # inline comment",
      "EMPTY=",
      "CRLF_STYLE=ok",
    ].join("\r\n");
    const parsed = parseEnv(text);
    expect(parsed.PLAIN).toBe("hello");
    expect(parsed.QUOTED).toBe("with spaces");
    expect(parsed.SINGLE).toBe("single val");
    expect(parsed.EXPORTED).toBe("yes");
    expect(parsed.ESCAPED).toBe("line\nnl");
    expect(parsed.INLINE).toBe("value");
    expect(parsed.EMPTY).toBe("");
    expect(parsed.CRLF_STYLE).toBe("ok");
  });

  it("ignorerar rader utan liktecken och kommentarrader (negativt)", () => {
    const parsed = parseEnv("# endast kommentar\nintentckel\nINVALID LINE\nOK=1");
    expect(parsed.OK).toBe("1");
    expect(Object.keys(parsed)).toEqual(["OK"]);
  });
});

describe("setEnvValue round-trip", () => {
  it("bevarar kommentarer och andra rader nar en hemlighet satts", () => {
    const original = [
      "# NEXUS-IDE .env",
      "OPENAI_API_KEY=",
      "# nästa grupp",
      "OLLAMA_BASE_URL=http://127.0.0.1:11434",
    ].join("\n");
    const next = setEnvValue(original, "OPENAI_API_KEY", "sk-test-123");
    // Kommentarer bevarade.
    expect(next).toContain("# NEXUS-IDE .env");
    expect(next).toContain("# nästa grupp");
    expect(next).toContain("OLLAMA_BASE_URL=http://127.0.0.1:11434");
    // Nyckeln uppdaterad i stallet for en ny rad.
    expect(next).toContain("OPENAI_API_KEY=sk-test-123");
    expect(next.match(/OPENAI_API_KEY=/g)?.length).toBe(1);
  });

  it("lagger till en helt ny nyckel narest om den saknas", () => {
    const next = setEnvValue("A=1\n", "BRAND_NEW", "x");
    expect(next).toContain("A=1");
    expect(next).toContain("BRAND_NEW=x");
  });
});

describe("ConfigStore", () => {
  it("mergear .env och process.env, satter hemlighet utan att laktera nagot varde", () => {
    const root = makeTempRoot();
    const envFile = path.join(root, ".env");
    fs.writeFileSync(envFile, "# bevarad kommentar\nFOO_API_KEY=\nBAR=keepme\n", "utf8");
    const store = ConfigStore.load({ root });

    store.setSecret("FOO_API_KEY", "sk-test-123");
    const written = fs.readFileSync(envFile, "utf8");
    expect(written).toContain("# bevarad kommentar");
    expect(written).toContain("FOO_API_KEY=sk-test-123");

    // secretInfo visar ALDRIG det faktiska vardet — bara namn + isSet + source.
    const info = store.secretInfo("FOO_API_KEY");
    expect(info.name).toBe("FOO_API_KEY");
    expect(info.isSet).toBe(true);
    expect(info.source).toBe("dotenv");
    expect(JSON.stringify(info)).not.toContain("sk-test-123");
    expect(info.masked).toBe("****");
  });

  it("process.env overstyrc dotenv och markeras som kalla 'env'", () => {
    const root = makeTempRoot();
    fs.writeFileSync(path.join(root, ".env"), "OVERRIDE_ME=from_dotenv\n", "utf8");
    process.env.OVERRIDE_ME = "from_process";
    try {
      const store = ConfigStore.load({ root });
      const info = store.secretInfo("OVERRIDE_ME");
      // secretInfo anvander endast namn/isSet/source; varde ej exponerat.
      expect(info.isSet).toBe(true);
      expect(info.source).toBe("env");
      // Intern secret() reads merged value — process vinner.
      expect(store.secret("OVERRIDE_ME")).toBe("from_process");
    } finally {
      delete process.env.OVERRIDE_ME;
    }
  });

  it("persistar settings till .nexus/settings.json och laser tillbaka (FAS installningar)", () => {
    const root = makeTempRoot();
    const store = ConfigStore.load({ root });
    store.set({ theme: "light", fontSize: 18 });
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, ".nexus", "settings.json"), "utf8"));
    expect(onDisk.theme).toBe("light");
    expect(onDisk.fontSize).toBe(18);

    const reloaded = ConfigStore.load({ root });
    expect(reloaded.get("theme")).toBe("light");
    expect(reloaded.get("fontSize")).toBe(18);
  });

  it("avvisar ogiltigt miljonamn (negativt)", () => {
    const root = makeTempRoot();
    const store = ConfigStore.load({ root });
    expect(() => store.setSecret("not a valid name!", "x")).toThrow();
  });

  it("allSecretInfo listar bara sekreta namn, inga varden", () => {
    const root = makeTempRoot();
    fs.writeFileSync(path.join(root, ".env"), "OPENAI_API_KEY=sk-abcdef123\nAPP_NAME=myapp\n", "utf8");
    const store = ConfigStore.load({ root });
    const list = store.allSecretInfo();
    const names = list.map((s) => s.name);
    expect(names).toContain("OPENAI_API_KEY");
    expect(names).not.toContain("APP_NAME");
    expect(JSON.stringify(list)).not.toContain("sk-abcdef123");
  });
});

describe("Logger rodaktning (R2/R7)", () => {
  it("hemligheten forekommer aldrig i debug.log efter att den satts och anvants", () => {
    const root = makeTempRoot();
    const logFile = path.join(root, "debug.log");
    const store = ConfigStore.load({ root });
    store.setSecret("SECRET_TOKEN_KEY", "sk-realfake-XYZ789");

    const logger = createLogger({ logFile, level: "debug" });
    // Varden "anvands" i bade meddelande och meta — rodaktning maste fa agat.
    logger.info("header Bearer abcdef.ghijkl.mno mot provider", {
      authorization: "Bearer sk-realfake-XYZ789",
      key: "sk-realfake-XYZ789",
      url: "https://x",
    });
    logger.warn("meddelande med nvapi-liknande nyckel nvapi-ABC123456 inbaddad");

    const raw = fs.readFileSync(logFile, "utf8");
    expect(raw).not.toContain("sk-realfake-XYZ789");
    expect(raw).not.toContain("nvapi-ABC123456");
    expect(raw).not.toContain("abcdef.ghijkl.mno");
    expect(raw).toContain("sk-****");
    expect(raw).toContain("Bearer ****");
    // ISO-tidstampel + varningsniva ar narvarande.
    expect(raw).toMatch(/\d{4}-\d{2}-\d{2}T[\d:.]+Z\|INFO\|/);
  });

  it("tail laser sista raderna och roteraar vid storleksgrans (negativt: tomt)", () => {
    const root = makeTempRoot();
    const logFile = path.join(root, "debug.log");
    const logger = createLogger({ logFile, level: "debug", maxBytes: 256 });
    for (let i = 0; i < 50; i++) logger.info(`rad ${i}`);
    const tail = logger.tail(3);
    expect(tail.length).toBeLessThanOrEqual(3);
    expect(tail[tail.length - 1]).toContain("rad 49");
    // Filen har roterats men finns kvar.
    expect(fs.existsSync(logger.path)).toBe(true);

    const empty = createLogger({ logFile: path.join(root, "missing.log") });
    expect(empty.tail(10)).toEqual([]);
  });
});

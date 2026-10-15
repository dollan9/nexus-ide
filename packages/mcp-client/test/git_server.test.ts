/**
 * Acceptanstest for FAS 4.3/4.4: nexus-git.mjs spawnas av den verkliga managern
 * mot ett verkligt temporart git-repo, och verktygen maste spegla repo:t.
 * Negativ kontroll: en korrupt server ger status "error" — de andra serverns
 * verktyg finns fortfarande kvar i registry.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitMcpToolName } from "@nexus/protocol";
import { McpConfigStore, McpServerManager } from "../src/index";
import { fixtureConfig, git, makeGitRepo, makeTempDir, productConfig, removeTempDir, repoRoot, structured, waitFor } from "./helpers";

const timeouts = { connectTimeoutMs: 25_000, listTimeoutMs: 15_000, callTimeoutMs: 25_000 };

let dir: string;
let repo: string;
let untrackedFile: string;
let committedFile: string;
let store: McpConfigStore;
let manager: McpServerManager;

beforeAll(async () => {
  dir = makeTempDir("nexus-mcp-git-");
  const made = makeGitRepo(dir);
  repo = made.repo;
  untrackedFile = made.untrackedFile;
  committedFile = made.committedFile;

  store = new McpConfigStore({ filePath: join(dir, "mcp.json"), repoRoot, workspaceRoot: dir, readDotEnv: false });
  store.write([
    productConfig("nexus-git", "nexus-git.mjs", ["--repo", repo]),
    // Samtidlig server sämre — den ska falla och de andra inte märka det.
    {
      id: "trasig-server",
      label: "korrupt config (positiv bebis: ger error)",
      transport: "stdio",
      command: process.execPath,
      args: [join(repoRoot, "scripts", "mcp-servers", "nexus-gitskrivfel.mjs")],
      enabled: true,
    },
    fixtureConfig("nexus-test-a"),
  ]);
  manager = new McpServerManager({ store, timeouts });
  await manager.startAll();
});

afterAll(async () => {
  await manager?.stopAll();
  if (dir !== undefined) removeTempDir(dir);
});

describe("nexus-git via McpServerManager", () => {
  it("servern är ansluten och den trasiga är error — ingen kedjereaktion", () => {
    const servers = manager.listServers();
    const gitInfo = servers.find((s) => s.id === "nexus-git");
    const broken = servers.find((s) => s.id === "trasig-server");
    expect(gitInfo?.status).toBe("connected");
    expect(gitInfo?.error).toBeUndefined();
    expect(broken?.status).toBe("error");
    expect(broken?.error).toBeTruthy();
    expect(servers.find((s) => s.id === "nexus-test-a")?.status).toBe("connected");
  });

  it("registry innehåller namespace-verktygen och kollision är omöjlig", () => {
    const names = manager.listTools().map((t) => t.name);
    for (const expected of ["nexus-git__status", "nexus-git__diff", "nexus-git__log", "nexus-git__show", "nexus-git__branch_list", "nexus-git__stage", "nexus-git__commit"]) {
      expect(names).toContain(expected);
    }
    expect(names).toContain("nexus-test-a__ping");
    // Den trasiga servern bidrar med 0 verktyg men tar inte andra med sig.
    expect(names.some((n) => n.startsWith("trasig-server__"))).toBe(false);
    expect(manager.activeToolCount()).toBe(names.length);
    for (const name of names) {
      const { serverId, localName } = splitMcpToolName(name);
      expect(manager.getTool(name)?.serverId).toBe(serverId);
      expect(manager.getTool(name)?.localName).toBe(localName);
    }
  });

  it("nexus-git__status visar verkligen det tempora repo:t", async () => {
    const result = await manager.callTool("nexus-git__status", {});
    expect(result.ok).toBe(true);
    expect(result.tookMs).toBeGreaterThanOrEqual(0);
    const data = structured(result);
    expect(String(data.repo)).toBe(repo);
    expect(data.branch).toBe("main");
    expect(data.clean).toBe(false);
    const untracked = data.untracked as string[];
    expect(untracked).toContain("untracked.txt");
    // Negativ kontroll: filen som faktiskt finns i repo:t nämns, inte ett fantomrepo.
    expect(String(data.raw)).toContain("untracked.txt");
    expect(readFileSync(untrackedFile, "utf8")).toContain("inte är indexerad");
  });

  it("diff fångar en verklig osparad ändring", async () => {
    writeFileSync(committedFile, "ursprungligt innehåll\nplus en rad\n", "utf8");
    const result = await manager.callTool("nexus-git__diff", { contextLines: 1 });
    expect(result.ok).toBe(true);
    const text = String(structured(result).text ?? "");
    expect(text).toContain("+plus en rad");
    expect(text).toContain("tracked.txt");
  });

  it("stage och commit skriver verkligt till repo:t", async () => {
    const staged = await manager.callTool("nexus-git__stage", { paths: ["untracked.txt"] });
    expect(staged.ok).toBe(true);

    const before = git(repo, "rev-list", "--count", "HEAD").trim();
    const committed = await manager.callTool("nexus-git__commit", { message: "test: spåra untracked.txt", paths: ["untracked.txt"] });
    expect(committed.ok, committed.error ?? committed.text).toBe(true);
    const sha = String(structured(committed).sha ?? "");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const after = git(repo, "rev-list", "--count", "HEAD").trim();
    expect(Number(after)).toBe(Number(before) + 1);
    // Filen är nu spårad i HEAD — och inte längre ospårad i workträt.
    expect(git(repo, "ls-files")).toContain("untracked.txt");
    expect(git(repo, "show", "--name-only", "--format=", "HEAD")).toContain("untracked.txt");
    expect(git(repo, "status", "--porcelain")).not.toContain("?? untracked.txt");

    const status = await manager.callTool("nexus-git__status", {});
    const data = structured(status);
    expect((data.untracked as string[]).some((p) => p.includes("untracked.txt"))).toBe(false);
    // diff-testen lämnade en osparad ändring i tracked.txt — den ska synas nu.
    expect((data.unstaged as string[]).some((p) => p.includes("tracked.txt"))).toBe(true);
  });

  it("log och show läser den nya commiten", async () => {
    const result = await manager.callTool("nexus-git__log", { limit: 5 });
    expect(result.ok).toBe(true);
    const commits = structured(result).commits as { subject: string; hash: string }[];
    expect(commits.length).toBeGreaterThanOrEqual(2);
    expect(commits.map((c) => c.subject)).toContain("test: spåra untracked.txt");

    const show = await manager.callTool("nexus-git__show", { rev: commits[0]?.hash ?? "HEAD", asDiff: true });
    expect(show.ok).toBe(true);
    expect(String(structured(show).meta)).toContain("commit");
  });

  it("branch_list visar main och readOnly-metadata är korrekt satt", async () => {
    const branch = await manager.callTool("nexus-git__branch_list", { includeRemote: false });
    expect(branch.ok).toBe(true);
    const branches = structured(branch).branches as { ref: string }[];
    expect(branches.some((b) => b.ref.includes("main"))).toBe(true);

    const readOnlyNames = manager.listTools().filter((t) => t.serverId === "nexus-git" && t.readOnly).map((t) => t.localName);
    expect(readOnlyNames.sort()).toEqual(["branch_list", "diff", "log", "show", "status"]);
    const writable = manager.listRegisteredTools().filter((t) => t.serverId === "nexus-git" && !t.readOnly).map((t) => t.localName);
    expect(writable.sort()).toEqual(["commit", "stage"]);
    expect(manager.getTool("nexus-git__commit")?.requiresApproval).toBe(true);
    expect(manager.getTool("nexus-git__status")?.requiresApproval).toBe(false);
  });

  it("ett okänt verktyg svarar ok:false — aldrig ett undantag", async () => {
    const result = await manager.callTool("nexus-git__finns_inte", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("verktyg finns inte");
    const wrongNamespace = await manager.callTool("ping", {});
    expect(wrongNamespace.ok).toBe(false);
  });

  it("en server som dör oväntat tappas ur registry men lämnar de andra intakta", async () => {
    const victim = await manager.start("nexus-test-a");
    expect(victim.status).toBe("connected");
    expect(manager.listTools().some((t) => t.serverId === "nexus-test-a")).toBe(true);

    const killed = await manager.callTool("nexus-test-a__close_self", {});
    expect(killed.ok).toBe(true);
    await waitFor("nexus-test-a markeras som stopped", () => manager.getServer("nexus-test-a")?.status === "stopped", 8_000);

    expect(manager.listTools().some((t) => t.serverId === "nexus-test-a")).toBe(false);
    // De andra (git) lever fortfarande och kan anropas.
    expect(manager.getServer("nexus-git")?.status).toBe("connected");
    const still = await manager.callTool("nexus-git__status", {});
    expect(still.ok).toBe(true);
  });

  it("stderr fran servern hamnar i mcp/log med rätt serverId", async () => {
    const lines: { serverId: string; line: string }[] = [];
    const off = manager.on("mcp/log", (payload) => lines.push(payload));
    const info = await manager.upsert(productConfig("nexus-git-2", "nexus-git.mjs", ["--repo", repo]));
    off();
    expect(info.status).toBe("connected");
    expect(lines.some((l) => l.serverId === "nexus-git-2" && l.line.includes("redo"))).toBe(true);
    expect(existsSync(join(repo, ".git"))).toBe(true);
  });

  it("upsert av en trasig config är icke-förstörande för befintliga verktyg", async () => {
    const gitToolsBefore = manager.listTools().filter((t) => t.serverId === "nexus-git").length;
    const info = await manager.upsert({
      id: "saktig",
      transport: "stdio",
      command: process.execPath,
      args: [join(repoRoot, "scripts", "mcp-servers", "nexus-filesystem.mjs", "--root", dir), "--hall"],
      enabled: true,
    });
    // Saknad variabel i args? Nej: här är felet en okänd flagga → servern startar
    // men verktygen listas ändå. Vi kontrollerar därför att registret är heult.
    expect(["connected", "error", "starting"]).toContain(info.status);
    expect(manager.listTools().filter((t) => t.serverId === "nexus-git").length).toBe(gitToolsBefore);
    expect(gitToolsBefore).toBeGreaterThan(0);
    await manager.remove("saktig");
  });
});

/**
 * scripts/scaffold.mjs — genererar hela workspace-kopplingen (package.json + tsconfig + mapkar)
 * för NEXUS-IDE. Idempotent: kör om det, skrivs inte över befintliga src-filer.
 *
 * Orkestratorn äger denna fil. Byggare ska INTE köra den.
 *
 * Versionerna nedan är VERIFIERADE mot registry i denna session (se .agent/ultra/ledger.md),
 * med undantag där vi medvetet går på en LTS-liknande range för att släppa peer-resolving.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Windows-säker väg: fileURLToPath ger "C:\..." utan leading slash, vilket dirname/join hanterar korrekt.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const V = {
  typescript: "~5.9.0",
  vitest: "^3.2.4",
  "@types/node": "^24.0.0",
  react: "^19.0.0",
  "react-dom": "^19.0.0",
  "@types/react": "^19.0.0",
  "@types/react-dom": "^19.0.0",
  "monaco-editor": "^0.57.0",
  "@xterm/xterm": "^6.0.0",
  "@xterm/addon-fit": "^0.11.0",
  "simple-git": "^4.0.0",
  "@modelcontextprotocol/sdk": "^1.20.0",
  ws: "^8.22.0",
  "@types/ws": "^8.18.0",
  zod: "^3.25.0",
  diff: "^8.0.0",
  "@types/diff": "^7.0.0",
  chokidar: "^4.0.0",
  electron: "^44.0.0",
  "electron-builder": "^26.0.0",
  vite: "^6.0.0",
  "@vitejs/plugin-react": "^4.6.0",
  playwright: "^1.55.0",
  "cross-env": "^10.0.0",
  rimraf: "^6.0.1",
};

const pkgs = [
  {
    dir: "packages/protocol",
    name: "@nexus/protocol",
    desc: "Kontrakt för host↔renderer: metoder, events, alla typer.",
    deps: {},
    dev: ["typescript", "vitest"],
  },
  {
    dir: "packages/providers",
    name: "@nexus/providers",
    desc: "Enhetligt modellager: NVIDIA NIM, Ollama, vLLM, LM Studio, llama.cpp, OpenAI, Anthropic, Google, OpenRouter, Groq, Mistral, custom.",
    deps: { "@nexus/protocol": "workspace:*" },
    dev: ["typescript", "vitest", "@types/node"],
  },
  {
    dir: "packages/mcp-client",
    name: "@nexus/mcp-client",
    desc: "MCP-klient (stdio + SSE + streamable HTTP), server-manager och dynamisk tool-registry.",
    deps: { "@nexus/protocol": "workspace:*", "@modelcontextprotocol/sdk": V["@modelcontextprotocol/sdk"], zod: V.zod },
    dev: ["typescript", "vitest", "@types/node"],
  },
  {
    dir: "packages/voice",
    name: "@nexus/voice",
    desc: "Röst in/ut mot ai-service: Whisper STT + Piper/edge-tts TTS, med mikrofonmatris i webbläsaren.",
    deps: { "@nexus/protocol": "workspace:*" },
    dev: ["typescript", "vitest", "@types/node"],
  },
  {
    dir: "packages/vision",
    name: "@nexus/vision",
    desc: "Ögon: skärmdump (Electron/mss), VLM-analys och OCR-fallback.",
    deps: { "@nexus/protocol": "workspace:*" },
    dev: ["typescript", "vitest", "@types/node"],
  },
  {
    dir: "packages/core",
    name: "@nexus/core",
    desc: "Agentkärna: ReAct/tool-loop, planering, minne, checkpoints, sök/replace, config, logger, RAG-klient.",
    deps: {
      "@nexus/protocol": "workspace:*",
      "@nexus/providers": "workspace:*",
      "@nexus/mcp-client": "workspace:*",
      "@nexus/voice": "workspace:*",
      "@nexus/vision": "workspace:*",
      "simple-git": V["simple-git"],
      diff: V.diff,
      chokidar: V.chokidar,
      zod: V.zod,
    },
    dev: ["typescript", "vitest", "@types/node", "@types/diff"],
  },
  {
    dir: "packages/host",
    name: "@nexus/host",
    desc: "IDE-host: binder ihop kärnan till metodtabellen och exponerar den över Electron IPC eller WebSocket.",
    deps: {
      "@nexus/core": "workspace:*",
      "@nexus/protocol": "workspace:*",
      "@nexus/providers": "workspace:*",
      "@nexus/mcp-client": "workspace:*",
      "@nexus/voice": "workspace:*",
      "@nexus/vision": "workspace:*",
      ws: V.ws,
    },
    dev: ["typescript", "vitest", "@types/node", "@types/ws"],
  },
  {
    dir: "packages/ui",
    name: "@nexus/ui",
    desc: "React-komponenter: filträd, flikar, Monaco-wrapper, diff-vy, AI-panel, kommandopalett, settings, tema.",
    deps: {
      "@nexus/protocol": "workspace:*",
      react: V.react,
      "react-dom": V["react-dom"],
      "monaco-editor": V["monaco-editor"],
      "@xterm/xterm": V["@xterm/xterm"],
      "@xterm/addon-fit": V["@xterm/addon-fit"],
      diff: V.diff,
    },
    dev: ["typescript", "vitest", "@types/react", "@types/react-dom", "@types/diff", "jsdom", "vite"],
  },
  {
    dir: "apps/desktop",
    name: "@nexus/desktop",
    desc: "Electron-skal: main-process (host+IPC), preload ( säker bro), renderer (Vite+React), ai-service auto-start.",
    deps: {
      "@nexus/host": "workspace:*",
      "@nexus/core": "workspace:*",
      "@nexus/ui": "workspace:*",
      "@nexus/protocol": "workspace:*",
    },
    dev: [
      "electron",
      "electron-builder",
      "vite",
      "@vitejs/plugin-react",
      "typescript",
      "vitest",
      "@types/node",
      "cross-env",
      "ws",
      "@nexus/host",
      "@nexus/ui",
      "@nexus/protocol",
    ],
  },
  {
    dir: "tests/e2e",
    name: "@nexus/e2e",
    desc: "E2E-svit T1–T10: Playwright mot renderer i browser-läge + riktig host-process over WebSocket.",
    deps: {
      "@nexus/protocol": "workspace:*",
      "@nexus/host": "workspace:*",
      "@nexus/core": "workspace:*",
      "@nexus/providers": "workspace:*",
      "@nexus/mcp-client": "workspace:*",
      ws: V.ws,
    },
    dev: ["typescript", "vitest", "playwright", "@types/node", "@types/ws"],
  },
  {
    dir: "templates/mcp-server-ts",
    name: "nexus-mcp-template-ts",
    desc: "Mall för användarens egna MCP-servrar i TypeScript.",
    deps: { "@modelcontextprotocol/sdk": V["@modelcontextprotocol/sdk"], zod: V.zod },
    dev: ["typescript", "@types/node"],
  },
];

const pkgJson = (p) => ({
  name: p.name,
  version: "1.0.0",
  private: p.dir.startsWith("templates") ? false : true,
  description: p.desc,
  license: "MIT",
  main: "dist/index.js",
  types: "dist/index.d.ts",
  scripts: {
    build: "tsc -p tsconfig.json",
    typecheck: "tsc -p tsconfig.json --noEmit",
    test: "vitest run --passWithNoTests",
    dev: "tsc -p tsconfig.json --watch",
  },
  dependencies: Object.fromEntries(
    Object.entries(p.deps).map(([k, v]) => [k, v.startsWith("workspace:") ? v : v]),
  ),
  devDependencies: Object.fromEntries(
    p.dev.map((d) => [d, d.startsWith("@nexus") ? "workspace:*" : V[d] ?? "*"]),
  ),
});

let created = 0;
let skipped = 0;
for (const p of pkgs) {
  const dir = join(ROOT, p.dir);
  const srcDir = join(dir, "src");
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  const pj = join(dir, "package.json");
  if (existsSync(pj)) {
    skipped++;
  } else {
    writeFileSync(pj, JSON.stringify(pkgJson(p), null, 2) + "\n", "utf8");
    created++;
  }
  const ts = join(dir, "tsconfig.json");
  if (!existsSync(ts)) {
    writeFileSync(
      ts,
      JSON.stringify(
        {
          extends: p.dir.startsWith("apps/") || p.dir.startsWith("tests/") || p.dir.startsWith("templates/")
            ? "../../tsconfig.base.json"
            : "../../tsconfig.base.json",
          compilerOptions: { outDir: "dist", rootDir: "src" },
          include: ["src/**/*.ts", "src/**/*.tsx"],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }
  // Index-stub bara om den saknas — byggarna skriver över den med riktig kod.
  const idx = join(srcDir, "index.ts");
  if (!existsSync(idx)) writeFileSync(idx, `// ${p.name} — implementeras av respektive builder.\nexport const PACKAGE_NAME = ${JSON.stringify(p.name)};\n`, "utf8");
  console.log(`pkg ${p.name.padEnd(26)} ${p.dir}`);
}

// ai-service är Python men behöver en package.json för att pnpm ska köra dess scripts.
const aiDir = join(ROOT, "apps/ai-service");
mkdirSync(join(aiDir, "app"), { recursive: true });
mkdirSync(join(aiDir, "tests"), { recursive: true });
if (!existsSync(join(aiDir, "package.json"))) {
  writeFileSync(
    join(aiDir, "package.json"),
    JSON.stringify(
      {
        name: "@nexus/ai-service",
        version: "1.0.0",
        private: true,
        description: "Python FastAPI-tjänst för röst (Whisper/Piper), vision (VLM/OCR) och embeddings/RAG.",
        license: "MIT",
        scripts: {
          setup: "bash ../../scripts/setup_ai_service.sh",
          start: "bash ../../scripts/start_ai_service.sh",
          test: "bash ../../scripts/test_ai_service.sh",
          build: "echo 'ai-service: ingen build-step (Python, körs från src)'",
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  created++;
}

for (const d of ["blueprints/raw", "scripts", "tests/unit", "assets", "resources"]) mkdirSync(join(ROOT, d), { recursive: true });

const npmrc = join(ROOT, ".npmrc");
if (!existsSync(npmrc)) {
  writeFileSync(
    npmrc,
    "strict-peer-dependencies=false\nauto-install-peers=true\nlink-workspace-packages=true\nenable-pre-post-scripts=true\n// electron: ingen signering i lokal build\nnode-linker=hoisted\n",
    "utf8",
  );
}

console.log(`\nscaffold: ${created} package.json skapade, ${skipped} befintliga behållna.`);

import { defineConfig } from "vitest/config";

/**
 * MCP-clienten borjar riktiga processer (vara servrar + git + skal). Dfor:
 * forks-pool (isolering), generosa timeouts och bara test/*.test.ts.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    pool: "forks",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 20_000,
  },
});

/**
 * Vitest-config för @nexus/ui — jsdom är tillåtet bara här (se CONVENTIONS.md).
 * Testerna täcker ren logik: rambrytning/kodning, transportval, flik-reducer,
 * fuzzy-match, ghost-text-maskin, trädbyggnad, godkännande, tema-upplösning, debounce.
 * Inga snapshot-soppior och inga test som hävdar nothing.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    globals: false,
    restoreMocks: true,
  },
});

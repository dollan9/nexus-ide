import { defineConfig } from "playwright/test";
export default defineConfig({
  testDir: "./specs",
  timeout: 180_000,
  expect: { timeout: 25_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "report.json" }]],
  use: { baseURL: "http://127.0.0.1:7947", trace: "off", screenshot: "only-on-failure", viewport: { width: 1600, height: 950 } },
});

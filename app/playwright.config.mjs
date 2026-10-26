import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.mjs",
  outputDir: "/tmp/excalidraw-browser-results",
  retries: 0,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: process.env.BROWSER_TEST_BASE_URL,
    browserName: "chromium",
  },
});

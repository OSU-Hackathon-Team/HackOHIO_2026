import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/studio", timeout: 90000, workers: 1,
  forbidOnly: !!process.env.CI,
  use: { baseURL: "http://127.0.0.1:5175", channel: process.env.PLAYWRIGHT_CHANNEL || undefined, headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" },
  reporter: "list",
  webServer: { command: "npm run dev -w @splice/frontend -- --host 127.0.0.1 --port 5175 --strictPort", url: "http://127.0.0.1:5175", reuseExistingServer: false, timeout: 60000 },
});

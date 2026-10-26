import { defineConfig, devices } from "@playwright/test";

/**
 * The webview, built (`npm run build`), in Chromium — the engine VS Code's
 * webviews run in — under the page and content security policy the extension
 * gives it, with VS Code's messaging stood in for. No server: the page and
 * the bundle are answered from memory and dist/ (see test/webview.ts).
 */
export default defineConfig({
  testDir: "./test",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
  ],
});

import { mkdirSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import { E2E_LINKED_DIR, E2E_TEMPLATES_DIR } from "./e2e/templates-dir";

// Before the dev server starts: it skips a linked folder that isn't there.
mkdirSync(E2E_LINKED_DIR, { recursive: true });

/**
 * End-to-end tests drive the example app (`example/`) in a real Chromium.
 *
 * The example is the integration the README promises — a host owning a
 * workspace of files, both editors controlled, save through the host, AI
 * through a proxied route — so it is the right surface to test end to end.
 * The dev server consumes the library from source, so no build is needed and
 * an edit to the package is exercised on the next run.
 *
 * A dedicated port keeps the suite off whatever `npm run dev` you have open.
 */
const PORT = Number(process.env.E2E_PORT ?? 5174);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // A wedged browser or dev server must never hold a CI job open indefinitely.
  globalTimeout: 15 * 60_000,
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Roomy enough that the toolbar never wraps and the inspector never
        // covers the canvas; the editor fills whatever box it is given.
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: {
    command: `npm run dev -w example -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    // Its own templates folder, and a linked folder standing in for one
    // outside the repo: the disk-sync spec reads and writes files there,
    // never in the repo's templates/ (see e2e/templates-dir.ts).
    env: { BD_TEMPLATES_DIR: E2E_TEMPLATES_DIR, BD_LINKED_DIRS: E2E_LINKED_DIR },
  },
});

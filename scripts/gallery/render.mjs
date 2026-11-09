/**
 * Pictures of documents as the studio of one checkout draws them. Each
 * checkout's example app is served on its own port, with its own templates
 * folder and Vite cache, nothing linked and the AI route off, so a run never
 * touches the repo's templates or another dev server.
 */
import { mkdirSync, rmSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "./engine.mjs";

const VIEWPORT = { width: 1500, height: 950 };

async function freePort() {
  return new Promise((done, fail) => {
    const server = netServer();
    server.unref();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

/** Serve a checkout's studio, run `work` against it, and stop it again. */
export async function withStudio(checkout, scratch, work) {
  const templates = join(scratch, "templates");
  mkdirSync(templates, { recursive: true });
  Object.assign(process.env, { BD_TEMPLATES_DIR: templates, BD_LINKED_DIRS: "", BD_AI: "off" });
  const vite = await import(pathToFileURL(join(REPO, "node_modules/vite/dist/node/index.js")).href);
  const port = await freePort();
  const server = await vite.createServer({
    root: join(checkout, "example"),
    configFile: join(checkout, "example/vite.config.js"),
    cacheDir: join(scratch, "vite-cache"),
    logLevel: "error",
    clearScreen: false,
    server: { port, strictPort: true, host: "127.0.0.1" },
  });
  await server.listen();
  const { chromium } = await import(pathToFileURL(join(REPO, "node_modules/playwright/index.mjs")).href);
  const browser = await chromium.launch();
  try {
    return await work({
      /** Draw one document and save the canvas as a PNG. */
      async shoot(doc, file, name = "gallery") {
        // The app keeps its documents on disk too, and disk wins at startup.
        rmSync(join(templates, "scratch"), { recursive: true, force: true });
        const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1.5, colorScheme: "light" });
        try {
          const page = await context.newPage();
          await page.addInitScript(
            ([d, n]) => {
              localStorage.setItem(
                "better-diagrams:workspace",
                JSON.stringify({ files: [{ id: "g", name: n, kind: "architecture", doc: d }], activeId: "g", removed: [] }),
              );
            },
            [doc, name],
          );
          await page.goto(`http://127.0.0.1:${port}/`);
          await page.waitForSelector(".as-root .react-flow__node", { timeout: 30000 });
          await page.waitForTimeout(900);
          const fit = page.locator(".react-flow__controls-fitview");
          if (await fit.count()) {
            await fit.click();
            await page.waitForTimeout(600);
          }
          await page.locator(".react-flow").screenshot({ path: file });
        } finally {
          await context.close();
        }
      },
      /** Screenshot a local HTML page (a contact sheet or a pair), full height. */
      async page(html, file, width = 1600) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
        try {
          const page = await context.newPage();
          await page.goto(pathToFileURL(html).href);
          await page.waitForLoadState("load");
          await page.screenshot({ path: file, fullPage: true });
        } finally {
          await context.close();
        }
      },
    });
  } finally {
    await browser.close();
    await server.close();
  }
}

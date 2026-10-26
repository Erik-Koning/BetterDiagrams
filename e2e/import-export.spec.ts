import { readFile, writeFile } from "node:fs/promises";
import { ARCH_FILE, exact, expect, SMALL_TEMPLATE, test } from "./fixtures";

async function downloadedText(download: Awaited<ReturnType<import("./fixtures").Studio["download"]>>) {
  const path = await download.path();
  expect(path, "download was saved to disk").toBeTruthy();
  return readFile(path!, "utf8");
}

test.describe("import and export", () => {
  test("an import opens as a new file beside a diagram with work in it, and in place over one node", async ({ page, studio }, testInfo) => {
    await studio.goto();
    const file = testInfo.outputPath("import.json");
    await writeFile(file, JSON.stringify(SMALL_TEMPLATE));

    await studio.importFile(file);

    // A file of its own, named by the document's title — and the editor on it says so.
    await expect(studio.fileButton).toHaveText(exact("Auth slice"));
    await expect(studio.toast).toHaveText("Loaded import.json · in a new file");
    // …and then lets it go, like any toast (the app runs in StrictMode).
    await expect(studio.toast).toHaveCount(0);
    await expect(studio.nodeTitled("Auth Service")).toBeVisible();
    await expect(studio.nodeTitled("Users DB")).toBeVisible();
    await expect(studio.nodeTitled("REST API")).toHaveCount(0);
    // The diagram it was imported over is untouched.
    await studio.openFile(ARCH_FILE);
    await expect(studio.nodeTitled("REST API")).toBeVisible();

    // A new file holding one starter node takes the import in place, after asking.
    await studio.newFile();
    await page.getByRole("dialog", { name: "Get started" }).getByRole("button", { name: /Insert Node Manually/ }).click();
    await expect(studio.page.locator(".react-flow__node")).toHaveCount(1);
    const before = (await studio.workspace()).files.length;
    await studio.importFile(file);
    await expect(studio.nodeTitled("Auth Service")).toBeVisible();
    await expect(studio.page.locator(".react-flow__node")).toHaveCount(2);
    expect((await studio.workspace()).files).toHaveLength(before);
  });

  test("exports the template as a JSON download", async ({ studio }) => {
    await studio.goto();

    const download = await studio.download(() => studio.fromMenu("Export", /^Template \(\.json\)/));
    expect(download.suggestedFilename()).toMatch(/\.json$/);

    const doc = JSON.parse(await downloadedText(download));
    expect(doc.nodes.map((node: { id: string }) => node.id)).toEqual(
      expect.arrayContaining(["cdn", "api", "pay"]),
    );
    expect(doc.edges.length).toBeGreaterThan(0);
  });

  test("exports Mermaid", async ({ studio }) => {
    await studio.goto();

    const download = await studio.download(() => studio.fromMenu("Export", /^Mermaid/));
    expect(download.suggestedFilename()).toMatch(/\.mmd$/);

    const text = await downloadedText(download);
    expect(text).toContain("flowchart LR");
    expect(text).toContain("REST API");
  });

  test("Show all lines in the page is saved with the diagram, and every export after opens with them shown", async ({ page, studio }) => {
    await studio.goto();
    const shown = (menu: Awaited<ReturnType<typeof studio.openMenu>>) =>
      menu.getByRole("checkbox", { name: "Show all lines in the page" });
    await shown(await studio.openMenu("Export")).check();
    await expect(studio.toast).toHaveText("Interactive HTML opens with every line shown");
    await page.keyboard.press("Escape");
    // A document setting: it comes back with the diagram.
    await studio.save();
    await studio.goto();
    await expect(shown(await studio.openMenu("Export"))).toBeChecked();
    await page.keyboard.press("Escape");

    const download = await studio.download(() => studio.fromMenu("Export", /^Interactive HTML/));
    // Saved under its own name: a file without an extension opens as text.
    const file = test.info().outputPath("export.html");
    await download.saveAs(file);
    await page.goto(`file://${file}`);
    await expect(page.locator("#bd-alllines")).toBeChecked();
    await expect(page.locator("body")).not.toHaveClass(/bd-lines-hover/);
    // The page's own check still turns lines on hover back on.
    await page.locator("#bd-menu").click();
    await page.locator("#bd-alllines").uncheck();
    await expect(page.locator("body")).toHaveClass(/bd-lines-hover/);
  });

  test.describe("a registry exporter", () => {
    test.use({ permissions: ["clipboard-read", "clipboard-write"] });

    test("appears in the Export menu and runs the host's code", async ({ page, studio }) => {
      await studio.goto();

      // `Copy summary` is registered by example/src/extensions.js — nothing
      // in the library knows about it.
      await studio.fromMenu("Export", /^Copy summary/);

      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toMatch(/\d+ nodes, \d+ connections/);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Connections:");
    });
  });
});

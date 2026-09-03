import { readFile, writeFile } from "node:fs/promises";
import { expect, SMALL_TEMPLATE, test } from "./fixtures";

async function downloadedText(download: Awaited<ReturnType<import("./fixtures").Studio["download"]>>) {
  const path = await download.path();
  expect(path, "download was saved to disk").toBeTruthy();
  return readFile(path!, "utf8");
}

test.describe("import and export", () => {
  test("imports a template file from disk, replacing the document", async ({ page, studio }, testInfo) => {
    await studio.goto();
    const file = testInfo.outputPath("import.json");
    await writeFile(file, JSON.stringify(SMALL_TEMPLATE));

    const chooser = page.waitForEvent("filechooser");
    await studio.root.getByRole("button", { name: "Import", exact: true }).click();
    await (await chooser).setFiles(file);

    await expect(studio.nodeTitled("Auth Service")).toBeVisible();
    await expect(studio.nodeTitled("Users DB")).toBeVisible();
    await expect(studio.nodeTitled("REST API")).toHaveCount(0);
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

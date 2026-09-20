import { readFile } from "node:fs/promises";
import { expect, test } from "./fixtures";

/**
 * Picture exports render the live canvas through the browser — html-to-image,
 * canvas, and the PDF writer. The example has provider variants and dated
 * elements, so each format first asks which states to export.
 */
const FORMATS = [
  { item: /^PNG image/, ext: "png", check: (data: Buffer) => expect(data.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { item: /^SVG vector/, ext: "svg", check: (data: Buffer) => expect(data.toString("utf8")).toMatch(/<svg[\s>]/) },
  { item: /^PDF document/, ext: "pdf", check: (data: Buffer) => expect(data.subarray(0, 5).toString("latin1")).toBe("%PDF-") },
] as const;

test.describe("picture exports", () => {
  for (const { item, ext, check } of FORMATS) {
    test(`exports the current state as ${ext.toUpperCase()}`, async ({ page, studio }) => {
      await studio.goto();
      await studio.fromMenu("Export", item);

      const dialog = page.getByRole("dialog", { name: `Export ${ext.toUpperCase()}` });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("radio", { name: /Current state/ })).toBeChecked();

      const download = await studio.download(() =>
        dialog.getByRole("button", { name: "Export", exact: true }).click(),
      );
      expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${ext}$`));
      const path = await download.path();
      expect(path).toBeTruthy();
      const data = await readFile(path!);
      expect(data.length).toBeGreaterThan(1000);
      check(data);
      await expect(dialog).toBeHidden();
    });
  }
});

/**
 * Marketing's gradient setting, end to end: the host's Gradients toggle
 * (shown only in marketing mode) flips the root class, the stylesheet paints
 * the cards flat, and the SVG that comes out has no gradient in it. jsdom
 * cannot compute a `background-image`, so the screen half lives here.
 */
test.describe("marketing without gradients", () => {
  test("flattens the cards on screen and strips gradients from the SVG export", async ({ page, studio }) => {
    await studio.goto();
    const gradientsToggle = page.getByLabel("Gradients", { exact: true });
    // Technical has none to switch off, so the host does not offer it.
    await expect(gradientsToggle).toHaveCount(0);

    await page.getByLabel("Marketing", { exact: true }).check();
    await expect(studio.root).toHaveClass(/as-root--marketing/);
    await expect(gradientsToggle).toBeChecked();
    const card = studio.root.locator(".as-node:not(.as-node--shaped)").first();
    await expect(card).toHaveCSS("background-image", /linear-gradient/);

    await gradientsToggle.uncheck();
    await expect(studio.root).toHaveClass(/as-root--no-gradients/);
    await expect(card).toHaveCSS("background-image", "none");
    // The flat coat is a colour, not the transparent a bare `background:`
    // reset would leave.
    await expect(card).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

    const svgOf = async () => {
      await studio.fromMenu("Export", /^SVG vector/);
      const dialog = page.getByRole("dialog", { name: "Export SVG" });
      const download = await studio.download(() =>
        dialog.getByRole("button", { name: "Export", exact: true }).click(),
      );
      return readFile((await download.path())!, "utf8");
    };
    const flat = await svgOf();
    expect(flat).not.toMatch(/<linearGradient/);
    expect(flat).toMatch(/<feDropShadow /);

    // And back on: the same export carries them again.
    await gradientsToggle.check();
    await expect(studio.root).not.toHaveClass(/as-root--no-gradients/);
    await expect(card).toHaveCSS("background-image", /linear-gradient/);
    expect(await svgOf()).toMatch(/<linearGradient/);
  });
});

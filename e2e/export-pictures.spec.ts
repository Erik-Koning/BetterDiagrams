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

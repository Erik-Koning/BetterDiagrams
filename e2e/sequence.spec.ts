import { readFile } from "node:fs/promises";
import { SEQ_FILE, expect, test } from "./fixtures";

test.describe("editing a sequence", () => {
  test("adds a participant, renames it, saves, and reloads", async ({ page, studio }) => {
    await studio.goto();
    await studio.openFile(SEQ_FILE);

    await studio.fromMenu("Insert", /^Participant /);
    await expect(studio.participant("New Participant")).toBeVisible();
    // Selecting the new column opens its inspector.
    await studio.participant("New Participant").click();

    const label = studio.inspector.getByLabel("Participant label", { exact: true });
    await expect(label).toHaveValue("New Participant");
    await label.fill("Inventory");
    await expect(studio.participant("Inventory")).toBeVisible();

    await studio.save();
    await page.reload();
    await expect(studio.fileButton).toHaveText(new RegExp(`^${SEQ_FILE}`));
    await expect(studio.participant("Inventory")).toBeVisible();
  });

  test("undo removes the added participant", async ({ studio }) => {
    await studio.goto();
    await studio.openFile(SEQ_FILE);
    await expect(studio.undoButton).toBeDisabled();

    await studio.fromMenu("Insert", /^Actor /);
    await expect(studio.participant("New Actor")).toBeVisible();

    await expect(studio.undoButton).toBeEnabled();
    await studio.undoButton.click();
    await expect(studio.participant("New Actor")).toHaveCount(0);
  });

  test("the live template panel counts participants and messages", async ({ page, studio }) => {
    await studio.goto();
    await studio.openFile(SEQ_FILE);

    const json = await studio.showJson();
    await expect(json).toContainText('"label": "Order API"');
    await expect(page.locator(".app__meta")).toHaveText(/5 participants · 9 messages/);
  });

  test("exports the sequence as Mermaid", async ({ studio }) => {
    await studio.goto();
    await studio.openFile(SEQ_FILE);

    const download = await studio.download(() => studio.fromMenu("Export", /^Mermaid/));
    const path = await download.path();
    expect(path).toBeTruthy();
    const text = await readFile(path!, "utf8");
    expect(text).toContain("sequenceDiagram");
    expect(text).toContain("Customer");
    expect(text).toContain("POST /orders");
  });
});

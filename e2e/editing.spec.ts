import { expect, test } from "./fixtures";

test.describe("editing an architecture", () => {
  test("inserts a node and renames it from the inspector", async ({ studio }) => {
    await studio.goto();

    await studio.fromMenu("Insert", /^Node /);
    await expect(studio.nodeTitled("New Service")).toBeVisible();
    await expect(studio.selectedNodes).toHaveCount(1);

    const label = studio.inspector.getByLabel("Node label", { exact: true });
    await expect(label).toHaveValue("New Service");
    await label.fill("Checkout Service");

    await expect(studio.nodeTitled("Checkout Service")).toBeVisible();
    await expect(studio.nodeTitled("New Service")).toHaveCount(0);
  });

  test("undo removes an inserted node and redo brings it back", async ({ studio }) => {
    await studio.goto();
    await expect(studio.undoButton).toBeDisabled();

    await studio.fromMenu("Insert", /^Node /);
    await expect(studio.nodeTitled("New Service")).toBeVisible();

    await expect(studio.undoButton).toBeEnabled();
    await studio.undoButton.click();
    await expect(studio.nodeTitled("New Service")).toHaveCount(0);

    await expect(studio.redoButton).toBeEnabled();
    await studio.redoButton.click();
    await expect(studio.nodeTitled("New Service")).toBeVisible();
  });

  test("saving writes the document to the host and survives a reload", async ({ page, studio }) => {
    await studio.goto();

    await studio.fromMenu("Insert", /^Node /);
    await studio.inspector.getByLabel("Node label", { exact: true }).fill("Checkout Service");
    await studio.save();

    const workspace = await studio.workspace();
    const active = workspace.files.find((file) => file.id === workspace.activeId);
    expect(active?.doc.nodes?.map((node) => node.label)).toContain("Checkout Service");

    // Unsaved changes are flagged against the last save.
    await studio.inspector.getByLabel("Node label", { exact: true }).fill("Checkout API");
    await expect(studio.saveButton).toHaveText("Save •");
    await studio.save();

    // Live edits stay in memory; only Save writes through — so what comes
    // back after a reload is exactly what the host was handed.
    await page.reload();
    await expect(studio.nodeTitled("Checkout API")).toBeVisible();
    await expect(studio.saveButton).toHaveText("Save");
  });

  test("the live template panel mirrors the document and highlights the selection", async ({ page, studio }) => {
    await studio.goto();
    const json = await studio.showJson();

    await expect(json).toContainText('"label": "REST API"');
    await expect(page.locator(".app__meta")).toHaveText(/\d+ nodes · \d+ edges/);

    await studio.node("api").click();
    await expect(page.locator(".app__json-hit")).toContainText('"id": "api"');

    await studio.inspector.getByLabel("Node label", { exact: true }).fill("Public API");
    await expect(json).toContainText('"label": "Public API"');
  });

  test("keyboard: search, the shortcut sheet, and save", async ({ page, studio }) => {
    await studio.goto();
    await studio.focusEditor();

    await page.keyboard.press("ControlOrMeta+k");
    const search = studio.root.getByLabel("Search nodes", { exact: true });
    await expect(search).toBeFocused();
    await search.fill("Worker");
    await expect(studio.root.locator(".as-search__count")).toHaveText("1/1");
    await page.keyboard.press("Escape");
    await expect(search).toHaveValue("");

    await studio.focusEditor();
    await page.keyboard.press("?");
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    await studio.fromMenu("Insert", /^Node /);
    await studio.focusEditor();
    await page.keyboard.press("ControlOrMeta+s");
    await expect(studio.toast).toHaveText("Saved");
    await expect(studio.saveButton).toHaveText("Save");
  });
});

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

  test("an edit made before the session's first save is flagged, and survives save + reload", async ({ page, studio }) => {
    await studio.goto();
    await expect(studio.saveButton).toHaveText("Save");

    // Recolour a line on a freshly loaded diagram. The button used to keep
    // reading "Save — everything is saved" until the first save of the
    // session had happened, so a reload here silently lost the change.
    await page.locator(".as-edge__hit").first().click({ force: true });
    const rose = studio.inspector.getByRole("button", { name: "Edge colour rose" });
    await rose.click();
    await expect(rose).toHaveAttribute("aria-pressed", "true");
    await expect(studio.saveButton).toHaveText("Save •");

    await studio.save();
    await page.reload();
    await expect(studio.saveButton).toHaveText("Save");
    await page.locator(".as-edge__hit").first().click({ force: true });
    await expect(studio.inspector.getByRole("button", { name: "Edge colour rose" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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

  test.describe("copy, paste, duplicate", () => {
    test.use({ permissions: ["clipboard-read", "clipboard-write"] });

    // Asserted on the lines as DRAWN, not as stored. The reported bug left
    // the document intact — every jsdom test of the paste passed — while the
    // canvas lost every edge: a rebuild plus a deferred re-select stripped
    // React Flow of the node geometry it draws edges from. Only a real
    // browser, with a real ResizeObserver, sees that.
    test("pasting a node keeps every line on the canvas and selects the copy", async ({ page, studio }) => {
      await studio.goto();
      const before = await studio.drawnEdges.count();
      expect(before).toBeGreaterThan(0);

      await studio.node("api").click();
      await page.keyboard.press("ControlOrMeta+c");
      await expect(studio.toast).toHaveText("Copied 1 node");
      await page.keyboard.press("ControlOrMeta+v");
      await expect(studio.toast).toHaveText("Pasted 1 node");

      // A single-node fragment carries no lines, so the count must hold —
      // and stay held once React Flow has re-measured the new node.
      await expect(studio.selectedNodes).toHaveCount(1);
      await expect(studio.selectedNodes).not.toHaveAttribute("data-id", "api");
      await page.waitForTimeout(250);
      await expect(studio.drawnEdges).toHaveCount(before);

      // …and the copy's lines come with a duplicate, then leave with undo.
      await studio.node("api").click();
      await page.keyboard.press("ControlOrMeta+d");
      await expect(studio.toast).toContainText("Duplicated");
      await page.waitForTimeout(250);
      expect(await studio.drawnEdges.count()).toBeGreaterThan(before);

      await studio.undoButton.click();
      await page.waitForTimeout(250);
      await expect(studio.drawnEdges).toHaveCount(before);
    });
  });
});

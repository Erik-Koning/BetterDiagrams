import { expect, test } from "./fixtures";

/**
 * The side arrows off a selected card, where layout is real: jsdom measures
 * every box as zero, so only here can they be seen to stand OFF each side and
 * the new box to land beside its source with the arrow drawn between them.
 */
test.describe("quick-add arrows", () => {
  test("stand off each side of a selected card and add a connected box there", async ({ page, studio }) => {
    await studio.goto();
    await studio.fromMenu("Insert", /^Node /);
    const source = studio.selectedNodes;
    await expect(source).toHaveCount(1);
    const sourceId = (await source.getAttribute("data-id"))!;

    const arrow = (where: string) => page.getByRole("button", { name: `Add a connected Service ${where}` });
    for (const where of ["above", "to the right", "below", "to the left"]) await expect(arrow(where)).toBeVisible();

    const card = (await source.boundingBox())!;
    const right = (await arrow("to the right").boundingBox())!;
    const above = (await arrow("above").boundingBox())!;
    // Off the card, not on it, and centred on the side it adds to.
    expect(right.x).toBeGreaterThan(card.x + card.width + 8);
    expect(Math.abs(right.y + right.height / 2 - (card.y + card.height / 2))).toBeLessThan(2);
    expect(above.y + above.height).toBeLessThan(card.y - 8);
    expect(Math.abs(above.x + above.width / 2 - (card.x + card.width / 2))).toBeLessThan(2);

    await arrow("to the right").click();

    // The new box is selected, its name open to type into.
    const name = page.getByRole("textbox", { name: "Name", exact: true });
    await expect(name).toBeFocused();
    await name.fill("Quick ledger");
    await name.press("Enter");
    await expect(studio.nodeTitled("Quick ledger")).toBeVisible();

    const added = studio.selectedNodes;
    await expect(added).toHaveCount(1);
    const addedId = (await added.getAttribute("data-id"))!;
    expect(addedId).not.toBe(sourceId);
    const box = (await added.boundingBox())!;
    expect(box.x).toBeGreaterThan(card.x + card.width);
    expect(Math.abs(box.y - card.y)).toBeLessThan(2);

    await expect
      .poll(async () => (await studio.liveDoc()).edges.filter((e) => e.source === sourceId && e.target === addedId).length)
      .toBe(1);
    await expect(page.locator(`.react-flow__edge[data-id]`).last()).toBeVisible();

    // The arrows moved on to the new box; a second click to the right of the
    // FIRST box fans out below the one already there rather than on top of it.
    await studio.node(sourceId).click();
    await arrow("to the right").click();
    await page.getByRole("textbox", { name: "Name", exact: true }).press("Escape");
    const third = (await studio.selectedNodes.boundingBox())!;
    expect(Math.abs(third.x - box.x)).toBeLessThan(2);
    expect(third.y).toBeGreaterThan(box.y + box.height);
  });

  test("hide on a multi-selection and under the Select tool", async ({ page, studio }) => {
    await studio.goto();
    await studio.fromMenu("Insert", /^Node /);
    const inserted = (await studio.selectedNodes.getAttribute("data-id"))!;
    const arrows = page.getByRole("button", { name: /^Add a connected / });
    await expect(arrows).toHaveCount(4);

    await page.locator(`.react-flow__node-shape:not([data-id="${inserted}"])`).first().click({ modifiers: ["Shift"] });
    await expect(studio.selectedNodes).toHaveCount(2);
    await expect(arrows).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(studio.selectedNodes).toHaveCount(0);
    await studio.node(inserted).click();
    await expect(arrows).toHaveCount(4);
    await studio.pickTool("Select");
    await expect(arrows).toHaveCount(0);
  });
});

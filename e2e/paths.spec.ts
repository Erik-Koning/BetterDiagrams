import { expect, test } from "./fixtures";

test.describe("paths", () => {
  test("lighting a path glows its members and never touches the document", async ({ studio, page }) => {
    await studio.goto();

    // Offered because the example names two flows. The label counts the lit ones.
    const menuButton = studio.root.getByRole("button", { name: /^Paths/ });
    await expect(menuButton).toHaveText("Paths");
    await menuButton.click();
    const menu = studio.root.getByRole("menu");
    await menu.getByRole("checkbox", { name: "Background job" }).check();

    // api → queue → worker glow; the CDN, which is on the other flow, does not.
    await expect(studio.node("q")).toHaveClass(/as-path-node/);
    await expect(studio.node("wrk")).toHaveClass(/as-path-node/);
    await expect(studio.node("cdn")).not.toHaveClass(/as-path-node/);
    // Presence, not visibility: a dead-vertical line has a zero-width box,
    // which Playwright reads as hidden however brightly it is stroked.
    const flow = page.locator('.react-flow__edge[data-id="z6"] .as-edge__flow');
    await expect(flow).toHaveCount(1);
    await expect(flow).toHaveClass(/as-edge--c-violet/);
    await expect(page.locator('.react-flow__edge[data-id="z1"] .as-edge__flow')).toHaveCount(0);
    await expect(studio.root.locator(".as-legend")).toContainText("Background job");
    await expect(menuButton).toHaveText("Paths (1)");

    // Everything at once.
    await menu.getByRole("menuitem", { name: "Select all" }).click();
    await expect(studio.node("cdn")).toHaveClass(/as-path-node/);
    await expect(studio.root.locator(".as-legend")).toContainText("Checkout charge");

    // The document still names both paths — before and after an edit that
    // re-derives it from the canvas (which has no representation of them).
    let doc = await studio.liveDoc();
    expect(doc.paths).toHaveLength(2);
    await studio.dragNode("q", 40, 0);
    doc = await studio.liveDoc();
    expect(doc.paths).toHaveLength(2);
    await expect(studio.node("q")).toHaveClass(/as-path-node/);

    // Lights out.
    await menuButton.click();
    await studio.root.getByRole("menu").getByRole("menuitem", { name: "Clear" }).click();
    await expect(studio.node("q")).not.toHaveClass(/as-path-node/);
    await expect(page.locator(".as-edge__flow")).toHaveCount(0);
    await expect(studio.root.locator(".as-legend")).not.toContainText("Background job");
    await expect(menuButton).toHaveText("Paths");
  });
});

test.describe("paths in the interactive HTML export", () => {
  test("the exported page lights a path from its own menu", async ({ studio, page }) => {
    await studio.goto();
    const download = await studio.download(() => studio.fromMenu("Export", /^Interactive HTML/));
    // Saved under its own name: the download's temp path has no extension,
    // and a file without one opens as text rather than as a page.
    const file = test.info().outputPath("export.html");
    await download.saveAs(file);
    await page.goto(`file://${file}`);

    await page.locator("#bd-menu").click();
    await expect(page.locator("#bd-pathlegend")).toBeHidden();
    await page.getByRole("checkbox", { name: "Background job" }).check();
    // The overlays are extra strokes cloned into the tagged groups.
    await expect(page.locator('[data-el="edge:z6"] .bd-flowline')).toHaveCount(1);
    await expect(page.locator('[data-el="node:q"] .bd-glowbody')).toHaveCount(1);
    await expect(page.locator('[data-el="node:cdn"] .bd-glowbody')).toHaveCount(0);
    await expect(page.locator("#bd-pathlegend")).toContainText("Background job");

    await page.locator("#bd-paths-all").click();
    await expect(page.locator('[data-el="node:cdn"] .bd-glowbody')).toHaveCount(1);
    await page.locator("#bd-paths-none").click();
    await expect(page.locator("[data-path]")).toHaveCount(0);
    await expect(page.locator("#bd-pathlegend")).toBeHidden();
  });
});

/**
 * Fields beyond the rows: the row menu, pins, the paths panel, the grid and
 * field search — on a small data model imported through the toolbar.
 */
import { writeFile } from "node:fs/promises";
import { expect, test } from "./fixtures";

const table = (id: string, label: string, fields: Array<Record<string, unknown>>, x: number, y: number, over: Record<string, unknown> = {}) => ({
  id, label, kind: "table", icon: "none", description: "", parentId: null, x, y, w: 230, h: 120, fields, ...over,
});

const DATA_MODEL = {
  version: 1,
  meta: { title: "Shop data model" },
  nodes: [
    table("users", "Users", [{ id: "id", name: "id", key: "pk" }, { id: "email", name: "email", type: "text" }], 80, 120),
    table("orders", "Orders", [{ id: "id", name: "id", key: "pk" }, { id: "user_id", name: "user_id", key: "fk", type: "→ users" }], 480, 120, {
      data: { fields: [{ name: "id", type: "uuid" }, { name: "user_id", type: "uuid", relationship: { referenceTo: ["Users"] } }, { name: "total", type: "money" }] },
    }),
    table("items", "Items", [{ id: "id", name: "id", key: "pk" }, { id: "order_id", name: "order_id", key: "fk" }], 880, 120),
    table("logs", "Logs", [{ id: "id", name: "id", key: "pk" }], 480, 420),
  ],
  edges: [
    { id: "o-u", source: "orders", target: "users", label: "", style: "solid", color: "slate", startField: "user_id", endField: "id" },
    { id: "i-o", source: "items", target: "orders", label: "", style: "solid", color: "slate", startField: "order_id", endField: "id" },
  ],
};

test.describe("fields", () => {
  test.beforeEach(async ({ studio }, testInfo) => {
    await studio.goto();
    const file = testInfo.outputPath("data-model.json");
    await writeFile(file, JSON.stringify(DATA_MODEL));
    await studio.importFile(file);
    await expect(studio.nodeTitled("Orders")).toBeVisible();
  });

  test("a row click opens the field menu, never the node menu, and never moves the node", async ({ studio }) => {
    const before = (await studio.liveDoc()).nodes.find((n) => n.id === "orders")!;
    const menu = await studio.openFieldMenu("orders", "user_id");
    await expect(menu.getByText("Orders · user_id")).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /Pin for search/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Duplicate" })).toHaveCount(0);
    await studio.page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    const after = (await studio.liveDoc()).nodes.find((n) => n.id === "orders")!;
    expect([after.x, after.y]).toEqual([before.x, before.y]);
  });

  test("pin two fields, show paths, hover a route, and the document never learns", async ({ studio }) => {
    const docBefore = await studio.liveDoc();
    let menu = await studio.openFieldMenu("items", "order_id");
    await menu.getByRole("menuitem", { name: /Pin for search/ }).click();
    await expect(studio.fieldRow("items", "order_id")).toHaveClass(/as-node__field--pinned/);
    menu = await studio.openFieldMenu("users", "id");
    await menu.getByRole("menuitem", { name: /Pin for search/ }).click();
    await expect(studio.pinStrip.getByRole("button", { name: "Show paths" })).toBeEnabled();

    await studio.pinStrip.getByRole("button", { name: "Show paths" }).click();
    await expect(studio.pathPanel).toBeVisible();
    const route = studio.pathPanel.getByRole("button", { name: /Items\.order_id → Orders → Users\.id/ });
    await expect(route).toBeVisible();
    await expect(studio.node("orders")).toHaveClass(/as-path-node/);
    await expect(studio.node("logs")).not.toHaveClass(/as-path-node/);
    await route.hover();
    await expect(studio.node("orders")).toHaveClass(/as-path-node/);

    // A drag moves the node, keeps the pins, and writes no path into the document.
    await studio.dragNode("orders", 60, 40);
    await expect(studio.pinStrip).toBeVisible();
    const docAfter = await studio.liveDoc();
    expect(docAfter.paths).toEqual(docBefore.paths);
    await studio.pathPanel.getByRole("button", { name: "Close paths panel" }).click();
    await expect(studio.pathPanel).toBeHidden();
  });

  test("the field grid sorts, filters, and downloads CSV", async ({ studio }) => {
    const menu = await studio.openFieldMenu("orders", "user_id");
    await menu.getByRole("menuitem", { name: "View all fields" }).click();
    const grid = studio.fieldGrid("Orders");
    await expect(grid).toBeVisible();
    await expect(grid.getByRole("row")).toHaveCount(4); // header + 3
    await grid.getByRole("columnheader", { name: /Type/ }).getByRole("button").click();
    await expect(grid.getByRole("columnheader", { name: /Type/ })).toHaveAttribute("aria-sort", "ascending");
    await grid.getByRole("searchbox", { name: "Filter fields" }).fill("total");
    await expect(grid.getByRole("row")).toHaveCount(2);
    const download = studio.page.waitForEvent("download");
    await grid.getByRole("button", { name: "Download CSV" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/orders-fields\.csv$/);
    const text = await (await file.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks as Buffer[]).toString("utf8"));
    expect(text.split("\r\n")[0]).toMatch(/^Key,Name,Label,Type/);
    expect(text).toContain("total");
    await studio.page.keyboard.press("Escape");
    await expect(grid).toBeHidden();
  });

  test("a table pin, the key on each hop, and the badge on a singled-out route", async ({ studio, page }) => {
    // The title, not the card's centre — a record node's centre is a field row, which opens the field menu.
    await studio.node("users").locator(".as-node__title").click({ button: "right" });
    const nodeMenu = page.getByRole("menu", { name: "Actions" });
    await nodeMenu.getByRole("menuitem", { name: /Pin table for search/ }).click();
    await expect(studio.pinStrip.getByRole("button", { name: "Users", exact: true })).toBeVisible();
    const menu = await studio.openFieldMenu("items", "order_id");
    await menu.getByRole("menuitem", { name: /Pin for search/ }).click();
    await studio.pinStrip.getByRole("button", { name: "Show paths" }).click();
    // Pinned table first, then the field: the route reads from the first pin to the second.
    const route = studio.pathPanel.getByRole("button", { name: /Users → Orders → Items\.order_id/ });
    await expect(route).toContainText("user_id▸order_id");
    // The only route is singled out: bright, with the key on each hop.
    await expect(page.locator(".as-edge__routekeytext")).toHaveCount(2);
    await expect(page.locator(".as-edge__routekeytext").filter({ hasText: "user_id" })).toBeVisible();
    // One route ranks nothing: the hop strip above already names its keys.
    await expect(studio.pathPanel.getByRole("region", { name: "Keys most routes use" })).toHaveCount(0);
  });

  test("key coverage scores a chosen set of keys and finds the smallest", async ({ studio }) => {
    await studio.fromMenu("View", /Key coverage/);
    const panel = studio.page.getByRole("region", { name: "Key coverage" });
    await expect(panel).toBeVisible();
    await expect(panel.locator(".as-coverage__pct")).toHaveText("0%");
    await panel.getByRole("region", { name: "Candidate keys" }).getByRole("button", { name: /Orders · user_id/ }).click();
    await expect(panel.locator(".as-coverage__pct")).toHaveText("50%");
    await expect(studio.node("logs").locator(".as-node--dimmed")).toHaveCount(1);
    await panel.getByRole("button", { name: "Find smallest set" }).click();
    await expect(panel.locator(".as-coverage__pct")).toHaveText("75%");
    await expect(panel.getByText(/Smallest set, proven/)).toBeVisible();
    await studio.page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });

  test("show references marks the key's table and the referencing one, fades the rest, and a click on empty canvas lifts it", async ({ studio }) => {
    const menu = await studio.openFieldMenu("users", "id");
    await menu.getByRole("menuitem", { name: /Show references \(1\)/ }).click();
    const card = (id: string) => studio.page.locator(`.react-flow__node[data-id="${id}"] .as-node`);
    await expect(card("orders")).toHaveClass(/as-node--match/);
    await expect(card("users")).toHaveClass(/as-node--match/);
    await expect(card("items")).toHaveClass(/as-node--unmarked/);
    await expect(card("logs")).toHaveClass(/as-node--unmarked/);
    // Somewhere on the bare pane — not a card, not a floating panel.
    const spot = await studio.page.evaluate(() => {
      const pane = document.querySelector(".react-flow__pane")!;
      const r = pane.getBoundingClientRect();
      for (const [fx, fy] of [[0.5, 0.5], [0.1, 0.9], [0.9, 0.1], [0.5, 0.9], [0.1, 0.5], [0.9, 0.5], [0.3, 0.3]]) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        if (document.elementFromPoint(x, y) === pane) return { x, y };
      }
      return null;
    });
    expect(spot).not.toBeNull();
    await studio.page.mouse.click(spot!.x, spot!.y);
    await expect(card("orders")).not.toHaveClass(/as-node--match/);
    await expect(card("items")).not.toHaveClass(/as-node--unmarked/);
  });

  test("search finds a field and marks its row", async ({ studio }) => {
    const search = studio.root.getByLabel("Search nodes and fields", { exact: true });
    await search.fill("user_id");
    await expect(studio.root.getByText("Orders · user_id")).toBeVisible();
    await search.press("Enter");
    await expect(studio.fieldRow("orders", "user_id")).toHaveClass(/as-node__field--match/);
  });

  test("key usage: search a field name, pick it, and see the share of tables that carry it", async ({ studio, page }) => {
    await studio.fromMenu("View", /^Key usage/);
    const panel = studio.root.getByRole("region", { name: "Key usage" });
    await expect(panel).toBeVisible();
    // It opens in the left sidebar, where the paths and references panels live.
    const box = (await panel.boundingBox())!;
    const canvas = (await studio.canvas.boundingBox())!;
    expect(box.x).toBeLessThan(canvas.x + canvas.width / 2);

    await panel.getByRole("searchbox", { name: "Search field names or keys" }).fill("user");
    await panel.getByRole("searchbox").press("Enter");
    await expect(panel.getByText("1 of 4 tables use them")).toBeVisible();
    await expect(panel.locator(".as-coverage__pct")).toHaveText("25%");
    await panel.getByRole("checkbox", { name: "Count the tables they point at" }).check();
    await expect(panel.locator(".as-coverage__pct")).toHaveText("50%");
    await expect(studio.page.locator('.react-flow__node[data-id="logs"] .as-node--dimmed')).toHaveCount(1);

    await panel.getByRole("region", { name: "Tables using them" }).getByRole("button", { name: /Orders/ }).click();
    await expect(studio.fieldRow("orders", "user_id")).toHaveClass(/as-node__field--match/);
    await studio.focusEditor();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });

  test("the interactive HTML export searches and traces the same model", async ({ studio, page }) => {
    const download = await studio.download(() => studio.fromMenu("Export", /^Interactive HTML/));
    const file = test.info().outputPath("model.html");
    await download.saveAs(file);
    await page.goto(`file://${file}`);
    const row = (nodeId: string, fieldId: string) => page.locator(`[data-el="node:${nodeId}"] rect.bd-row[data-field="${fieldId}"]`);
    const menu = page.locator("#bd-context");
    const panel = page.locator("#bd-panel");

    // A field the card doesn't draw: the hit names it, Enter opens the grid on it.
    const search = page.getByLabel("Search nodes and fields");
    await search.fill("total");
    await expect(page.locator("#bd-searchcount")).toHaveText("1/1");
    await search.press("Enter");
    await expect(page.locator("#bd-searchhit")).toHaveText("Orders · total (not a row)");
    await expect(page.locator("#bd-grid tr.bd-grid__hit")).toContainText("money");
    await page.keyboard.press("Escape");
    await expect(page.locator("#bd-grid")).toBeHidden();

    // Pin two fields from their rows; the routes between them light up.
    await row("items", "order_id").click();
    await menu.getByRole("menuitem", { name: /Pin for search/ }).click();
    await row("users", "id").click();
    await menu.getByRole("menuitem", { name: /Pin for search/ }).click();
    await page.locator("#bd-pinstrip").getByRole("button", { name: "Show paths" }).click();
    const route = panel.getByRole("button", { name: /Items\.order_id → Orders → Users\.id/ });
    await expect(route).toBeVisible();
    // First the direct answer, as in the editor: these two join only through Orders.
    await expect(panel.getByRole("region", { name: "Keys joining the pins" })).toContainText("No key joins them directly; see the routes below.");
    expect(await panel.locator("section[aria-label]").evaluateAll((els) => els.slice(0, 2).map((el) => el.getAttribute("aria-label")))).toEqual(["Keys joining the pins", "Routes"]);
    await expect(page.locator('[data-el="edge:i-o"] [data-route]').first()).toBeAttached();
    await expect(page.locator('[data-el="node:logs"] [data-route]')).toHaveCount(0);
    // Singled out, every hop names its key.
    await route.hover();
    await expect(page.locator(".bd-x-keybadge")).toHaveCount(2);
    expect((await page.locator(".bd-x-keybadge").allTextContents()).sort()).toEqual(["order_id", "user_id"]);

    // The other direction: what points at a key.
    await row("users", "id").click();
    await menu.getByRole("menuitem", { name: /Show references \(1\)/ }).click();
    await expect(panel).toContainText("Orders.user_id → id");
    await expect(row("orders", "user_id")).toHaveClass(/bd-x-match/);
    await expect(page.locator('[data-el="node:logs"]')).toHaveClass(/bd-x-unmarked/);
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(page.locator(".bd-x-match")).toHaveCount(0);

    // Key usage, in the same left sidebar: which tables carry a field.
    await page.locator("#bd-usagebtn").click();
    await expect(panel).toHaveAttribute("aria-label", "Key usage");
    expect((await panel.boundingBox())!.x).toBeLessThan(100);
    const usage = page.getByLabel("Search field names or keys");
    await usage.fill("user");
    await usage.press("Enter");
    await expect(page.locator(".bd-stat__pct")).toHaveText("25%");
    await expect(page.locator(".bd-stat__detail")).toHaveText("1 of 4 tables use them");
    await expect(page.locator('[data-el="node:logs"]')).toHaveClass(/bd-x-dim/);
    await panel.getByRole("checkbox", { name: "Count the tables they point at" }).check();
    await expect(page.locator(".bd-stat__pct")).toHaveText("50%");
  });
  test("impact, model structure, and a saved analysis that comes back from the Analyses menu", async ({ studio }) => {
    const menu = await studio.openFieldMenu("users", "id");
    await menu.getByRole("menuitem", { name: /Show impact/ }).click();
    const impact = studio.root.getByRole("region", { name: "Impact" });
    await expect(impact.getByRole("status")).toHaveText("2 tables depend on Users · id");
    await expect(studio.page.locator('.react-flow__node[data-id="logs"] .as-node--dimmed')).toHaveCount(1);

    await studio.fromMenu("View", /^Model structure/);
    const structure = studio.root.getByRole("region", { name: "Model structure" });
    await expect(structure.getByRole("list", { name: "Hubs" }).getByRole("button").first()).toContainText("Orders");
    await structure.getByRole("tab", { name: "Bridges" }).click();
    await expect(structure.getByRole("region", { name: "Bridge keys" })).toContainText("Items.order_id → Orders");

    await studio.fromMenu("View", /^Key usage/);
    const usage = studio.root.getByRole("region", { name: "Key usage" });
    await usage.getByRole("searchbox", { name: "Search field names or keys" }).fill("user");
    await usage.getByRole("searchbox").press("Enter");
    await usage.getByRole("button", { name: "Save…" }).click();
    const dialog = studio.page.getByRole("dialog", { name: "Save analysis" });
    await expect(dialog).toContainText("1 of 4 tables use them (25%)");
    await dialog.getByRole("textbox", { name: "Title" }).fill("User key");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect.poll(async () => ((await studio.liveDoc()).analyses as Array<{ title: string }> | undefined)?.map((a) => a.title)).toEqual(["User key"]);

    await usage.getByRole("button", { name: "Close key usage panel" }).click();
    const analyses = await studio.openMenu("Analyses (1)");
    await expect(analyses.getByRole("menuitem", { name: /^User key/ })).toContainText("Key usage · 1 of 4 tables use them (25%)");
    await analyses.getByRole("menuitem", { name: /^User key/ }).click();
    await expect(studio.root.getByRole("region", { name: "Key usage" }).locator(".as-coverage__pct")).toHaveText("25%");
  });

  test("lineage: import OpenLineage events, trace a column, and see it row to row — in the editor and the exported page", async ({ studio, page }) => {
    const events = [
      {
        eventType: "COMPLETE",
        job: { namespace: "etl", name: "orders_load" },
        outputs: [
          { namespace: "db", name: "public.orders", facets: { columnLineage: { fields: { user_id: { inputFields: [{ namespace: "db", name: "public.users", field: "id" }] } } } } },
          { namespace: "db", name: "public.items", facets: { columnLineage: { fields: { order_id: { inputFields: [{ namespace: "db", name: "public.orders", field: "user_id" }] } } } } },
        ],
      },
    ];
    const file = test.info().outputPath("lineage.json");
    await writeFile(file, JSON.stringify(events));
    await page.getByLabel("OpenLineage events").setInputFiles(file);
    await expect(studio.toast).toContainText("Imported 2 lineage links");

    const menu = await studio.openFieldMenu("orders", "user_id");
    await menu.getByRole("menuitem", { name: /Trace lineage/ }).click();
    const panel = studio.root.getByRole("region", { name: "Lineage" });
    await expect(panel.getByRole("status")).toHaveText("1 upstream column · 1 downstream");
    await expect(page.locator(".as-lineage__line")).toHaveCount(2);
    await expect(studio.fieldRow("users", "id")).toHaveClass(/as-node__field--match/);

    const download = await studio.download(() => studio.fromMenu("Export", /^Interactive HTML/));
    const html = test.info().outputPath("lineage.html");
    await download.saveAs(html);
    await page.goto(`file://${html}`);
    await page.locator('[data-el="node:orders"] rect.bd-row[data-field="user_id"]').click();
    await page.locator("#bd-context").getByRole("menuitem", { name: /Trace lineage/ }).click();
    await expect(page.locator("#bd-panel")).toHaveAttribute("aria-label", "Lineage");
    await expect(page.locator(".bd-x-lineage")).toHaveCount(2);

    // The ⋯ menu: the model's structure, computed when the file was made.
    await page.locator("#bd-menu").click();
    await page.locator("#bd-structbtn").click();
    await expect(page.locator("#bd-panel")).toHaveAttribute("aria-label", "Model structure");
    await expect(page.locator('#bd-panel [aria-label="Hubs"] button').first()).toContainText("Order");

    // A link carries a question — structure is not one; key usage is.
    await page.locator("#bd-menu").click();
    await page.locator("#bd-linkbtn").click();
    await expect(page.locator("#bd-toast")).toHaveText("Open routes, key usage, impact or a neighbourhood first");
    await page.locator("#bd-usagebtn").click();
    const usage = page.getByLabel("Search field names or keys");
    await usage.fill("user");
    await usage.press("Enter");
    await page.locator("#bd-menu").click();
    await page.locator("#bd-linkbtn").click();
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/\?a=[\w-]+$/);
    // Opened fresh, the link restores the picks.
    const url = page.url();
    await page.goto("about:blank");
    await page.goto(url);
    await expect(page.locator("#bd-panel")).toHaveAttribute("aria-label", "Key usage");
    await expect(page.locator(".bd-stat__pct")).toHaveText("25%");
  });
});

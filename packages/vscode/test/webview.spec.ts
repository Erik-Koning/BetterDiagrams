import { expect, test as base } from "@playwright/test";
import { ARCHITECTURE, SEQUENCE, Webview, json } from "./webview";
import { VIEW_DEFAULTS } from "../src/protocol";

const test = base.extend<{ webview: Webview }>({
  webview: async ({ page }, use) => {
    const webview = new Webview(page);
    await use(webview);
    // Nothing refused by the content security policy, nothing thrown.
    expect(webview.errors).toEqual([]);
  },
});

test.describe("the VS Code webview", () => {
  test("shows a diagram in the studio, styled as in the browser", async ({ webview, page }) => {
    await webview.open();
    await webview.init(json(ARCHITECTURE));
    await expect(webview.nodeTitled("Storefront")).toBeVisible();
    await expect(webview.nodeTitled("Orders DB")).toBeVisible();
    // VS Code's default webview stylesheet is gone: no padding round the editor.
    await expect(page.locator("#_defaultStyles")).toHaveCount(0);
    expect(await page.evaluate(() => getComputedStyle(document.body).paddingLeft)).toBe("0px");
    expect(await webview.posted("loss")).toEqual([{ type: "loss", lines: [] }]);
  });

  test("opening a file never changes it, even one with no positions", async ({ webview, page }) => {
    await webview.open();
    const unplaced = { ...ARCHITECTURE, nodes: ARCHITECTURE.nodes.map(({ x: _x, y: _y, ...node }) => node) };
    await webview.init(json(unplaced));
    await expect(webview.nodeTitled("Orders API")).toBeVisible();
    await page.waitForTimeout(500);
    expect(await webview.posted("edit")).toEqual([]);
  });

  test("a person's edit goes to the extension as the whole document", async ({ webview }) => {
    await webview.open();
    await webview.init(json(ARCHITECTURE));
    await webview.fromMenu("Insert", /^Node /);
    await expect(webview.nodeTitled("New Service")).toBeVisible();
    await expect.poll(async () => (await webview.posted("edit")).length).toBeGreaterThan(0);
    const edits = await webview.posted("edit");
    const doc = edits.at(-1)!.doc as typeof ARCHITECTURE;
    expect(doc.nodes.map((node) => node.label)).toEqual(["Storefront", "Orders API", "Orders DB", "New Service"]);
    expect(doc.edges).toHaveLength(2);
  });

  test("follows the text when it changes in VS Code, without writing it back", async ({ webview }) => {
    await webview.open();
    await webview.init(json(ARCHITECTURE));
    await expect(webview.nodeTitled("Orders API")).toBeVisible();
    const renamed = { ...ARCHITECTURE, nodes: ARCHITECTURE.nodes.map((n) => (n.id === "api" ? { ...n, label: "Checkout API" } : n)) };
    await webview.send({ type: "text", text: json(renamed), read: { state: "diagram" } });
    await expect(webview.nodeTitled("Checkout API")).toBeVisible();
    await expect(webview.nodeTitled("Orders API")).toHaveCount(0);
    expect(await webview.posted("edit")).toEqual([]);
  });

  test("half-typed JSON keeps the last picture, read-only, under the reason", async ({ webview, page }) => {
    await webview.open();
    await webview.init(json(ARCHITECTURE));
    await expect(webview.nodeTitled("Storefront")).toBeVisible();
    await webview.send({ type: "text", text: '{ "nodes": [', read: { state: "invalid", reason: "It isn't valid JSON (Unexpected end)." } });
    const problem = page.getByRole("status").filter({ hasText: "This file isn't a diagram right now." });
    await expect(problem).toContainText("It isn't valid JSON");
    await expect(webview.nodeTitled("Storefront")).toBeVisible();
    await webview.send({ type: "text", text: json(ARCHITECTURE), read: { state: "diagram" } });
    await expect(problem).toHaveCount(0);
  });

  test("JSON that isn't a diagram says so, and shows nothing to edit", async ({ webview, page }) => {
    await webview.open();
    await webview.init(json({ name: "my-package" }), { read: { state: "invalid", reason: "It's JSON, but not a diagram." } });
    await expect(page.getByRole("status")).toContainText("It's JSON, but not a diagram.");
    await expect(page.locator(".bd-vscode__nothing")).toBeVisible();
    await expect(webview.root).toHaveCount(0);
  });

  test("an empty file starts a new diagram", async ({ webview }) => {
    await webview.open();
    await webview.init("", { read: { state: "empty" } });
    await expect(webview.root).toBeVisible();
  });

  test("a sequence opens in the sequence editor", async ({ webview }) => {
    await webview.open();
    await webview.init(json(SEQUENCE));
    await expect(webview.participant("Customer")).toBeVisible();
    await expect(webview.participant("Order API")).toBeVisible();
  });

  test("tells the extension what editing would drop", async ({ webview }) => {
    await webview.open();
    const odd = { ...ARCHITECTURE, nodes: ARCHITECTURE.nodes.map((n, i) => (i === 0 ? { ...n, colour: "red" } : n)) };
    await webview.init(json(odd));
    await expect(webview.nodeTitled("Storefront")).toBeVisible();
    const [loss] = await webview.posted("loss");
    expect(loss.lines.length).toBeGreaterThan(0);
    expect(loss.lines.join(" ")).toContain("colour");
  });

  test("⌘Z is VS Code's: the studio takes no step back of its own", async ({ webview, page }) => {
    await webview.open();
    await webview.init(json(ARCHITECTURE));
    await webview.fromMenu("Insert", /^Node /);
    await expect(webview.nodeTitled("New Service")).toBeVisible();
    await expect.poll(async () => (await webview.posted("edit")).length).toBeGreaterThan(0);
    const before = (await webview.posted("edit")).length;
    await webview.page.locator(".react-flow__pane").click({ position: { x: 40, y: 400 } });
    await page.keyboard.press("ControlOrMeta+z");
    await page.waitForTimeout(300);
    await expect(webview.nodeTitled("New Service")).toBeVisible();
    expect((await webview.posted("edit")).length).toBe(before);
  });

  test("the toolbar's Undo and Redo are VS Code's too", async ({ webview, page }) => {
    await webview.open();
    await webview.init(json(ARCHITECTURE));
    await expect(webview.nodeTitled("Storefront")).toBeVisible();
    // Enabled with nothing done here yet: only VS Code knows its history.
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    expect(await webview.posted("undo")).toEqual([{ type: "undo" }]);
    expect(await webview.posted("redo")).toEqual([{ type: "redo" }]);
    expect(await webview.posted("edit")).toEqual([]);
  });

  test("an export reaches the extension instead of downloading", async ({ webview, page }) => {
    await webview.open();
    await webview.init(json(ARCHITECTURE));
    await expect(webview.nodeTitled("Storefront")).toBeVisible();
    await webview.fromMenu("Export", /^Template \(\.json\)/);
    await expect.poll(async () => (await webview.posted("export")).length).toBe(1);
    const exported = await page.evaluate(() => {
      const message = (window as unknown as { __posted: Array<{ type: string; filename: string; data: Uint8Array }> }).__posted.find(
        (m) => m.type === "export",
      )!;
      return { filename: message.filename, text: new TextDecoder().decode(message.data) };
    });
    expect(exported.filename).toBe("shop.template.json");
    expect(JSON.parse(exported.text).nodes).toHaveLength(3);
  });

  test("a picture export reaches the extension too", async ({ webview, page }) => {
    await webview.open();
    await webview.init(json(ARCHITECTURE));
    await expect(webview.nodeTitled("Storefront")).toBeVisible();
    await webview.fromMenu("Export", /^PNG image/);
    await expect.poll(async () => (await webview.posted("export")).length).toBe(1);
    const png = await page.evaluate(() => {
      const message = (window as unknown as { __posted: Array<{ type: string; filename: string; data: Uint8Array }> }).__posted.find(
        (m) => m.type === "export",
      )!;
      return { filename: message.filename, signature: [...message.data.slice(1, 4)].map((c) => String.fromCharCode(c)).join("") };
    });
    expect(png).toEqual({ filename: "shop.png", signature: "PNG" });
  });

  test("a node's ↗ goes to the extension to open, as a file: one goes to navigate", async ({ webview, page }) => {
    await webview.open();
    const linked = {
      ...ARCHITECTURE,
      nodes: ARCHITECTURE.nodes.map((n) =>
        n.id === "api" ? { ...n, url: "https://example.com/orders-api" } : n.id === "db" ? { ...n, url: "file:Schema" } : n,
      ),
    };
    await webview.init(json(linked));
    await expect(webview.nodeTitled("Orders API")).toBeVisible();
    // The page itself opens nothing: no tab, no navigation away from the studio.
    const popups: string[] = [];
    page.on("popup", (p) => popups.push(p.url()));
    await page.getByRole("link", { name: "Open https://example.com/orders-api" }).click();
    await expect.poll(() => webview.posted("open")).toEqual([{ type: "open", url: "https://example.com/orders-api" }]);
    // As in the browser, following it leaves the card it sits on unselected.
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
    await page.getByRole("button", { name: "Open linked file Schema" }).click();
    await expect.poll(() => webview.posted("navigate")).toEqual([{ type: "navigate", ref: "Schema" }]);
    expect(popups).toEqual([]);
    expect(page.url()).toMatch(/\/index\.html$/);
  });

  for (const bodyClass of ["vscode-light", "vscode-dark"]) {
    test(`cards keep their fills and icons (${bodyClass})`, async ({ webview, page }) => {
      // The studio's light-dark() colours are compiled to read a literal
      // color-scheme, which its root declares (this page declares none):
      // without one they're invalid, and paint nothing.
      await webview.open({ bodyClass });
      await webview.init(json(ARCHITECTURE));
      const card = page.locator('.react-flow__node[data-id="web"] .as-node');
      await expect(card).toBeVisible();
      const paint = await card.evaluate((node) => ({
        fill: getComputedStyle(node).backgroundColor,
        stroke: getComputedStyle(node.querySelector(".as-node__iconbox svg")!).stroke,
      }));
      expect(paint.fill).not.toBe("rgba(0, 0, 0, 0)");
      expect(paint.stroke).not.toBe("none");
    });
  }

  test("light or dark follows VS Code's theme, unless the setting pins one", async ({ webview, page }) => {
    await webview.open({ bodyClass: "vscode-light" });
    await webview.init(json(ARCHITECTURE));
    const shell = page.locator(".bd-vscode");
    await expect(shell).toHaveAttribute("data-theme", "light");
    await page.evaluate(() => document.body.classList.replace("vscode-light", "vscode-dark"));
    await expect(shell).toHaveAttribute("data-theme", "dark");
    await webview.send({ type: "view", view: { ...VIEW_DEFAULTS, theme: "light" } });
    await expect(shell).toHaveAttribute("data-theme", "light");
  });

  test("the Settings menu switches light and dark, here at once and in VS Code's settings", async ({ webview, page }) => {
    await webview.open({ bodyClass: "vscode-light" });
    await webview.init(json(ARCHITECTURE));
    const shell = page.locator(".bd-vscode");
    const menu = await webview.settings();
    await expect(menu.getByText("Follow VS Code (light)")).toBeVisible();
    await menu.getByRole("radio", { name: "Dark" }).check();
    await expect(shell).toHaveAttribute("data-theme", "dark");
    expect(await webview.posted("setView")).toEqual([{ type: "setView", view: { theme: "dark" } }]);
  });

  test("the view switches reach the studio: technical, and the minimap", async ({ webview, page }) => {
    await webview.open();
    await webview.init(json(ARCHITECTURE));
    await expect(webview.root).toHaveClass(/as-root--marketing/);
    const menu = await webview.settings();
    await menu.getByRole("checkbox", { name: "Marketing" }).uncheck();
    await expect(webview.root).not.toHaveClass(/as-root--marketing/);
    await menu.getByRole("checkbox", { name: "Minimap" }).check();
    await expect(page.locator(".react-flow__minimap")).toBeVisible();
    expect(await webview.posted("setView")).toEqual([
      { type: "setView", view: { presentation: "technical" } },
      { type: "setView", view: { minimap: true } },
    ]);
    // A change in VS Code's Settings UI arrives the same way.
    await webview.send({ type: "view", view: { ...VIEW_DEFAULTS, presentation: "technical", minimap: false } });
    await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
  });

  test("read-only from the menu holds for this editor and writes no setting", async ({ webview }) => {
    await webview.open();
    await webview.init(json(ARCHITECTURE));
    const menu = await webview.settings();
    await menu.getByRole("checkbox", { name: "Read-only" }).check();
    await expect(webview.root.getByRole("button", { name: "Insert", exact: true })).toHaveCount(0);
    expect(await webview.posted("setView")).toEqual([]);
  });

  test("the AI panel is there when VS Code has a model, and its answers come back through the extension", async ({ webview }) => {
    await webview.open();
    await webview.init(json(ARCHITECTURE));
    await expect(webview.root.getByRole("button", { name: "AI", exact: true })).toHaveCount(0);
    await webview.send({ type: "ai", label: "Test Model" });
    await webview.root.getByRole("button", { name: "AI", exact: true }).click();
    await webview.root.getByRole("textbox", { name: "Message" }).fill("add a cache");
    await webview.root.getByRole("textbox", { name: "Message" }).press("Enter");
    await expect.poll(() => webview.posted("generate")).toHaveLength(1);
    const [asked] = await webview.posted("generate");
    expect((asked.request as { input: string }).input).toContain("add a cache");
    const answer = {
      ...ARCHITECTURE,
      nodes: [...ARCHITECTURE.nodes, { id: "cache", label: "Order cache", kind: "cache", x: 320, y: 200 }],
    };
    await webview.send({ type: "generated", id: asked.id, text: `Added a cache.\n${JSON.stringify(answer)}` });
    await expect(webview.nodeTitled("Order cache")).toBeVisible();
    await expect.poll(async () => JSON.stringify((await webview.posted("edit")).at(-1)?.doc ?? null)).toContain("Order cache");
  });

  test("Derive sequence asks the extension for a new file holding the sequence", async ({ webview }) => {
    await webview.open();
    await webview.init(json({ ...ARCHITECTURE, edges: ARCHITECTURE.edges.map((e, i) => ({ ...e, seq: i + 1 })) }));
    const menu = await webview.settings();
    await menu.getByRole("menuitem", { name: /Derive sequence/ }).click();
    const [created] = await webview.posted("create");
    expect(created.name).toBe("Shop — sequence");
    expect((created.doc as { messages: unknown[] }).messages).toHaveLength(2);
  });

  test("Copy schema on a sequence copies through VS Code's clipboard", async ({ webview }) => {
    await webview.open();
    await webview.init(json(SEQUENCE));
    const menu = await webview.settings();
    await menu.getByRole("menuitem", { name: /Copy schema/ }).click();
    const [copied] = await webview.posted("copy");
    expect(copied.text).toContain("participants");
  });

  test("an example replaces the diagram as one edit", async ({ webview }) => {
    await webview.open();
    await webview.init(json(ARCHITECTURE));
    const menu = await webview.settings();
    await menu.getByRole("menuitem", { name: /Multi-cloud/ }).click();
    await expect.poll(async () => ((await webview.posted("edit")).at(-1)?.doc as { zones?: unknown[] } | undefined)?.zones?.length ?? 0).toBeGreaterThan(0);
  });

  test("a file VS Code can't write is shown, never edited", async ({ webview }) => {
    await webview.open();
    await webview.init(json(ARCHITECTURE), { readOnly: true });
    await expect(webview.nodeTitled("Storefront")).toBeVisible();
    await expect(webview.root.getByRole("button", { name: "Insert", exact: true })).toHaveCount(0);
  });
});

/**
 * Shared fixtures for the end-to-end suite.
 *
 * `studio` is a small page object over the example app: the toolbar menus,
 * the file selector, the canvas, the inspector, and the host's own chrome
 * (the JSON panel, the header toggles). Locators are by accessible name
 * wherever the UI has one, so a test reads like the click it performs.
 */
import { test as base, expect, type Download, type Locator, type Page } from "@playwright/test";

/**
 * The seeded files. The host names the first one "Architecture", but the
 * editor keeps a file's name and its document's meta.title as one title with
 * two homes — so on mount it takes the example's own title.
 */
export const ARCH_FILE = "Multi-cloud deployment";
export const SEQ_FILE = "Order flow";

/** Where the example app persists its workspace (see example/src/App.jsx). */
export const WORKSPACE_KEY = "better-diagrams:workspace";

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Anchor a label to the whole text, so "API" does not also match "REST API". */
export const exact = (text: string): RegExp => new RegExp(`^${escapeRegExp(text)}$`);

export interface LiveNode {
  id: string;
  label: string;
  kind: string;
  x: number;
  y: number;
  [key: string]: unknown;
}

export interface LiveEdge {
  id: string;
  source: string;
  target: string;
  [key: string]: unknown;
}

/** The architecture document as the host's JSON panel prints it. */
export interface LiveDoc {
  version: number;
  meta?: Record<string, unknown>;
  nodes: LiveNode[];
  edges: LiveEdge[];
  zones?: Array<{ id: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface WorkspaceFile {
  id: string;
  name: string;
  kind: "architecture" | "sequence";
  doc: { nodes?: Array<{ id: string; label: string }>; participants?: Array<{ id: string; label: string }>; [k: string]: unknown };
}

export interface Workspace {
  files: WorkspaceFile[];
  activeId: string | null;
  removed: WorkspaceFile[];
}

export class Studio {
  constructor(readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto("/");
    await expect(this.root).toBeVisible();
  }

  /** The mounted editor — architecture or sequence, whichever file is active. */
  get root(): Locator {
    return this.page.locator(".as-root");
  }

  get canvas(): Locator {
    return this.page.locator(".react-flow__pane");
  }

  /**
   * Hand the editor the keyboard without selecting anything on the canvas:
   * the Fit button is inside the editor's root and only re-fits the view.
   */
  async focusEditor(): Promise<void> {
    await this.root.getByRole("button", { name: "Fit", exact: true }).click();
  }

  get inspector(): Locator {
    return this.root.locator(".as-inspector");
  }

  get toast(): Locator {
    return this.root.locator(".as-toast");
  }

  // ── Toolbar ──────────────────────────────────────────────────────────────

  /** A dropdown trigger: "Insert", "Export", "Arrange"… (rendered as "Insert"). */
  menuButton(label: string): Locator {
    return this.root.getByRole("button", { name: `${label}`, exact: true });
  }

  async openMenu(label: string): Promise<Locator> {
    await this.menuButton(label).click();
    const menu = this.root.getByRole("menu");
    await expect(menu).toBeVisible();
    return menu;
  }

  async fromMenu(label: string, item: string | RegExp): Promise<void> {
    const menu = await this.openMenu(label);
    await menu.getByRole("menuitem", { name: item }).click();
  }

  get saveButton(): Locator {
    return this.root.getByRole("button", { name: /^Save/ });
  }

  /** Click Save and wait for the round trip through the host to land. */
  async save(): Promise<void> {
    await this.saveButton.click();
    await expect(this.toast).toHaveText("Saved");
    await expect(this.saveButton).toHaveText("Save");
  }

  get undoButton(): Locator {
    return this.root.getByRole("button", { name: "Undo", exact: true });
  }

  get redoButton(): Locator {
    return this.root.getByRole("button", { name: "Redo", exact: true });
  }

  // ── Files ────────────────────────────────────────────────────────────────

  /** The file selector at the top-left of the toolbar; its text is the active file's name. */
  get fileButton(): Locator {
    return this.root.getByTitle("Files — switch, create, rename, delete");
  }

  async openFileMenu(): Promise<Locator> {
    await this.fileButton.click();
    const menu = this.root.getByRole("menu");
    await expect(menu).toBeVisible();
    return menu;
  }

  async openFile(name: string): Promise<void> {
    const menu = await this.openFileMenu();
    await menu.getByTitle(`Open ${name}`).click();
    await expect(this.fileButton).toHaveText(exact(name));
  }

  async newFile(): Promise<void> {
    const menu = await this.openFileMenu();
    await menu.getByRole("menuitem", { name: /New file/ }).click();
  }

  /** What the host has persisted — exactly what `onSave` and structure ops write. */
  async workspace(): Promise<Workspace> {
    return this.page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
      WORKSPACE_KEY,
    );
  }

  // ── Canvas ───────────────────────────────────────────────────────────────

  /** A React Flow node by its document id. */
  node(id: string): Locator {
    return this.page.locator(`.react-flow__node[data-id="${id}"]`);
  }

  get selectedNodes(): Locator {
    return this.page.locator(".react-flow__node.selected");
  }

  /**
   * The lines React Flow has actually DRAWN. Fewer than the document's edges
   * whenever a provider filter hides some — and, in the bug this exists for,
   * zero while the document still listed every one of them.
   */
  get drawnEdges(): Locator {
    return this.page.locator(".react-flow__edge");
  }

  /**
   * Import a template through the toolbar's Import button, accepting the
   * "Replace this diagram?" question the editor asks whenever the canvas
   * already holds something (an empty canvas, or a layout file, never asks).
   */
  async importFile(path: string): Promise<void> {
    const chooser = this.page.waitForEvent("filechooser");
    await this.root.getByRole("button", { name: "Import", exact: true }).click();
    await (await chooser).setFiles(path);
    const replace = this.page
      .getByRole("dialog", { name: /^Replace this diagram/ })
      .getByRole("button", { name: "Replace" });
    await replace.waitFor({ state: "visible", timeout: 1500 }).then(
      () => replace.click(),
      () => undefined,
    );
  }

  /** A field row on a record node's card. */
  fieldRow(nodeId: string, fieldId: string): Locator {
    return this.node(nodeId).locator(`.as-node__field[data-field-id="${fieldId}"]`);
  }

  /** Click a row and wait for the field menu. */
  async openFieldMenu(nodeId: string, fieldId: string): Promise<Locator> {
    await this.fieldRow(nodeId, fieldId).click();
    const menu = this.page.getByRole("menu", { name: "Actions" });
    await expect(menu).toBeVisible();
    return menu;
  }

  /** The strip of pinned fields above the canvas. */
  get pinStrip(): Locator {
    return this.page.getByRole("toolbar", { name: "Pinned fields" });
  }

  /** The paths panel between pinned fields. */
  get pathPanel(): Locator {
    return this.page.getByRole("region", { name: "Paths between pinned fields" });
  }

  /** A node's field grid dialog. */
  fieldGrid(nodeLabel: string): Locator {
    return this.page.getByRole("dialog", { name: `${nodeLabel} — fields` });
  }

  /** An architecture node by the label painted on its card. */
  nodeTitled(label: string): Locator {
    return this.page.locator(".as-node__title").filter({ hasText: exact(label) });
  }

  /** A sequence participant by the label in its lifeline header. */
  participant(label: string): Locator {
    return this.page.locator(".as-seq-head__label").filter({ hasText: exact(label) });
  }

  /** A sequence message by its label text (an autonumber prefix, if any, is allowed). */
  message(label: string): Locator {
    return this.page
      .locator(".as-seq-msg__text")
      .filter({ hasText: new RegExp(`(^|\\s)${escapeRegExp(label)}$`) });
  }

  private async center(locator: Locator): Promise<{ x: number; y: number }> {
    const box = await locator.boundingBox();
    expect(box, "element has a bounding box").toBeTruthy();
    return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  }

  /**
   * Draw a connection the way a user does: pick up the handle on the source
   * card's right edge and drop it on the target card. Handles only arm while
   * their card is hovered, so the pointer path starts on the card itself.
   */
  async connect(sourceId: string, targetId: string): Promise<void> {
    const source = this.node(sourceId);
    await source.hover();
    const handle = await this.center(source.locator('.react-flow__handle[data-handleid="right"]'));
    await this.page.mouse.move(handle.x, handle.y);
    await this.page.mouse.down();
    const target = await this.center(this.node(targetId));
    await this.page.mouse.move(target.x, target.y, { steps: 15 });
    await this.page.mouse.up();
  }

  // ── Canvas tools ─────────────────────────────────────────────────────────

  /** The tool tray's trigger — it shows whichever tool is live. */
  get toolButton(): Locator {
    return this.root.locator(".as-toolpicker > button");
  }

  /** Pick a tool the way a user does: hover the tray open, click a row. */
  async pickTool(name: "Cursor" | "Select" | "Pan"): Promise<void> {
    await this.toolButton.hover();
    const tray = this.root.getByRole("menu", { name: "Canvas tools" });
    await expect(tray).toBeVisible();
    await tray.getByRole("menuitemradio", { name: new RegExp(`^${name}`) }).click();
    await expect(tray).toBeHidden();
    await expect(this.toolButton).toHaveText(new RegExp(`^${name}`));
  }

  /** The screen-space box that holds every one of these cards, plus a margin. */
  async boxAround(ids: readonly string[], pad = 10): Promise<{ x1: number; y1: number; x2: number; y2: number }> {
    const boxes = await Promise.all(ids.map((id) => this.node(id).boundingBox()));
    boxes.forEach((box, i) => expect(box, `${ids[i]} has a bounding box`).toBeTruthy());
    return {
      x1: Math.min(...boxes.map((b) => b!.x)) - pad,
      y1: Math.min(...boxes.map((b) => b!.y)) - pad,
      x2: Math.max(...boxes.map((b) => b!.x + b!.width)) + pad,
      y2: Math.max(...boxes.map((b) => b!.y + b!.height)) + pad,
    };
  }

  /**
   * The same box, with its press point lifted clear of the inspector bar.
   *
   * The bar floats over the bottom of the canvas — and a multi-selection's
   * bar, carrying every setting the selection shares, is several rows tall —
   * so a press aimed at a card underneath it lands on the bar and starts no
   * band. A band only has to CROSS a card to take it, so starting higher up
   * costs nothing.
   */
  async clearOfInspector(area: { x1: number; y1: number; x2: number; y2: number }) {
    const bar = await this.inspector.boundingBox();
    if (!bar || area.y1 < bar.y - 4) return area;
    return { ...area, y1: bar.y - 12 };
  }

  /** Rubber-band a screen-space rectangle, optionally holding a modifier. */
  async band(
    area: { x1: number; y1: number; x2: number; y2: number },
    modifier?: "Shift" | "Meta",
  ): Promise<void> {
    if (modifier) await this.page.keyboard.down(modifier);
    await this.page.mouse.move(area.x1, area.y1);
    await this.page.mouse.down();
    await this.page.mouse.move(area.x2, area.y2, { steps: 12 });
    await this.page.mouse.up();
    if (modifier) await this.page.keyboard.up(modifier);
  }

  /** Drag a card by a screen-space offset. */
  async dragNode(id: string, dx: number, dy: number): Promise<void> {
    const from = await this.center(this.node(id));
    await this.page.mouse.move(from.x, from.y);
    await this.page.mouse.down();
    await this.page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
    await this.page.mouse.up();
  }

  // ── Host chrome (the example app around the editor) ──────────────────────

  /**
   * A host view setting — Read-only, Minimap, AI panel, Light, Marketing,
   * Gradients, Lines on hover, JSON — as its checkbox in the Settings menu,
   * opened on the way if it is closed.
   */
  async setting(name: string): Promise<Locator> {
    const menu = this.page.getByRole("menu", { name: "Settings" });
    if (!(await menu.isVisible())) {
      await this.page.getByRole("button", { name: "Settings" }).click();
      await expect(menu).toBeVisible();
    }
    return menu.getByLabel(name, { exact: true });
  }

  /** Open the live-template side panel and return the rendered JSON. */
  async showJson(): Promise<Locator> {
    await (await this.setting("JSON")).check();
    const json = this.page.locator(".app__json");
    await expect(json).toBeVisible();
    return json;
  }

  /**
   * The document as the host sees it right now, parsed from the JSON panel —
   * the panel prints exactly `JSON.stringify(doc, null, 2)`. Opens the panel
   * if it is closed. Edits commit on a short debounce, so poll when reading
   * straight after one.
   */
  async liveDoc(): Promise<LiveDoc> {
    const json = await this.showJson();
    return JSON.parse((await json.textContent()) ?? "null");
  }

  /** Run `action` and return the download it triggers. */
  async download(action: () => Promise<void>): Promise<Download> {
    const [download] = await Promise.all([this.page.waitForEvent("download"), action()]);
    return download;
  }
}

export const test = base.extend<{ studio: Studio }>({
  context: async ({ context }, use) => {
    // The dev server's auto-save writes every open file into the repo's
    // /templates folder. Refuse the probe so a test run never touches disk,
    // and the app carries on exactly as a production build would. On the
    // context, not the page, so a test that opens a second tab is covered.
    await context.route("**/__templates**", (route) =>
      route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"disabled under e2e"}' }),
    );

    // An uncaught exception anywhere in a test is a failure even when the
    // assertions happen to pass — React may have recovered, the user did not.
    const errors: string[] = [];
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));

    await use(context);

    expect(errors, "uncaught errors in the page").toEqual([]);
  },
  studio: async ({ page }, use) => {
    await use(new Studio(page));
  },
});

export { expect };

/** A tiny architecture document for import, paste, and generate paths. */
export const SMALL_TEMPLATE = {
  version: 1,
  meta: { title: "Auth slice" },
  nodes: [
    { id: "auth", label: "Auth Service", kind: "service", x: 40, y: 40, w: 170, h: 76 },
    { id: "users", label: "Users DB", kind: "database", x: 340, y: 40, w: 170, h: 76 },
  ],
  edges: [{ id: "e1", source: "auth", target: "users", label: "reads" }],
};

/** A tiny sequence document for the cross-kind paste path. */
export const SMALL_SEQUENCE = {
  version: 1,
  meta: { title: "Login" },
  participants: [
    { id: "alice", label: "Alice", kind: "actor" },
    { id: "idp", label: "Identity Provider", kind: "service" },
  ],
  messages: [{ id: "m1", from: "alice", to: "idp", label: "authenticate", style: "sync" }],
};

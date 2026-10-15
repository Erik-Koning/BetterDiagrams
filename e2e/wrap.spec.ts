/**
 * Wrapped cards in the real app. With Wrap on, a card shows all of its text
 * without being opened: the title top-left, the description across the
 * card's full width under the icon, every line of it. Whether the text
 * actually fits the box validation measured can only be seen where the text
 * is laid out — jsdom lays out nothing.
 */
import { writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const STORY =
  "As a returning customer, I want to reorder a past basket in one tap, so that the weekly shop takes seconds.";
const CRITERIA = [
  "Acceptance criteria:",
  "- The basket shows every item from the order, at today's prices",
  "- Items no longer stocked are listed, greyed out, with a substitute offered",
  "- One tap adds the whole basket; a toast says how many were added",
  "- Works offline and syncs when the connection returns",
].join("\n");

const card = (id: string, over: Record<string, unknown>) => ({
  id, label: id, kind: "task", icon: "none", description: "", parentId: null, x: 0, y: 0, w: 200, h: 84, wrap: true, ...over,
});

const STORIES = {
  version: 1,
  meta: { title: "Stories" },
  nodes: [
    card("reorder", { label: STORY, description: CRITERIA, date: "2026-11-01", storyPoints: 5, priority: "p1" }),
    card("narrow", { label: STORY, description: CRITERIA, w: 160, x: 260 }),
    card("api", { kind: "service", icon: "server", label: "Checkout API", description: `${STORY} ${CRITERIA}`, w: 240, x: 480 }),
    card("logout", { label: "Log out", x: 780 }),
  ],
  edges: [],
};

interface Piece { top: number; bottom: number; left: number; right: number }

/** Where each piece of a card's text sits, in the card's own px — the canvas is zoomed. */
async function layoutOf(page: Page, id: string) {
  return page.evaluate((nodeId) => {
    const host = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`)!;
    const cardEl = host.querySelector<HTMLElement>(".as-node")!;
    const r = cardEl.getBoundingClientRect();
    const zoom = r.width / cardEl.offsetWidth;
    const piece = (selector: string): Piece | null => {
      const el = host.querySelector(selector);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: (b.top - r.top) / zoom, bottom: (b.bottom - r.top) / zoom, left: (b.left - r.left) / zoom, right: (b.right - r.left) / zoom };
    };
    return {
      h: cardEl.offsetHeight,
      title: piece(".as-node__title")!,
      desc: piece(".as-node__desc"),
      date: piece(".as-date"),
      icon: piece(".as-node__iconbox"),
    };
  }, id);
}

/** Every piece of text inside the card's border, and the title at the top. */
async function expectAllTextShown(page: Page, id: string) {
  const at = await layoutOf(page, id);
  for (const piece of [at.title, at.desc, at.date]) {
    if (piece) expect(piece.bottom, `${id} text runs past the card`).toBeLessThanOrEqual(at.h - 1);
  }
  // Under the eyebrow at most: the block is pinned to the top.
  expect(at.title.top, `${id} title is not at the top`).toBeLessThan(21);
  return at;
}

test.describe("wrapped cards", () => {
  test.beforeEach(async ({ studio }, testInfo) => {
    await studio.goto();
    const file = testInfo.outputPath("stories.json");
    await writeFile(file, JSON.stringify(STORIES));
    await studio.importFile(file);
    await expect(studio.node("reorder")).toBeVisible();
  });

  for (const marketing of [true, false]) {
    test(`show every line in ${marketing ? "marketing" : "technical"}: the title top-left, the description full width under the icon`, async ({ page, studio }) => {
      if (!marketing) await (await studio.setting("Marketing")).uncheck();
      await expect(studio.root).toHaveClass(marketing ? /as-root--marketing/ : /^(?!.*as-root--marketing)/);

      for (const id of ["reorder", "narrow", "api", "logout"]) {
        const at = await expectAllTextShown(page, id);
        // The description starts at the card's own left padding, not in the
        // column beside an icon.
        if (at.desc) expect(at.desc.left, `${id} description is indented`).toBeLessThan(15);
      }
      // A card with an icon: the description runs under it, not beside it.
      const api = await layoutOf(page, "api");
      expect(api.desc!.left).toBeLessThan(api.icon!.left + 1);
      expect(api.desc!.top).toBeGreaterThanOrEqual(api.icon!.bottom - 1);
      // Every line of the criteria is on the card, one per line as typed.
      await expect(studio.node("reorder").locator(".as-node__desc")).toHaveText(CRITERIA, { useInnerText: true });
    });
  }

  test("grow as the description is typed and shrink back when it is cleared", async ({ page, studio }) => {
    const before = (await layoutOf(page, "logout")).h;
    await studio.node("logout").click();
    const description = studio.inspector.getByLabel("Node description");
    await description.fill(CRITERIA);
    await expect.poll(async () => (await layoutOf(page, "logout")).h).toBeGreaterThan(before + 60);
    await expectAllTextShown(page, "logout");
    // And the document carries the grown height, so it reloads the same.
    await expect
      .poll(async () => (await studio.liveDoc()).nodes.find((n) => n.id === "logout")?.h)
      .toBe((await layoutOf(page, "logout")).h);

    // Cleared, it fits its one-line title again — shorter than the default
    // size it was imported at, since the box follows the text both ways.
    await description.fill("");
    await expect.poll(async () => (await layoutOf(page, "logout")).h).toBeLessThanOrEqual(before);
    await expectAllTextShown(page, "logout");
  });

  test("grow when the title is renamed longer in place", async ({ page, studio }) => {
    const before = (await layoutOf(page, "logout")).h;
    await studio.node("logout").click();
    await page.keyboard.press("F2");
    const input = studio.node("logout").locator("input.as-node__title");
    await expect(input).toBeFocused();
    await input.fill(STORY);
    await input.press("Enter");
    await expect(studio.node("logout").locator(".as-node__title")).toHaveText(STORY);
    await expect.poll(async () => (await layoutOf(page, "logout")).h).toBeGreaterThan(before + 30);
    await expectAllTextShown(page, "logout");
  });
});

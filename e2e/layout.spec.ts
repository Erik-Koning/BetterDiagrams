/**
 * Arranging in the real app: the default Tidy, Polish, and the Layout panel's
 * choices, gallery and findings, each one a single undo step.
 */
import { writeFile } from "node:fs/promises";
import { expect, test } from "./fixtures";

const box = { icon: "none", description: "", w: 170, h: 76 };

const ROUGH = {
  version: 1,
  meta: { title: "Rough arrangement" },
  nodes: [
    { ...box, id: "a", label: "Alpha", kind: "service", parentId: null, x: 0, y: 0 },
    { ...box, id: "b", label: "Bravo", kind: "service", parentId: null, x: 30, y: 20 },
    { ...box, id: "c", label: "Charlie", kind: "service", parentId: null, x: 500, y: 6 },
    { ...box, id: "d", label: "Delta", kind: "database", parentId: null, x: 800, y: 0 },
  ],
  edges: [
    { id: "ab", source: "a", target: "c", label: "calls", style: "solid", color: "slate" },
    { id: "bc", source: "b", target: "c", label: "", style: "solid", color: "slate" },
    { id: "cd", source: "c", target: "d", label: "", style: "solid", color: "slate" },
  ],
};

type Doc = { settings?: { arrange?: string; layout?: Record<string, unknown> }; nodes: Array<{ id: string; x: number; y: number; w: number; h: number }> };

const overlapping = (doc: Doc, one: string, other: string) => {
  const a = doc.nodes.find((n) => n.id === one)!;
  const b = doc.nodes.find((n) => n.id === other)!;
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
};

test.describe("arranging", () => {
  test.beforeEach(async ({ studio }, testInfo) => {
    await studio.goto();
    const file = testInfo.outputPath("rough.json");
    await writeFile(file, JSON.stringify(ROUGH));
    await studio.importFile(file);
    await expect(studio.nodeTitled("Bravo")).toBeVisible();
  });

  test("Polish keeps the arrangement and clears the overlap, and undo puts it back", async ({ studio }) => {
    await studio.fromMenu("Arrange", /^Polish/);
    await expect(studio.toast).toContainText("Polished");
    const polished = (await studio.liveDoc()) as unknown as Doc;
    expect(overlapping(polished, "a", "b")).toBe(false);
    const at = (id: string) => polished.nodes.find((n) => n.id === id)!;
    expect(at("a").x).toBeLessThan(at("c").x);
    expect(at("c").x).toBeLessThan(at("d").x);

    await studio.undoButton.click();
    const back = (await studio.liveDoc()) as unknown as Doc;
    expect(overlapping(back, "a", "b")).toBe(true);
  });

  test("Tidy places everything, and Best fit is what a document starts on", async ({ studio }) => {
    const menu = await studio.openMenu("Arrange");
    await expect(menu.getByRole("radio", { name: "Best fit" })).toBeChecked();
    await menu.getByRole("menuitem", { name: /^Tidy/ }).click();
    await expect(studio.toast).toContainText("Tidied");
    const tidied = (await studio.liveDoc()) as unknown as Doc;
    expect(overlapping(tidied, "a", "b")).toBe(false);
  });

  test("the panel scores the picture, and a choice arranges and is kept", async ({ page, studio }) => {
    await studio.fromMenu("Arrange", /Layout panel/);
    const panel = page.getByRole("region", { name: "Layout" });
    await expect(panel.getByRole("status", { name: /Layout score \d+ out of 100/ })).toBeVisible();
    await panel.getByText("Boxes overlap").click();

    await panel.getByRole("group", { name: "Direction" }).getByRole("button", { name: "Top to bottom" }).click();
    await expect.poll(async () => ((await studio.liveDoc()) as unknown as Doc).settings?.layout?.direction).toBe("down");
    const down = (await studio.liveDoc()) as unknown as Doc;
    const y = (id: string) => down.nodes.find((n) => n.id === id)!.y;
    expect(y("c")).toBeGreaterThan(y("a"));
    expect(y("d")).toBeGreaterThan(y("c"));

    await studio.undoButton.click();
    await expect.poll(async () => ((await studio.liveDoc()) as unknown as Doc).settings?.layout).toBeUndefined();
  });

  test("a thumbnail in the gallery applies that arrangement", async ({ page, studio }) => {
    await studio.fromMenu("Arrange", /Layout panel/);
    const panel = page.getByRole("region", { name: "Layout" });
    await panel.getByTitle(/Use this arrangement: Grid/).click();
    await expect.poll(async () => ((await studio.liveDoc()) as unknown as Doc).settings?.layout?.algorithm).toBe("grid");
  });

  test("pointing at a finding picks it out on the canvas", async ({ page, studio }) => {
    await studio.fromMenu("Arrange", /Layout panel/);
    const panel = page.getByRole("region", { name: "Layout" });
    await panel.getByText("Boxes overlap").click();
    const dimmed = (id: string) => studio.node(id).locator(".as-node--dimmed");
    await expect(dimmed("d")).toHaveCount(0);
    await panel.getByRole("button", { name: /"Alpha" and "Bravo" overlap/ }).hover();
    // What the finding is about stays bright, and everything else steps back.
    await expect(dimmed("d")).toHaveCount(1);
    await expect(dimmed("a")).toHaveCount(0);
    await page.mouse.move(800, 400);
    await expect(dimmed("d")).toHaveCount(0);
  });
});

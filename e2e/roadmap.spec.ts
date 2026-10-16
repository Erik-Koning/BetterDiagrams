/**
 * A plan laid out by date in the real app: Arrange → By date puts the work on
 * a calendar with a ruler, dragging a card sideways reschedules it (and undo
 * puts the dates back), and a picture of it carries the ruler.
 */
import { readFile, writeFile } from "node:fs/promises";
import { expect, test } from "./fixtures";

const card = { icon: "none", description: "", x: 0, y: 0, w: 200, h: 84 };

const PLAN = {
  version: 1,
  meta: { title: "Launch roadmap" },
  nodes: [
    { ...card, id: "web", label: "Web", kind: "group", parentId: null, w: 400, h: 300 },
    { ...card, id: "design", label: "Design", kind: "task", parentId: "web", startDate: "2026-03-02", date: "2026-03-20" },
    { ...card, id: "build", label: "Build", kind: "task", parentId: "web", startDate: "2026-03-23", date: "2026-04-24" },
    { ...card, id: "ship", label: "Ship", kind: "milestone", parentId: null, date: "2026-05-04", w: 170, h: 96 },
  ],
  edges: [
    { id: "d-b", source: "design", target: "build", label: "", style: "solid", color: "slate" },
    { id: "b-s", source: "build", target: "ship", label: "", style: "solid", color: "slate" },
  ],
};

type Doc = { settings?: { arrange?: string; roadmap?: { from: string; dayWidth: number } }; nodes: Array<{ id: string; date?: string; startDate?: string; x: number; w: number }> };

test.describe("roadmap", () => {
  test.beforeEach(async ({ studio }, testInfo) => {
    await studio.goto();
    const file = testInfo.outputPath("roadmap.json");
    await writeFile(file, JSON.stringify(PLAN));
    await studio.importFile(file);
    await expect(studio.nodeTitled("Build")).toBeVisible();
    const menu = await studio.openMenu("Arrange");
    await menu.getByRole("radio", { name: "By date" }).click();
    await expect(studio.toast).toContainText("Laid out by date");
    // Picking it fits the view, animated: wait for the canvas to come to rest.
    let last = "";
    await expect
      .poll(async () => {
        const box = JSON.stringify(await studio.node("build").boundingBox());
        const still = box === last;
        last = box;
        return still;
      }, { intervals: [150] })
      .toBe(true);
  });

  test("lays the plan out on a calendar, under a ruler", async ({ studio }) => {
    const ruler = studio.root.locator(".as-roadmap-ruler");
    await expect(ruler).toBeVisible();
    await expect(ruler).toContainText(/Mar/);
    await expect(ruler).toContainText(/Apr/);

    const doc = (await studio.liveDoc()) as unknown as Doc;
    expect(doc.settings?.arrange).toBe("roadmap");
    const { from, dayWidth } = doc.settings!.roadmap!;
    expect(from).toBe("2026-03-01");
    // Build runs from Mar 23 (day 22) to the end of Apr 24 (day 54), in its frame.
    const build = doc.nodes.find((n) => n.id === "build")!;
    expect(build.w).toBe(33 * dayWidth);
    // Design ends where Build starts, less the weekend between them.
    const design = doc.nodes.find((n) => n.id === "design")!;
    expect(build.x - (design.x + design.w)).toBe(2 * dayWidth);
  });

  test("dragging a card a week to the right moves its dates a week, and undo moves them back", async ({ page, studio }) => {
    const doc = (await studio.liveDoc()) as unknown as Doc;
    const { dayWidth } = doc.settings!.roadmap!;
    // Close the Settings menu the JSON panel was opened from, or the drag's press only closes it.
    await page.keyboard.press("Escape");
    const box = (await studio.node("build").boundingBox())!;
    // Screen pixels per canvas pixel, from the card itself.
    const zoom = box.width / doc.nodes.find((n) => n.id === "build")!.w;

    // React Flow starts a drag once the pointer has moved, and the card follows
    // from there: a nudge first, so the card travels (all but) the full week.
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 2, at.y);
    await page.mouse.move(at.x + 7 * dayWidth * zoom, at.y, { steps: 12 });
    await page.mouse.up();
    await expect
      .poll(async () => ((await studio.liveDoc()) as unknown as Doc).nodes.find((n) => n.id === "build"))
      .toMatchObject({ startDate: "2026-03-30", date: "2026-05-01" });

    // The inspector says so too.
    await studio.node("build").click();
    await expect(studio.root.getByLabel("Due date")).toHaveValue("2026-05-01");

    await studio.undoButton.click();
    await expect
      .poll(async () => ((await studio.liveDoc()) as unknown as Doc).nodes.find((n) => n.id === "build"))
      .toMatchObject({ startDate: "2026-03-23", date: "2026-04-24" });
  });

  test("an SVG export draws the ruler over the plan", async ({ studio }) => {
    // A task's dates aren't timeline states, so there is no state to pick: it downloads straight away.
    const download = await studio.download(() => studio.fromMenu("Export", /^SVG vector/));
    const svg = await readFile((await download.path())!, "utf8");
    // Two months at this width: the ruler is in weeks, the first naming its year.
    expect(svg).toContain(">Feb 23 ’26<");
    expect(svg).toContain(">Mar 2<");
    expect(svg).toContain(">Apr 6<");
  });
});

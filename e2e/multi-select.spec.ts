import { writeFile } from "node:fs/promises";
import { expect, test, type Studio } from "./fixtures";

/** Two cards with room between them, and one line joining them. */
const PAIR = {
  version: 1,
  meta: { title: "Pair" },
  nodes: [
    { id: "a", label: "Alpha", kind: "service", x: 40, y: 40, w: 170, h: 76 },
    { id: "b", label: "Beta", kind: "service", x: 460, y: 40, w: 170, h: 76 },
    { id: "c", label: "Gamma", kind: "database", x: 880, y: 40, w: 170, h: 76 },
  ],
  edges: [
    { id: "ab", source: "a", target: "b", label: "calls" },
    { id: "bc", source: "b", target: "c", label: "reads" },
  ],
};

async function importPair(studio: Studio, path: string) {
  await writeFile(path, JSON.stringify(PAIR));
  await studio.importFile(path);
  await expect(studio.nodeTitled("Alpha")).toBeVisible();
  // The import fits the view with a short tween (50ms after the load, 300ms
  // long); measure nothing until the cards have stopped moving, or a band
  // drawn around them lands elsewhere. The pause carries us past the start
  // of the tween — before it, two samples agree for the wrong reason.
  await studio.page.waitForTimeout(400);
  let last = await studio.node("a").boundingBox();
  await expect
    .poll(async () => {
      const now = await studio.node("a").boundingBox();
      const still = !!now && !!last && now.x === last.x && now.width === last.width;
      last = now;
      return still;
    })
    .toBe(true);
}

test.describe("editing several things at once", () => {
  test("the inspector for a multi-selection carries the shared settings and writes them to all", async ({
    studio,
  }, testInfo) => {
    await studio.goto();
    await studio.focusEditor();
    await importPair(studio, testInfo.outputPath("pair.json"));
    await studio.page.keyboard.press("ControlOrMeta+a");
    // Nodes and connections together: the count is a tab strip, nodes first.
    const nodesTab = studio.inspector.getByRole("tab", { name: "3 nodes" });
    const edgesTab = studio.inspector.getByRole("tab", { name: "2 connections" });
    await expect(nodesTab).toHaveAttribute("aria-selected", "true");

    // Text styling reaches every node; the per-node fields are not offered.
    await expect(studio.inspector.getByLabel("Node label")).toHaveCount(0);
    await studio.inspector.getByLabel("Text alignment", { exact: true }).selectOption("center");
    await studio.inspector.getByLabel("Label size").selectOption("16");
    await expect
      .poll(async () => (await studio.liveDoc()).nodes.map((n) => [n.textAlign, n.fontSize]))
      .toEqual([["center", 16], ["center", 16], ["center", 16]]);

    // And the lines: where each end leaves from, the heads, the style.
    await edgesTab.click();
    await expect(edgesTab).toHaveAttribute("aria-selected", "true");
    await studio.inspector.getByLabel("Start anchor").selectOption("right");
    await studio.inspector.getByLabel("End anchor").selectOption("left");
    await studio.inspector.getByLabel("Edge style").selectOption("dashed");
    await expect
      .poll(async () => (await studio.liveDoc()).edges.map((e) => [e.start, e.end, e.style]))
      .toEqual([
        [{ side: "right" }, { side: "left" }, "dashed"],
        [{ side: "right" }, { side: "left" }, "dashed"],
      ]);
  });

  test("resizing one node of a multi-selection resizes them all", async ({ studio }, testInfo) => {
    await studio.goto();
    // Fit (the focus gesture) re-tweens the view, so it goes BEFORE the
    // import's own settle — a band drawn while the cards move lands elsewhere.
    await studio.focusEditor();
    await importPair(studio, testInfo.outputPath("pair.json"));
    await studio.pickTool("Select");
    await studio.band(await studio.boxAround(["a", "b"]));
    await expect(studio.node("a")).toHaveClass(/selected/);
    await expect(studio.node("b")).toHaveClass(/selected/);
    // Resizing is a Cursor-tool gesture (the handles are hidden under
    // Select); the selection survives the switch.
    await studio.pickTool("Cursor");
    await expect(studio.node("b")).toHaveClass(/selected/);

    // Drag Alpha's bottom-right handle out; Beta follows it live.
    const handle = studio.node("a").locator(".react-flow__resize-control.bottom.right.handle");
    const box = (await handle.boundingBox())!;
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await studio.page.mouse.move(from.x, from.y);
    await studio.page.mouse.down();
    await studio.page.mouse.move(from.x + 80, from.y + 40, { steps: 10 });
    const mid = await Promise.all([studio.node("a").boundingBox(), studio.node("b").boundingBox()]);
    expect(mid[0]!.width).toBeGreaterThan(170);
    expect(mid[1]!.width).toBeCloseTo(mid[0]!.width, 0);
    await studio.page.mouse.up();

    await expect
      .poll(async () => {
        const doc = await studio.liveDoc();
        const a = doc.nodes.find((n) => n.id === "a")!;
        const b = doc.nodes.find((n) => n.id === "b")!;
        const c = doc.nodes.find((n) => n.id === "c")!;
        return { same: a.w === b.w && a.h === b.h, grown: (a.w as number) > 170 && (a.h as number) > 76, c: [c.w, c.h] };
      })
      .toEqual({ same: true, grown: true, c: [170, 76] });
  });

  test("a node outside the selection resizes alone, from the handles its hover brings up", async ({
    studio,
  }, testInfo) => {
    await studio.goto();
    await studio.focusEditor();
    await importPair(studio, testInfo.outputPath("pair.json"));
    await studio.pickTool("Select");
    await studio.band(await studio.boxAround(["a", "b"]));
    await studio.pickTool("Cursor");
    await expect(studio.selectedNodes).toHaveCount(2);

    // Gamma is not selected, so it has no handles — until the pointer rests
    // on it. Then its corner is there to take, with no click first.
    const gamma = studio.node("c");
    await expect(gamma.locator(".react-flow__resize-control")).toHaveCount(0);
    await gamma.hover();
    const handle = gamma.locator(".react-flow__resize-control.bottom.right.handle");
    await expect(handle).toBeVisible();
    // Hover-only: the corners are up, the selection outline's edge lines are not.
    await expect(gamma.locator(".react-flow__resize-control.line").first()).toBeHidden();

    const box = (await handle.boundingBox())!;
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await studio.page.mouse.move(from.x, from.y);
    await studio.page.mouse.down();
    await studio.page.mouse.move(from.x + 80, from.y + 40, { steps: 10 });
    await studio.page.mouse.up();

    // Gamma grew; the selection neither followed it nor changed.
    await expect
      .poll(async () => {
        const doc = await studio.liveDoc();
        const by = Object.fromEntries(doc.nodes.map((n) => [n.id, [n.w, n.h]]));
        return { grown: (by.c![0] as number) > 170 && (by.c![1] as number) > 76, a: by.a, b: by.b };
      })
      .toEqual({ grown: true, a: [170, 76], b: [170, 76] });
    await expect(studio.node("a")).toHaveClass(/selected/);
    await expect(studio.node("b")).toHaveClass(/selected/);
    await expect(gamma).not.toHaveClass(/selected/);

    // And once the pointer moves on, the handles go with it.
    await studio.page.mouse.move(5, 400);
    await expect(gamma.locator(".react-flow__resize-control")).toHaveCount(0);
  });
});

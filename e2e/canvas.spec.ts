import { expect, test } from "./fixtures";

/**
 * Pointer paths on the canvas. These are the interactions jsdom cannot
 * exercise at all: React Flow's connection and drag machinery listens to real
 * pointer events with real geometry.
 */
test.describe("pointer work on the canvas", () => {
  test("dragging from a handle onto another card draws a connection", async ({ studio }) => {
    await studio.goto();
    // Open the panel first and re-fit, so the cards sit where the pointer
    // path expects them for the rest of the test.
    await studio.showJson();
    await studio.focusEditor();

    const before = await studio.liveDoc();
    const between = (doc: typeof before) =>
      doc.edges.filter((edge) => edge.source === "cdn" && edge.target === "wrk");
    expect(between(before)).toHaveLength(0);

    await studio.connect("cdn", "wrk");

    await expect.poll(async () => between(await studio.liveDoc()).length).toBe(1);
    const after = await studio.liveDoc();
    expect(after.edges).toHaveLength(before.edges.length + 1);
    expect(after.nodes).toHaveLength(before.nodes.length);
    // Undoable like any other edit.
    await expect(studio.undoButton).toBeEnabled();
    await studio.undoButton.click();
    await expect.poll(async () => between(await studio.liveDoc()).length).toBe(0);
  });

  test("dragging a card moves it, and the position survives save and reload", async ({ page, studio }) => {
    await studio.goto();
    await studio.showJson();
    await studio.focusEditor();

    const cdn = (doc: Awaited<ReturnType<typeof studio.liveDoc>>) => doc.nodes.find((node) => node.id === "cdn")!;
    const before = cdn(await studio.liveDoc());

    // Straight down: nothing sits under CDN, so the drop lands on open canvas.
    await studio.dragNode("cdn", 0, 110);

    // Only the vertical move is asserted: the drop snaps to the alignment
    // guide of whatever card it lands near, which can shift x by design.
    await expect.poll(async () => cdn(await studio.liveDoc()).y).toBeGreaterThan(before.y + 40);
    const moved = cdn(await studio.liveDoc());

    await studio.save();
    await page.reload();
    const after = cdn(await studio.liveDoc());
    expect(after.x).toBe(moved.x);
    expect(after.y).toBe(moved.y);
  });
});

/**
 * The tool tray and the rubber band it switches on. Entirely pointer work:
 * jsdom has no layout, so no band ever catches anything there.
 */
test.describe("the canvas tools", () => {
  test("the tray opens on hover and the Select tool bands across the cards it sweeps", async ({
    studio,
  }) => {
    await studio.goto();
    await studio.focusEditor();

    // Hover alone, no click: the tray is a mode switch reached for mid-gesture.
    await studio.toolButton.hover();
    await expect(studio.root.getByRole("menu", { name: "Canvas tools" })).toBeVisible();
    await studio.pickTool("Select");

    await studio.band(await studio.boxAround(["cdn", "api"]));

    await expect(studio.node("cdn")).toHaveClass(/selected/);
    await expect(studio.node("api")).toHaveClass(/selected/);
    await expect(studio.node("wrk")).not.toHaveClass(/selected/);
    // The band ends on a click, and the pane answers a click by dropping the
    // selection — so this is the assertion that the click was swallowed.
    await expect(studio.selectedNodes).not.toHaveCount(0);
  });

  test("a second band MERGES into the first when ⇧ is held, and replaces it otherwise", async ({
    studio,
  }) => {
    await studio.goto();
    await studio.focusEditor();
    await studio.pickTool("Select");

    await studio.band(await studio.boxAround(["cdn", "api"]));
    // The first band's inspector now floats over the Worker card.
    await studio.band(await studio.clearOfInspector(await studio.boxAround(["wrk"])), "Shift");

    await expect(studio.node("cdn")).toHaveClass(/selected/);
    await expect(studio.node("api")).toHaveClass(/selected/);
    await expect(studio.node("wrk")).toHaveClass(/selected/);

    // Without the modifier the new band is the whole selection again.
    await studio.band(await studio.clearOfInspector(await studio.boxAround(["wrk"])));
    await expect(studio.node("wrk")).toHaveClass(/selected/);
    await expect(studio.node("cdn")).not.toHaveClass(/selected/);
    await expect(studio.node("api")).not.toHaveClass(/selected/);
  });

  test("a press that never moves is still an ordinary click, and cards stay put", async ({
    studio,
  }) => {
    await studio.goto();
    await studio.showJson();
    await studio.focusEditor();
    await studio.pickTool("Select");

    const before = (await studio.liveDoc()).nodes.find((node) => node.id === "cdn")!;

    await studio.node("cdn").click();
    await expect(studio.node("cdn")).toHaveClass(/selected/);
    await expect(studio.inspector).toBeVisible();

    // A drag under this tool draws a band rather than moving what it started
    // on, so the card it began over has not budged.
    await studio.band(await studio.boxAround(["cdn"], 0));
    const after = (await studio.liveDoc()).nodes.find((node) => node.id === "cdn")!;
    expect({ x: after.x, y: after.y }).toEqual({ x: before.x, y: before.y });
  });

  test("the Cursor tool's own band merges too when ⇧ is held", async ({ studio }) => {
    await studio.goto();
    await studio.focusEditor();

    // React Flow's band — the one the Cursor tool uses — only starts on the
    // bare pane, so both drags begin in the margin outside the infra zone.
    const pane = (await studio.canvas.boundingBox())!;
    const zone = (await studio.node("zone:region").boundingBox())!;
    const gutter = zone.x - pane.x;
    expect(gutter, "empty pane to the left of the diagram").toBeGreaterThan(8);
    const outside = zone.x - gutter / 2;

    const first = await studio.boxAround(["cdn", "api"]);
    await studio.band({ ...first, x1: outside });
    await expect(studio.node("cdn")).toHaveClass(/selected/);
    await expect(studio.node("api")).toHaveClass(/selected/);

    const second = await studio.clearOfInspector(await studio.boxAround(["wrk"]));
    await studio.band({ ...second, x1: outside }, "Shift");

    // Without the merge this second band replaced the first: holding the
    // modifier did nothing at all, because React Flow drops the selection the
    // moment a band passes its click threshold.
    await expect(studio.node("wrk")).toHaveClass(/selected/);
    await expect(studio.node("cdn")).toHaveClass(/selected/);
    await expect(studio.node("api")).toHaveClass(/selected/);
  });

  test("the Pan tool drags the canvas instead of what is under the pointer", async ({ studio }) => {
    await studio.goto();
    await studio.showJson();
    await studio.focusEditor();
    await studio.pickTool("Pan");

    const before = (await studio.liveDoc()).nodes.find((node) => node.id === "cdn")!;
    const start = (await studio.node("cdn").boundingBox())!;

    await studio.page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await studio.page.mouse.down();
    await studio.page.mouse.move(start.x + start.width / 2 + 120, start.y + start.height / 2 + 60, {
      steps: 12,
    });
    await studio.page.mouse.up();

    // The card moved on screen…
    const moved = (await studio.node("cdn").boundingBox())!;
    expect(moved.x).toBeGreaterThan(start.x + 60);
    // …but only because the whole canvas did. The document is untouched.
    const after = (await studio.liveDoc()).nodes.find((node) => node.id === "cdn")!;
    expect({ x: after.x, y: after.y }).toEqual({ x: before.x, y: before.y });
  });
});

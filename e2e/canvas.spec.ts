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

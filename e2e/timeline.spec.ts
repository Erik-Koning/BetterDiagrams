import { expect, test } from "./fixtures";

test.describe("the timeline", () => {
  test("scrubbing ghosts or hides what has not landed yet", async ({ studio }) => {
    await studio.goto();

    // Offered because the example has dated elements.
    await studio.root.getByRole("button", { name: "⏱ Timeline" }).click();
    const scrubber = studio.root.getByRole("group", { name: "Timeline scrubber" });
    await expect(scrubber).toBeVisible();

    // Jump to the first dated point, before Queue and Worker exist.
    await scrubber.getByTitle("Jump to a specific date").click();
    await scrubber.getByLabel("Jump to a date", { exact: true }).fill("2026-03-02");
    await scrubber.getByLabel("Jump to a date", { exact: true }).press("Enter");
    // Ahead of 2026-03-02 in the example: Queue, Worker, Payments; the three
    // connections into them; and the vendor zone.
    await expect(scrubber.locator(".as-timeline__ahead")).toHaveText("7 ahead");

    // Ghost (the default): still drawn, marked as future.
    await expect(studio.node("q")).toHaveClass(/as-future/);
    await expect(studio.node("wrk")).toHaveClass(/as-future/);
    await expect(studio.node("cdn")).not.toHaveClass(/as-future/);

    // Hide: gone from the canvas; the document itself is untouched.
    await scrubber.getByRole("button", { name: "Hide later" }).click();
    await expect(studio.node("q")).toHaveCount(0);
    await expect(studio.node("wrk")).toHaveCount(0);
    await expect(studio.nodeTitled("CDN")).toBeVisible();
    const doc = await studio.liveDoc();
    expect(doc.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(["q", "wrk", "pay"]));

    // The next dated point is the one Queue and Worker land on.
    await scrubber.getByRole("button", { name: "Next dated point" }).click();
    await expect(studio.nodeTitled("Queue")).toBeVisible();
    await expect(studio.nodeTitled("Worker")).toBeVisible();
    await expect(studio.node("pay")).toHaveCount(0);

    await scrubber.getByRole("button", { name: "Exit timeline" }).click();
    await expect(scrubber).toBeHidden();
    await expect(studio.nodeTitled("Payments")).toBeVisible();
  });
});

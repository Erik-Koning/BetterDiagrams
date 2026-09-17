import { writeFile } from "node:fs/promises";
import { expect, test } from "./fixtures";

/** One group with contents, one node outside it, one edge crossing the frame. */
const FOLDED = {
  version: 1,
  meta: { title: "Folded overview" },
  settings: { groupContents: "hide" },
  nodes: [
    { id: "vpc", label: "Application VPC", kind: "group", x: 40, y: 40, w: 400, h: 240 },
    { id: "api", label: "REST API", kind: "service", parentId: "vpc", x: 24, y: 48, w: 170, h: 76 },
    { id: "db", label: "Postgres", kind: "database", x: 600, y: 100, w: 170, h: 76 },
  ],
  edges: [{ id: "e1", source: "api", target: "db", label: "reads" }],
};

test.describe("folding every group", () => {
  test("a document that hides group contents opens folded; the toolbar toggle flips it", async ({ page, studio }, testInfo) => {
    await studio.goto();
    // The default document never set the preference, so no switch is offered.
    await expect(studio.root.getByRole("button", { name: "Fold groups" })).toHaveCount(0);

    const file = testInfo.outputPath("folded.json");
    await writeFile(file, JSON.stringify(FOLDED));
    const chooser = page.waitForEvent("filechooser");
    await studio.root.getByRole("button", { name: "Import", exact: true }).click();
    await (await chooser).setFiles(file);

    // Folded: the chip stands in for the group, its contents are off the
    // canvas, and the edge into them lands on the chip.
    await expect(studio.node("vpc")).toBeVisible();
    await expect(studio.node("vpc")).toContainText("Application VPC");
    await expect(studio.nodeTitled("REST API")).toHaveCount(0);
    await expect(studio.page.locator(".react-flow__edge")).toHaveCount(1);
    // The chip has no expand toggle of its own — the fold is the document's.
    await expect(studio.node("vpc").getByRole("button", { name: /Expand/ })).toHaveCount(0);
    const toggle = studio.root.getByRole("button", { name: "Fold groups" });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    await toggle.click();
    await expect(studio.nodeTitled("REST API")).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect
      .poll(async () => (await studio.liveDoc()).settings)
      .toEqual({ groupContents: "show" });
    // Unfolding hands back the frame at its stored size, not a 180×44 chip.
    const vpc = (await studio.liveDoc()).nodes.find((n) => n.id === "vpc")!;
    expect(vpc).toMatchObject({ w: 400, h: 240 });
    expect(vpc.collapsed).toBeUndefined();

    await toggle.click();
    await expect(studio.nodeTitled("REST API")).toHaveCount(0);
    await expect
      .poll(async () => (await studio.liveDoc()).settings)
      .toEqual({ groupContents: "hide" });

    // A document edit like any other: ⌘Z brings the contents back.
    await studio.root.getByRole("button", { name: "Undo" }).click();
    await expect(studio.nodeTitled("REST API")).toBeVisible();
  });

  test("an empty frame stays open under the fold, and a drop into it lifts the fold rather than vanishing", async ({
    page,
    studio,
  }, testInfo) => {
    await studio.goto();
    await studio.focusEditor();
    const file = testInfo.outputPath("spare.json");
    await writeFile(
      file,
      JSON.stringify({
        ...FOLDED,
        nodes: [
          ...FOLDED.nodes,
          { id: "spare", label: "Spare frame", kind: "group", x: 40, y: 400, w: 360, h: 220 },
        ],
      }),
    );
    const chooser = page.waitForEvent("filechooser");
    await studio.root.getByRole("button", { name: "Import", exact: true }).click();
    await (await chooser).setFiles(file);
    await expect(studio.nodeTitled("Postgres")).toBeVisible();
    // Nothing inside, nothing to fold: the frame renders open, at its size.
    await expect(studio.node("spare")).toHaveClass(/react-flow__node-group/);
    const frame = (await studio.node("spare").boundingBox())!;
    expect(frame.width).toBeGreaterThan(300);

    // Drop the database into it. The frame now has contents the fold would
    // close over — so the edit lifts the fold instead: the card stays in
    // view inside its new frame, every other group opens too, and the
    // toolbar toggle is there to fold it all again.
    const db = (await studio.node("db").boundingBox())!;
    await studio.dragNode("db", frame.x + frame.width / 2 - (db.x + db.width / 2), frame.y + frame.height / 2 - (db.y + db.height / 2));
    await expect(studio.nodeTitled("Postgres")).toBeVisible();
    await expect(studio.nodeTitled("REST API")).toBeVisible();
    await expect(studio.toast).toContainText("group contents shown");
    const toggle = studio.root.getByRole("button", { name: "Fold groups" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect
      .poll(async () => {
        const doc = await studio.liveDoc();
        return [doc.settings, doc.nodes.find((n) => n.id === "db")!.parentId];
      })
      .toEqual([{ groupContents: "show" }, "spare"]);

    // One undo entry for the drop and the unfold together.
    await studio.root.getByRole("button", { name: "Undo" }).click();
    await expect(studio.nodeTitled("Postgres")).toBeVisible();
    await expect(studio.nodeTitled("REST API")).toHaveCount(0);
    await expect
      .poll(async () => (await studio.liveDoc()).nodes.find((n) => n.id === "db")!.parentId)
      .toBeNull();

    // And the toggle still folds everything, including a frame filled later.
    await studio.root.getByRole("button", { name: "Redo" }).click();
    await expect(studio.nodeTitled("Postgres")).toBeVisible();
    await toggle.click();
    await expect(studio.nodeTitled("Postgres")).toHaveCount(0);
    await expect(studio.nodeTitled("REST API")).toHaveCount(0);
  });
});

import { Studio, expect, test } from "./fixtures";

test.describe("two tabs on one workspace", () => {
  test("a save in one tab reaches the other through the storage event", async ({ context, studio }) => {
    await studio.goto();
    // Persist the seeded files first, so the second tab shares their ids.
    await studio.save();

    const other = new Studio(await context.newPage());
    await other.goto();
    await expect(other.nodeTitled("REST API")).toBeVisible();

    await studio.fromMenu("Insert", /^Node /);
    await studio.inspector.getByLabel("Node label", { exact: true }).fill("Checkout Service");
    await expect(studio.nodeTitled("Checkout Service")).toBeVisible();
    // Live edits stay in the tab that made them.
    await expect(other.nodeTitled("Checkout Service")).toHaveCount(0);

    await studio.save();
    await expect(other.nodeTitled("Checkout Service")).toBeVisible();
    await expect(other.nodeTitled("REST API")).toBeVisible();
  });
});

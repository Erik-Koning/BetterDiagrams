import { ARCH_FILE, expect, SMALL_SEQUENCE, SMALL_TEMPLATE, test } from "./fixtures";

test.describe("pasting JSON", () => {
  test("into the welcome modal seeds the new file", async ({ page, studio }) => {
    await studio.goto();
    await studio.newFile();

    const welcome = page.getByRole("dialog", { name: "Get started" });
    await welcome.getByLabel("File name", { exact: true }).fill("Pasted diagram");
    await welcome.getByLabel("Diagram JSON").fill(JSON.stringify(SMALL_TEMPLATE, null, 2));
    await expect(welcome.getByRole("button", { name: "Architecture" })).toHaveAttribute("aria-pressed", "true");
    await welcome.getByRole("button", { name: "Insert", exact: true }).click();

    await expect(welcome).toBeHidden();
    await expect(studio.fileButton).toHaveText(/^Pasted diagram/);
    await expect(studio.nodeTitled("Auth Service")).toBeVisible();
    await expect(studio.nodeTitled("Users DB")).toBeVisible();
  });

  test("a sequence document is recognised and routed to a new sequence file", async ({ page, studio }) => {
    await studio.goto();
    await studio.newFile();

    const welcome = page.getByRole("dialog", { name: "Get started" });
    await welcome.getByLabel("Diagram JSON").fill(JSON.stringify(SMALL_SEQUENCE, null, 2));
    // The picker follows the shape of the paste.
    await expect(welcome.getByRole("button", { name: "Sequence" })).toHaveAttribute("aria-pressed", "true");
    await welcome.getByRole("button", { name: "Insert", exact: true }).click();

    await expect(welcome).toBeHidden();
    await expect(studio.participant("Alice")).toBeVisible();
    await expect(studio.participant("Identity Provider")).toBeVisible();
    await expect(studio.message("authenticate")).toBeVisible();

    const workspace = await studio.workspace();
    const active = workspace.files.find((file) => file.id === workspace.activeId);
    expect(active?.kind).toBe("sequence");
  });

  test("Edit template JSON rewrites the current file in place", async ({ page, studio }) => {
    await studio.goto();
    const json = await studio.showJson();

    await page.getByRole("button", { name: "✎ Edit template JSON" }).click();
    const dialog = page.getByRole("dialog", { name: "Get started" });
    await expect(dialog.getByLabel("File name", { exact: true })).toHaveValue(ARCH_FILE);
    // This dialog edits the current file, so its kind is pinned.
    await expect(dialog.getByRole("button", { name: "Sequence" })).toBeDisabled();
    await expect(dialog.getByLabel("Diagram JSON")).toContainText('"version": 1');

    await dialog.getByLabel("Diagram JSON").fill(JSON.stringify(SMALL_TEMPLATE, null, 2));
    await dialog.getByRole("button", { name: "Insert", exact: true }).click();

    await expect(dialog).toBeHidden();
    await expect(studio.nodeTitled("Auth Service")).toBeVisible();
    await expect(studio.nodeTitled("REST API")).toHaveCount(0);
    await expect(json).toContainText('"label": "Auth Service"');
  });
});

import { ARCH_FILE, SEQ_FILE, expect, test } from "./fixtures";

test.describe("the workspace of files", () => {
  test("switches to the sequence file and back", async ({ page, studio }) => {
    await studio.goto();

    await studio.openFile(SEQ_FILE);
    await expect(studio.participant("Customer")).toBeVisible();
    await expect(studio.participant("Payment Gateway")).toBeVisible();
    await expect(studio.message("POST /orders")).toBeVisible();
    // The host's header follows the active file's kind.
    await expect(page.getByRole("button", { name: "⇄ Architecture" })).toBeVisible();
    await expect(page.getByRole("button", { name: "→ Sequence" })).toBeHidden();

    await studio.openFile(ARCH_FILE);
    await expect(studio.nodeTitled("REST API")).toBeVisible();
    await expect(page.getByRole("button", { name: "→ Sequence" })).toBeVisible();
  });

  test("the active file is remembered across a reload", async ({ page, studio }) => {
    await studio.goto();
    await studio.openFile(SEQ_FILE);

    await page.reload();
    await expect(studio.fileButton).toHaveText(new RegExp(`^${SEQ_FILE}`));
    await expect(studio.participant("Customer")).toBeVisible();
  });

  test("a file: link on a node jumps to the linked file", async ({ studio }) => {
    await studio.goto();

    await studio.node("pay").getByLabel(`Open linked file ${SEQ_FILE}`).click();
    await expect(studio.fileButton).toHaveText(new RegExp(`^${SEQ_FILE}`));
    await expect(studio.participant("Order API")).toBeVisible();
  });

  test("a new file opens the welcome modal, and a blank file deletes without asking", async ({ page, studio }) => {
    await studio.goto();

    await studio.newFile();
    const welcome = page.getByRole("dialog", { name: "Get started" });
    await expect(welcome).toBeVisible();
    await expect(welcome.getByLabel("File name", { exact: true })).toHaveValue("Untitled 3");

    // "Manually" keeps its promise: the new file opens with a first node in it.
    await welcome.getByRole("button", { name: "Insert Node Manually" }).click();
    await expect(welcome).toBeHidden();
    await expect(studio.fileButton).toHaveText(/^Untitled 3/);
    await expect(studio.nodeTitled("New Service")).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(1);

    // Undo it away: an empty file is deleted without the confirmation.
    await studio.undoButton.click();
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
    const menu = await studio.openFileMenu();
    await menu.getByRole("button", { name: "Delete Untitled 3" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(studio.fileButton).toHaveText(new RegExp(`^${SEQ_FILE}`));
  });

  test("renames a file from the menu and the document title follows", async ({ page, studio }) => {
    await studio.goto();

    const menu = await studio.openFileMenu();
    await menu.getByRole("button", { name: `Rename ${ARCH_FILE}` }).click();
    const input = menu.getByLabel("File name", { exact: true });
    await expect(input).toHaveValue(ARCH_FILE);
    await input.fill("Platform");
    await input.press("Enter");

    await expect(studio.fileButton).toHaveText(/^Platform/);
    const json = await studio.showJson();
    await expect(json).toContainText('"title": "Platform"');

    // Structure operations persist immediately, without a Save.
    await page.reload();
    await expect(studio.fileButton).toHaveText(/^Platform/);
  });

  test("deleting a file with content asks first, and Recently removed restores it", async ({ page, studio }) => {
    await studio.goto();

    let menu = await studio.openFileMenu();
    await menu.getByRole("button", { name: `Delete ${SEQ_FILE}` }).click();
    const confirm = page.getByRole("dialog", { name: `Delete ${SEQ_FILE}?` });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Delete file" }).click();
    await expect(confirm).toBeHidden();
    await expect(studio.fileButton).toHaveText(new RegExp(`^${ARCH_FILE}`));

    menu = await studio.openFileMenu();
    await expect(menu.getByTitle(`Open ${SEQ_FILE}`)).toHaveCount(0);
    await menu.getByRole("menuitem", { name: /Recently removed/ }).click();

    const removed = page.getByRole("dialog", { name: "Recently removed" });
    await removed.getByRole("button", { name: `Restore ${SEQ_FILE}` }).click();
    await expect(studio.fileButton).toHaveText(new RegExp(`^${SEQ_FILE}`));
    await expect(studio.participant("Customer")).toBeVisible();
  });

  test("→ Sequence derives a new sequence file from the numbered flow", async ({ page, studio }) => {
    await studio.goto();

    await page.getByRole("button", { name: "→ Sequence" }).click();
    for (const label of ["REST API", "Queue", "Worker"]) {
      await expect(studio.participant(label)).toBeVisible();
    }
    await expect(studio.message("enqueue")).toBeVisible();
    await expect(studio.message("consume")).toBeVisible();

    // A NEW file, never the source. The derived document keeps the diagram's
    // title, so the file takes that name too: two entries, one of each kind.
    const menu = await studio.openFileMenu();
    const entries = menu.getByTitle(`Open ${ARCH_FILE}`);
    await expect(entries).toHaveCount(2);
    await expect(entries.filter({ hasText: "arch" })).toHaveCount(1);
    await expect(entries.filter({ hasText: "seq" })).toHaveCount(1);

    const workspace = await studio.workspace();
    expect(workspace.files).toHaveLength(3);
    expect(workspace.files.find((file) => file.id === workspace.activeId)?.kind).toBe("sequence");
    expect(workspace.files.find((file) => file.kind === "architecture")?.doc.nodes?.length).toBeGreaterThan(0);
  });
});

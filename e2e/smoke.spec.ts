import { ARCH_FILE, SEQ_FILE, expect, exact, test } from "./fixtures";

test.describe("workspace shell", () => {
  test("loads the seeded workspace with the example architecture", async ({ page, studio }) => {
    await studio.goto();

    await expect(page).toHaveTitle(/Architecture Studio/);
    await expect(page.getByRole("heading", { level: 1, name: "BetterDiagrams" })).toBeVisible();
    await expect(studio.fileButton).toHaveText(exact(`${ARCH_FILE} ▾`));

    for (const label of ["CDN", "REST API", "Queue", "Worker", "Payments"]) {
      await expect(studio.nodeTitled(label)).toBeVisible();
    }

    await expect(studio.menuButton("Insert")).toBeVisible();
    await expect(studio.menuButton("Export")).toBeVisible();
    await expect(studio.saveButton).toHaveText("Save");
    await expect(studio.saveButton).toBeEnabled();
    await expect(studio.undoButton).toBeDisabled();
  });

  test("the file menu lists both seeded files with their kinds", async ({ studio }) => {
    await studio.goto();
    const menu = await studio.openFileMenu();

    await expect(menu.getByTitle(`Open ${ARCH_FILE}`)).toContainText("arch");
    await expect(menu.getByTitle(`Open ${SEQ_FILE}`)).toContainText("seq");
    await expect(menu.getByRole("menuitem", { name: /New file/ })).toBeVisible();
  });

  test("read-only hides the editing chrome and restores it when unchecked", async ({ page, studio }) => {
    await studio.goto();
    const readOnly = page.getByLabel("Read-only", { exact: true });

    await readOnly.check();
    await expect(studio.menuButton("Insert")).toBeHidden();
    await expect(studio.saveButton).toBeHidden();
    await expect(studio.undoButton).toBeHidden();
    // The diagram itself still renders.
    await expect(studio.nodeTitled("REST API")).toBeVisible();

    await readOnly.uncheck();
    await expect(studio.menuButton("Insert")).toBeVisible();
    await expect(studio.saveButton).toBeVisible();
  });

  test("the host's theme and minimap toggles reach the editor", async ({ page, studio }) => {
    await studio.goto();
    const app = page.locator(".app");
    const minimap = page.locator(".react-flow__minimap");

    await expect(app).toHaveAttribute("data-theme", "dark");
    await page.getByLabel("Light", { exact: true }).check();
    await expect(app).toHaveAttribute("data-theme", "light");

    await expect(minimap).toBeVisible();
    await page.getByLabel("Minimap", { exact: true }).uncheck();
    await expect(minimap).toBeHidden();
  });
});

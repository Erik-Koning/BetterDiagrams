/**
 * Loading a real schema and reading it at scale: a SQL script through the
 * toolbar, domains that set the shared tables aside, a sensitivity
 * suggestion fixed from Checks, and the exported page showing the shared
 * list and a profiled table's numbers.
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";

const FIXTURES = join(__dirname, "../packages/better-diagrams/src/contract/import/fixtures");
const POSTGRES = join(FIXTURES, "postgres.sql");

const table = (id: string, fields: Array<Record<string, unknown>>, x: number, y: number, over: Record<string, unknown> = {}) => ({
  id, label: id, kind: "table", icon: "none", description: "", parentId: null, x, y, w: 200, h: 110,
  fields: fields.map((f) => ({ id: String(f.name), ...f })), ...over,
});

/** Three clusters of four tables, every table also keyed to users; users profiled; one untagged email. */
function hubModel() {
  const nodes: unknown[] = [
    table("users", [{ name: "id", key: "pk" }, { name: "email" }], 0, 0, {
      data: { model: { profile: { rowCount: 200, columns: { email: { nullRate: 0.125, distinct: 175 } } } } },
    }),
  ];
  const edges: unknown[] = [];
  for (let c = 0; c < 3; c++) {
    for (let k = 0; k < 4; k++) {
      const id = `c${c}t${k}`;
      nodes.push(table(id, [{ name: "id", key: "pk" }, { name: "user_id", key: "fk" }, { name: "next_id", key: "fk" }], 300 + k * 260, c * 220));
      edges.push({ id: `${id}-u`, source: id, target: "users", label: "", style: "dashed", color: "slate", startField: "user_id", endField: "id" });
      edges.push({ id: `${id}-n`, source: id, target: `c${c}t${(k + 1) % 4}`, label: "", style: "dashed", color: "slate", startField: "next_id", endField: "id" });
    }
  }
  return { version: 1, meta: { title: "Hub model" }, nodes, edges };
}

test.describe("loading a schema", () => {
  test("a SQL script from the toolbar becomes tables, keys and schema groups", async ({ studio }) => {
    await studio.goto();
    await studio.importFile(POSTGRES);
    await expect(studio.nodeTitled("order_lines")).toBeVisible();
    await expect(studio.root.getByText(/Imported 4 tables · 4 keys from postgres\.sql/)).toBeVisible();
    await expect.poll(async () => (await studio.liveDoc()).edges.length).toBe(4);
    const doc = await studio.liveDoc();
    expect(doc.nodes.filter((n) => n.kind === "group").map((n) => n.label)).toEqual(["public", "sales"]);
    expect(doc.edges.find((e) => e.source === "sales.order_lines" && e.target === "sales.orders")).toMatchObject({ relation: "composition" });
  });

  test("Import folder reads a dbt project's target/: manifest and catalog together", async ({ studio, page }) => {
    await studio.goto();
    // A real directory, picked the way a reader picks one.
    const target = join(test.info().outputPath("jaffle_shop"), "target");
    await mkdir(target, { recursive: true });
    await copyFile(join(FIXTURES, "dbt/manifest.json"), join(target, "manifest.json"));
    await copyFile(join(FIXTURES, "dbt/catalog.json"), join(target, "catalog.json"));
    await writeFile(join(target, "run_results.json"), "{}");
    await page.locator("input[webkitdirectory]").setInputFiles(test.info().outputPath("jaffle_shop"));
    const replace = page.getByRole("dialog", { name: /^Replace this diagram/ }).getByRole("button", { name: "Replace" });
    await replace.waitFor({ state: "visible", timeout: 1500 }).then(() => replace.click(), () => undefined);
    await expect(studio.root.getByText(/from the dbt manifest and catalog/)).toBeVisible();
    await expect(studio.nodeTitled("order_items")).toBeVisible();
    const doc = await studio.liveDoc();
    expect(doc.meta?.title).toBe("jaffle_shop");
    const customers = doc.nodes.find((n) => n.id === "marts.customers") as { fields?: Array<{ id: string; type?: string; key?: string }> } | undefined;
    // The catalog's types, the tests' key.
    expect(customers?.fields?.find((f) => f.id === "customer_id")).toMatchObject({ type: "NUMBER", key: "pk" });
    expect(doc.edges.some((e) => e.source === "marts.orders" && e.target === "marts.customers")).toBe(true);
  });
});

test.describe("at scale", () => {
  test.beforeEach(async ({ studio }, testInfo) => {
    await studio.goto();
    const file = testInfo.outputPath("hub-model.json");
    await writeFile(file, JSON.stringify(hubModel()));
    await studio.importFile(file);
    await expect(studio.nodeTitled("c0t0")).toBeVisible();
  });

  test("domains set the table every cluster points at aside, and find the clusters", async ({ studio }) => {
    await studio.fromMenu("View", /^Model structure/);
    const panel = studio.root.getByRole("region", { name: "Model structure" });
    await expect(panel.getByRole("status")).toContainText("13 tables · 3 domains · 1 shared");
    await panel.getByRole("tab", { name: "Domains" }).click();
    await expect(panel.getByRole("region", { name: "Shared tables" })).toContainText("users");
  });

  test("a column that looks personal is suggested a tag, and Fix tags the row", async ({ studio }) => {
    // The menu button's name carries the count ("Checks (3)").
    await studio.root.getByRole("button", { name: /^Checks/ }).click();
    await studio.root.getByRole("menuitem", { name: /Show all \d+ in a panel/ }).click();
    const panel = studio.root.getByRole("region", { name: "Checks" });
    const sensitive = panel.getByRole("list", { name: "Looks sensitive, not tagged" });
    await expect(sensitive).toContainText('"users.email" looks like an email address');
    await sensitive.getByRole("button", { name: "Fix" }).click();
    await expect
      .poll(async () => {
        const users = (await studio.liveDoc()).nodes.find((n) => n.id === "users") as { fields?: Array<{ id: string; tags?: string[] }> } | undefined;
        return users?.fields?.find((f) => f.id === "email")?.tags;
      })
      .toEqual(["pii:email"]);
  });

  test("the exported page shows the shared table and a profiled table's numbers", async ({ studio, page }) => {
    const download = await studio.download(() => studio.fromMenu("Export", /^Interactive HTML/));
    const html = test.info().outputPath("hub.html");
    await download.saveAs(html);
    await page.goto(`file://${html}`);
    await page.locator("#bd-menu").click();
    await page.locator("#bd-structbtn").click();
    await page.locator("#bd-panel").getByRole("tab", { name: "Domains" }).click();
    await expect(page.locator("#bd-panel [aria-label='Shared by every domain']")).toContainText("users");
    await page.locator('[data-el="node:users"]').first().click({ button: "right" });
    await page.locator("#bd-context").getByRole("menuitem", { name: /View all fields/ }).click();
    await expect(page.locator("#bd-grid thead th").last()).toHaveText("Distinct");
    await expect(page.locator("#bd-grid tbody tr", { hasText: "email" })).toContainText("12.5%");
  });
});

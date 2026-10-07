/**
 * Templates on disk are live while developing: a file opened from the
 * templates menu is bound to it — app edits save back, edits made by any
 * other program reload in the app, and the file on disk wins. The dev server
 * under test keeps its templates in a temporary folder (templates-dir.ts),
 * so nothing here touches the repo's templates/ — and links a second
 * temporary folder the way `BD_LINKED_DIRS` links one outside the repo.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { E2E_LINKED_DIR, E2E_LINKS_ROOT, E2E_PICK_DIR, E2E_TEMPLATES_DIR } from "./templates-dir";

test.use({ diskTemplates: true });

const SCRATCH = join(E2E_TEMPLATES_DIR, "scratch");
const EXAMPLES = join(E2E_TEMPLATES_DIR, "examples");

const task = (id: string, label: string, x: number, y: number, over: Record<string, unknown> = {}) => ({
  id, label, kind: "task", icon: "none", description: "", parentId: null, x, y, w: 200, h: 84, ...over,
});

const plan = (title: string) => ({
  version: 1,
  meta: { title },
  nodes: [
    task("design", "Design", 80, 120, { assignees: ["Ana"] }),
    task("build", "Build", 480, 120, { assignees: ["Ravi"] }),
    task("ship", "Ship", 880, 120),
  ],
  edges: [
    { id: "a", source: "design", target: "build", label: "", style: "solid", color: "slate" },
    { id: "b", source: "build", target: "ship", label: "", style: "solid", color: "slate" },
  ],
});

type Doc = ReturnType<typeof plan>;
const read = (path: string): Doc => JSON.parse(readFileSync(path, "utf8"));
const nodeOf = (doc: Doc, id: string) => doc.nodes.find((n) => n.id === id)!;
/** Another program editing the file: read, change, write back. */
const editOnDisk = (path: string, change: (doc: Doc) => void) => {
  const doc = read(path);
  change(doc);
  writeFileSync(path, JSON.stringify(doc, null, 2));
};

const title = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"] .as-node__title`);
const reloadToasts = (page: Page) => page.locator("[data-sonner-toast]").filter({ hasText: "Reloaded" });

/**
 * A workspace of one uniquely named file, so this test's auto-save writes a
 * file no other test reads — tests run in parallel against one server.
 */
async function seedWorkspace(context: BrowserContext, name: string) {
  await context.addInitScript(
    (ws) => {
      // Init scripts also run on about:blank, where storage is off limits.
      if (location.protocol !== "http:") return;
      if (!localStorage.getItem("better-diagrams:workspace")) localStorage.setItem("better-diagrams:workspace", ws);
    },
    JSON.stringify({
      files: [{ id: "seed", name, kind: "architecture", doc: { version: 1, nodes: [{ id: "s", label: "Seed", kind: "task", x: 0, y: 0 }], edges: [] } }],
      activeId: "seed",
      removed: [],
    }),
  );
}

let created: string[] = [];
let base = "";
/** The id the server addresses the linked folder by — `linked-<name>-<hash>`. */
let linkedId: string | undefined;

test.beforeEach(async ({ context, request }, testInfo) => {
  // Only ever against a server whose templates live in the temporary folder:
  // a dev server someone started by hand on the e2e port, reused by
  // Playwright, would be pointed at the repo's own templates/.
  const probe = await (await request.get("/__templates")).json().catch(() => null);
  test.skip(
    probe?.dirs?.scratch !== SCRATCH,
    `the dev server on the e2e port is not using ${E2E_TEMPLATES_DIR} — stop it and let Playwright start its own`,
  );
  linkedId = (probe?.linked as { folder: string; dir: string }[] | undefined)?.find((l) => l.dir === E2E_LINKED_DIR)?.folder;
  mkdirSync(SCRATCH, { recursive: true });
  mkdirSync(EXAMPLES, { recursive: true });
  base = `zz-w${testInfo.workerIndex}-${testInfo.testId.slice(0, 8)}`.toLowerCase();
  created = [join(SCRATCH, `${base}-seed.json`)];
  await seedWorkspace(context, `${base}-seed`);
});

/** Folders a test linked from the app — unlinked and removed after it. */
let linkedDirs: string[] = [];

test.afterEach(async ({ request }) => {
  for (const path of created) rmSync(path, { force: true });
  if (linkedDirs.length) {
    const listing = await (await request.get("/__templates")).json().catch(() => null);
    for (const link of (listing?.linked ?? []) as { folder: string; dir: string; source: string }[]) {
      if (linkedDirs.includes(link.dir) && link.source === "saved") await request.delete(`/__templates/links/${link.folder}`);
    }
    for (const dir of linkedDirs) if (dir !== E2E_PICK_DIR) rmSync(dir, { recursive: true, force: true });
    linkedDirs = [];
  }
});

/** Write a plan file into a templates folder and open it in the app. */
async function openPlan(
  studio: { goto(): Promise<void>; openTemplate(file: string): Promise<void>; page: Page },
  folder: string,
  file = `${base}.json`,
) {
  const path = join(folder, file);
  created.push(path);
  writeFileSync(path, JSON.stringify(plan(`Sync ${base}`), null, 2));
  await studio.goto();
  await studio.openTemplate(file);
  await expect(title(studio.page, "design")).toHaveText("Design");
  return { file, path };
}

test("a file opened from disk is its own workspace file, bound to it, and opening writes nothing", async ({ studio }) => {
  const { file, path } = await openPlan(studio, SCRATCH);
  const before = readFileSync(path, "utf8");
  const ws = await studio.workspace();
  const opened = ws.files.find((f) => (f as { disk?: { file: string } }).disk?.file === file);
  expect(opened, "a workspace file bound to the template").toBeTruthy();
  expect(ws.files).toHaveLength(2);
  expect(ws.activeId).toBe(opened!.id);
  // Past the auto-save debounce: still the exact text its author wrote.
  await studio.page.waitForTimeout(1500);
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("an edit made on disk reloads in the app with no action", async ({ studio, page }) => {
  const { path } = await openPlan(studio, SCRATCH);
  editOnDisk(path, (doc) => {
    nodeOf(doc, "build").label = "Build v2";
    Object.assign(nodeOf(doc, "build"), { done: true });
  });
  await expect(title(page, "build")).toHaveText("Build v2");
  await expect(page.locator('.react-flow__node[data-id="build"] .as-task__check--done')).toHaveCount(1);
  await expect(reloadToasts(page)).toHaveCount(1);
});

test("an edit in the app saves back to the file, and never bounces back as a reload", async ({ studio, page }) => {
  const { path } = await openPlan(studio, SCRATCH);
  await page.locator('.react-flow__node[data-id="design"]').getByRole("checkbox").click();
  await expect.poll(() => (nodeOf(read(path), "design") as { done?: boolean }).done).toBe(true);
  // The server's own write is not announced, so the app never reloads itself.
  await page.waitForTimeout(800);
  await expect(reloadToasts(page)).toHaveCount(0);
});

test("a conflict inside the save debounce: the file on disk wins", async ({ studio, page }) => {
  const { path } = await openPlan(studio, SCRATCH);
  // Design waits on nothing, so its check takes the press (Ship's is blocked).
  await page.locator('.react-flow__node[data-id="design"]').getByRole("checkbox").click();
  // The app's save is still waiting out its debounce when the outside edit lands.
  editOnDisk(path, (doc) => {
    nodeOf(doc, "ship").label = "Ship (moved to Friday)";
  });
  await expect(title(page, "ship")).toHaveText("Ship (moved to Friday)");
  await page.waitForTimeout(1500);
  const onDisk = read(path);
  expect(nodeOf(onDisk, "ship").label).toBe("Ship (moved to Friday)");
  expect((nodeOf(onDisk, "design") as { done?: boolean }).done).toBeUndefined();
});

test("an edit made while the app was closed wins at startup, and is not overwritten", async ({ studio, context }) => {
  const { path } = await openPlan(studio, SCRATCH);
  await studio.page.close();
  editOnDisk(path, (doc) => {
    nodeOf(doc, "ship").label = "Ship (edited while closed)";
  });
  const page = await context.newPage();
  await page.goto("/");
  await expect(title(page, "ship")).toHaveText("Ship (edited while closed)");
  await page.waitForTimeout(1500);
  expect(nodeOf(read(path), "ship").label).toBe("Ship (edited while closed)");
});

test("opening a file that is already open switches to it instead of opening a copy", async ({ studio }) => {
  const { file } = await openPlan(studio, SCRATCH);
  await studio.openTemplate(file);
  const ws = await studio.workspace();
  expect(ws.files.filter((f) => (f as { disk?: { file: string } }).disk?.file === file)).toHaveLength(1);
});

test("an example is saved back when edited, and the app can never delete one", async ({ studio, page, request }) => {
  const { file, path } = await openPlan(studio, EXAMPLES);
  await page.locator('.react-flow__node[data-id="design"]').getByRole("checkbox").click();
  await expect.poll(() => (nodeOf(read(path), "design") as { done?: boolean }).done).toBe(true);
  const refused = await request.delete(`/__templates/examples/${file}`);
  expect(refused.status()).toBe(403);
  expect(read(path).nodes).toHaveLength(3);
});

/** Linked-folder tests need the server to be linking the e2e folder. */
const needsLink = () =>
  test.skip(!linkedId, `the dev server on the e2e port is not linking ${E2E_LINKED_DIR} — stop it and let Playwright start its own`);

test("a diagram in a linked folder outside the repo is live: app edits save back, disk edits reload", async ({ studio, page }) => {
  needsLink();
  // Named the way another project names things, not the way the app slugs.
  const { file, path } = await openPlan(studio, E2E_LINKED_DIR, `Zz Tracker_${base}.json`);
  const ws = await studio.workspace();
  const bound = ws.files.find((f) => (f as { disk?: { file: string } }).disk?.file === file) as { disk: { folder: string } } | undefined;
  expect(bound?.disk.folder).toBe(linkedId);

  await page.locator('.react-flow__node[data-id="design"]').getByRole("checkbox").click();
  await expect.poll(() => (nodeOf(read(path), "design") as { done?: boolean }).done).toBe(true);

  editOnDisk(path, (doc) => {
    nodeOf(doc, "ship").label = "Ship (edited in the other project)";
  });
  await expect(title(page, "ship")).toHaveText("Ship (edited in the other project)");
  await expect(reloadToasts(page)).toHaveCount(1);
});

test("a linked folder is never deleted from, never written over a non-diagram, and never escaped", async ({ studio, page, request }) => {
  needsLink();
  const diagram = `${base}.json`;
  const pkg = `${base}-package.json`;
  for (const [file, doc] of [
    [diagram, plan(`Linked ${base}`)],
    [pkg, { name: "not-a-diagram", version: "1.0.0" }],
  ] as const) {
    const path = join(E2E_LINKED_DIR, file);
    created.push(path);
    writeFileSync(path, JSON.stringify(doc, null, 2));
  }

  // Listed under its own caption; the package.json shows but cannot open.
  await studio.goto();
  await page.getByRole("button", { name: "Settings" }).click();
  const menu = page.getByRole("menu", { name: "Settings" });
  await expect(menu.getByText("Linked / better-diagrams-e2e-linked")).toBeVisible();
  await expect(menu.getByRole("menuitem").filter({ hasText: diagram }).first()).toBeEnabled();
  const pkgItem = menu.getByRole("menuitem").filter({ hasText: pkg });
  await expect(pkgItem).toBeDisabled();
  await expect(pkgItem).toContainText("not a diagram");

  const pkgBefore = readFileSync(join(E2E_LINKED_DIR, pkg), "utf8");
  const overwrite = await request.put(`/__templates/${linkedId}/${pkg}`, { data: plan("Overwrite") });
  expect(overwrite.status()).toBe(409);
  expect(readFileSync(join(E2E_LINKED_DIR, pkg), "utf8")).toBe(pkgBefore);

  const removed = await request.delete(`/__templates/${linkedId}/${diagram}`);
  expect(removed.status()).toBe(403);
  expect(read(join(E2E_LINKED_DIR, diagram)).nodes).toHaveLength(3);

  for (const name of ["..%2Fescape.json", ".hidden.json"]) {
    const escaped = await request.put(`/__templates/${linkedId}/${name}`, { data: plan("Escape") });
    expect(escaped.status(), name).toBe(400);
  }

  // A text/plain POST is what another site can send without a CORS preflight.
  const crossSite = await request.post("/__templates/links", {
    headers: { "content-type": "text/plain" },
    data: JSON.stringify({ dir: E2E_LINKS_ROOT }),
  });
  expect(crossSite.status()).toBe(415);
});

test("a file bound to a linked folder the server isn't linking says its edits stay in the browser", async ({ studio, page }) => {
  await studio.goto();
  await page.evaluate(() => {
    const key = "better-diagrams:workspace";
    const ws = JSON.parse(localStorage.getItem(key)!);
    ws.files.push({
      id: "stranded",
      name: "Stranded plan",
      kind: "architecture",
      doc: { version: 1, nodes: [], edges: [] },
      disk: { folder: "linked-gone-000000", file: "plan.json", display: "~/gone/tracker" },
    });
    localStorage.setItem(key, JSON.stringify(ws));
  });
  await page.reload();
  const warning = page.locator("[data-sonner-toast]").filter({ hasText: "Stranded plan isn't synced to disk" });
  await expect(warning).toContainText("~/gone/tracker");
});

/** The links the app saved, as the dev server keeps them across restarts. */
const savedLinks = (): string[] => {
  try {
    return JSON.parse(readFileSync(join(E2E_TEMPLATES_DIR, "linked.json"), "utf8")).linked;
  } catch {
    return [];
  }
};

/** A folder of its own for a test to link, holding one plan. */
function planFolder(name: string) {
  const dir = join(E2E_LINKS_ROOT, name);
  mkdirSync(dir, { recursive: true });
  linkedDirs.push(dir);
  const file = `${base}.json`;
  writeFileSync(join(dir, file), JSON.stringify(plan(`Linked ${base}`), null, 2));
  return { dir, file };
}

const strandedToast = (page: Page) => page.locator("[data-sonner-toast]").filter({ hasText: "isn't synced to disk" });

test("a folder linked from the menu lists its diagrams live, is kept for the next run, and unlinks", async ({ studio, page }) => {
  const { dir, file } = planFolder(base);
  await studio.goto();
  await page.getByRole("button", { name: "Settings" }).click();
  const menu = page.getByRole("menu", { name: "Settings" });
  await menu.getByRole("menuitem").filter({ hasText: "Link a folder…" }).click();
  await menu.getByLabel("Folder path").fill(dir);
  await menu.getByRole("button", { name: "Link", exact: true }).click();
  await expect(menu.getByText(`Linked / ${base}`, { exact: true })).toBeVisible();
  expect(savedLinks()).toContain(dir);

  await studio.openTemplate(file);
  await expect(title(page, "design")).toHaveText("Design");
  await page.locator('.react-flow__node[data-id="design"]').getByRole("checkbox").click();
  await expect.poll(() => (nodeOf(read(join(dir, file)), "design") as { done?: boolean }).done).toBe(true);

  // Unlinking stops the sync; the file it was bound to stays where it is.
  await page.getByRole("button", { name: "Settings" }).click();
  await menu.getByRole("menuitem").filter({ hasText: `Unlink ${base}` }).click();
  await expect.poll(savedLinks).not.toContain(dir);
  await expect
    .poll(async () => {
      const ws = await studio.workspace();
      return ws.files.find((f) => f.id === ws.activeId);
    })
    .not.toHaveProperty("disk");
  expect(existsSync(join(dir, file))).toBe(true);
});

test("a linked folder that moves strands its files, and Re-link binds them to where it is now — asking when the copies differ", async ({
  studio,
  page,
  request,
}) => {
  const { dir: before, file } = planFolder(`${base}-before`);
  const after = join(E2E_LINKS_ROOT, `${base}-after`);
  linkedDirs.push(after);
  expect((await request.post("/__templates/links", { data: { dir: before } })).status()).toBe(200);
  await studio.goto();
  await studio.openTemplate(file);
  await page.locator('.react-flow__node[data-id="design"]').getByRole("checkbox").click();
  await expect.poll(() => (nodeOf(read(join(before, file)), "design") as { done?: boolean }).done).toBe(true);

  renameSync(before, after);
  // Edited while the folder is lost: this save can't land, and says why.
  await page.locator('.react-flow__node[data-id="build"]').getByRole("checkbox").click();
  const stranded = strandedToast(page);
  await expect(stranded).toContainText("is missing");

  await stranded.getByRole("button", { name: "Re-link…" }).click();
  const form = page.getByRole("form", { name: "Re-link folder" });
  await form.getByLabel("Folder path").fill(after);
  await form.getByRole("button", { name: "Re-link", exact: true }).click();

  // The browser has Build done, the moved file doesn't: the person picks.
  const conflict = page.locator("[data-sonner-toast]").filter({ hasText: "differs from" });
  await conflict.getByRole("button", { name: "Keep my edits" }).click();
  await expect.poll(() => (nodeOf(read(join(after, file)), "build") as { done?: boolean }).done).toBe(true);
  await expect(stranded).toHaveCount(0);
  // The saved link moved with it.
  expect(savedLinks()).toContain(after);
  expect(savedLinks()).not.toContain(before);
});

test("Browse… links the folder the system dialog picks, and a re-link whose copies match rebinds quietly", async ({ studio, page }) => {
  // The stand-in dialog always "picks" E2E_PICK_DIR (see playwright.config.ts).
  const file = `${base}.json`;
  const path = join(E2E_PICK_DIR, file);
  created.push(path);
  linkedDirs.push(E2E_PICK_DIR);
  const doc = plan(`Picked ${base}`);
  writeFileSync(path, JSON.stringify(doc, null, 2));

  await studio.goto();
  await page.evaluate(
    ({ file, doc }) => {
      const key = "better-diagrams:workspace";
      const ws = JSON.parse(localStorage.getItem(key)!);
      ws.files.push({ id: "lost", name: "Lost plan", kind: "architecture", doc, disk: { folder: "linked-lost-111111", file, display: "~/lost" } });
      ws.activeId = "lost";
      localStorage.setItem(key, JSON.stringify(ws));
    },
    { file, doc },
  );
  await page.reload();
  await strandedToast(page).getByRole("button", { name: "Re-link…" }).click();
  await page.getByRole("form", { name: "Re-link folder" }).getByRole("button", { name: "Browse…" }).click();

  // (Not "Re-linked": the warning itself says "until it's re-linked".)
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "syncs again" })).toBeVisible();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "differs from" })).toHaveCount(0);
  await expect(strandedToast(page)).toHaveCount(0);
  await expect
    .poll(async () => ((await studio.workspace()).files.find((f) => f.id === "lost") as { disk?: { folder: string } }).disk?.folder)
    .toMatch(/^linked-better-diagrams-e2e-pick-/);

  await page.locator('.react-flow__node[data-id="design"]').getByRole("checkbox").click();
  await expect.poll(() => (nodeOf(read(path), "design") as { done?: boolean }).done).toBe(true);
});

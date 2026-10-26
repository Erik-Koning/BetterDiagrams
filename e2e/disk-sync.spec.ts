/**
 * Templates on disk are live while developing: a file opened from the
 * templates menu is bound to it — app edits save back, edits made by any
 * other program reload in the app, and the file on disk wins. The dev server
 * under test keeps its templates in a temporary folder (templates-dir.ts),
 * so nothing here touches the repo's templates/ — and links a second
 * temporary folder the way `BD_LINKED_DIRS` links one outside the repo.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  E2E_LINKED_DIR,
  E2E_LINKS_ROOT,
  E2E_PICK_ANSWER,
  E2E_PICK_DIR,
  E2E_PICK_FILE,
  E2E_SAVE_ANSWER,
  E2E_SAVE_DIR,
  E2E_TEMPLATES_DIR,
} from "./templates-dir";

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
  // Recursive for a folder a test made; a symlink is removed, never followed.
  for (const path of created) rmSync(path, { force: true, recursive: true });
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

test("a linked folder lists its diagrams at any depth and leaves other JSON out; it is never deleted from, written over a non-diagram, or escaped", async ({
  studio,
  page,
  request,
}) => {
  needsLink();
  const diagram = `${base}.json`;
  const docs = join(E2E_LINKED_DIR, `${base}-docs`);
  const nested = `${base}-docs/${base}-nested.json`;
  const pkg = `${base}-package.json`;
  mkdirSync(docs, { recursive: true });
  created.push(docs);
  for (const [file, doc] of [
    [diagram, plan(`Linked ${base}`)],
    [nested, plan(`Nested ${base}`)],
    [pkg, { name: "not-a-diagram", version: "1.0.0" }],
  ] as const) {
    const path = join(E2E_LINKED_DIR, file);
    created.push(path);
    writeFileSync(path, JSON.stringify(doc, null, 2));
  }

  // Listed under its own caption, the nested diagram by its path; the
  // package.json is counted under the caption rather than listed.
  await studio.goto();
  await page.getByRole("button", { name: "Settings" }).click();
  const menu = page.getByRole("menu", { name: "Settings" });
  await expect(menu.getByText("Linked / better-diagrams-e2e-linked")).toBeVisible();
  await expect(menu.getByRole("menuitem").filter({ hasText: diagram }).first()).toBeEnabled();
  await expect(menu.getByRole("menuitem").filter({ hasText: nested })).toBeEnabled();
  await expect(menu.getByRole("menuitem").filter({ hasText: pkg })).toHaveCount(0);
  await expect(menu.getByText(/other JSON files? (isn't a diagram|aren't diagrams)/)).toBeVisible();

  // The nested one opens live like any other: an edit saves back to it.
  await menu.getByRole("menuitem").filter({ hasText: nested }).click();
  await expect(title(page, "design")).toHaveText("Design");
  await page.locator('.react-flow__node[data-id="design"]').getByRole("checkbox").click();
  await expect.poll(() => (nodeOf(read(join(E2E_LINKED_DIR, nested)), "design") as { done?: boolean }).done).toBe(true);

  const pkgBefore = readFileSync(join(E2E_LINKED_DIR, pkg), "utf8");
  const overwrite = await request.put(`/__templates/${linkedId}/${pkg}`, { data: plan("Overwrite") });
  expect(overwrite.status()).toBe(409);
  expect(readFileSync(join(E2E_LINKED_DIR, pkg), "utf8")).toBe(pkgBefore);

  const removed = await request.delete(`/__templates/${linkedId}/${diagram}`);
  expect(removed.status()).toBe(403);
  expect(read(join(E2E_LINKED_DIR, diagram)).nodes).toHaveLength(3);

  for (const name of ["..%2Fescape.json", ".hidden.json", `${base}-docs%2F..%2F..%2Fescape.json`, `.git%2F${base}.json`, `node_modules%2F${base}.json`]) {
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

/** A plan in the linked folder whose first node carries a key the schema doesn't define. */
async function openLossyPlan(studio: { goto(): Promise<void>; openTemplate(file: string): Promise<void>; page: Page }) {
  const file = `${base}.json`;
  const path = join(E2E_LINKED_DIR, file);
  created.push(path);
  const doc = plan(`${base} lossy`);
  Object.assign(doc.nodes[0], { owner: "team-payments" });
  writeFileSync(path, JSON.stringify(doc, null, 2));
  await studio.goto();
  await studio.openTemplate(file);
  await expect(title(studio.page, "design")).toHaveText("Design");
  // Said as it opens: this editor won't keep the key.
  await expect(studio.page.locator("[data-sonner-toast]").filter({ hasText: "1 thing this editor doesn't keep" })).toBeVisible();
  // An edit (Design: Build waits on it): the save that would drop the key
  // asks first, and nothing is written meanwhile.
  await studio.page.locator('.react-flow__node[data-id="design"]').getByRole("checkbox").click();
  const ask = studio.page.locator("[data-sonner-toast]").filter({ hasText: `Saving ${base} lossy will remove 1 thing` });
  await expect(ask).toContainText('"owner"');
  await studio.page.waitForTimeout(1500);
  expect(read(path).nodes[0]).toHaveProperty("owner", "team-payments");
  expect((nodeOf(read(path), "design") as { done?: boolean }).done).toBeUndefined();
  return { path, ask };
}

test("a save that would drop something from the file asks first; Save anyway writes it", async ({ studio, page }) => {
  needsLink();
  const { path, ask } = await openLossyPlan(studio);
  await expect(ask.locator("[data-close-button]")).toHaveCount(0);
  await ask.getByRole("button", { name: "Save anyway" }).click();
  await expect.poll(() => (nodeOf(read(path), "design") as { done?: boolean }).done).toBe(true);
  expect(read(path).nodes[0]).not.toHaveProperty("owner");
  // Answered once: the next edit saves without asking again.
  await page.locator('.react-flow__node[data-id="build"]').getByRole("checkbox").click();
  await expect.poll(() => (nodeOf(read(path), "build") as { done?: boolean }).done).toBe(true);
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "will remove" })).toHaveCount(0);
});

test("a save that would drop something: Keep the file leaves it as it was, and the copy carries on unsynced", async ({ studio, page }) => {
  needsLink();
  const { path, ask } = await openLossyPlan(studio);
  const before = readFileSync(path, "utf8");
  await ask.getByRole("button", { name: "Keep the file" }).click();
  await expect
    .poll(async () => ((await studio.workspace()).files.find((f) => f.name === `${base} lossy`) as { disk?: unknown } | undefined)?.disk)
    .toBeUndefined();
  // Its scratch copy, named so no other test's `${base}.json` lookup matches it.
  created.push(join(SCRATCH, `${base}-lossy.json`));
  await page.waitForTimeout(1500);
  expect(readFileSync(path, "utf8")).toBe(before);
  // The copy kept its edit.
  await expect(page.locator('.react-flow__node[data-id="design"]').getByRole("checkbox")).toHaveAttribute("aria-checked", "true");
  // Closed before the cleanup, so no save lands after it.
  await page.close();
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

/**
 * Linking single files. The stand-in file dialog answers E2E_PICK_FILE, or
 * the path a test writes to E2E_PICK_ANSWER (see playwright.config.ts) — one
 * answer for the whole server, so these tests take turns.
 */
test.describe("linked files", () => {
  test.describe.configure({ mode: "serial" });

  const link = join(E2E_TEMPLATES_DIR, "symlinks", basename(E2E_PICK_FILE));
  // A link to the picked file left by an interrupted run would be handed back
  // instead of a new one (`picked-plan-2.json`), so none survives into a test.
  test.beforeEach(() => {
    const links = dirname(link);
    for (const name of existsSync(links) ? readdirSync(links) : []) {
      if (name.startsWith(basename(E2E_PICK_FILE, ".json"))) rmSync(join(links, name), { force: true });
    }
  });
  const isLink = () => {
    try {
      return lstatSync(link).isSymbolicLink();
    } catch {
      return false;
    }
  };
  /** A new file, and Link a file on disk… from its welcome modal: the dialog answers E2E_PICK_FILE. */
  const linkFromWelcome = async (studio: { goto(): Promise<void>; newFile(): Promise<void> }, page: Page) => {
    rmSync(E2E_PICK_ANSWER, { force: true });
    // An unlinked (or, mid-question, unbound) copy auto-saves to scratch under its title.
    created.push(link, E2E_PICK_FILE, E2E_PICK_ANSWER, join(SCRATCH, `linked-${base}.json`));
    writeFileSync(E2E_PICK_FILE, JSON.stringify(plan(`Linked ${base}`), null, 2));
    await studio.goto();
    await studio.newFile();
    await page.getByRole("dialog", { name: "Get started" }).getByRole("button", { name: "Link a file on disk…" }).click();
    await expect(title(page, "design")).toHaveText("Design");
  };

  test("Link a file on disk… symlinks the file the dialog picks and opens it live, in the blank file's place; Unlink removes only the link", async ({
    studio,
    page,
  }) => {
    await linkFromWelcome(studio, page);
    expect(isLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(E2E_PICK_FILE));
    // The blank Untitled made way for it rather than lingering.
    await expect.poll(async () => (await studio.workspace()).files.map((f) => f.name)).toEqual([`${base}-seed`, `Linked ${base}`]);

    // An edit in the app goes through the link to the file itself...
    await page.locator('.react-flow__node[data-id="design"]').getByRole("checkbox").click();
    await expect.poll(() => (nodeOf(read(E2E_PICK_FILE), "design") as { done?: boolean }).done).toBe(true);
    expect(isLink()).toBe(true);
    // ...and an edit made where the file lives reloads here, once.
    editOnDisk(E2E_PICK_FILE, (doc) => {
      nodeOf(doc, "build").label = "Build it";
    });
    await expect(title(page, "build")).toHaveText("Build it");
    await expect(reloadToasts(page)).toHaveCount(1);
    // So does a save that replaces the file whole — a temp file renamed over
    // it, the way many editors and agents write — and the watch survives it.
    for (const label of ["Ship it", "Ship it now"]) {
      const doc = read(E2E_PICK_FILE);
      nodeOf(doc, "ship").label = label;
      writeFileSync(`${E2E_PICK_FILE}.tmp`, JSON.stringify(doc, null, 2));
      renameSync(`${E2E_PICK_FILE}.tmp`, E2E_PICK_FILE);
      await expect(title(page, "ship")).toHaveText(label);
    }

    // Unlinking takes the link away and leaves the file; the open copy carries on unbound.
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("menu", { name: "Settings" }).getByRole("menuitem", { name: `Unlink ${basename(E2E_PICK_FILE)}` }).click();
    await expect.poll(isLink).toBe(false);
    expect(existsSync(E2E_PICK_FILE)).toBe(true);
    await expect
      .poll(async () => ((await studio.workspace()).files.find((f) => f.name === `Linked ${base}`) as { disk?: unknown } | undefined)?.disk)
      .toBeUndefined();
  });

  test("a link removed and remade under its name for another file never takes the open copy for that file", async ({ studio, page }) => {
    await linkFromWelcome(studio, page);
    const other = join(dirname(E2E_PICK_FILE), `other-${base}`, basename(E2E_PICK_FILE));
    created.push(dirname(other));
    mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, JSON.stringify(plan(`Other ${base}`), null, 2));
    const otherBefore = readFileSync(other, "utf8");

    // The link goes outside the app (by hand, or a `git clean` — symlinks/ is
    // git-ignored): an edit can't save, and stays in the browser.
    rmSync(link);
    await page.locator('.react-flow__node[data-id="design"]').getByRole("checkbox").click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: `Couldn't save Linked ${base}` })).toBeVisible();

    // Another file of the same name is linked: it takes the name that's free now.
    writeFileSync(E2E_PICK_ANSWER, other);
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Link a file on disk…/ }).click();
    await expect.poll(() => isLink() && realpathSync(link)).toBe(realpathSync(other));

    // The open copy is told it isn't that file, and the other opens beside it.
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: `Linked ${base} isn't synced with` })).toBeVisible();
    await expect.poll(async () => (await studio.workspace()).files.map((f) => f.name)).toEqual([`${base}-seed`, `Linked ${base}`, `Other ${base}`]);
    const ws = await studio.workspace();
    expect(ws.files.find((f) => f.name === `Linked ${base}`)).not.toHaveProperty("disk");
    expect((ws.files.find((f) => f.name === `Other ${base}`) as { disk?: unknown }).disk).toEqual({
      folder: "symlinks",
      file: basename(E2E_PICK_FILE),
      target: other,
    });
    // Past the save debounce: the stale copy's edit never reached the other file.
    await page.waitForTimeout(1500);
    expect(readFileSync(other, "utf8")).toBe(otherBefore);
    // Closed before the cleanup, so the detached copy's scratch save can't land after it.
    await page.close();
  });

  test("linking a file again after its link went asks before the edits made meanwhile meet the file", async ({ studio, page }) => {
    await linkFromWelcome(studio, page);
    rmSync(link);
    await page.locator('.react-flow__node[data-id="design"]').getByRole("checkbox").click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: `Couldn't save Linked ${base}` })).toBeVisible();

    // The same file, linked again — the warning's own advice.
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Link a file on disk…/ }).click();
    const ask = page.locator("[data-sonner-toast]").filter({ hasText: "differs from" });
    await ask.getByRole("button", { name: "Keep my edits" }).click();
    await expect.poll(() => (nodeOf(read(E2E_PICK_FILE), "design") as { done?: boolean }).done).toBe(true);
    expect(isLink()).toBe(true);
    expect((await studio.workspace()).files.filter((f) => f.name === `Linked ${base}`)).toHaveLength(1);
  });

  test("the server links a file once, only a diagram, under a free name; Unlink and saves never touch what isn't a link", async ({
    request,
  }) => {
    const links = join(E2E_TEMPLATES_DIR, "symlinks");
    const dir = join(dirname(E2E_PICK_FILE), `server-${base}`);
    const [a, b] = ["a", "b"].map((sub) => join(dir, sub, `${base}.json`));
    const notDiagram = join(dir, "package.json");
    const listed = join(EXAMPLES, `${base}-listed.json`);
    const plain = join(links, `${base}-plain.json`);
    created.push(dir, listed, plain);
    for (const path of [a, b]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(plan(`Server ${base}`)));
    }
    writeFileSync(notDiagram, "{}");
    writeFileSync(listed, JSON.stringify(plan(`Listed ${base}`)));
    writeFileSync(plain, JSON.stringify(plan(`Plain ${base}`)));
    const link = async (path: string) => {
      const res = await request.post("/__templates/symlinks", { data: { path } });
      return { status: res.status(), body: await res.json() };
    };

    // Not a diagram: refused, and nothing is made.
    const refused = await link(notDiagram);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/not a diagram/);

    // Two files with one name: the second link takes a number.
    const first = await link(a);
    const second = await link(b);
    created.push(join(links, first.body.entry.file), join(links, second.body.entry.file));
    expect([first.body.entry.file, second.body.entry.file]).toEqual([`${base}.json`, `${base}-2.json`]);
    expect(realpathSync(join(links, second.body.entry.file))).toBe(realpathSync(b));
    // Linking a file again hands back its link; one the menu lists opens from where it is.
    expect((await link(a)).body.entry.file).toBe(`${base}.json`);
    expect((await link(listed)).body.entry).toMatchObject({ folder: "examples", file: basename(listed) });

    // Unlink refuses a plain file, and removes a link but never its file.
    expect((await request.delete(`/__templates/symlinks/${basename(plain)}`)).status()).toBe(409);
    expect(existsSync(plain)).toBe(true);
    expect((await request.delete(`/__templates/symlinks/${base}.json`)).ok()).toBe(true);
    expect(existsSync(a)).toBe(true);
    // And a save to a link that is gone never makes a file in its place.
    expect((await request.put(`/__templates/symlinks/${base}.json`, { data: plan("x") })).status()).toBe(404);
    expect(readdirSync(links)).not.toContain(`${base}.json`);
  });

  test("a linked file that moves is never recreated; Re-link… on the warning points the link at it, keeping the open file bound", async ({
    studio,
    page,
  }) => {
    const moved = join(dirname(E2E_PICK_FILE), `moved-${base}`, basename(E2E_PICK_FILE));
    created.push(dirname(moved));
    await linkFromWelcome(studio, page);

    // The file moves away: an edit here can't save, and nothing is written where it was.
    mkdirSync(dirname(moved), { recursive: true });
    renameSync(E2E_PICK_FILE, moved);
    await page.locator('.react-flow__node[data-id="design"]').getByRole("checkbox").click();
    const warning = page.locator("[data-sonner-toast]").filter({ hasText: `Couldn't save Linked ${base}` });
    await expect(warning).toBeVisible();
    expect(existsSync(E2E_PICK_FILE)).toBe(false);
    await page.getByRole("button", { name: "Settings" }).click();
    const menu = page.getByRole("menu", { name: "Settings" });
    await expect(menu.getByRole("menuitem").filter({ hasText: "which is missing" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: `Re-link ${basename(E2E_PICK_FILE)}` })).toBeVisible();
    await page.getByRole("button", { name: "Settings" }).click();

    // Re-link… from the warning; the dialog answers where the file is now.
    writeFileSync(E2E_PICK_ANSWER, moved);
    await warning.getByRole("button", { name: "Re-link…" }).click();
    // The edit never reached the file, so the two differ: it asks, and keeping
    // the edits writes them to the file in its new place, through the same link.
    const ask = page.locator("[data-sonner-toast]").filter({ hasText: "differs from" });
    // The file is held unbound until answered, so the question can't be closed unanswered.
    await expect(ask.getByRole("button", { name: "Keep my edits" })).toBeVisible();
    await expect(ask.locator("[data-close-button]")).toHaveCount(0);
    await ask.getByRole("button", { name: "Keep my edits" }).click();
    await expect.poll(() => (nodeOf(read(moved), "design") as { done?: boolean }).done).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(moved));
    await expect(warning).toHaveCount(0);
    const bound = async () =>
      ((await studio.workspace()).files.find((f) => f.name === `Linked ${base}`) as { disk?: { folder: string; file: string } } | undefined)?.disk;
    // Bound to the same link, which answers to the file where it is now.
    await expect.poll(bound).toEqual({ folder: "symlinks", file: basename(E2E_PICK_FILE), target: moved });

    // And it is live there: an edit made in the new place reloads.
    editOnDisk(moved, (doc) => {
      nodeOf(doc, "build").label = "Build, moved";
    });
    await expect(title(page, "build")).toHaveText("Build, moved");
  });

  test("saves wait while a re-link settles: an edit made as the link is re-pointed never reaches the file unasked", async ({
    studio,
    page,
  }) => {
    const moved = join(dirname(E2E_PICK_FILE), `moved-${base}`, basename(E2E_PICK_FILE));
    created.push(dirname(moved));
    await linkFromWelcome(studio, page);
    mkdirSync(dirname(moved), { recursive: true });
    renameSync(E2E_PICK_FILE, moved);
    const onDisk = readFileSync(moved, "utf8");

    // The server re-points the link, and its answer is held back: the window
    // in which the app doesn't yet know the link points somewhere new.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let repointed = false;
    await page.route("**/__templates/symlinks", async (route) => {
      const response = await route.fetch();
      repointed = true;
      await released;
      await route.fulfill({ response });
    });
    const writes: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PUT" && req.url().includes("/__templates/symlinks/")) writes.push(req.url());
    });

    // Re-link… from the menu; the dialog answers where the file is now.
    writeFileSync(E2E_PICK_ANSWER, moved);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("menu", { name: "Settings" }).getByRole("menuitem", { name: `Re-link ${basename(E2E_PICK_FILE)}` }).click();
    await expect.poll(() => repointed).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(moved));
    // The watcher reports the file under the link in that window. Linux's sees
    // the link re-pointed; a touch makes every platform's say so.
    utimesSync(moved, new Date(), new Date());

    // An edit in that window, and past the save debounce: nothing is written through the link.
    await page.locator('.react-flow__node[data-id="design"]').getByRole("checkbox").click();
    await page.waitForTimeout(1500);
    expect(writes).toEqual([]);
    expect(readFileSync(moved, "utf8")).toBe(onDisk);

    // The answer lands: the copies differ, so it asks, and "Use the file" takes the file's.
    release();
    const ask = page.locator("[data-sonner-toast]").filter({ hasText: "differs from" });
    await ask.getByRole("button", { name: "Use the file" }).click();
    await expect(page.locator('.react-flow__node[data-id="design"]').getByRole("checkbox")).toHaveAttribute("aria-checked", "false");
    await expect
      .poll(async () => ((await studio.workspace()).files.find((f) => f.name === `Linked ${base}`) as { disk?: unknown } | undefined)?.disk)
      .toEqual({ folder: "symlinks", file: basename(E2E_PICK_FILE), target: moved });
    expect(readFileSync(moved, "utf8")).toBe(onDisk);
  });
});

/**
 * Save as…. The stand-in save dialog answers E2E_SAVE_DIR and the name the
 * app suggested, or the path a test writes to E2E_SAVE_ANSWER — one answer
 * for the whole server, so these tests take turns.
 */
test.describe("save as", () => {
  test.describe.configure({ mode: "serial" });

  test("Save as… writes the file where the dialog says, links it as if opened from there, and keeps editing it there", async ({ studio, page }) => {
    rmSync(E2E_SAVE_ANSWER, { force: true });
    const name = `${base}-seed.json`;
    const target = join(E2E_SAVE_DIR, name);
    const linkPath = join(E2E_TEMPLATES_DIR, "symlinks", name);
    created.push(target, linkPath);
    await studio.goto();
    // The seed file auto-saves to scratch: it has no other home yet.
    await expect.poll(() => existsSync(join(SCRATCH, name))).toBe(true);

    const menu = await studio.openFileMenu();
    await menu.getByRole("menuitem", { name: /^Save as…/ }).click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: `Saved ${base}-seed to ${target}` })).toBeVisible();
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(realpathSync(linkPath)).toBe(realpathSync(target));
    expect(read(target).nodes.map((n) => n.id)).toEqual(["s"]);
    // Bound to it — its scratch copy is gone — and an edit saves there.
    await expect.poll(() => existsSync(join(SCRATCH, name))).toBe(false);
    expect((await studio.workspace()).files[0]).toMatchObject({ disk: { folder: "symlinks", file: name, target } });
    await page.locator('.react-flow__node[data-id="s"]').getByRole("checkbox").click();
    await expect.poll(() => (read(target).nodes[0] as { done?: boolean }).done).toBe(true);
    // And an edit made there reloads here.
    editOnDisk(target, (doc) => {
      doc.nodes[0].label = "Seed, edited there";
    });
    await expect(title(page, "s")).toHaveText("Seed, edited there");
  });

  test("New file on disk… starts a blank diagram where the dialog says, linked, in the blank file's place, and live from there", async ({
    studio,
    page,
  }) => {
    const name = `${base}-new.json`;
    const target = join(E2E_SAVE_DIR, name);
    const linkPath = join(E2E_TEMPLATES_DIR, "symlinks", name);
    writeFileSync(E2E_SAVE_ANSWER, target);
    created.push(target, linkPath, E2E_SAVE_ANSWER);
    await studio.goto();
    await studio.newFile();
    await page.getByRole("dialog", { name: "Get started" }).getByRole("button", { name: "New file on disk…" }).click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: `Started ${base}-new` })).toBeVisible();
    // Blank, titled after its name, and symlinked as if it had been linked.
    expect(read(target)).toEqual({ version: 1, meta: { title: `${base}-new` }, nodes: [], edges: [] });
    expect(realpathSync(linkPath)).toBe(realpathSync(target));
    await expect.poll(async () => (await studio.workspace()).files.map((f) => f.name)).toEqual([`${base}-seed`, `${base}-new`]);
    expect((await studio.workspace()).files[1]).toMatchObject({ disk: { folder: "symlinks", file: name, target } });
    // Live both ways: an edit made there reloads here, and one made here saves there.
    editOnDisk(target, (doc) => {
      doc.nodes.push(task("design", "Design", 80, 120));
    });
    await expect(title(page, "design")).toHaveText("Design");
    await page.locator('.react-flow__node[data-id="design"]').getByRole("checkbox").click();
    await expect.poll(() => (nodeOf(read(target), "design") as { done?: boolean }).done).toBe(true);
  });

  test("New file on disk… naming a file that's there links it as it is, and never writes a blank over it", async ({ studio, page }) => {
    const name = `${base}-kept.json`;
    const target = join(E2E_SAVE_DIR, name);
    const text = JSON.stringify(plan(`Kept ${base}`), null, 2);
    writeFileSync(target, text);
    writeFileSync(E2E_SAVE_ANSWER, target);
    created.push(target, join(E2E_TEMPLATES_DIR, "symlinks", name), E2E_SAVE_ANSWER);
    await studio.goto();
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await page.getByRole("menuitem", { name: /^New file on disk…/ }).click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: `Opened Kept ${base}` })).toContainText("It was there already");
    await expect(title(page, "design")).toHaveText("Design");
    expect(readFileSync(target, "utf8")).toBe(text);
    // Beside the seed file, which has work in it, rather than in its place.
    expect((await studio.workspace()).files.map((f) => f.name)).toEqual([`${base}-seed`, `Kept ${base}`]);
  });

  test("Save as… into a linked folder binds the file there, at any depth, rather than linking it", async ({ studio, page }) => {
    needsLink();
    const dir = join(E2E_LINKED_DIR, `${base}-saved`);
    const target = join(dir, "Architecture.json");
    mkdirSync(dir, { recursive: true });
    created.push(dir);
    writeFileSync(E2E_SAVE_ANSWER, target);
    created.push(E2E_SAVE_ANSWER);
    await studio.goto();
    const menu = await studio.openFileMenu();
    await menu.getByRole("menuitem", { name: /^Save as…/ }).click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: `Saved ${base}-seed to` })).toBeVisible();
    expect(read(target).nodes.map((n) => n.id)).toEqual(["s"]);
    expect((await studio.workspace()).files[0]).toMatchObject({ disk: { folder: linkedId, file: `${base}-saved/Architecture.json` } });
    expect(existsSync(join(E2E_TEMPLATES_DIR, "symlinks", "Architecture.json"))).toBe(false);
    await page.locator('.react-flow__node[data-id="s"]').getByRole("checkbox").click();
    await expect.poll(() => (read(target).nodes[0] as { done?: boolean }).done).toBe(true);
  });
});

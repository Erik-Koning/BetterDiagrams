/**
 * Task graphs in the real app: the done check, the blocked mark, assignee
 * tabs and the People legend, dependency lines on hover, the line switch,
 * the planning views (filters, critical path, team capacity), a tracker's
 * CSV import, and the Task flow preset on the Welcome screen.
 */
import { readFile, writeFile } from "node:fs/promises";
import { expect, test } from "./fixtures";

const task = (id: string, label: string, x: number, y: number, over: Record<string, unknown> = {}) => ({
  id, label, kind: "task", icon: "none", description: "", parentId: null, x, y, w: 200, h: 84, ...over,
});

const PLAN = {
  version: 1,
  meta: { title: "Launch plan" },
  nodes: [
    task("design", "Design", 80, 120, { assignees: ["Ana"], storyPoints: 2 }),
    task("build", "Build", 480, 120, { assignees: ["Ravi", "Ana"], storyPoints: 5, description: "API + UI" }),
    task("infra", "Infra", 80, 420, { assignees: ["Ravi"] }),
  ],
  edges: [
    { id: "pre", source: "design", target: "build", label: "", style: "solid", color: "slate" },
    { id: "dep", source: "infra", target: "build", label: "", style: "dashed", color: "sky", relation: "dependency" },
  ],
};

test.describe("task graphs", () => {
  test.beforeEach(async ({ studio }, testInfo) => {
    await studio.goto();
    const file = testInfo.outputPath("plan.json");
    await writeFile(file, JSON.stringify(PLAN));
    await studio.importFile(file);
    await expect(studio.nodeTitled("Build")).toBeVisible();
  });

  test.describe("Copy schema", () => {
    test.use({ permissions: ["clipboard-read", "clipboard-write"] });

    test("on a plan copies the Task flow schema, with no clouds to ask about", async ({ page }) => {
      await page.locator(".app__bar").getByRole("button", { name: "Copy schema" }).click();
      const dialog = page.getByRole("dialog", { name: "Copy task-flow schema & system prompt" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "AWS" })).toHaveCount(0);
      await dialog.getByRole("button", { name: "Copy schema" }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("TASK FLOW:");
    });
  });

  test("the corner check marks a task done without selecting it, and unblocks what waits on it", async ({ studio, page }) => {
    // Build waits on Design and Infra: its check is struck through and refuses a click.
    const build = studio.node("build").getByRole("checkbox");
    await expect(build).toHaveClass(/as-task__check--blocked/);
    await expect(build).toHaveAttribute("aria-disabled", "true");
    await expect(build).toHaveCSS("cursor", "not-allowed");
    // Forced: Playwright, rightly, won't press an aria-disabled control on its own.
    await build.click({ force: true });
    await expect(build).toHaveAttribute("aria-checked", "false");
    await expect(page.getByText("Blocked", { exact: true })).toHaveCount(0);
    const check = studio.node("design").getByRole("checkbox");
    await check.click();
    await expect(check).toHaveAttribute("aria-checked", "true");
    await expect(check).toHaveClass(/as-task__check--done/);
    await expect(studio.selectedNodes).toHaveCount(0);
    await expect.poll(async () => (await studio.liveDoc()).nodes.find((n) => n.id === "design")?.done).toBe(true);

    // Build still waits on Infra; finishing that too opens its check.
    await expect(build).toHaveClass(/as-task__check--blocked/);
    await studio.node("infra").getByRole("checkbox").click();
    await expect(build).not.toHaveClass(/as-task__check--blocked/);
    await expect(build).toHaveCSS("cursor", "pointer");
    await build.click();
    await expect(build).toHaveAttribute("aria-checked", "true");
  });

  test("assignee tabs hang under the card and the legend picks a person", async ({ studio, page }) => {
    await expect(studio.node("build").locator(".as-node__assignee")).toHaveText(["Ravi", "Ana"]);
    const people = page.getByRole("group", { name: "People" });
    await people.getByRole("button", { name: /Ravi/ }).click();
    await expect(studio.node("design").locator(".as-node")).toHaveClass(/as-node--dimmed/);
    await expect(studio.node("infra").locator(".as-node")).not.toHaveClass(/as-node--dimmed/);
  });

  test("a dependency line shows only while one of its tasks is hovered", async ({ studio, page }) => {
    const dep = page.locator('.react-flow__edge[data-id="dep"]');
    const pre = page.locator('.react-flow__edge[data-id="pre"]');
    await expect(dep).toHaveClass(/as-edge--dormant/);
    await expect(pre).not.toHaveClass(/as-edge--dormant/);
    await studio.node("infra").hover();
    await expect(dep).not.toHaveClass(/as-edge--dormant/);
    await studio.canvas.hover({ position: { x: 1000, y: 700 } });
    await expect(dep).toHaveClass(/as-edge--dormant/);
  });

  test("a line between two tasks switches to a dependency in its inspector", async ({ studio, page }) => {
    await page.locator('.react-flow__edge[data-id="pre"] .as-edge__hit').click({ force: true });
    const link = studio.inspector.getByRole("group", { name: "Link type" });
    await expect(link.getByRole("button", { name: "Prerequisite" })).toHaveAttribute("aria-pressed", "true");
    await link.getByRole("button", { name: "Dependency (on hover)" }).click();
    await expect
      .poll(async () => (await studio.liveDoc()).edges.find((e) => e.id === "pre")?.relation)
      .toBe("dependency");
  });
});

test.describe("planning", () => {
  test.beforeEach(async ({ studio }, testInfo) => {
    await studio.goto();
    const file = testInfo.outputPath("plan.json");
    await writeFile(file, JSON.stringify(PLAN));
    await studio.importFile(file);
    await expect(studio.nodeTitled("Build")).toBeVisible();
  });

  test("the Ready filter keeps what can start now and recedes the rest", async ({ studio, page }) => {
    const menu = await studio.openMenu("View");
    await menu.getByRole("radio", { name: "Ready" }).check();
    await page.keyboard.press("Escape");
    await expect(studio.node("build").locator(".as-node")).toHaveClass(/as-node--dimmed/);
    await expect(studio.node("design").locator(".as-node")).not.toHaveClass(/as-node--dimmed/);
    await expect(studio.node("infra").locator(".as-node")).not.toHaveClass(/as-node--dimmed/);
    // The Plan legend's count is the same filter, and clears it.
    const ready = page.getByRole("group", { name: "Plan" }).locator(".as-legend__state--ready");
    await expect(ready).toHaveAttribute("aria-pressed", "true");
    await ready.click();
    await expect(studio.node("build").locator(".as-node")).not.toHaveClass(/as-node--dimmed/);
  });

  test("the critical path lights the chain with the most work left", async ({ studio, page }) => {
    const menu = await studio.openMenu("View");
    await menu.getByRole("checkbox", { name: "Show critical path" }).check();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("group", { name: "Critical path" })).toContainText("7 pts left · 2 steps");
    await expect(page.locator('.react-flow__edge[data-id="pre"] .as-edge__pathglow')).toHaveCount(1);
    await expect(page.locator('.react-flow__edge[data-id="dep"] .as-edge__pathglow')).toHaveCount(0);
  });

  test("team capacity is saved with the document and flags someone over it", async ({ studio, page }) => {
    await studio.fromMenu("View", /^Team capacity/);
    const dialog = page.getByRole("dialog", { name: "Team capacity" });
    await dialog.getByLabel("Ana's capacity in story points").fill("4");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);
    const ana = page.getByRole("group", { name: "People" }).getByRole("button", { name: /Ana/ });
    await expect(ana.locator(".as-legend__count")).toHaveText("7/4 pts");
    await expect(ana.locator(".as-legend__count")).toHaveClass(/as-legend__count--over/);
    await expect.poll(async () => (await studio.liveDoc()).settings).toMatchObject({ capacity: { Ana: 4 } });
  });
});

test("a tracker's CSV export imports as a task graph", async ({ studio }, testInfo) => {
  await studio.goto();
  const file = testInfo.outputPath("sprint.csv");
  await writeFile(
    file,
    [
      "Summary,Issue key,Status,Priority,Assignee,Sprint,Custom field (Story Points),Inward issue link (Blocks)",
      "Write spec,WEB-1,Done,Medium,Ana,Sprint 1,3,",
      "Build API,WEB-2,In Progress,High,Ravi,Sprint 1,8,WEB-1",
      "QA pass,WEB-3,To Do,Low,,Sprint 2,2,WEB-2",
    ].join("\n"),
  );
  await studio.importFile(file);
  await expect(studio.nodeTitled("QA pass")).toBeVisible();
  const doc = await studio.liveDoc();
  const byLabel = (label: string) => doc.nodes.find((n) => n.label === label);
  expect(byLabel("Write spec")).toMatchObject({ kind: "task", done: true, storyPoints: 3, assignees: ["Ana"] });
  expect(byLabel("Build API")).toMatchObject({ stage: "in-progress", priority: "p1" });
  expect(byLabel("Sprint 2")?.kind).toBe("group");
  expect(doc.edges.map((e) => [e.source, e.target])).toContainEqual([byLabel("Build API")!.id, byLabel("QA pass")!.id]);
  await expect(studio.node(byLabel("QA pass")!.id).getByRole("checkbox")).toHaveClass(/as-task__check--blocked/);
});

test("the Task flow preset starts a plan with a task", async ({ studio, page }) => {
  await studio.goto();
  await studio.newFile();
  const welcome = page.getByRole("dialog", { name: "Get started" });
  await welcome.getByRole("button", { name: "Task flow" }).click();
  await welcome.getByRole("button", { name: /Insert Task Manually/ }).click();
  await expect(page.locator(".as-node--task")).toHaveCount(1);
  await expect(page.locator(".as-task__check")).toBeVisible();
});

test.describe("task graphs in the interactive HTML export", () => {
  /** Export the plan as interactive HTML and keep it as a file to open. */
  async function exportPlan(studio: Parameters<Parameters<typeof test>[2]>[0]["studio"]) {
    const file = test.info().outputPath("plan.json");
    await writeFile(file, JSON.stringify(PLAN));
    await studio.goto();
    await studio.importFile(file);
    await expect(studio.nodeTitled("Build")).toBeVisible();
    const download = await studio.download(() => studio.fromMenu("Export", /^Interactive HTML/));
    const html = test.info().outputPath("export.html");
    await download.saveAs(html);
    return html;
  }
  const part = (id: string, name: string) => `.bd-el[data-el="node:${id}"][data-part="${name}"]`;
  const stateOf = (text: string) => JSON.parse(/id="bd-task-state">([\s\S]*?)<\/script>/.exec(text)![1]!) as { done: string[] };

  test("checks toggle and blocked checks follow; the People legend previews and focuses", async ({ studio, page }) => {
    const html = await exportPlan(studio);
    await page.goto(`file://${html}`);
    // Build waits on Design and on Infra: struck through, and a click does nothing.
    const blocked = page.locator(part("build", "check-blocked"));
    await expect(blocked).toBeVisible();
    await expect(blocked).toHaveCSS("cursor", "not-allowed");
    await blocked.click({ force: true });
    await expect(blocked).toBeVisible();
    await expect(page.locator(part("build", "check-done"))).toBeHidden();
    await page.locator(part("design", "check-open")).click();
    await expect(page.locator(part("design", "check-done"))).toBeVisible();
    await expect(blocked).toBeVisible();
    await page.locator(part("infra", "check-open")).click();
    await expect(blocked).toBeHidden();
    await expect(page.locator(part("build", "check-open"))).toBeVisible();

    await page.locator('.bd-el[data-el="person:Ravi"]').hover();
    await expect(page.locator('.bd-el[data-el="node:design"]:not([data-part])')).toHaveClass(/bd-pmute/);
    await page.locator('.bd-el[data-el="person:Ana"]').click();
    await page.mouse.move(5, 5);
    await expect(page.locator('.bd-el[data-el="node:infra"]:not([data-part])')).toHaveClass(/bd-pmute/);
    await expect(page.locator('.bd-el[data-el="node:design"]:not([data-part])')).not.toHaveClass(/bd-pmute/);
  });

  test("Save writes the checks into the file, then every check saves on its own", async ({ studio, page }) => {
    const html = await exportPlan(studio);
    // Chrome's file picker, standing in: the picked file is the export itself.
    await page.addInitScript((start) => {
      const file = { text: start, writes: [] as string[] };
      (window as unknown as { __bdFile: typeof file }).__bdFile = file;
      (window as unknown as { showOpenFilePicker: unknown }).showOpenFilePicker = async () => [
        {
          name: "export.html",
          getFile: async () => ({ text: async () => file.text }),
          createWritable: async () => ({
            write: async (t: string) => {
              file.text = t;
              file.writes.push(t);
            },
            close: async () => {},
          }),
          requestPermission: async () => "granted",
        },
      ];
    }, await readFile(html, "utf8"));
    await page.goto(`file://${html}`);
    const writes = () => page.evaluate(() => (window as unknown as { __bdFile: { writes: string[] } }).__bdFile.writes);

    await page.locator(part("design", "check-open")).click();
    await expect(page.locator("#bd-task-status")).toContainText("Unsaved");
    await page.locator("#bd-task-save").click();
    await expect.poll(async () => (await writes()).length).toBe(1);
    expect(stateOf((await writes())[0]!).done).toEqual(["design"]);
    await expect(page.locator("#bd-task-status")).toContainText("Saved to export.html");

    await page.locator(part("infra", "check-open")).click();
    await expect.poll(async () => (await writes()).length).toBe(2);
    expect(stateOf((await writes())[1]!).done).toEqual(["design", "infra"]);
  });

  test("without file access, Save hands back a copy with the checks in", async ({ studio, page }) => {
    const html = await exportPlan(studio);
    await page.addInitScript(() => {
      (window as unknown as { showOpenFilePicker: unknown }).showOpenFilePicker = undefined;
    });
    await page.goto(`file://${html}`);
    await page.locator(part("design", "check-open")).click();
    const chooser = page.waitForEvent("filechooser");
    const download = page.waitForEvent("download");
    await page.locator("#bd-task-save").click();
    await (await chooser).setFiles(html);
    const copy = test.info().outputPath("copy.html");
    await (await download).saveAs(copy);
    expect(stateOf(await readFile(copy, "utf8")).done).toEqual(["design"]);
    await expect(page.locator("#bd-task-status")).toContainText("replace the old file");
  });
});

/**
 * @vitest-environment jsdom
 *
 * Task graphs, live in the interactive HTML export: the exported page runs
 * its own scripts in an iframe, as in html-explorer-page.test.ts — checks
 * toggle, Blocked follows, the People legend previews and focuses, checks
 * are kept in the browser and saved back into the file through a stand-in
 * for the browser's file picker.
 */
import { afterEach, describe, expect, it } from "vitest";
import { validateTemplate, type DiagramTemplate } from "../contract/schema";
import { BUILTIN_EXPORTERS } from "./exporters";
import { createRegistry } from "./create-registry";
import { HTML_TASK_SCRIPT } from "./html-tasks";
import bakeryJson from "../../../../templates/examples/bakery-data-model.json";

const registry = createRegistry();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** design (done) → build → ship → svc; design → docs. Ana: design, docs, ship. Ravi: build, ship. */
const PLAN = validateTemplate({
  version: 1,
  meta: { title: "Plan" },
  nodes: [
    { id: "design", label: "Design", kind: "task", x: 0, y: 0, assignees: ["Ana"], done: true },
    { id: "build", label: "Build", kind: "task", x: 300, y: 0, assignees: ["Ravi"] },
    { id: "ship", label: "Ship", kind: "task", x: 600, y: 0, assignees: ["Ravi", "Ana"] },
    { id: "docs", label: "Docs", kind: "task", x: 300, y: 200, assignees: ["Ana"] },
    { id: "svc", label: "Service", kind: "service", x: 900, y: 0 },
  ],
  edges: [
    { id: "db", source: "design", target: "build" },
    { id: "bs", source: "build", target: "ship" },
    { id: "ss", source: "ship", target: "svc" },
    { id: "dd", source: "design", target: "docs" },
  ],
});

async function exportHtml(template: DiagramTemplate = PLAN) {
  return (await BUILTIN_EXPORTERS.html.run({ template, registry, filename: "plan" }))!.blob.text();
}

const frames: HTMLIFrameElement[] = [];
afterEach(() => {
  for (const f of frames.splice(0)) f.remove();
  localStorage.clear();
});

async function openPage(html: string, before?: (win: Window & typeof globalThis) => void) {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  frames.push(frame);
  const win = frame.contentWindow! as Window & typeof globalThis;
  before?.(win);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  const groups = (el: string) => [...doc.querySelectorAll(".bd-el")].filter((g) => g.getAttribute("data-el") === el);
  const part = (id: string, name: string) => groups(`node:${id}`).find((g) => g.getAttribute("data-part") === name)!;
  const body = (id: string) => groups(`node:${id}`).find((g) => !g.hasAttribute("data-part"))!;
  const on = (g: Element) => g.hasAttribute("data-on");
  const row = (name: string) => groups(`person:${name}`)[0]!;
  const click = (target: Element) => {
    const inner = target.querySelector("circle, path, text") ?? target;
    inner.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  };
  const pointer = (target: Element, type: string) => target.dispatchEvent(new win.Event(type));
  const muted = (el: string) => groups(el).some((g) => g.classList.contains("bd-pmute"));
  const mutedEdge = (el: string) => groups(el).some((g) => g.classList.contains("bd-pmute-edge"));
  const status = () => doc.getElementById("bd-task-status")!.textContent;
  return { win, doc, groups, part, body, on, row, click, pointer, muted, mutedEdge, status };
}

describe("the exported SVG", () => {
  it("draws every state a task can take as parts under the node's own id, stamped with the export's state", async () => {
    const html = await exportHtml();
    const p = await openPage(html);
    // Design is done: its body says so, and the done check and strike are on.
    expect(p.body("design").hasAttribute("data-done")).toBe(true);
    expect(p.on(p.part("design", "check-done"))).toBe(true);
    expect(p.on(p.part("design", "check-open"))).toBe(false);
    expect(p.on(p.part("design", "strike"))).toBe(true);
    // Ship waits on Build, which is open: its check is struck through.
    expect(p.on(p.part("ship", "check-blocked"))).toBe(true);
    expect(p.on(p.part("ship", "check-open"))).toBe(false);
    expect(p.on(p.part("build", "check-blocked"))).toBe(false);
    expect(p.on(p.part("build", "check-open"))).toBe(true);
    // No Ready or Blocked pill is drawn at all.
    expect(p.doc.querySelectorAll('[data-part="blocked"], [data-part="ready"]')).toHaveLength(0);
    expect(p.row("Ana")).toBeTruthy();
  });

  it("leaves a page without tasks exactly as it was", async () => {
    const html = (await BUILTIN_EXPORTERS.html.run({ template: validateTemplate(bakeryJson), registry, filename: "b" }))!.blob.text();
    const text = await html;
    expect(text).not.toContain("bd-task");
    expect(text).not.toContain("data-part");
  });

  it("ships a script that can never end its own <script> or open a comment", () => {
    for (const bad of ["<!--", "</script", "</body", "</style"]) expect(HTML_TASK_SCRIPT).not.toContain(bad);
  });

  it("keeps a hostile task name inside its data block", async () => {
    const html = await exportHtml(
      validateTemplate({ version: 1, nodes: [{ id: "x", label: "</script><b>pwn", kind: "task", x: 0, y: 0, assignees: ["<!--"] }], edges: [] }),
    );
    const data = html.slice(html.indexOf('id="bd-task-data">'));
    expect(data.slice(0, data.indexOf("</script>"))).not.toMatch(/<\/script|<!--/);
    // The state markers appear once each.
    expect(html.split("<!--bd-task-state-->").length).toBe(2);
    expect(html.split("<!--/bd-task-state-->").length).toBe(2);
  });
});

describe("checks in the page", () => {
  it("toggle on click, and every check waiting on it follows — without selecting the card", async () => {
    const p = await openPage(await exportHtml());
    p.click(p.part("build", "check-open"));
    expect(p.body("build").hasAttribute("data-done")).toBe(true);
    expect(p.on(p.part("build", "check-done"))).toBe(true);
    expect(p.part("build", "check-done").getAttribute("aria-checked")).toBe("true");
    expect(p.on(p.part("ship", "check-blocked"))).toBe(false);
    expect(p.on(p.part("ship", "check-open"))).toBe(true);
    // The explorer never saw the press: nothing is ringed as selected.
    expect(p.doc.querySelectorAll(".bd-x-ring")).toHaveLength(0);

    // Reopening Design blocks what still waits on it — Docs; Build is done, and a done task is never blocked.
    p.click(p.part("design", "check-done"));
    expect(p.on(p.part("docs", "check-blocked"))).toBe(true);
    expect(p.on(p.part("build", "check-blocked"))).toBe(false);
    expect(p.on(p.part("design", "strike"))).toBe(false);
  });

  it("refuse a blocked task's check, and name what it waits on", async () => {
    const p = await openPage(await exportHtml());
    const blocked = p.part("ship", "check-blocked");
    expect(blocked.getAttribute("aria-disabled")).toBe("true");
    expect(blocked.getAttribute("aria-label")).toBe("Ship — Blocked — waiting on Build");
    expect(blocked.querySelector("title")!.textContent).toBe("Blocked — waiting on Build");
    // Each press on its own — two that both got through would cancel out.
    p.click(blocked);
    expect(p.body("ship").hasAttribute("data-done")).toBe(false);
    blocked.dispatchEvent(new p.win.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    expect(p.body("ship").hasAttribute("data-done")).toBe(false);
    expect(p.on(blocked)).toBe(true);
    expect(p.doc.querySelectorAll(".bd-x-ring")).toHaveLength(0);
  });

  it("toggle from the keyboard", async () => {
    const p = await openPage(await exportHtml());
    const check = p.part("build", "check-open");
    expect(check.getAttribute("role")).toBe("checkbox");
    check.dispatchEvent(new p.win.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    expect(p.body("build").hasAttribute("data-done")).toBe(true);
  });

  it("are kept in this browser across a reload, flagged as unsaved", async () => {
    const html = await exportHtml();
    const first = await openPage(html);
    first.click(first.part("build", "check-open"));
    expect(first.status()).toMatch(/Unsaved/);
    const again = await openPage(html);
    expect(again.body("build").hasAttribute("data-done")).toBe(true);
    expect(again.status()).toMatch(/Unsaved/);
  });
});

describe("the People legend in the page", () => {
  it("previews a person on hover: other task cards recede, lines and other nodes stay", async () => {
    const p = await openPage(await exportHtml());
    p.pointer(p.row("Ravi"), "pointerenter");
    expect(p.muted("node:design")).toBe(true);
    expect(p.muted("node:docs")).toBe(true);
    expect(p.muted("node:build")).toBe(false);
    expect(p.muted("node:svc")).toBe(false);
    expect(p.mutedEdge("edge:dd")).toBe(false);
    p.pointer(p.row("Ravi"), "pointerleave");
    expect(p.muted("node:design")).toBe(false);
  });

  it("focuses on a person on click: every other node and every line they aren't part of recedes", async () => {
    const p = await openPage(await exportHtml());
    p.click(p.row("Ravi"));
    expect(p.muted("node:design")).toBe(true);
    expect(p.muted("node:svc")).toBe(true);
    expect(p.muted("node:build")).toBe(false);
    // design → build touches Ravi's Build; design → docs touches nothing of his.
    expect(p.mutedEdge("edge:db")).toBe(false);
    expect(p.mutedEdge("edge:dd")).toBe(true);
    expect(p.row("Ravi").getAttribute("aria-pressed")).toBe("true");

    // Hovering someone else previews them; leaving brings the focus back.
    p.pointer(p.row("Ana"), "pointerenter");
    expect(p.muted("node:build")).toBe(true);
    expect(p.mutedEdge("edge:dd")).toBe(false);
    p.pointer(p.row("Ana"), "pointerleave");
    expect(p.mutedEdge("edge:dd")).toBe(true);

    p.click(p.row("Ravi"));
    expect(p.muted("node:design")).toBe(false);
  });

  it("works on a drilled level, through a ghost", async () => {
    const nested = validateTemplate({
      version: 1,
      nodes: [
        { id: "epic", label: "Epic", kind: "service", x: 0, y: 0 },
        { id: "inner", label: "Inner", kind: "task", parentId: "epic", x: 20, y: 20, assignees: ["Ana"] },
        { id: "outer", label: "Outer", kind: "task", x: 400, y: 0, assignees: ["Ravi"] },
      ],
      edges: [{ id: "oi", source: "outer", target: "inner" }],
    });
    const p = await openPage(await exportHtml(nested));
    // The epic's level draws Outer as a ghost; Inner is blocked by it there.
    expect(p.on(p.part("inner", "check-blocked"))).toBe(true);
    p.click(p.part("ghost:outer", "check-open"));
    expect(p.on(p.part("inner", "check-blocked"))).toBe(false);
    expect(p.on(p.part("inner", "check-open"))).toBe(true);
    expect(p.on(p.part("outer", "check-done"))).toBe(true);
    p.click(p.groups("person:Ana").at(-1)!);
    expect(p.muted("node:ghost:outer")).toBe(true);
  });
});

describe("saving checks into the file", () => {
  /** The browser's file picker, standing in: a file whose text is `start`, and the writes it took. */
  function picker(win: Window & typeof globalThis, start: string, name = "about:blank") {
    const file = { text: start, writes: [] as string[] };
    const handle = {
      name,
      getFile: async () => ({ text: async () => file.text }),
      createWritable: async () => ({
        write: async (t: string) => {
          file.text = t;
          file.writes.push(t);
        },
        close: async () => {},
      }),
      requestPermission: async () => "granted",
    };
    (win as unknown as { showOpenFilePicker: () => Promise<unknown[]> }).showOpenFilePicker = async () => [handle];
    return file;
  }
  const outside = (text: string) => text.replace(/<!--bd-task-state-->[\s\S]*?<!--\/bd-task-state-->/, "");
  const stateOf = (text: string) =>
    JSON.parse(/id="bd-task-state">([\s\S]*?)<\/script>/.exec(text)![1]!) as { done: string[]; savedAt: number };

  it("writes the checks into the picked file — only the state block changes — and auto-saves after", async () => {
    const html = await exportHtml();
    let file!: ReturnType<typeof picker>;
    const p = await openPage(html, (win) => (file = picker(win, html)));
    p.click(p.part("build", "check-open"));
    p.doc.getElementById("bd-task-save")!.click();
    await wait(20);
    expect(file.writes).toHaveLength(1);
    expect(outside(file.writes[0]!)).toBe(outside(html));
    expect(stateOf(file.writes[0]!).done).toEqual(["build", "design"]);
    expect(stateOf(file.writes[0]!).savedAt).toBeGreaterThan(0);
    expect(p.status()).toMatch(/Saved to/);

    // From now on a check saves on its own — re-reading the file each time.
    p.click(p.part("docs", "check-open"));
    await wait(500);
    expect(file.writes).toHaveLength(2);
    expect(stateOf(file.writes[1]!).done).toEqual(["build", "design", "docs"]);
  });

  it("refuses a file that is a different export", async () => {
    const html = await exportHtml();
    const other = await exportHtml(validateTemplate({ ...PLAN, meta: { title: "Another plan" } }));
    let file!: ReturnType<typeof picker>;
    const p = await openPage(html, (win) => (file = picker(win, other)));
    p.click(p.part("build", "check-open"));
    p.doc.getElementById("bd-task-save")!.click();
    await wait(20);
    expect(file.writes).toHaveLength(0);
    expect(p.status()).toMatch(/different export/);
  });

  it("reopens from the saved file with the checks in", async () => {
    const html = await exportHtml();
    let file!: ReturnType<typeof picker>;
    const p = await openPage(html, (win) => (file = picker(win, html)));
    p.click(p.part("build", "check-open"));
    p.doc.getElementById("bd-task-save")!.click();
    await wait(20);
    localStorage.clear();
    const reopened = await openPage(file.text);
    expect(reopened.body("build").hasAttribute("data-done")).toBe(true);
    expect(reopened.status()).toBe("");
  });
});

describe("the plan in the page", () => {
  const SPRINT = validateTemplate({
    version: 1,
    settings: { capacity: { Ana: 4 } },
    nodes: [
      { id: "s1", label: "Sprint 1", kind: "group", x: 0, y: 0, w: 1200, h: 300 },
      { id: "api", label: "API", kind: "task", parentId: "s1", x: 30, y: 60, storyPoints: 5, assignees: ["Ana"] },
      { id: "qa", label: "QA", kind: "task", parentId: "s1", x: 330, y: 60, storyPoints: 1, assignees: ["Ana"] },
      { id: "late", label: "Late", kind: "task", parentId: "s1", x: 330, y: 200, storyPoints: 2, date: "2020-01-01" },
      { id: "ship", label: "Ship", kind: "milestone", parentId: "s1", x: 630, y: 60 },
    ],
    edges: [
      { id: "a-q", source: "api", target: "qa" },
      { id: "q-s", source: "qa", target: "ship" },
    ],
  });
  const texts = (g: Element) => [...g.querySelectorAll("text")].map((t) => t.textContent);

  it("recounts blocked checks, Reached, late dates, the roll-up, the Plan and each person's load as checks change", async () => {
    const p = await openPage(await exportHtml(SPRINT));
    expect(p.on(p.part("api", "check-open"))).toBe(true);
    expect(p.on(p.part("qa", "check-blocked"))).toBe(true);
    expect(p.on(p.part("late", "due-late"))).toBe(true);
    const rollup = p.part("s1", "rollup");
    expect(texts(rollup)).toEqual(["0/8 pts"]);
    const plan = p.doc.querySelector(".bd-el[data-plan]")!;
    expect(texts(plan)).toEqual(["0/8 pts", "2 READY · 1 BLOCKED · 1 OVERDUE"]);
    expect(texts(p.row("Ana")).at(-1)).toBe("6/4 pts");

    p.click(p.part("api", "check-open"));
    expect(p.on(p.part("qa", "check-open"))).toBe(true);
    expect(texts(rollup)).toEqual(["5/8 pts"]);
    expect(texts(p.row("Ana")).at(-1)).toBe("1/4 pts");

    p.click(p.part("qa", "check-open"));
    p.click(p.part("late", "check-open"));
    expect(p.on(p.part("ship", "reached"))).toBe(true);
    expect(p.on(p.part("late", "due-late"))).toBe(false);
    expect(texts(plan)).toEqual(["8/8 pts", ""]);
  });

  it("moves what's late with the date when the page is shown on a new day", async () => {
    let now = new Date(2026, 9, 2, 22, 0).getTime();
    const dueToday = validateTemplate({
      version: 1,
      nodes: [{ id: "t", label: "T", kind: "task", x: 0, y: 0, date: "2026-10-02" }],
      edges: [],
    });
    const p = await openPage(await exportHtml(dueToday), (win) => {
      // The page's own clock, set before its script reads it.
      const Real = win.Date;
      class Clock extends Real {
        constructor(...args: unknown[]) {
          if (args.length) super(...(args as [number]));
          else super(now);
        }
        static now() {
          return now;
        }
      }
      win.Date = Clock as unknown as DateConstructor;
    });
    expect(p.on(p.part("t", "due-late"))).toBe(false);
    now = new Date(2026, 9, 3, 8, 0).getTime();
    p.doc.dispatchEvent(new p.win.Event("visibilitychange"));
    expect(p.on(p.part("t", "due-late"))).toBe(true);
  });
});

/**
 * @vitest-environment jsdom
 *
 * The interactive HTML export's viewer habits, driven the way a reader drives
 * the file: the exported page runs its own scripts in an iframe, as in
 * html-explorer-page.test.ts. The legend docks in the window's corner, one
 * per level with the level on show; lines hide but the hovered box's, and
 * the menu's "Show all lines" brings them back.
 */
import { afterEach, describe, expect, it } from "vitest";
import { validateTemplate, type DiagramTemplate } from "../contract/schema";
import { BUILTIN_EXPORTERS } from "./exporters";
import { createRegistry } from "./create-registry";
import { fileLinkPage } from "./draw";
import { buildTimelineHtml } from "./html-export";
import bakeryJson from "../../../../templates/examples/bakery-data-model.json";

const registry = createRegistry();

/**
 * A sprint holding a → b → c, and a dependency a ⇢ c, feeding a release
 * outside it; Ana holds a and b, so the legend has People rows.
 */
const PLAN = validateTemplate({
  version: 1,
  meta: { title: "Plan" },
  nodes: [
    { id: "sprint", label: "Sprint", kind: "group", x: 0, y: 0, w: 920, h: 200 },
    { id: "a", label: "A", kind: "task", parentId: "sprint", x: 24, y: 60, assignees: ["Ana"] },
    { id: "b", label: "B", kind: "task", parentId: "sprint", x: 324, y: 60, assignees: ["Ana"] },
    { id: "c", label: "C", kind: "task", parentId: "sprint", x: 624, y: 60 },
    { id: "release", label: "Release", kind: "milestone", x: 380, y: 300 },
  ],
  edges: [
    { id: "ab", source: "a", target: "b" },
    { id: "bc", source: "b", target: "c" },
    { id: "ac", source: "a", target: "c", relation: "dependency", style: "dashed" },
    { id: "sr", source: "sprint", target: "release" },
  ],
});

const frames: HTMLIFrameElement[] = [];
afterEach(() => {
  for (const f of frames.splice(0)) f.remove();
  localStorage.clear();
});

async function openPage(template: DiagramTemplate) {
  const html = await (await BUILTIN_EXPORTERS.html.run({ template, registry, filename: "page" }))!.blob.text();
  const frame = document.createElement("iframe");
  document.body.append(frame);
  frames.push(frame);
  const win = frame.contentWindow! as Window & typeof globalThis;
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  const $ = <T extends Element = HTMLElement>(sel: string) => doc.querySelector(sel) as T | null;
  const groups = (el: string) => [...doc.querySelectorAll(".bd-el")].filter((g) => g.getAttribute("data-el") === el);
  const lit = () =>
    [...new Set([...doc.querySelectorAll(".bd-line-on")].map((g) => g.getAttribute("data-el")))].sort();
  const pointer = (target: Element, type: string) => target.dispatchEvent(new win.MouseEvent(type, { bubbles: true }));
  const check = (id: string, on: boolean) => {
    const box = $<HTMLInputElement>(`#${id}`)!;
    box.checked = on;
    box.dispatchEvent(new win.Event("change", { bubbles: true }));
  };
  const shownKeys = () => [...doc.querySelectorAll<HTMLElement>("#bd-dock .bd-key")].filter((k) => !k.hidden);
  return { win, doc, $, groups, lit, pointer, check, shownKeys };
}

describe("the docked legend", () => {
  it("leaves the picture for the window's corner, rows and all", async () => {
    const p = await openPage(PLAN);
    const key = p.shownKeys();
    expect(key).toHaveLength(1);
    // Every part of it moved: the frame and headings, and the People rows.
    expect(p.doc.querySelector('#bd-stage [data-el="legend:"], #bd-stage [data-person]')).toBeNull();
    expect(key[0]!.querySelector('[data-el="legend:"]')).not.toBeNull();
    expect(key[0]!.querySelector('[data-el="person:Ana"]')).not.toBeNull();
    // Sized to the box it filled in the picture.
    const svg = key[0]!.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe(p.groups("legend:")[0]!.getAttribute("data-box"));
  });

  it("keeps its rows working where it docks: a person still focuses on click", async () => {
    const p = await openPage(PLAN);
    const row = p.groups("person:Ana")[0]!;
    row.dispatchEvent(new p.win.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(row.classList.contains("bd-person-on")).toBe(true);
  });

  it("shows the legend of the level on show, and the menu's Legend check hides it", async () => {
    const p = await openPage(validateTemplate(bakeryJson));
    // One legend per level — the root's and Customers' — the root's on show.
    expect([...p.doc.querySelectorAll("#bd-dock .bd-key")].map((k) => k.getAttribute("data-view"))).toEqual(["", "customers"]);
    const shown = () => p.shownKeys().map((k) => k.getAttribute("data-view"));
    expect(shown()).toEqual([""]);
    p.doc.dispatchEvent(new p.win.CustomEvent("bd:show", { detail: "customers" }));
    expect(shown()).toEqual(["customers"]);
    p.check("bd-showkey", false);
    expect(shown()).toEqual([]);
    p.check("bd-showkey", true);
    expect(shown()).toEqual(["customers"]);
  });
});

describe("lines on hover", () => {
  it("hides every line until a box it joins is hovered, then shows just that box's", async () => {
    const p = await openPage(PLAN);
    expect(p.doc.body.classList.contains("bd-lines-hover")).toBe(true);
    expect(p.lit()).toEqual([]);
    p.pointer(p.groups("node:c")[0]!, "pointerover");
    expect(p.lit()).toEqual(["edge:ac", "edge:bc"]);
    // Moving to another box swaps them; leaving the picture clears them.
    p.pointer(p.groups("node:a")[0]!, "pointerover");
    expect(p.lit()).toEqual(["edge:ab", "edge:ac"]);
    p.pointer(p.$("#bd-stage")!, "pointerleave");
    expect(p.lit()).toEqual([]);
  });

  it("always draws the structure: the sprint's line to the release is kept, the lines inside it hover", async () => {
    const p = await openPage(PLAN);
    const keep = (id: string) => p.groups(`edge:${id}`).every((g) => g.hasAttribute("data-keep"));
    expect(["ab", "bc", "ac", "sr"].filter(keep)).toEqual(["sr"]);
  });

  it("shows them all while the menu's Show all lines is on", async () => {
    const p = await openPage(PLAN);
    p.check("bd-alllines", true);
    expect(p.doc.body.classList.contains("bd-lines-hover")).toBe(false);
    p.check("bd-alllines", false);
    expect(p.doc.body.classList.contains("bd-lines-hover")).toBe(true);
  });

  it("opens with them all shown when the document says settings.htmlLines: all, and the check still hides them", async () => {
    const p = await openPage({ ...PLAN, settings: { htmlLines: "all" } });
    expect(p.$<HTMLInputElement>("#bd-alllines")!.checked).toBe(true);
    expect(p.doc.body.classList.contains("bd-lines-hover")).toBe(false);
    p.check("bd-alllines", false);
    expect(p.doc.body.classList.contains("bd-lines-hover")).toBe(true);
  });

  it("opens that way on a drill-down page too", async () => {
    const bakery = validateTemplate(bakeryJson);
    const p = await openPage({ ...bakery, settings: { ...bakery.settings, htmlLines: "all" } });
    expect(p.$("section[data-view]")).not.toBeNull();
    expect(p.$<HTMLInputElement>("#bd-alllines")!.checked).toBe(true);
    expect(p.doc.body.classList.contains("bd-lines-hover")).toBe(false);
  });
});

/**
 * The canvas's ↗ and ⊞ N, in the page: a card's web link is a link the
 * reader follows, and a node with things inside says how many. An API with
 * a router inside it (which has a handler of its own), a database whose link
 * names another diagram, and a group of two with a link of its own.
 */
const LINKED = validateTemplate({
  version: 1,
  meta: { title: "Linked" },
  nodes: [
    { id: "api", label: "API", kind: "service", url: "https://example.com/api", x: 0, y: 0 },
    { id: "router", label: "Router", kind: "service", parentId: "api", x: 0, y: 0 },
    { id: "handler", label: "Handler", kind: "service", parentId: "router", x: 0, y: 0 },
    { id: "db", label: "DB", kind: "database", url: "file:Schema", x: 320, y: 0 },
    { id: "grp", label: "Payments", kind: "group", url: "https://example.com/payments", x: 0, y: 200, w: 520, h: 180 },
    { id: "pay", label: "Pay", kind: "service", parentId: "grp", x: 24, y: 60 },
    { id: "refund", label: "Refund", kind: "service", parentId: "grp", x: 260, y: 60 },
  ],
  edges: [{ id: "e1", source: "api", target: "db" }],
});

describe("links and levels, as the canvas shows them", () => {
  it("draws a card's web link as one the reader follows into a new tab, and a file: link to that diagram's page beside this one — not a frame's", async () => {
    const p = await openPage(LINKED);
    const links = [...p.doc.querySelectorAll('.bd-view:not([hidden]) a.bd-link')].map((a) => [
      a.closest("[data-el]")!.getAttribute("data-el"),
      a.getAttribute("href"),
      a.getAttribute("target"),
      a.getAttribute("rel"),
    ]);
    expect(links).toEqual([
      ["node:api", "https://example.com/api", "_blank", "noopener noreferrer"],
      // In place, as the canvas's file link swaps the diagram on show.
      ["node:db", "Schema.html", null, null],
    ]);
    expect(p.$('[data-el="node:db"] a.bd-link title')!.textContent).toBe("Schema — its page, exported beside this one");
  });

  it("names a file: link's page as its own export names it, and only ever as a relative path", () => {
    expect(fileLinkPage("payments.json")).toBe("payments.html");
    expect(fileLinkPage("Order flow")).toBe("Order%20flow.html");
    expect(fileLinkPage("../docs/Pay.JSON")).toBe("../docs/Pay.html");
    expect(fileLinkPage("docs\\pay.json")).toBe("docs/pay.html");
    // A scheme is just a name here: its colon is escaped, so it can't run.
    expect(fileLinkPage("javascript:alert(1)")).toBe("javascript%3Aalert(1).html");
    expect(fileLinkPage("http://evil.example/x")).toBe("http%3A/evil.example/x.html");
    // Nor can it reach another host: no leading // (scheme-relative, or a
    // Windows network share from a page opened off disk) and no absolute path.
    expect(fileLinkPage("//evil.example/x")).toBe("evil.example/x.html");
    expect(fileLinkPage("\\\\evil.example\\share\\x.json")).toBe("evil.example/share/x.html");
    expect(fileLinkPage("/etc/hosts")).toBe("etc/hosts.html");
    expect(fileLinkPage("docs//pay.json")).toBe("docs/pay.html");
    // Names nothing: no link.
    expect(fileLinkPage("docs/")).toBe("");
    expect(fileLinkPage("..")).toBe("");
    expect(fileLinkPage("   ")).toBe("");
  });

  it("opens the link and nothing else: the card it sits on still drills on its own click", async () => {
    const p = await openPage(LINKED);
    // The browser's own following of the link is not jsdom's to do.
    p.win.addEventListener("click", (e) => e.preventDefault(), true);
    const view = () => p.$(".bd-view:not([hidden])")!.getAttribute("data-view");
    const api = p.groups("node:api").find((g) => g.closest(".bd-view:not([hidden])"))!;
    api.querySelector("a.bd-link rect")!.dispatchEvent(new p.win.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(view()).toBe("");
    api.dispatchEvent(new p.win.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(view()).toBe("api");
  });

  it("badges what has things inside, counted on the whole document — on a level too", async () => {
    const p = await openPage(LINKED);
    const badge = (view: string, el: string) =>
      [...p.doc.querySelectorAll(`section[data-view="${view}"] [data-el="${el}"] text`)].map((t) => t.textContent).find((t) => t?.startsWith("⊞")) ?? null;
    expect(badge("", "node:api")).toBe("⊞ 1");
    expect(badge("", "node:grp")).toBe("⊞ 2");
    expect(badge("", "node:db")).toBeNull();
    // Inside the API, the router still opens a level of its own.
    expect(badge("api", "node:router")).toBe("⊞ 1");
  });

  it("leaves both out of a picture, which can't be clicked", async () => {
    const svg = await (await BUILTIN_EXPORTERS.svg.run({ template: LINKED, registry, filename: "pic" }))!.blob.text();
    expect(svg).not.toContain("bd-link");
    expect(svg).not.toContain("⊞");
  });
});

/**
 * How the page opens is the document's to say: its `settings.html*` set the
 * menu's checks, and the reader can still change each. A web, an API and a
 * queue that land on Mar 1, Apr 1 and Jun 1 2020, and a database that is
 * always there.
 */
const DATED = validateTemplate({
  version: 1,
  meta: { title: "Dated" },
  nodes: [
    { id: "web", label: "Web", kind: "service", date: "2020-03-01", x: 0, y: 0 },
    { id: "api", label: "API", kind: "gateway", date: "2020-04-01", x: 300, y: 0 },
    { id: "jobs", label: "Jobs", kind: "queue", date: "2020-06-01", x: 600, y: 0 },
    { id: "db", label: "DB", kind: "database", x: 300, y: 200 },
  ],
  edges: [
    { id: "e1", source: "web", target: "api" },
    { id: "e2", source: "api", target: "jobs" },
    { id: "e3", source: "api", target: "db" },
  ],
});

describe("how the page opens, as the document says", () => {
  type Page = Awaited<ReturnType<typeof openPage>>;
  const ghosted = (p: Page, id: string) => p.groups(`node:${id}`).some((g) => g.classList.contains("bd-dim"));
  const hidden = (p: Page, id: string) => p.groups(`node:${id}`).some((g) => g.classList.contains("bd-hidden"));

  it("opens on today, held to the document's dates, with the timeline bar and later things ghosted", async () => {
    const p = await openPage(DATED);
    expect(p.$("#bd-timeline")!.hidden).toBe(false);
    expect(p.$<HTMLInputElement>("#bd-showtl")!.checked).toBe(true);
    expect(p.$<HTMLInputElement>('input[name="bd-mode"][value="dim"]')!.checked).toBe(true);
    // Today is long past 2020, so it opens on the last date: nothing later.
    expect(p.$("#bd-ahead")!.textContent).toBe("all here");
  });

  it("opens on the first date, and ghosts what comes after it", async () => {
    const p = await openPage({ ...DATED, settings: { htmlTimelineDate: "first" } });
    expect(p.$("#bd-date")!.textContent).toContain("Mar 1");
    expect([ghosted(p, "web"), ghosted(p, "api"), ghosted(p, "jobs"), ghosted(p, "db")]).toEqual([false, true, true, false]);
  });

  it("opens on the last date when asked, whatever today is", async () => {
    const p = await openPage({ ...DATED, settings: { htmlTimelineDate: "last" } });
    expect(p.$("#bd-date")!.textContent).toContain("Jun 1");
    expect(p.$("#bd-ahead")!.textContent).toBe("all here");
  });

  it("leaves out what comes later instead, under htmlLater: hide, and the menu's Ghost later brings it back", async () => {
    const p = await openPage({ ...DATED, settings: { htmlTimelineDate: "first", htmlLater: "hide" } });
    expect(p.$<HTMLInputElement>('input[name="bd-mode"][value="hide"]')!.checked).toBe(true);
    expect([hidden(p, "api"), ghosted(p, "api")]).toEqual([true, false]);
    const ghost = p.$<HTMLInputElement>('input[name="bd-mode"][value="dim"]')!;
    ghost.checked = true;
    ghost.dispatchEvent(new p.win.Event("change", { bubbles: true }));
    expect([hidden(p, "api"), ghosted(p, "api")]).toEqual([false, true]);
  });

  it("opens without the timeline bar, everything shown, until the menu's Timeline bar brings it back", async () => {
    const p = await openPage({ ...DATED, settings: { htmlTimeline: "hide", htmlTimelineDate: "first", htmlLater: "hide" } });
    expect(p.$("#bd-timeline")!.hidden).toBe(true);
    expect(p.$<HTMLInputElement>("#bd-showtl")!.checked).toBe(false);
    expect([hidden(p, "jobs"), ghosted(p, "jobs")]).toEqual([false, false]);
    p.check("bd-showtl", true);
    expect(p.$("#bd-timeline")!.hidden).toBe(false);
  });

  it("opens without the legend under htmlLegend: hide, and the menu's Legend check shows it", async () => {
    expect((await openPage(PLAN)).shownKeys()).toHaveLength(1);
    const p = await openPage({ ...PLAN, settings: { htmlLegend: "hide" } });
    expect(p.$<HTMLInputElement>("#bd-showkey")!.checked).toBe(false);
    expect(p.shownKeys()).toHaveLength(0);
    p.check("bd-showkey", true);
    expect(p.shownKeys()).toHaveLength(1);
  });

  it("opens that way on a drill-down page too", async () => {
    const bakery = validateTemplate(bakeryJson);
    const p = await openPage({ ...bakery, settings: { ...bakery.settings, htmlLegend: "hide" } });
    expect(p.$("section[data-view]")).not.toBeNull();
    expect(p.$<HTMLInputElement>("#bd-showkey")!.checked).toBe(false);
    expect(p.shownKeys()).toHaveLength(0);
  });

  it("is the page it always was when nothing is asked for", () => {
    const base = { svg: "<svg></svg>", title: "T", stops: ["2020-03-01", "2020-06-01"], dockLegend: true, hoverLines: true };
    expect(buildTimelineHtml({ ...base, hideTimeline: false, timelineDate: "today", hideLater: false, hideLegend: false })).toBe(
      buildTimelineHtml(base),
    );
  });
});

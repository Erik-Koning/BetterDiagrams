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
  it("draws a card's web link as one the reader follows into a new tab — not a file: link, not a frame's", async () => {
    const p = await openPage(LINKED);
    const links = [...p.doc.querySelectorAll('.bd-view:not([hidden]) a.bd-link')].map((a) => [
      a.closest("[data-el]")!.getAttribute("data-el"),
      a.getAttribute("href"),
      a.getAttribute("target"),
      a.getAttribute("rel"),
    ]);
    expect(links).toEqual([["node:api", "https://example.com/api", "_blank", "noopener noreferrer"]]);
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

/**
 * @vitest-environment jsdom
 *
 * The interactive HTML export's search and relationship analysis, driven the
 * way a reader drives the file: the exported page is written into an iframe
 * and runs its OWN scripts — the player, the level navigator and the bundled
 * explorer — so this tests what ships. Each test gets a fresh frame, so no
 * listener outlives its page.
 */
import { describe, expect, it } from "vitest";
import { validateTemplate, type DiagramTemplate } from "../contract/schema";
import { BUILTIN_EXPORTERS } from "./exporters";
import { createRegistry } from "./create-registry";
import bakeryJson from "../../../../templates/examples/bakery-data-model.json";

const registry = createRegistry();

/** The bakery data model: tables with rows and data-bag fields, keys, and one drill level (Customers). */
function bakery(): DiagramTemplate {
  return validateTemplate(bakeryJson);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function openPage(template: DiagramTemplate = bakery()) {
  const html = await (await BUILTIN_EXPORTERS.html.run({ template, registry, filename: "page" }))!.blob.text();
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const win = frame.contentWindow! as Window & typeof globalThis;
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();

  const $ = <T extends Element = HTMLElement>(sel: string) => doc.querySelector(sel) as T | null;
  const view = () => $(".bd-view:not([hidden])")?.getAttribute("data-view") ?? "";
  /** An element's groups on the level being shown. */
  const group = (el: string) =>
    [...doc.querySelectorAll(".bd-view:not([hidden]) [data-el], #bd-stage > svg [data-el]")].find((g) => g.getAttribute("data-el") === el)!;
  const row = (nodeId: string, fieldId: string) =>
    [...group(`node:${nodeId}`).querySelectorAll("rect.bd-row")].find((r) => r.getAttribute("data-field") === fieldId)!;
  const mouse = (target: Element, type: string, init: MouseEventInit = {}) =>
    target.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 40, clientY: 40, ...init }));
  const key = (key: string, target: Element = doc.body, init: KeyboardEventInit = {}) =>
    target.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  const search = (query: string) => {
    const input = $<HTMLInputElement>("#bd-search")!;
    input.value = query;
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    return input;
  };
  const menu = () => [...doc.querySelectorAll("#bd-context .bd-context__item")].map((b) => b.firstElementChild!.textContent);
  const pick = (label: string | RegExp) => {
    const item = [...doc.querySelectorAll<HTMLButtonElement>("#bd-context .bd-context__item")].find((b) => {
      const text = b.firstElementChild!.textContent ?? "";
      return typeof label === "string" ? text === label : label.test(text);
    });
    if (!item) throw new Error(`no menu item ${label} in ${JSON.stringify(menu())}`);
    item.click();
  };
  const button = (label: string) => [...doc.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;
  const ringed = () => [...doc.querySelectorAll(".bd-x-ring")].map((r) => r.parentElement!.getAttribute("data-el"));
  return { win, doc, $, view, group, row, mouse, key, search, menu, pick, button, ringed };
}

describe("search", () => {
  it("finds nodes on every level, and Enter walks the matches — drilling where one lives", async () => {
    const p = await openPage();
    const input = p.search("loyalty");
    expect(p.$("#bd-searchcount")!.textContent).toBe("1/3");
    p.key("Enter", input);
    // The Customers card says "loyalty" in its description.
    expect(p.view()).toBe("");
    expect(p.ringed()).toEqual(["node:customers"]);
    p.key("Enter", input);
    expect(p.$("#bd-searchcount")!.textContent).toBe("2/3");
    expect(p.view()).toBe("customers");
    expect(p.win.location.hash).toBe("#/customers");
    expect(p.ringed()).toEqual(["node:customers/loyalty-members"]);
    p.key("Enter", input, { shiftKey: true });
    expect(p.$("#bd-searchcount")!.textContent).toBe("1/3");
    expect(p.view()).toBe("");
  });

  it("marks a field's row, and opens the grid on a field the node doesn't draw", async () => {
    const p = await openPage();
    const input = p.search("chef_id");
    p.key("Enter", input);
    expect(p.$("#bd-searchhit")!.textContent).toBe("Recipe · chef_id");
    expect(p.row("recipes", "chef_id").classList.contains("bd-x-match")).toBe(true);

    p.search("email");
    expect(p.row("recipes", "chef_id").classList.contains("bd-x-match")).toBe(false); // a new search starts clean
    p.key("Enter", input);
    expect(p.$("#bd-searchhit")!.textContent).toMatch(/· email \(not a row\)$/);
    await wait(120);
    expect(p.$("#bd-grid")!.hidden).toBe(false);
    expect(p.$("#bd-grid tr.bd-grid__hit")!.textContent).toContain("email");
    p.key("Escape");
    expect(p.$("#bd-grid")!.hidden).toBe(true);
  });

  it("says when nothing matches, and Escape clears it", async () => {
    const p = await openPage();
    const input = p.search("zzz-nothing");
    expect(p.$("#bd-searchcount")!.textContent).toBe("0 matches");
    p.key("Escape", input);
    expect(input.value).toBe("");
    expect(p.$("#bd-searchcount")!.hidden).toBe(true);
  });
});

describe("references", () => {
  it("a key's menu marks everything pointing at it and opens the panel; Escape lifts both", async () => {
    const p = await openPage();
    p.mouse(p.row("people", "id"), "click");
    expect(p.menu()).toEqual(["Pin for search", "View all fields", "Show references (2)", "Show impact", "Copy name"]);
    p.pick("Show references (2)");
    const panel = p.$("#bd-panel")!;
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain("Referenced by2");
    expect(panel.textContent).toContain("Customer.person_id → id");
    expect(panel.textContent).toContain("Recipe.chef_id → id");
    expect(p.$("#bd-toast")!.textContent).toBe("2 references from 2 tables marked");
    const marked = [...p.doc.querySelectorAll("rect.bd-row.bd-x-match")].map((r) => `${r.closest("[data-el]")!.getAttribute("data-el")}.${r.getAttribute("data-field")}`);
    expect(marked.sort()).toEqual(["node:customers.person_id", "node:people.id", "node:recipes.chef_id"]);
    // Every card the reference did not touch steps back.
    expect(p.group("node:bread").classList.contains("bd-x-unmarked")).toBe(true);
    expect(p.group("node:people").classList.contains("bd-x-unmarked")).toBe(false);

    p.key("Escape");
    expect(panel.hidden).toBe(true);
    expect(p.doc.querySelectorAll(".bd-x-match, .bd-x-unmarked")).toHaveLength(0);
  });

  it("follows a reference to the key it lands on, both halves marked", async () => {
    const p = await openPage();
    p.mouse(p.row("recipes", "chef_id"), "contextmenu");
    p.pick("Follow reference");
    expect(p.ringed()).toEqual(["node:people"]);
    expect(p.row("recipes", "chef_id").classList.contains("bd-x-match")).toBe(true);
    expect(p.row("people", "id").classList.contains("bd-x-match")).toBe(true);
  });
});

describe("paths between pins", () => {
  it("routes between two pinned tables, lit on the picture; hovering one singles it out", async () => {
    const p = await openPage();
    p.mouse(p.group("node:bread"), "contextmenu");
    p.pick("Pin table for search");
    p.mouse(p.group("node:people"), "contextmenu");
    p.pick("Pin table for search");
    expect(p.$("#bd-pinstrip")!.textContent).toContain("2 pinned");
    p.button("Show paths").click();

    const panel = p.$("#bd-panel")!;
    expect(panel.querySelector(".bd-panel__title")!.textContent).toBe("Paths between pins");
    const routes = [...panel.querySelectorAll("[data-route-row] .bd-route__title")].map((t) => t.textContent);
    expect(routes).toEqual(["Bread → Recipe → Person", "Bread → Product → Coupon → Customer → Person"]);
    expect(panel.textContent).toContain("Tables between4");
    // Both routes lit: an edge on each carries an overlay.
    const lit = (edge: string) => p.group(`edge:${edge}`).querySelectorAll("[data-route]").length > 0;
    expect(lit("recipes::chef_id::people")).toBe(true);
    expect(lit("products::bread_id::bread")).toBe(true);

    p.mouse(panel.querySelector("[data-route-row]")!, "mouseenter");
    expect(lit("recipes::chef_id::people")).toBe(true);
    expect(lit("products::bread_id::bread")).toBe(false);
    p.mouse(panel.querySelector("[data-route-row]")!, "mouseleave");
    expect(lit("products::bread_id::bread")).toBe(true);

    // Unpinning one closes the panel: two pins or nothing to search.
    p.button("×").click();
    expect(panel.hidden).toBe(true);
    expect(p.doc.querySelectorAll("[data-route]")).toHaveLength(0);
  });

  it("several selected tables: what lies between them, the rest dimmed", async () => {
    const p = await openPage();
    p.mouse(p.group("node:bread"), "click");
    p.mouse(p.group("node:cutlery"), "click", { shiftKey: true });
    p.mouse(p.group("node:coupons"), "click", { shiftKey: true });
    expect(p.ringed().sort()).toEqual(["node:bread", "node:coupons", "node:cutlery"]);
    p.mouse(p.group("node:coupons"), "contextmenu");
    p.pick("Show paths between 3 tables");
    expect(p.$("#bd-panel .bd-panel__title")!.textContent).toBe("Between 3 pins");
    expect(p.group("node:ingredients").classList.contains("bd-x-dim")).toBe(true);
    expect(p.group("node:recipes").classList.contains("bd-x-dim")).toBe(false);
    p.button("Reachable").click();
    expect(p.group("node:ingredients").classList.contains("bd-x-dim")).toBe(false);
  });
});

describe("the page's own navigation keeps working", () => {
  it("a click drills into a card with a level; a modifier-click selects it instead", async () => {
    const p = await openPage();
    p.mouse(p.group("node:customers"), "click", { shiftKey: true });
    expect(p.view()).toBe("");
    expect(p.ringed()).toEqual(["node:customers"]);
    p.mouse(p.group("node:customers"), "click");
    expect(p.view()).toBe("customers");
    expect(p.ringed()).toEqual([]); // a drill clears the selection
  });

  it("Escape settles the explorer's state before it drills out", async () => {
    const p = await openPage();
    const input = p.search("loyalty");
    p.key("Enter", input);
    p.key("Enter", input);
    expect(p.view()).toBe("customers");
    p.key("Escape"); // the selection goes first
    expect(p.view()).toBe("customers");
    expect(p.ringed()).toEqual([]);
    p.key("Escape"); // then the navigator's own
    expect(p.view()).toBe("");
  });
});

describe("the field grid", () => {
  it("lists every field — drawn or not — filters, and pins", async () => {
    const p = await openPage();
    p.mouse(p.group("node:people"), "contextmenu");
    p.pick("View all fields");
    const grid = p.$("#bd-grid")!;
    expect(grid.hidden).toBe(false);
    expect(grid.querySelectorAll("tbody tr")).toHaveLength(10);
    const filter = grid.querySelector<HTMLInputElement>(".bd-grid__filter")!;
    filter.value = "building";
    filter.dispatchEvent(new p.win.Event("input", { bubbles: true }));
    expect(grid.querySelectorAll("tbody tr")).toHaveLength(1);
    grid.querySelector<HTMLButtonElement>("tbody .bd-link")!.click();
    expect(p.$("#bd-pinstrip")!.textContent).toContain("Person · building_id");
    expect(p.row("people", "building_id").parentElement!.querySelector(".bd-x-bar")).not.toBeNull();
  });

  it("shows a profiled table's observed numbers — and only then", async () => {
    const doc = bakery();
    const people = doc.nodes.find((n) => n.id === "people")!;
    people.data = { ...people.data, model: { ...(people.data?.model as object), profile: { rowCount: 200, columns: { email: { nullRate: 0.125, distinct: 175 } } } } };
    const p = await openPage(doc);
    p.mouse(p.group("node:people"), "contextmenu");
    p.pick("View all fields");
    const heads = [...p.doc.querySelectorAll("#bd-grid thead th")].map((th) => th.textContent);
    expect(heads.slice(-2)).toEqual(["Nulls", "Distinct"]);
    const email = [...p.doc.querySelectorAll("#bd-grid tbody tr")].find((tr) => tr.textContent!.includes("email"))!;
    expect(email.textContent).toContain("12.5%");
    expect(email.textContent).toContain("175");
    p.key("Escape");
    p.mouse(p.group("node:recipes"), "contextmenu");
    p.pick("View all fields");
    expect([...p.doc.querySelectorAll("#bd-grid thead th")].map((th) => th.textContent)).not.toContain("Nulls");
  });
});

describe("key usage", () => {
  const using = (p: Awaited<ReturnType<typeof openPage>>) =>
    [...p.doc.querySelectorAll('#bd-panel section[aria-label="Tables using them"] .bd-item__label')].map((e) => e.textContent);
  const type = (p: Awaited<ReturnType<typeof openPage>>, text: string) => {
    const input = p.$<HTMLInputElement>(".bd-usage__search")!;
    input.value = text;
    input.dispatchEvent(new p.win.Event("input", { bubbles: true }));
    return input;
  };

  it("is offered only where there are tables, and opens in the left sidebar", async () => {
    const p = await openPage();
    const button = p.$<HTMLButtonElement>("#bd-usagebtn")!;
    expect(button.hidden).toBe(false);
    button.click();
    expect(p.$("#bd-panel")!.getAttribute("aria-label")).toBe("Key usage");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    // Nothing typed: the names two or more tables share, most shared first.
    const shared = [...p.doc.querySelectorAll(".bd-ubars--results .bd-ubar__name")].map((e) => e.textContent);
    expect(shared.slice(0, 2)).toEqual(["id", "name"]);

    const architecture = await openPage(validateTemplate({
      version: 1,
      nodes: [{ id: "a", label: "A", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76 }],
      edges: [],
    }));
    expect(architecture.$<HTMLButtonElement>("#bd-usagebtn")!.hidden).toBe(true);
  });

  it("scores picked names — any or all of them — lists the tables, and dims the rest", async () => {
    const p = await openPage();
    p.$<HTMLButtonElement>("#bd-usagebtn")!.click();
    p.key("Enter", type(p, "owner")); // Enter picks the top match
    expect(p.$(".bd-stat__pct")!.textContent).toBe("33%");
    p.key("Enter", type(p, "building"));
    expect(p.$(".bd-stat__pct")!.textContent).toBe("44%");
    expect(p.$(".bd-stat__detail")!.textContent).toBe("4 of 9 tables use them");
    expect(using(p)).toEqual(["Building", "Cutlery", "Person", "Product"]);
    expect(p.group("node:bread").classList.contains("bd-x-dim")).toBe(true);
    expect(p.group("node:cutlery").classList.contains("bd-x-dim")).toBe(false);

    p.button("All").click();
    expect(p.$(".bd-stat__pct")!.textContent).toBe("11%");
    expect(using(p)).toEqual(["Person"]);
    p.button("Clear").click();
    expect(p.$(".bd-stat")).toBeNull();
    expect(p.doc.querySelectorAll(".bd-x-dim")).toHaveLength(0);
  });

  it("can count the table a key points at; a listed table is a jump with its picked fields marked", async () => {
    const p = await openPage();
    p.$<HTMLButtonElement>("#bd-usagebtn")!.click();
    p.key("Enter", type(p, "building_id"));
    expect(using(p)).toEqual(["Cutlery", "Person"]);
    const targets = [...p.doc.querySelectorAll<HTMLInputElement>("#bd-panel input[type=checkbox]")].find((c) => c.parentElement!.textContent!.includes("point at"))!;
    targets.click();
    expect(using(p)).toEqual(["Building", "Cutlery", "Person"]);
    [...p.doc.querySelectorAll<HTMLButtonElement>("#bd-panel .bd-item")].find((b) => b.textContent!.startsWith("Person"))!.click();
    expect(p.ringed()).toEqual(["node:people"]);
    expect(p.row("people", "building_id").classList.contains("bd-x-match")).toBe(true);
  });

  it("shares the sidebar with the paths panel; Escape in its box clears, then closes", async () => {
    const p = await openPage();
    p.$<HTMLButtonElement>("#bd-usagebtn")!.click();
    const input = type(p, "zz");
    expect(p.$("#bd-panel")!.textContent).toContain("No field name contains “zz”.");
    p.key("Escape", input);
    expect(input.value).toBe("");
    p.key("Escape", input);
    expect(p.$("#bd-panel")!.hidden).toBe(true);

    p.$<HTMLButtonElement>("#bd-usagebtn")!.click();
    p.mouse(p.group("node:bread"), "contextmenu");
    p.pick("Pin table for search");
    p.mouse(p.group("node:people"), "contextmenu");
    p.pick("Pin table for search");
    p.button("Show paths").click();
    expect(p.$("#bd-panel")!.getAttribute("aria-label")).toBe("Paths between pinned fields");
    expect(p.$("#bd-usagebtn")!.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("milestone 1 in the page", () => {
  const type = (p: Awaited<ReturnType<typeof openPage>>, text: string) => {
    const input = p.$<HTMLInputElement>(".bd-usage__search")!;
    input.value = text;
    input.dispatchEvent(new p.win.Event("input", { bubbles: true }));
    return input;
  };

  it("focuses a table's neighbourhood from its menu and dims the rest", async () => {
    const p = await openPage();
    p.mouse(p.group("node:bread"), "contextmenu");
    p.pick("Focus neighbourhood");
    expect(p.$("#bd-panel")!.getAttribute("aria-label")).toBe("Neighbourhood");
    expect(p.$("#bd-panel [role=status]")!.textContent).toBe("3 tables within 1 join");
    expect(p.group("node:people").classList.contains("bd-x-dim")).toBe(true);
    expect(p.group("node:recipes").classList.contains("bd-x-dim")).toBe(false);
    p.button("2").click();
    expect(p.group("node:people").classList.contains("bd-x-dim")).toBe(false);
    p.key("Escape");
    expect(p.$("#bd-panel")!.hidden).toBe(true);
    expect(p.doc.querySelectorAll(".bd-x-dim")).toHaveLength(0);
  });

  it("shows a route as SQL, in the dialect the reader picks", async () => {
    const p = await openPage();
    p.mouse(p.group("node:bread"), "contextmenu");
    p.pick("Pin table for search");
    p.mouse(p.group("node:people"), "contextmenu");
    p.pick("Pin table for search");
    p.button("Show paths").click();
    p.$<HTMLButtonElement>('#bd-panel [aria-label="SQL for route 1"]')!.click();
    const code = () => p.$("#bd-panel .bd-sql__code")!.textContent!;
    expect(code()).toMatch(/^SELECT \*\nFROM \S+ AS t0\n {2}(LEFT|INNER) JOIN \S+ AS t1 ON t1\.id = t0\.recipe_id\n {2}(LEFT|INNER) JOIN \S+ AS t2 ON t2\.id = t1\.chef_id$/);
    const dialect = p.$<HTMLSelectElement>('#bd-panel select[aria-label="SQL dialect"]')!;
    dialect.value = "tsql";
    dialect.dispatchEvent(new p.win.Event("change", { bubbles: true }));
    expect(p.$<HTMLSelectElement>('#bd-panel select[aria-label="SQL dialect"]')!.value).toBe("tsql");
  });

  it("flags a name stored two ways in key usage, and narrows to one way", async () => {
    const t = (id: string, fields: Array<Record<string, unknown>>, x: number) => ({
      id, label: id, kind: "table", icon: "none", description: "", parentId: null, x, y: 0, w: 230, h: 120,
      fields: fields.map((f) => ({ id: String(f.id), name: String(f.id), ...f })),
    });
    const p = await openPage(validateTemplate({
      version: 1,
      nodes: [
        t("a", [{ id: "id", key: "pk", type: "uuid" }, { id: "tenant_id", type: "uuid" }], 0),
        t("b", [{ id: "id", key: "pk", type: "uuid" }, { id: "tenant_id", type: "varchar(36)" }], 300),
        t("c", [{ id: "id", key: "pk", type: "uuid" }], 600),
      ],
      edges: [],
    }));
    p.$<HTMLButtonElement>("#bd-usagebtn")!.click();
    const only = [...p.doc.querySelectorAll<HTMLInputElement>("#bd-panel input[type=checkbox]")].find((c) => c.parentElement!.textContent!.includes("Inconsistent"))!;
    only.click();
    const names = [...p.doc.querySelectorAll(".bd-ubars--results .bd-ubar__name")].map((e) => e.textContent);
    expect(names).toEqual(["tenant_id"]);
    expect(p.$(".bd-ubars--results .bd-ubar__badge--mixed")!.getAttribute("title")).toBe("2 types: uuid, varchar");
    p.key("Enter", type(p, "tenant"));
    const ways = [...p.doc.querySelectorAll<HTMLButtonElement>(".bd-usage__variants button")];
    expect(ways.map((b) => b.textContent)).toEqual(["uuid · 1 table", "varchar(36) · 1 table"]);
    ways[1]!.click();
    expect(p.$('#bd-panel section[aria-label="Tables using them"] .bd-pcap')!.textContent).toBe("Storing tenant_id as varchar1");
    expect(p.group("node:a").classList.contains("bd-x-dim")).toBe(true);
    expect(p.group("node:b").classList.contains("bd-x-dim")).toBe(false);
  });
});

describe("milestone 2 in the page", () => {
  it("carries the export's findings: a Checks button, grouped findings, each a jump marking its columns", async () => {
    const t = (id: string, fields: Array<Record<string, unknown>>, x: number) => ({
      id, label: id[0]!.toUpperCase() + id.slice(1), kind: "table", icon: "none", description: "", parentId: null, x, y: 0, w: 230, h: 120,
      fields: fields.map((f) => ({ id: String(f.id), name: String(f.id), ...f })),
    });
    const p = await openPage(validateTemplate({
      version: 1,
      nodes: [
        t("customers", [{ id: "id", key: "pk", type: "uuid" }], 0),
        t("orders", [{ id: "id", key: "pk", type: "uuid" }, { id: "customer_id", type: "uuid" }], 300),
        t("logs", [{ id: "message", type: "text" }], 600),
      ],
      edges: [],
    }));
    const button = p.$<HTMLButtonElement>("#bd-checksbtn")!;
    expect(button.hidden).toBe(false);
    expect(button.textContent).toMatch(/^Checks \(\d+\)$/);
    button.click();
    expect(p.$("#bd-panel")!.getAttribute("aria-label")).toBe("Checks");
    const undeclared = p.$('#bd-panel ul[aria-label="Undeclared reference"]')!;
    const item = undeclared.querySelector<HTMLButtonElement>("button")!;
    expect(item.textContent).toContain('"Orders.customer_id" looks like a reference to Customers');
    item.click();
    expect(p.ringed()).toEqual(["node:orders"]);
    expect(p.row("orders", "customer_id").classList.contains("bd-x-match")).toBe(true);
    // The severity filter narrows the list.
    p.button("Errors").click();
    expect(p.$('#bd-panel ul[aria-label="Undeclared reference"]')).toBeNull();
    button.click();
    expect(p.$("#bd-panel")!.hidden).toBe(true);
  });

  it("shows what depends on a table, dims the rest, and lights the chain to one under the pointer", async () => {
    const p = await openPage();
    p.mouse(p.group("node:people"), "contextmenu");
    p.pick("Show impact");
    const panel = p.$("#bd-panel")!;
    expect(panel.getAttribute("aria-label")).toBe("Impact");
    expect(panel.querySelector("[role=status]")!.textContent).toMatch(/^\d+ tables? depends? on Person/);
    expect(p.group("node:people").classList.contains("bd-x-dim")).toBe(false);
    const rows = [...panel.querySelectorAll<HTMLButtonElement>("section .bd-item")];
    expect(rows.length).toBeGreaterThan(0);
    p.mouse(rows[rows.length - 1]!, "mouseenter");
    expect(p.doc.querySelectorAll("[data-route]").length).toBeGreaterThan(0);
    p.mouse(rows[rows.length - 1]!, "mouseleave");
    expect(p.doc.querySelectorAll("[data-route]")).toHaveLength(0);
    p.button("Dependencies").click();
    expect(panel.querySelector("[role=status]")!.textContent).toMatch(/^Person depends on/);
  });
});

describe("milestone 3 in the page", () => {
  it("offers governance and the data dictionary from the menu", async () => {
    const p = await openPage();
    const gov = p.$<HTMLButtonElement>("#bd-govbtn")!;
    expect(gov.hidden).toBe(false);
    gov.click();
    const panel = p.$("#bd-panel")!;
    expect(panel.getAttribute("aria-label")).toBe("Governance");
    expect(panel.textContent).toContain("Tables described");
    // Columns whose names say personal data, untagged: the bakery's email columns.
    const suggested = panel.querySelector("[aria-label='Looks sensitive, not tagged']")!;
    expect(suggested.textContent).toContain("email");
    expect(suggested.textContent).toContain("pii:email?");
    // The dictionary is written in the page, from the model it carries.
    const saved: string[] = [];
    (p.win.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
      saved.push(b.type);
      return "blob:x";
    };
    (p.win.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    const links: string[] = [];
    p.win.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      links.push(this.download);
    };
    p.$<HTMLButtonElement>("#bd-dictbtn")!.click();
    expect(saved).toEqual(["text/csv"]);
    expect(links[0]).toMatch(/-dictionary\.csv$/);
  });

  it("shows the model's structure from the export's own answer: hubs, bridges, domains in colour", async () => {
    const p = await openPage();
    const btn = p.$<HTMLButtonElement>("#bd-structbtn")!;
    expect(btn.hidden).toBe(false);
    btn.click();
    const panel = p.$("#bd-panel")!;
    expect(panel.getAttribute("aria-label")).toBe("Model structure");
    expect(panel.querySelector("[role=status]")!.textContent).toMatch(/^\d+ tables · \d+ domains?/);
    const hubs = [...panel.querySelectorAll<HTMLButtonElement>("[aria-label=Hubs] button")];
    expect(hubs.length).toBeGreaterThan(0);
    // Pointing at a hub keeps it and its neighbours bright.
    p.mouse(hubs.at(-1)!, "mouseover");
    p.mouse(hubs.at(-1)!, "mouseenter");
    expect(p.doc.querySelectorAll(".bd-x-dim").length).toBeGreaterThan(0);
    p.mouse(hubs.at(-1)!, "mouseleave");
    p.mouse(hubs.at(-1)!, "mouseout");
    expect(p.doc.querySelectorAll(".bd-x-dim")).toHaveLength(0);

    p.button("Bridges").click();
    expect(p.$("#bd-panel")!.textContent).toContain("Bridge keys");
    p.button("Domains").click();
    const tint = p.$<HTMLInputElement>("#bd-panel input[type=checkbox]")!;
    tint.click();
    expect(p.doc.querySelectorAll(".bd-x-domain").length).toBeGreaterThan(0);
    const domains = [...p.doc.querySelectorAll<HTMLButtonElement>("#bd-panel [aria-label=Domains] button")];
    expect(domains.length).toBeGreaterThan(0);
    domains[0]!.click();
    expect(p.doc.querySelectorAll(".bd-x-dim").length).toBeGreaterThan(0);
    p.$<HTMLButtonElement>("[aria-label='Close model structure panel']")!.click();
    expect(p.doc.querySelectorAll(".bd-x-dim, .bd-x-domain")).toHaveLength(0);
  });
});

describe("model structure with a shared table", () => {
  it("lists the table every cluster points at as shared, apart from the domains", async () => {
    const t = (id: string, x: number, y: number, fields: string[]) => ({
      id, label: id, kind: "table", icon: "none", description: "", parentId: null, x, y, w: 200, h: 120,
      fields: [{ id: "id", name: "id", key: "pk" }, ...fields.map((f) => ({ id: f, name: f, key: "fk" }))],
    });
    const nodes = [t("users", 0, 0, [])];
    const edges: unknown[] = [];
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < 4; k++) {
        nodes.push(t(`c${c}t${k}`, 300 + k * 260, c * 260, ["user_id", "next_id"]));
        edges.push({ id: `c${c}t${k}-u`, source: `c${c}t${k}`, target: "users", startField: "user_id", endField: "id" });
        edges.push({ id: `c${c}t${k}-n`, source: `c${c}t${k}`, target: `c${c}t${(k + 1) % 4}`, startField: "next_id", endField: "id" });
      }
    }
    const p = await openPage(validateTemplate({ version: 1, nodes, edges } as never));
    p.$<HTMLButtonElement>("#bd-structbtn")!.click();
    expect(p.$("#bd-panel [role=status]")!.textContent).toMatch(/^13 tables · 3 domains · 1 shared/);
    p.button("Domains").click();
    const shared = p.$("#bd-panel [aria-label='Shared by every domain']")!;
    expect(shared.textContent).toContain("users");
    p.$<HTMLInputElement>("#bd-panel input[type=checkbox]")!.click();
    expect(p.group("node:c0t0").querySelector(".bd-x-domain")).not.toBeNull();
    expect(p.group("node:users").querySelector(".bd-x-domain")).toBeNull();
  });
});

describe("saved analyses in the page", () => {
  const withAnalyses = () =>
    validateTemplate({
      ...bakeryJson,
      analyses: [
        { id: "owners", title: "Owner key", kind: "usage", names: ["owner_id"], match: "any", includeTargets: false, snapshot: { headline: "1 of 9 tables use them (10%)", value: 0.1 } },
        { id: "people-impact", title: "People impact", kind: "impact", subject: { nodeId: "people" }, direction: "dependents", via: "keys" },
      ],
    } as never);

  it("lists the model's analyses with what they say now, and opens one", async () => {
    const p = await openPage(withAnalyses());
    const btn = p.$<HTMLButtonElement>("#bd-analysesbtn")!;
    expect(btn.hidden).toBe(false);
    expect(btn.textContent).toBe("Analyses (2)");
    btn.click();
    const panel = p.$("#bd-panel")!;
    expect(panel.getAttribute("aria-label")).toBe("Analyses");
    const items = [...panel.querySelectorAll<HTMLButtonElement>("[aria-label='Saved analyses'] button")];
    expect(items.map((b) => b.querySelector(".bd-item__label")!.textContent)).toEqual(["Owner key", "People impact"]);
    expect(items[0]!.textContent).toMatch(/Key usage · \d+ of \d+ tables use them \(\d+%\)was 10%, now \d+%/);
    items[0]!.click();
    expect(panel.getAttribute("aria-label")).toBe("Key usage");
    expect(panel.querySelector(".bd-stat__pct")!.textContent).toMatch(/%$/);
    expect(panel.textContent).toContain("owner_id");
    p.$<HTMLButtonElement>("#bd-analysesbtn")!.click();
    [...p.doc.querySelectorAll<HTMLButtonElement>("[aria-label='Saved analyses'] button")][1]!.click();
    expect(panel.getAttribute("aria-label")).toBe("Impact");
  });

  it("writes the analysis on show into a link, and a link opens it — level deep links still work", async () => {
    const p = await openPage(withAnalyses());
    p.$<HTMLButtonElement>("#bd-analysesbtn")!.click();
    p.doc.querySelector<HTMLButtonElement>("[aria-label='Saved analyses'] button")!.click();
    p.$<HTMLButtonElement>("#bd-linkbtn")!.click();
    const hash = p.win.location.hash;
    expect(hash).toMatch(/^#\/\?a=[A-Za-z0-9_-]+$/);

    const q = await openPage(bakery());
    expect(q.$("#bd-panel")!.hidden).toBe(true);
    q.win.location.hash = `#/customers${hash.slice(2)}`;
    await wait(20);
    expect(q.view()).toBe("customers");
    expect(q.$("#bd-panel")!.getAttribute("aria-label")).toBe("Key usage");
    expect(q.$("#bd-panel")!.textContent).toContain("owner_id");
  });
});

describe("column lineage in the page", () => {
  it("marks a traced column its table doesn't list", async () => {
    const p = await openPage(
      validateTemplate({
        ...bakeryJson,
        lineage: [{ id: "gone", from: { nodeId: "bread", fieldId: "main_ingredient_id" }, to: { nodeId: "products", fieldId: "legacy_sku" } }],
      } as never),
    );
    p.mouse(p.row("bread", "main_ingredient_id"), "click");
    p.pick("Trace lineage");
    const item = [...p.doc.querySelectorAll<HTMLButtonElement>("#bd-panel .bd-item")].find((b) => b.textContent!.startsWith("Product.legacy_sku"))!;
    expect(item.querySelector(".bd-badge")!.textContent).toBe("not in the model");
  });

  const withLineage = () =>
    validateTemplate({
      ...bakeryJson,
      lineage: [
        { id: "l1", from: { nodeId: "ingredients", fieldId: "name" }, to: { nodeId: "bread", fieldId: "main_ingredient_id" }, transform: "lookup" },
        { id: "l2", from: { nodeId: "bread", fieldId: "main_ingredient_id" }, to: { nodeId: "products", fieldId: "sku" }, job: "etl" },
      ],
    } as never);

  it("traces a column from its menu: the panel, the rows marked, lines drawn row to row", async () => {
    const p = await openPage(withLineage());
    // A column no link names is not offered the trace.
    p.mouse(p.row("people", "id"), "click");
    expect(p.menu()).not.toContain("Trace lineage");
    p.key("Escape");
    p.mouse(p.row("bread", "main_ingredient_id"), "click");
    p.pick("Trace lineage");
    const panel = p.$("#bd-panel")!;
    expect(panel.getAttribute("aria-label")).toBe("Lineage");
    expect(panel.querySelector("[role=status]")!.textContent).toBe("1 upstream column · 1 downstream");
    expect(panel.textContent).toContain("Ingredient.namelookup");
    expect(p.row("products", "sku").classList.contains("bd-x-match")).toBe(true);
    const lines = [...p.doc.querySelectorAll(".bd-x-lineage")];
    expect(lines.map((l) => l.getAttribute("data-lineage")).sort()).toEqual(["l1", "l2"]);
    expect(lines[0]!.getAttribute("d")).toMatch(/^M [\d.-]+ [\d.-]+ C /);
    // Pointing at a column brightens the chain to it.
    const item = [...panel.querySelectorAll<HTMLButtonElement>(".bd-item")].find((b) => b.textContent!.startsWith("Product.sku"))!;
    p.mouse(item, "mouseenter");
    p.mouse(item, "mouseover");
    expect(p.doc.querySelector(".bd-x-lineage--on")!.getAttribute("data-lineage")).toBe("l2");
    p.$<HTMLButtonElement>("[aria-label='Close lineage panel']")!.click();
    expect(p.doc.querySelectorAll(".bd-x-lineage")).toHaveLength(0);
    expect(p.row("products", "sku").classList.contains("bd-x-match")).toBe(false);
  });
});

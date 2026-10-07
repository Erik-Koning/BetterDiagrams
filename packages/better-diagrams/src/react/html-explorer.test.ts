/**
 * The interactive HTML export's explorer, export side: the data the page
 * carries, the bundled runtime being current, and the page it lands in.
 * (What the page DOES with it is html-explorer-page.test.ts.)
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateTemplate, type DiagramTemplate } from "../contract/schema";
import { fieldRecords, keyReferences, searchFields } from "../contract/fields";
import { computeRouteView } from "./field-routes";
import { dataDictionary, governanceReport } from "../contract/dictionary";
import { readAnalysis } from "./saved-analyses";
import type { SavedAnalysisBody } from "../contract/analyses";
import { impactOf } from "../contract/impact";
import { routeSql } from "../contract/route-sql";
import { fieldUsage } from "../contract/key-usage";
import { drawToSvg, emitTemplate } from "./draw";
import { BUILTIN_EXPORTERS, htmlExplorerData } from "./exporters";
import { buildTimelineHtml } from "./html-export";
import { explorerDocument } from "./html-explorer";
import { EXPLORER_RUNTIME, EXPLORER_RUNTIME_HASH, EXPLORER_RUNTIME_INPUTS } from "./html-explorer-runtime.generated";
import { createRegistry } from "./create-registry";
import bakeryJson from "../../../../templates/examples/bakery-data-model.json";
import { LIGHT_THEME, paletteFromTheme } from "./theme";

const registry = createRegistry();
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

/** The bakery data model: tables with rows and data-bag fields, keys, and one drill level (Customers). */
function bakery(): DiagramTemplate {
  return validateTemplate(bakeryJson);
}

describe("the bundled runtime", () => {
  it("is built from the current sources — run `npm run build:explorer` if this fails", () => {
    // The same hash scripts/build-explorer-runtime.mjs writes.
    const hash = createHash("sha256");
    for (const rel of EXPLORER_RUNTIME_INPUTS) {
      hash.update(rel);
      hash.update("\0");
      hash.update(readFileSync(`${packageRoot}${rel}`, "utf8").replace(/\r\n/g, "\n"));
      hash.update("\0");
    }
    expect(hash.digest("hex")).toBe(EXPLORER_RUNTIME_HASH);
  });

  it("is the editor's own analysis, not a copy of it", () => {
    for (const module of ["src/contract/fields.ts", "src/contract/graph.ts", "src/contract/key-usage.ts", "src/react/field-routes.ts", "src/react/path-view.ts"]) {
      expect(EXPLORER_RUNTIME_INPUTS).toContain(module);
    }
  });

  it("stays within its size budget — precompute static answers rather than bundle their code", () => {
    expect(EXPLORER_RUNTIME.length).toBeLessThan(120_000);
  });

  it("can be inlined in a <script> and leaves one global behind", () => {
    expect(EXPLORER_RUNTIME).not.toMatch(/<\/script/i);
    expect(EXPLORER_RUNTIME).not.toContain("<!--");
    expect(EXPLORER_RUNTIME.startsWith("var BDExplorer")).toBe(true);
    // The system prompt is dead weight in a page; the pure mark keeps it out.
    expect(EXPLORER_RUNTIME).not.toContain("PATHS:");
  });
});

describe("explorerDocument — the slice the page carries", () => {
  it("answers every question the analysis asks the same as the whole document", () => {
    const doc = bakery();
    const slice = explorerDocument(doc);
    for (const node of doc.nodes) {
      const own = slice.nodes.find((n) => n.id === node.id)!;
      expect(fieldRecords(own, slice), node.id).toEqual(fieldRecords(node, doc));
      expect(keyReferences(slice, { nodeId: node.id }), node.id).toEqual(keyReferences(doc, { nodeId: node.id }));
    }
    for (const q of ["id", "building", "email", "string"]) expect(searchFields(slice, q)).toEqual(searchFields(doc, q));
    const query = { pins: [{ nodeId: "bread" }, { nodeId: "people" }], undirected: true, mode: "between" as const };
    const view = computeRouteView(slice, query, ["sky", "rose"]);
    expect(view).toEqual(computeRouteView(doc, query, ["sky", "rose"]));
    // Everything else the page runs on the slice: key usage, impact, SQL, the dictionary.
    expect(fieldUsage(slice)).toEqual(fieldUsage(doc));
    for (const node of doc.nodes) {
      expect(impactOf(slice, { nodeId: node.id }), node.id).toEqual(impactOf(doc, { nodeId: node.id }));
    }
    for (const route of view.routes) expect(routeSql(slice, route.walk)).toEqual(routeSql(doc, route.walk));
    expect(dataDictionary(slice)).toEqual(dataDictionary(doc));
    expect(governanceReport(slice)).toEqual(governanceReport(doc));
  });

  it("carries the lineage and re-runs saved analyses the same as the whole document", () => {
    const doc = validateTemplate({
      ...bakery(),
      lineage: [
        { id: "l1", from: { nodeId: "people", fieldId: "email" }, to: { nodeId: "customers", fieldId: "email" } },
        { id: "l2", from: { nodeId: "customers", fieldId: "email" }, to: { nodeId: "coupons", fieldId: "code" } },
      ],
    });
    const slice = explorerDocument(doc);
    expect(slice.lineage).toEqual(doc.lineage);
    expect(governanceReport(slice)).toEqual(governanceReport(doc));
    const label = (id: string) => id;
    const saved: SavedAnalysisBody[] = [
      { kind: "usage", names: ["owner_id", "email"], match: "any", includeTargets: true },
      { kind: "coverage", keys: [{ nodeId: "people", fieldId: "id" }], scope: { kind: "all" } },
      { kind: "impact", subject: { nodeId: "people" }, direction: "dependents", via: "keys" },
      { kind: "neighbourhood", from: ["bread"], depth: 2, direction: "both", keysOnly: false },
      { kind: "paths", pins: [{ nodeId: "bread" }, { nodeId: "people" }], undirected: true, mode: "between" },
    ];
    for (const a of saved) expect(readAnalysis(slice, a, label), a.kind).toEqual(readAnalysis(doc, a, label));
  });

  it("carries a table's profile, so the page's grid and dictionary see the same numbers", () => {
    const doc = bakery();
    const people = doc.nodes.find((n) => n.id === "people")!;
    people.data = { ...people.data, model: { ...(people.data?.model as object), profile: { rowCount: 200, columns: { email: { nullRate: 0.125 } } } } };
    const slice = explorerDocument(doc);
    const own = slice.nodes.find((n) => n.id === "people")!;
    expect(fieldRecords(own, slice)).toEqual(fieldRecords(people, doc));
    expect(fieldRecords(own, slice).find((r) => r.name === "email")!.profile).toEqual({ nullRate: 0.125 });
    expect(dataDictionary(slice)).toEqual(dataDictionary(doc));
  });

  it("leaves a host's own data out of a file that may be mailed around", () => {
    const doc = validateTemplate({
      version: 1,
      nodes: [
        {
          id: "t", label: "T", kind: "table", icon: "none", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76,
          data: { secret: "token", model: { shape: "entity", name: "t", owner: "ops", fields: [{ name: "id", primaryKey: true }] } },
        },
      ],
      edges: [],
    });
    const node = explorerDocument(doc).nodes[0]!;
    expect(node.data).toEqual({ model: { shape: "entity", name: "t", fields: [{ name: "id", primaryKey: true }] } });
    expect(JSON.stringify(node)).not.toContain("token");
  });
});

describe("htmlExplorerData", () => {
  it("maps every level the page renders, by what its SVG draws", () => {
    const doc = bakery();
    const data = htmlExplorerData(doc, registry);
    expect(Object.keys(data.levels).sort()).toEqual(["", "customers"]);
    // The root draws Customers as a card; its child lives on the next level.
    expect(data.levels[""]!.nodes).toContain("customers");
    expect(data.levels[""]!.nodes).not.toContain("customers/loyalty-members");
    expect(data.levels.customers!.nodes).toContain("customers/loyalty-members");
    expect(data.homes["customers/loyalty-members"]).toEqual(["customers"]);
    expect(data.homes.bread).toBeUndefined();
    // Every drawn line names two drawn boxes.
    for (const level of Object.values(data.levels)) {
      for (const [, s, t] of level.edges) {
        expect(level.nodes).toContain(s);
        expect(level.nodes).toContain(t);
      }
    }
  });

  it("paints routes in the export palette's hues, and the theme's highlighter", () => {
    const doc = bakery();
    expect(htmlExplorerData(doc, registry).routeColor).toBe("#ff2d95");
    const light = htmlExplorerData(doc, registry, paletteFromTheme(LIGHT_THEME));
    expect(light.routeColor).toBe(LIGHT_THEME.routeColor);
    expect(light.edgeHex.sky).toBe(LIGHT_THEME.edgeColors!.sky);
    expect(htmlExplorerData(doc, registry, { routeColor: "#123456" }).routeColor).toBe("#123456");
    expect(light.routeColors.length).toBeGreaterThan(0);
  });
});

describe("field rows as targets", () => {
  it("are drawn only when asked, so every other export is unchanged", () => {
    const doc = bakery();
    const plain = drawToSvg(emitTemplate(doc, registry).cmds);
    expect(plain).not.toContain("bd-row");
    const hits = drawToSvg(emitTemplate(doc, registry, {}, { fieldHits: true }).cmds);
    expect(hits).toMatch(/<rect class="bd-row" data-field="building_id" [^>]*fill="transparent"\/>/);
    // One per drawn row — the data-bag fields a node doesn't draw have none.
    const drawnRows = doc.nodes.filter((n) => !n.parentId).reduce((sum, n) => sum + (n.fields?.length ?? 0), 0);
    expect(hits.match(/class="bd-row"/g)).toHaveLength(drawnRows);
  });
});

describe("the exported page", () => {
  it("carries the search box, the panels' hooks, the data and the runtime", async () => {
    const result = await BUILTIN_EXPORTERS.html.run({ template: bakery(), registry, filename: "bakery" });
    const text = await result!.blob.text();
    for (const hook of ['id="bd-search"', 'id="bd-pinstrip"', 'id="bd-panel"', 'id="bd-context"', 'id="bd-grid"', 'id="bd-explorer-data"']) {
      expect(text).toContain(hook);
    }
    expect(text).toContain("BDExplorer.mountExplorer(document");
    expect(text).toContain('class="bd-row" data-field=');
    expect(text).not.toMatch(/src="http|href="http|@import/);
  });

  it("keeps a hostile label from closing the data block", async () => {
    const doc = validateTemplate({
      version: 1,
      nodes: [{ id: "x", label: "</script><script>alert(1)</script>", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76 }],
      edges: [],
    });
    const text = await (await BUILTIN_EXPORTERS.html.run({ template: doc, registry, filename: "x" }))!.blob.text();
    const data = text.slice(text.indexOf('id="bd-explorer-data">'), text.indexOf("</script>", text.indexOf('id="bd-explorer-data">')));
    expect(data).toContain("\\u003c/script>\\u003cscript>alert(1)");
  });

  it("is left out of a page built without it", () => {
    const page = buildTimelineHtml({ svg: "<svg></svg>", title: "T", stops: [] });
    expect(page).not.toContain("bd-search");
    expect(page).not.toContain("bd-explorer-data");
    expect(page).not.toContain("BDExplorer");
  });
});

/**
 * lineage.test.ts — column lineage: validation, the trace both ways, the
 * chain to one column, sensitive values flowing into untagged columns, the
 * OpenLineage importer, and the document keeping it apart from its edges.
 */
import { describe, expect, it } from "vitest";
import {
  importOpenLineage,
  lineageChain,
  lineageHeadline,
  mergeLineage,
  parseOpenLineageEvents,
  sensitiveLineage,
  traceLineage,
  validateLineage,
  type LineageLink,
} from "./lineage";
import { validateTemplate } from "./schema";
import { diffTemplates } from "./diff";

const table = (id: string, fields: Array<[string, string[]?]>, name?: string) => ({
  id,
  label: id[0]!.toUpperCase() + id.slice(1),
  kind: "table",
  icon: "none",
  description: "",
  parentId: null,
  fields: fields.map(([f, tags]) => ({ id: f, name: f, ...(tags ? { tags } : {}) })),
  ...(name ? { data: { model: { name } } } : {}),
});
const link = (id: string, from: string, to: string, transform?: string): LineageLink => {
  const [fn, ff] = from.split(".");
  const [tn, tf] = to.split(".");
  return { id, from: { nodeId: fn!, fieldId: ff! }, to: { nodeId: tn!, fieldId: tf! }, ...(transform ? { transform } : {}) };
};

/**
 *   orders.amount ─┐
 *   fx.rate ───────┴→ revenue.usd → report.total
 *   customers.email (pii) → marketing.contact → export.address (pii)
 */
const DOC = {
  nodes: [
    table("orders", [["amount"], ["id"]], "sales_orders"),
    table("fx", [["rate"]]),
    table("revenue", [["usd"]]),
    table("report", [["total"]]),
    table("customers", [["email", ["pii"]]]),
    table("marketing", [["contact"]]),
    table("export", [["address", ["pii"]]]),
  ],
  edges: [],
  lineage: [
    link("a", "orders.amount", "revenue.usd", "amount * rate"),
    link("b", "fx.rate", "revenue.usd"),
    link("c", "revenue.usd", "report.total", "SUM"),
    link("d", "customers.email", "marketing.contact"),
    link("e", "marketing.contact", "export.address"),
  ],
};

describe("validateLineage", () => {
  it("keeps links with two columns, pruning tables that left, self-links and repeats", () => {
    const out = validateLineage(
      [
        link("ok", "orders.amount", "revenue.usd", " amount * rate "),
        link("gone", "orders.amount", "nowhere.x"),
        link("self", "orders.amount", "orders.amount"),
        link("ok", "fx.rate", "revenue.usd"),
        { id: "table-only", from: { nodeId: "orders" }, to: { nodeId: "revenue", fieldId: "usd" } },
        "junk",
      ],
      { nodeIds: new Set(["orders", "revenue", "fx"]) },
    );
    expect(out).toEqual([link("ok", "orders.amount", "revenue.usd", "amount * rate")]);
  });

  it("is a separate collection in the document: validated, pruned with its tables, not an edge, not a change to Compare", () => {
    const doc = validateTemplate({ version: 1, ...DOC } as never);
    expect(doc.lineage).toHaveLength(5);
    expect(doc.edges).toEqual([]);
    const without = validateTemplate({ ...doc, nodes: doc.nodes.filter((n) => n.id !== "fx") });
    expect(without.lineage!.map((l) => l.id)).toEqual(["a", "c", "d", "e"]);
    expect(diffTemplates(without, { ...without, lineage: [] }).summary).toMatchObject({ added: 0, removed: 0, changed: 0 });
  });
});

describe("traceLineage", () => {
  it("walks upstream to what a column is made from, and downstream to what it feeds", () => {
    const t = traceLineage(DOC.lineage, { nodeId: "revenue", fieldId: "usd" });
    expect(t.columns.map((c) => [`${c.ref.nodeId}.${c.ref.fieldId}`, c.direction, c.depth])).toEqual([
      ["orders.amount", "upstream", 1],
      ["fx.rate", "upstream", 1],
      ["report.total", "downstream", 1],
    ]);
    expect(t.links.sort()).toEqual(["a", "b", "c"]);
    expect(lineageHeadline(t)).toBe("2 upstream columns · 1 downstream");
  });

  it("goes one way, several links deep, and stops where asked", () => {
    const down = traceLineage(DOC.lineage, { nodeId: "orders", fieldId: "amount" }, { direction: "downstream" });
    expect(down.columns.map((c) => c.depth)).toEqual([1, 2]);
    const capped = traceLineage(DOC.lineage, { nodeId: "orders", fieldId: "amount" }, { direction: "downstream", maxDepth: 1 });
    expect(capped.columns).toHaveLength(1);
    expect(capped.truncated).toBe(true);
  });

  it("rebuilds the chain to any traced column", () => {
    const t = traceLineage(DOC.lineage, { nodeId: "report", fieldId: "total" });
    // Walking order: from the subject outward.
    expect(lineageChain(DOC.lineage, t, { nodeId: "fx", fieldId: "rate" })!.map((l) => l.id)).toEqual(["c", "b"]);
    expect(lineageChain(DOC.lineage, t, { nodeId: "customers", fieldId: "email" })).toBeNull();
  });

  it("survives a cycle", () => {
    const cyc = [link("x", "a.f", "b.g"), link("y", "b.g", "a.f")];
    expect(traceLineage(cyc, { nodeId: "a", fieldId: "f" }).columns).toHaveLength(2);
  });
});

describe("sensitiveLineage", () => {
  it("lists the columns sensitive values flow into that carry no sensitive tag", () => {
    expect(sensitiveLineage(DOC)).toEqual([{ ref: { nodeId: "marketing", fieldId: "contact" }, source: { nodeId: "customers", fieldId: "email" }, hops: 1 }]);
    expect(sensitiveLineage({ ...DOC, lineage: [] })).toEqual([]);
  });
});

describe("OpenLineage", () => {
  const event = (outName: string, fields: Record<string, unknown>, job = "etl.revenue") => ({
    eventType: "COMPLETE",
    job: { namespace: "airflow", name: job },
    outputs: [{ namespace: "postgres://prod", name: outName, facets: { columnLineage: { fields } } }],
  });

  it("reads the columnLineage facet into links, matching datasets to tables and columns to fields", () => {
    const events = [
      event("analytics.revenue", {
        USD: {
          inputFields: [
            { namespace: "postgres://prod", name: "public.sales_orders", field: "AMOUNT", transformations: [{ type: "DIRECT", subtype: "TRANSFORMATION", description: "amount * rate" }] },
            { namespace: "postgres://prod", name: "public.fx", field: "rate", transformations: [{ type: "DIRECT", subtype: "IDENTITY" }] },
            { namespace: "postgres://prod", name: "public.unknown_table", field: "x" },
          ],
        },
      }),
      // The same derivation seen again is one link; the older facet form.
      event("analytics.revenue", { usd: { inputFields: [{ namespace: "postgres://prod", name: "fx", field: "rate" }] } }),
      event("reporting.report", { total: { inputFields: [{ namespace: "p", name: "revenue", field: "usd" }], transformationDescription: "SUM(usd)" } }, "dbt.report"),
      event("reporting.report", { total: { inputFields: [{ namespace: "p", name: "revenue", field: "cents" }] } }),
    ];
    const r = importOpenLineage(DOC, JSON.stringify(events));
    expect(r.events).toBe(4);
    expect(r.lineage).toEqual([
      { id: "orders.amount->revenue.usd", from: { nodeId: "orders", fieldId: "amount" }, to: { nodeId: "revenue", fieldId: "usd" }, transform: "amount * rate", job: "etl.revenue" },
      { id: "fx.rate->revenue.usd", from: { nodeId: "fx", fieldId: "rate" }, to: { nodeId: "revenue", fieldId: "usd" }, transform: "DIRECT IDENTITY", job: "etl.revenue" },
      { id: "revenue.usd->report.total", from: { nodeId: "revenue", fieldId: "usd" }, to: { nodeId: "report", fieldId: "total" }, transform: "SUM(usd)", job: "dbt.report" },
      { id: "revenue.cents->report.total", from: { nodeId: "revenue", fieldId: "cents" }, to: { nodeId: "report", fieldId: "total" }, job: "etl.revenue" },
    ]);
    expect(r.unmatched).toEqual([{ namespace: "postgres://prod", name: "public.unknown_table", links: 1 }]);
    expect(r.unknownColumns).toEqual([{ nodeId: "revenue", fieldId: "cents" }]);
  });

  it("takes an array, one event, an { events } wrapper, or newline-delimited JSON — and a custom dataset resolver", () => {
    const one = event("revenue", { usd: { inputFields: [{ namespace: "n", name: "fx", field: "rate" }] } });
    expect(parseOpenLineageEvents(JSON.stringify(one))).toHaveLength(1);
    expect(parseOpenLineageEvents({ events: [one, one] })).toHaveLength(2);
    expect(parseOpenLineageEvents(`${JSON.stringify(one)}\n${JSON.stringify(one)}\n`)).toHaveLength(2);
    const r = importOpenLineage(DOC, [one], { resolveDataset: (d) => (d.name === "fx" ? "orders" : "revenue") });
    expect(r.lineage[0]).toMatchObject({ from: { nodeId: "orders", fieldId: "rate" }, to: { nodeId: "revenue", fieldId: "usd" } });
  });

  it("merges into a document's list, an imported id replacing the one there", () => {
    const merged = mergeLineage([link("a", "x.a", "y.b", "old"), link("k", "x.k", "y.k")], [link("a", "x.a", "y.b", "new")]);
    expect(merged.map((l) => [l.id, l.transform])).toEqual([["k", undefined], ["a", "new"]]);
  });
});

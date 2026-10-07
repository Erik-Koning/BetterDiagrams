/**
 * schema-diff.test.ts — column-level changes between two versions of a model,
 * with their impact, inferred renames, and the Markdown report.
 */
import { describe, expect, it } from "vitest";
import { schemaDiff, schemaDiffMarkdown } from "./schema-diff";

const table = (id: string, fields: Array<Record<string, unknown>>, name?: string) => ({
  id, label: id[0]!.toUpperCase() + id.slice(1),
  fields: fields.map((f) => ({ id: String(f.id), name: String(f.name ?? f.id), ...f })),
  ...(name ? { data: { model: { shape: "entity", name } } } : {}),
});
const fk = (id: string, source: string, target: string, field: string) => ({ id, source, target, startField: field, endField: "id" });

const BASE = {
  nodes: [
    table("customers", [{ id: "id", key: "pk", type: "uuid" }, { id: "email", type: "varchar(255)" }, { id: "nickname", type: "text" }]),
    table("orders", [
      { id: "id", key: "pk", type: "uuid" },
      { id: "customer_id", key: "fk", type: "uuid", required: true },
      { id: "total", type: "numeric(10,2)" },
      { id: "note", type: "text" },
      { id: "status", type: "varchar(20)" },
    ]),
    table("legacy", [{ id: "id", key: "pk", type: "uuid" }]),
    table("line_items", [{ id: "id", key: "pk" }, { id: "order_id" }, { id: "sku" }, { id: "qty" }, { id: "price" }]),
  ],
  edges: [fk("o-c", "orders", "customers", "customer_id")],
};
const NEXT = {
  nodes: [
    table("customers", [{ id: "id", key: "pk", type: "uuid" }, { id: "email", type: "varchar(100)" }, { id: "nick_name", type: "text" }]),
    table("orders", [
      { id: "id", key: "pk", type: "uuid" },
      { id: "customer_id", key: "fk", type: "uuid" },
      { id: "total", type: "integer" },
      { id: "status", type: "varchar(40)", required: true },
      { id: "channel", type: "text", required: true },
    ]),
    table("order_lines", [{ id: "id", key: "pk" }, { id: "order_id" }, { id: "sku" }, { id: "qty" }, { id: "price" }]),
    table("invoices", [{ id: "id", key: "pk", type: "uuid" }]),
  ],
  edges: [],
};

describe("schemaDiff", () => {
  const diff = schemaDiff(BASE, NEXT);
  const change = (nodeId: string, fieldId: string) => diff.columns.find((c) => c.nodeId === nodeId && c.fieldId === fieldId);

  it("matches tables by id, infers a renamed table from its columns, and lists the rest", () => {
    expect(diff.tables.renamed).toEqual([{ from: "line_items", to: "order_lines", confidence: 1 }]);
    expect(diff.tables.removed).toEqual(["legacy"]);
    expect(diff.tables.added).toEqual(["invoices"]);
  });

  it("classifies each column change as breaking, caution or safe", () => {
    expect(change("customers", "email")).toMatchObject({ kind: "changed", impact: "breaking", reason: "shorter: varchar(255) → varchar(100)" });
    expect(change("orders", "total")).toMatchObject({ impact: "breaking", reason: "type numeric(10,2) → integer" });
    expect(change("orders", "status")).toMatchObject({ impact: "caution", changes: ["type", "nullable"], reason: "type varchar(20) → varchar(40); now required" });
    // Required before, not now — and its reference is gone too, which breaks joins.
    expect(change("orders", "customer_id")).toMatchObject({ changes: ["nullable", "references"], impact: "breaking", reason: "now nullable; references customers → nothing" });
    expect(change("orders", "note")).toMatchObject({ kind: "removed", impact: "breaking" });
    expect(change("orders", "channel")).toMatchObject({ kind: "added", impact: "caution" });
    expect(change("legacy", "id")).toMatchObject({ kind: "removed", reason: "table removed" });
    expect(change("invoices", "id")).toMatchObject({ kind: "added", impact: "safe", reason: "table added" });
  });

  it("infers a renamed column — alike in type and key, close in name — with a confidence", () => {
    expect(change("customers", "nick_name")).toMatchObject({ kind: "renamed", impact: "caution", reason: "possibly renamed from nickname", confidence: 1 });
    expect(change("customers", "nickname")).toBeUndefined();
  });

  it("lists references added and removed, and counts by impact", () => {
    expect(diff.references.removed.map((l) => `${l.from.nodeId}.${l.from.fieldId}→${l.to.nodeId}`)).toEqual(["orders.customer_id→customers"]);
    expect(diff.references.added).toEqual([]);
    expect(diff.summary.breaking).toBeGreaterThan(0);
    expect(diff.summary.breaking + diff.summary.caution + diff.summary.safe).toBe(diff.columns.length);
  });

  it("matches a table by its entity name when its id changed", () => {
    const a = { nodes: [table("t1", [{ id: "id", key: "pk" }, { id: "x", type: "int" }], "Thing")], edges: [] };
    const b = { nodes: [table("t2", [{ id: "id", key: "pk" }, { id: "x", type: "int4" }], "thing")], edges: [] };
    const d = schemaDiff(a, b);
    expect(d.tables).toEqual({ added: [], removed: [], renamed: [] });
    // int and int4 are one type.
    expect(d.columns).toEqual([]);
  });

  it("writes a migration report, breaking changes first", () => {
    const md = schemaDiffMarkdown(diff, (id) => id);
    expect(md).toMatch(/^# Schema changes\n\n\*\*\d+ breaking · \d+ caution · \d+ safe\*\*/);
    expect(md).toContain("Table possibly renamed: line_items → order_lines (100%)");
    const orders = md.slice(md.indexOf("## orders"));
    expect(orders.indexOf("| breaking |")).toBeLessThan(orders.indexOf("| caution |"));
    expect(md).toContain("- removed: orders.customer_id → customers");
  });
});

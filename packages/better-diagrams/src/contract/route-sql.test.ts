/**
 * route-sql.test.ts — a route between tables as the SQL that walks it:
 * joins, aliases, quoting per dialect, join types, and the multiplicity
 * warnings.
 */
import { describe, expect, it } from "vitest";
import { routeSql, sqlTableName } from "./route-sql";

const table = (id: string, rows: Array<Record<string, unknown>>, name?: string) => ({
  id,
  label: id[0]!.toUpperCase() + id.slice(1),
  fields: rows.map((r) => ({ id: String(r.id), name: String(r.name ?? r.id), ...r })),
  ...(name ? { data: { model: { shape: "entity", name } } } : {}),
});
const fk = (id: string, source: string, target: string, field: string, model: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  id, source, target, startField: field, endField: "id", data: { model: { field, targetField: "id", ...model } }, ...over,
});

/** people ← recipes.chef_id (required) ← bread.recipe_id ← products.bread_id (unique) ; order ← order_lines. */
const DOC = {
  nodes: [
    table("people", [{ id: "id", key: "pk" }]),
    table("recipes", [{ id: "id", key: "pk" }, { id: "chef_id", key: "fk", required: true }]),
    table("bread", [{ id: "id", key: "pk" }, { id: "recipe_id", key: "fk" }]),
    table("products", [{ id: "id", key: "pk" }, { id: "bread_id", key: "fk", unique: true }]),
    table("order", [{ id: "id", key: "pk" }], "Order"),
    table("order_lines", [{ id: "id", key: "pk" }, { id: "order_id", key: "fk" }], "Order Line"),
    table("tasks", [{ id: "id", key: "pk" }, { id: "what_id", key: "fk" }]),
  ],
  edges: [
    fk("r-p", "recipes", "people", "chef_id", { required: true }),
    fk("b-r", "bread", "recipes", "recipe_id"),
    fk("p-b", "products", "bread", "bread_id"),
    fk("l-o", "order_lines", "order", "order_id"),
    fk("t-p", "tasks", "people", "what_id", { referenceTo: ["people", "order"] }),
    { id: "arch", source: "people", target: "order" },
  ],
};

describe("routeSql", () => {
  it("joins each hop on its key, INNER where a required key walks to what it references", () => {
    const out = routeSql(DOC, { nodes: ["recipes", "people"], edges: ["r-p"] });
    expect(out.sql).toBe("SELECT *\nFROM recipes AS t0\n  INNER JOIN people AS t1 ON t1.id = t0.chef_id");
    expect(out.warnings).toEqual([]);
    expect(out.hops).toEqual([{ edgeId: "r-p", join: "INNER", multiplicity: "one" }]);
  });

  it("flips the ON clause walking against the key, and warns when rows multiply", () => {
    const out = routeSql(DOC, { nodes: ["people", "recipes", "bread"], edges: ["r-p", "b-r"] });
    expect(out.sql).toBe(
      "SELECT *\nFROM people AS t0\n  LEFT JOIN recipes AS t1 ON t1.chef_id = t0.id\n  LEFT JOIN bread AS t2 ON t2.recipe_id = t1.id",
    );
    expect(out.hops.map((h) => h.multiplicity)).toEqual(["many", "many"]);
    expect(out.warnings.map((w) => [w.hop, w.kind])).toEqual([[0, "double-fan-out"]]);
  });

  it("a unique key walked back meets one row; a single to-many hop is a plain fan-out", () => {
    expect(routeSql(DOC, { nodes: ["bread", "products"], edges: ["p-b"] }).hops[0]!.multiplicity).toBe("one");
    const one = routeSql(DOC, { nodes: ["recipes", "bread"], edges: ["b-r"] });
    expect(one.warnings.map((w) => w.kind)).toEqual(["fan-out"]);
  });

  it("names tables by entity name, quotes what must be quoted in the dialect's quotes, and aliases by initials", () => {
    const walk = { nodes: ["order_lines", "order"], edges: ["l-o"] };
    expect(routeSql(DOC, walk, { aliases: "table" }).sql).toBe(
      'SELECT *\nFROM "Order Line" AS ol\n  LEFT JOIN "Order" AS o ON o.id = ol.order_id',
    );
    expect(routeSql(DOC, walk, { dialect: "tsql" }).sql).toContain("FROM [Order Line] AS t0");
    expect(routeSql(DOC, walk, { dialect: "mysql" }).sql).toContain("LEFT JOIN `Order` AS t1");
    expect(sqlTableName(DOC.nodes[0]!)).toBe("people");
    expect(sqlTableName({ id: "order-lines", label: "Order lines" })).toBe("Order lines");
  });

  it("selects each table's key on request, and honours a forced join type", () => {
    const out = routeSql(DOC, { nodes: ["recipes", "people"], edges: ["r-p"] }, { select: "keys", join: "left" });
    expect(out.sql).toBe("SELECT\n  t0.id AS t0_id,\n  t1.id AS t1_id\nFROM recipes AS t0\n  LEFT JOIN people AS t1 ON t1.id = t0.chef_id");
  });

  it("flags a polymorphic reference and a line with no key", () => {
    const poly = routeSql(DOC, { nodes: ["tasks", "people"], edges: ["t-p"] });
    expect(poly.sql).toContain("/* polymorphic: also match the target type */");
    expect(poly.warnings.map((w) => w.kind)).toEqual(["polymorphic"]);
    const arch = routeSql(DOC, { nodes: ["people", "order"], edges: ["arch"] });
    expect(arch.sql).toContain("ON 1 = 1");
    expect(arch.warnings.map((w) => w.kind)).toEqual(["no-key"]);
    expect(arch.hops[0]!.multiplicity).toBe("unknown");
  });
});

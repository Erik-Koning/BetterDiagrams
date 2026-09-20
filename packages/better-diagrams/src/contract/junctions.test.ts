/**
 * Junction tables: the storage spelling of many-to-many, found strictly and
 * folded into the one association UML draws.
 */
import { describe, expect, it } from "vitest";
import { collapseJunctions, junctionTables } from "./junctions";
import { validateTemplate, type DiagramTemplate } from "./schema";

const table = (id: string, fields: unknown[], over: Record<string, unknown> = {}) => ({
  id,
  label: id,
  kind: "table",
  icon: "none",
  description: "",
  parentId: null,
  x: 0,
  y: 0,
  w: 230,
  h: 96,
  fields,
  ...over,
});
const fk = (id: string, source: string, target: string, startField: string, endField = "id") => ({
  id,
  source,
  target,
  label: "",
  style: "dashed",
  color: "slate",
  startField,
  endField,
  relation: "reference",
  startLabel: "*",
  endLabel: "1",
});

/** users ⟵ order_items ⟶ products, with a quantity riding the junction. */
const MODEL: DiagramTemplate = validateTemplate({
  version: 1,
  nodes: [
    table("users", [{ id: "id", name: "id", type: "uuid", key: "pk" }]),
    table("products", [{ id: "id", name: "id", type: "uuid", key: "pk" }]),
    table("order_items", [
      { id: "user_id", name: "user_id", type: "uuid", key: "pfk" },
      { id: "product_id", name: "product_id", type: "uuid", key: "pfk" },
      { id: "qty", name: "qty", type: "int" },
    ]),
  ],
  edges: [fk("j1", "order_items", "users", "user_id"), fk("j2", "order_items", "products", "product_id")],
  paths: [{ id: "p", title: "Buy", steps: ["users", "order_items", "products"] }],
});

describe("junctionTables", () => {
  it("finds a table keyed by two foreign keys, with its lines in row order and its other rows as attributes", () => {
    const [j, ...rest] = junctionTables(MODEL);
    expect(rest).toEqual([]);
    expect(j).toMatchObject({ id: "order_items", label: "order_items" });
    expect(j!.edges.map((e) => e.id)).toEqual(["j1", "j2"]);
    expect(j!.attributes.map((f) => f.name)).toEqual(["qty"]);
  });

  it("pairs two unnamed lines with the two rows in order, but not a line that names a different row", () => {
    const bare = validateTemplate({
      ...MODEL,
      edges: MODEL.edges.map(({ startField: _s, endField: _e, ...e }) => e),
    });
    expect(junctionTables(bare)[0]!.edges.map((e) => e.id)).toEqual(["j1", "j2"]);
    const wrong = validateTemplate({
      ...MODEL,
      edges: [{ ...MODEL.edges[0]!, startField: "qty" }, MODEL.edges[1]!],
    });
    expect(junctionTables(wrong)).toEqual([]);
  });

  it("is strict: a third key, a plain key, an incoming line, or contents all disqualify", () => {
    const withThird = validateTemplate({
      ...MODEL,
      nodes: MODEL.nodes.map((n) =>
        n.id === "order_items"
          ? { ...n, fields: [...n.fields!, { id: "store_id", name: "store_id", type: "uuid", key: "pfk" }] }
          : n,
      ),
    });
    expect(junctionTables(withThird)).toEqual([]);
    const withOwnKey = validateTemplate({
      ...MODEL,
      nodes: MODEL.nodes.map((n) =>
        n.id === "order_items" ? { ...n, fields: [{ id: "id", name: "id", type: "uuid", key: "pk" }, ...n.fields!] } : n,
      ),
    });
    expect(junctionTables(withOwnKey)).toEqual([]);
    const referenced = validateTemplate({
      ...MODEL,
      nodes: [...MODEL.nodes, table("returns", [{ id: "item_id", name: "item_id", type: "uuid", key: "fk" }])],
      edges: [...MODEL.edges, fk("r", "returns", "order_items", "item_id", "user_id")],
    });
    expect(junctionTables(referenced)).toEqual([]);
    const withChild = validateTemplate({
      ...MODEL,
      nodes: [...MODEL.nodes, table("note", [], { parentId: "order_items", x: 10, y: 10 })],
    });
    expect(junctionTables(withChild)).toEqual([]);
  });
});

describe("collapseJunctions", () => {
  it("replaces the table and its two lines with one many-to-many line landing on the same rows", () => {
    const out = validateTemplate(collapseJunctions(MODEL));
    expect(out.nodes.map((n) => n.id)).toEqual(["users", "products"]);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).toMatchObject({
      id: "order_items::junction",
      source: "users",
      target: "products",
      label: "order_items",
      relation: "reference",
      style: "dashed",
      startLabel: "*",
      endLabel: "*",
      direction: "none",
      startField: "id",
      endField: "id",
    });
    expect(out.edges[0]!.data).toEqual({ junction: { id: "order_items", attributes: ["qty"] } });
    // The path that walked through the junction lost that step, not the whole route.
    expect(out.paths?.[0]?.steps).toEqual(["users", "products"]);
  });

  it("collapses only the junctions asked for, and is a no-op when there is none", () => {
    expect(collapseJunctions(MODEL, ["nope"])).toBe(MODEL);
    expect(collapseJunctions(validateTemplate({ ...MODEL, nodes: MODEL.nodes.slice(0, 2), edges: [] }))).toMatchObject({
      nodes: MODEL.nodes.slice(0, 2),
    });
    expect(collapseJunctions(MODEL, ["order_items"]).nodes).toHaveLength(2);
  });
});

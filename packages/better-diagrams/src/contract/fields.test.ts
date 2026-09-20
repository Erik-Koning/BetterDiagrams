/**
 * Data-model rows: a node's fields, an edge's cardinality, and the row anchors
 * that put a foreign-key line on the column it references.
 */
import { describe, expect, it } from "vitest";
import { referencesTo } from "./fields";
import {
  FIELD_ROW_H,
  MAX_NODE_FIELDS,
  buildSystemPrompt,
  fieldAnchors,
  fieldRowT,
  fieldListTop,
  fieldsBoxHeight,
  fromReactFlow,
  toReactFlow,
  uncrossFieldAnchors,
  validateTemplate,
  withEndSlots,
  type DiagramEdge,
  type DiagramNode,
  type DiagramTemplate,
} from "./schema";
import { mergeTemplate, splitTemplate } from "./presentation";
import { END_LABEL_INSET, cardinalityMarker, crowsFootPath, endLabelInset } from "./geometry";

const table = (
  id: string,
  fields: Array<Record<string, unknown>>,
  over: Record<string, unknown> = {},
) => ({
  id,
  label: id,
  kind: "table",
  icon: "none",
  description: "",
  parentId: null,
  x: 0,
  y: 0,
  w: 230,
  h: 200,
  fields,
  ...over,
});

/** Two tables and the foreign key between them — ids repeat ACROSS nodes. */
const MODEL: DiagramTemplate = {
  version: 1,
  nodes: [
    table("users", [
      { id: "id", name: "id", type: "uuid", key: "pk", required: true },
      { id: "email", name: "email", type: "citext", required: true },
    ]),
    table(
      "orders",
      [
        { id: "id", name: "id", type: "uuid", key: "pk" },
        { id: "user_id", name: "user_id", type: "uuid", key: "fk" },
      ],
      { x: 500 },
    ),
  ],
  edges: [
    {
      id: "fk1",
      source: "orders",
      target: "users",
      label: "references",
      style: "solid",
      color: "slate",
      startField: "user_id",
      endField: "id",
      startLabel: "0..*",
      endLabel: "1",
    },
  ],
} as unknown as DiagramTemplate;

describe("node fields", () => {
  it("keeps the rows and the cardinality through validation", () => {
    const t = validateTemplate(MODEL);
    expect(t.nodes[0].fields).toEqual([
      { id: "id", name: "id", type: "uuid", key: "pk", required: true },
      { id: "email", name: "email", type: "citext", required: true },
    ]);
    expect(t.edges[0]).toMatchObject({
      startField: "user_id",
      endField: "id",
      startLabel: "0..*",
      endLabel: "1",
    });
  });

  it("a node without fields never grows the key — old documents round-trip", () => {
    const t = validateTemplate({
      version: 1,
      nodes: [{ id: "a", label: "A", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76 }],
      edges: [],
    });
    expect("fields" in t.nodes[0]).toBe(false);
  });

  it("grows a node too short to show every row", () => {
    const t = validateTemplate({
      ...MODEL,
      nodes: [table("users", [{ id: "a", name: "a" }, { id: "b", name: "b" }], { h: 40 })],
      edges: [],
    });
    expect(t.nodes[0].h).toBe(fieldsBoxHeight(2, false));
    // A description pushes the list down, so the same rows need more room.
    const withDesc = validateTemplate({
      ...MODEL,
      nodes: [
        table("users", [{ id: "a", name: "a" }, { id: "b", name: "b" }], {
          h: 40,
          description: "one line",
        }),
      ],
      edges: [],
    });
    expect(withDesc.nodes[0].h).toBeGreaterThan(t.nodes[0].h);
  });

  it("never shrinks a node the user made taller than its rows need", () => {
    const t = validateTemplate({
      ...MODEL,
      nodes: [table("users", [{ id: "a", name: "a" }], { h: 400 })],
      edges: [],
    });
    expect(t.nodes[0].h).toBe(400);
  });

  it("derives a missing id from the name, and suffixes a collision", () => {
    const t = validateTemplate({
      ...MODEL,
      nodes: [
        table("users", [
          { name: "User ID" },
          { id: "user_id", name: "other" },
          { id: "user_id", name: "clash" },
        ]),
      ],
      edges: [],
    });
    expect(t.nodes[0].fields?.map((f) => f.id)).toEqual(["user_id", "user_id_2", "user_id_3"]);
  });

  it("drops an entry with neither id nor name, and forgets an unknown key role", () => {
    const t = validateTemplate({
      ...MODEL,
      nodes: [table("users", [{}, { name: "kept", key: "primary" }, { name: "" }])],
      edges: [],
    });
    expect(t.nodes[0].fields).toEqual([{ id: "kept", name: "kept" }]);
  });

  it("caps a runaway list rather than rendering rows off the box", () => {
    const many = Array.from({ length: MAX_NODE_FIELDS + 12 }, (_, i) => ({ name: `c${i}` }));
    const t = validateTemplate({ ...MODEL, nodes: [table("wide", many)], edges: [] });
    expect(t.nodes[0].fields).toHaveLength(MAX_NODE_FIELDS);
  });
});

describe("edge ends", () => {
  it("drops a field reference that names no row on THAT endpoint", () => {
    // "email" is a row of users, the TARGET — as a source reference it is
    // dangling, and a per-document check would have missed it.
    const t = validateTemplate({
      ...MODEL,
      edges: [{ ...MODEL.edges[0], startField: "email", endField: "nope" }],
    });
    expect(t.edges[0].startField).toBeUndefined();
    expect(t.edges[0].endField).toBeUndefined();
  });

  it("keeps same-named rows apart: `id` on both tables resolves per node", () => {
    const t = validateTemplate({
      ...MODEL,
      edges: [{ ...MODEL.edges[0], startField: "id", endField: "id" }],
    });
    expect(t.edges[0].startField).toBe("id");
    expect(t.edges[0].endField).toBe("id");
  });

  it("trims blank cardinality away instead of storing it", () => {
    const t = validateTemplate({
      ...MODEL,
      edges: [{ ...MODEL.edges[0], startLabel: "   ", endLabel: " 1..* " }],
    });
    expect("startLabel" in t.edges[0]).toBe(false);
    expect(t.edges[0].endLabel).toBe("1..*");
  });
});

describe("row anchors", () => {
  const users = validateTemplate(MODEL).nodes[0];

  it("puts the fraction at the centre of the row", () => {
    const first = fieldRowT(users, "id")!;
    const second = fieldRowT(users, "email")!;
    expect(first * users.h).toBeCloseTo(fieldListTop(false) + FIELD_ROW_H / 2, 5);
    expect((second - first) * users.h).toBeCloseTo(FIELD_ROW_H, 5);
  });

  it("is nothing for a row the node doesn't have", () => {
    expect(fieldRowT(users, "nope")).toBeUndefined();
    expect(fieldRowT(users, undefined)).toBeUndefined();
  });

  it("faces the side that looks at the other box", () => {
    const left = { fields: users.fields, description: "", h: users.h, centerX: 0 };
    const right = { fields: users.fields, description: "", h: users.h, centerX: 900 };
    expect(fieldAnchors({ startField: "id" }, left, right).start?.side).toBe("right");
    expect(fieldAnchors({ startField: "id" }, right, left).start?.side).toBe("left");
    // The end anchor reads the TARGET's rows and faces back at the source.
    expect(fieldAnchors({ endField: "email" }, left, right).end?.side).toBe("left");
  });

  it("honours a pinned left/right side but still lands on the row", () => {
    const a = { fields: users.fields, description: "", h: users.h, centerX: 0 };
    const b = { fields: users.fields, description: "", h: users.h, centerX: 900 };
    const out = fieldAnchors({ start: { side: "left" }, startField: "email" }, a, b);
    expect(out.start).toEqual({ side: "left", t: fieldRowT(users, "email") });
  });

  it("leaves a top/bottom pin alone — a row fraction means nothing there", () => {
    const a = { fields: users.fields, description: "", h: users.h, centerX: 0 };
    const b = { fields: users.fields, description: "", h: users.h, centerX: 900 };
    const pinned = { side: "top", t: 0.25 } as const;
    expect(fieldAnchors({ start: pinned, startField: "email" }, a, b).start).toEqual(pinned);
  });

  it("passes an edge with no field references straight through", () => {
    const a = { fields: users.fields, description: "", h: users.h, centerX: 0 };
    const b = { fields: users.fields, description: "", h: users.h, centerX: 900 };
    expect(fieldAnchors({ start: { side: "bottom" } }, a, b)).toEqual({ start: { side: "bottom" } });
    expect(fieldAnchors({}, a, b)).toEqual({});
  });
});

describe("un-crossing", () => {
  /**
   * The screenshot that asked for this: Coupon's two foreign keys, product_id
   * on the row ABOVE customer_id, but Product sitting BELOW Customer — so the
   * two lines cross the moment they leave the table.
   */
  const coupon = table("coupon", [
    { id: "id", name: "Id", key: "pk" },
    { id: "code", name: "code" },
    { id: "product", name: "product_id", key: "fk" },
    { id: "customer", name: "customer_id", key: "fk" },
  ]);
  const customer = table("customer", [{ id: "id", name: "Id", key: "pk" }], { x: 900, y: 0 });
  const product = table("product", [{ id: "id", name: "Id", key: "pk" }], { x: 900, y: 600 });
  const fk = (id: string, source: string, startField: string, target: string, over: Record<string, unknown> = {}) =>
    ({ id, source, target, label: "", style: "dashed", color: "slate", startField, endField: "id", ...over }) as unknown as DiagramEdge;
  const model = (edges: DiagramEdge[], nodes: unknown[] = [coupon, customer, product]) =>
    validateTemplate({ version: 1, nodes, edges } as unknown as DiagramTemplate);
  const nodeOf = (doc: DiagramTemplate) => (id: string) => {
    const n = doc.nodes.find((node) => node.id === id);
    return n && { fields: n.fields, description: n.description, box: { x: n.x, y: n.y, width: n.w, height: n.h } };
  };
  const rowT = (n: DiagramNode, fieldId: string) => fieldRowT(n, fieldId)!;

  it("trades the rows of two lines that would cross leaving the same side", () => {
    const doc = model([fk("toProduct", "coupon", "product", "product"), fk("toCustomer", "coupon", "customer", "customer")]);
    const slots = uncrossFieldAnchors(doc.edges, nodeOf(doc));
    const c = doc.nodes[0];
    // Each leaves from the OTHER's row; the far ends, alone on their sides, stay.
    expect(slots.get("toProduct")).toEqual({ start: rowT(c, "customer") });
    expect(slots.get("toCustomer")).toEqual({ start: rowT(c, "product") });
  });

  it("leaves lines that already fan out in destination order alone", () => {
    const doc = model([fk("toCustomer", "coupon", "customer", "customer"), fk("toProduct", "coupon", "product", "product")], [
      coupon,
      { ...customer, y: 600 },
      { ...product, y: 0 },
    ]);
    expect(uncrossFieldAnchors(doc.edges, nodeOf(doc)).size).toBe(0);
  });

  it("never moves an end the user pinned, or a top/bottom pin, or a floating end", () => {
    const doc = model([
      // Hand-pinned fraction on the right face, above the FK row — the user's.
      fk("pinned", "coupon", "product", "product", { startField: undefined, start: { side: "right", t: 0.1 } }),
      fk("toCustomer", "coupon", "customer", "customer"),
      // A bottom pin keeps its field but has no row to trade.
      fk("bottom", "coupon", "product", "product", { start: { side: "bottom", t: 0.9 } }),
      // No field, no pin: floats through the centre of the face.
      fk("floating", "coupon", "product", "product", { startField: undefined }),
    ]);
    // Only one row-anchored end on coupon's right face: nothing to trade with.
    expect(uncrossFieldAnchors(doc.edges, nodeOf(doc)).size).toBe(0);
  });

  it("hands out three rows in destination order, not just a pairwise swap", () => {
    const three = table("t", [
      { id: "a", name: "a", key: "fk" },
      { id: "b", name: "b", key: "fk" },
      { id: "c", name: "c", key: "fk" },
    ]);
    const target = (id: string, y: number) => table(id, [{ id: "id", name: "id", key: "pk" }], { x: 900, y });
    const doc = model(
      [fk("ea", "t", "a", "low"), fk("eb", "t", "b", "high"), fk("ec", "t", "c", "mid")],
      [three, target("low", 800), target("high", 0), target("mid", 400)],
    );
    const slots = uncrossFieldAnchors(doc.edges, nodeOf(doc));
    const t = doc.nodes[0];
    expect(slots.get("ea")).toEqual({ start: rowT(t, "c") });
    expect(slots.get("eb")).toEqual({ start: rowT(t, "a") });
    expect(slots.get("ec")).toEqual({ start: rowT(t, "b") });
  });

  it("keeps ties in their stored order", () => {
    // Both lines land on the same row of the same table: no reason to move.
    const doc = model([fk("one", "coupon", "product", "customer"), fk("two", "coupon", "customer", "customer")]);
    expect(uncrossFieldAnchors(doc.edges, nodeOf(doc)).size).toBe(0);
  });

  it("trades one side of a crossed pair between two tables, not both", () => {
    // Two lines between the same tables, crossed on BOTH faces. Trading both
    // would cross them again; the second face reads the first's live order.
    const left = table("l", [{ id: "p", name: "p", key: "fk" }, { id: "q", name: "q", key: "fk" }]);
    const right = table("r", [{ id: "x", name: "x", key: "pk" }, { id: "y", name: "y", key: "pk" }], { x: 900 });
    const doc = model(
      [fk("pToY", "l", "p", "r", { endField: "y" }), fk("qToX", "l", "q", "r", { endField: "x" })],
      [left, right],
    );
    const slots = uncrossFieldAnchors(doc.edges, nodeOf(doc));
    const [l] = doc.nodes;
    expect(slots.get("pToY")).toEqual({ start: rowT(l, "q") });
    expect(slots.get("qToX")).toEqual({ start: rowT(l, "p") });
  });

  it("aims at the first waypoint, as the router does", () => {
    // Both target rows would say "no crossing", but the upper line is routed
    // DOWN through a waypoint first — that is where it heads, so it trades.
    const doc = model(
      [fk("toCustomer", "coupon", "product", "customer", { points: [[600, 700]] }), fk("toProduct", "coupon", "customer", "product")],
    );
    const slots = uncrossFieldAnchors(doc.edges, nodeOf(doc));
    const c = doc.nodes[0];
    expect(slots.get("toCustomer")).toEqual({ start: rowT(c, "customer") });
    expect(slots.get("toProduct")).toEqual({ start: rowT(c, "product") });
  });

  it("skips an edge whose box the caller can't place", () => {
    const doc = model([fk("toProduct", "coupon", "product", "product"), fk("toCustomer", "coupon", "customer", "customer")]);
    const only = nodeOf(doc);
    expect(uncrossFieldAnchors(doc.edges, (id) => (id === "product" ? undefined : only(id))).size).toBe(0);
  });

  it("lays a trade over fieldAnchors, touching only the ends that moved", () => {
    const anchors = { start: { side: "right", t: 0.3 }, end: { side: "left", t: 0.6 } } as const;
    expect(withEndSlots(anchors, undefined)).toBe(anchors);
    expect(withEndSlots(anchors, { start: 0.45 })).toEqual({ start: { side: "right", t: 0.45 }, end: { side: "left", t: 0.6 } });
    // A trade for an end that resolved to nothing is nothing.
    expect(withEndSlots({ end: anchors.end }, { start: 0.45 })).toEqual({ end: anchors.end });
  });
});

describe("round trips", () => {
  it("survives the canvas: toReactFlow → fromReactFlow", () => {
    const before = validateTemplate(MODEL);
    const { nodes, edges } = toReactFlow(before);
    const after = fromReactFlow(nodes, edges, { base: before });
    expect(after.nodes[0].fields).toEqual(before.nodes[0].fields);
    expect(after.edges[0]).toMatchObject({
      startField: "user_id",
      endField: "id",
      startLabel: "0..*",
      endLabel: "1",
    });
  });

  it("splits as CONTENT — the layout file never mentions a column", () => {
    const before = validateTemplate(MODEL);
    const { content, presentation } = splitTemplate(before);
    expect(content.nodes[0].fields).toEqual(before.nodes[0].fields);
    expect(content.edges[0]).toMatchObject({ startField: "user_id", startLabel: "0..*" });
    const layout = JSON.stringify(presentation);
    expect(layout).not.toContain("user_id");
    expect(layout).not.toContain("0..*");
    // And the pair still rebuilds the document byte for byte.
    expect(mergeTemplate(content, presentation)).toEqual(before);
  });

  it("lays out a content-only data model, keeping every row", () => {
    const { content } = splitTemplate(validateTemplate(MODEL));
    const merged = mergeTemplate(content);
    expect(merged.nodes.map((n) => n.fields?.length)).toEqual([2, 2]);
    expect(merged.edges[0].startField).toBe("user_id");
  });
});

describe("crow's-foot markers", () => {
  it("reads the cardinalities people actually write", () => {
    const cases: Array<[string, string | undefined]> = [
      ["1", "one"],
      ["one", "one"],
      ["1..1", "one"],
      ["0..1", "zero-one"],
      ["optional", "zero-one"],
      ["0..*", "zero-many"],
      ["*", "zero-many"],
      ["n", "zero-many"],
      ["many", "zero-many"],
      ["1..*", "one-many"],
      ["1..n", "one-many"],
      ["1+", "one-many"],
    ];
    for (const [text, expected] of cases) {
      expect([text, cardinalityMarker(text)]).toEqual([text, expected]);
    }
  });

  it("stays silent on role text — an existing labelled edge keeps its arrow", () => {
    for (const text of ["owns", "publishes to", "", undefined, "   "]) {
      expect(cardinalityMarker(text)).toBeUndefined();
    }
  });

  it("draws the foot against the box and the modifier behind it", () => {
    // Travelling right (angle 0) into a box whose edge is at x = 100.
    const p = { x: 100, y: 50 };
    const foot = crowsFootPath("zero-many", p, 0);
    // Every prong touches the box; the apex and the ring sit back along the line.
    expect(foot).toContain("M 88 50 L 100 56");
    expect(foot).toContain("M 88 50 L 100 44");
    expect(foot).toContain("M 88 50 L 100 50");
    expect(foot).toContain("A 4 4");
    // "Exactly one" is two bars and no foot.
    const one = crowsFootPath("one", p, 0);
    expect(one).not.toContain("A 4 4");
    expect(one.match(/M /g)).toHaveLength(2);
  });

  it("pushes the end label clear of a symbol", () => {
    expect(endLabelInset(undefined)).toBe(END_LABEL_INSET);
    expect(endLabelInset("zero-many")).toBeGreaterThan(END_LABEL_INSET);
  });
});

describe("the prompt", () => {
  it("teaches rows and cardinality in both forms", () => {
    for (const prompt of [buildSystemPrompt(), buildSystemPrompt({ geometry: false })]) {
      expect(prompt).toContain('"fields"');
      expect(prompt).toContain("startField");
      expect(prompt).toContain("startLabel");
      expect(prompt).toContain('kind "table"');
    }
  });

  it("still forbids node geometry in the content form", () => {
    const content = buildSystemPrompt({ geometry: false });
    expect(content).toContain("NEVER emit x/y/w/h");
    // The NODE skeleton loses its box; the zone skeleton keeps one, because a
    // zone's geometry is membership rather than presentation.
    expect(content).not.toContain('"w":170');
    expect(content).toContain('"w":900');
  });
});

describe("referencesTo — what points at a key", () => {
  const t = validateTemplate({
    version: 1,
    nodes: [
      { id: "users", label: "Users", kind: "table", icon: "none", description: "", parentId: null, x: 0, y: 0, w: 230, h: 96, fields: [{ id: "id", name: "id", key: "pk" }, { id: "email", name: "email", unique: true }] },
      { id: "orders", label: "Orders", kind: "table", icon: "none", description: "", parentId: null, x: 400, y: 0, w: 230, h: 96, fields: [{ id: "user_id", name: "user_id", key: "fk" }] },
      { id: "notes", label: "Notes", kind: "table", icon: "none", description: "", parentId: null, x: 800, y: 0, w: 230, h: 96, fields: [{ id: "author", name: "author", key: "fk" }, { id: "mail", name: "mail", key: "fk" }] },
      { id: "logs", label: "Logs", kind: "table", icon: "none", description: "", parentId: null, x: 0, y: 400, w: 230, h: 96, fields: [{ id: "id", name: "id", key: "pk" }] },
    ],
    edges: [
      { id: "o-u", source: "orders", target: "users", label: "", style: "solid", color: "slate", startField: "user_id", endField: "id" },
      // No landing row named: lands on the table's key, as a followed reference would.
      { id: "n-u", source: "notes", target: "users", label: "", style: "solid", color: "slate", startField: "author" },
      // Lands on a unique column, not the key.
      { id: "n-m", source: "notes", target: "users", label: "", style: "solid", color: "slate", startField: "mail", endField: "email" },
      // A table pointing at itself.
      { id: "u-u", source: "users", target: "users", label: "", style: "solid", color: "slate", endField: "id" },
    ],
  } as unknown as DiagramTemplate);

  it("lists the foreign keys landing on a key, explicit or implied, self-references included", () => {
    expect(referencesTo(t, { nodeId: "users", fieldId: "id" })).toEqual([
      { nodeId: "orders", fieldId: "user_id", edgeId: "o-u" },
      { nodeId: "notes", fieldId: "author", edgeId: "n-u" },
      { nodeId: "users", edgeId: "u-u" },
    ]);
    expect(referencesTo(t, { nodeId: "users", fieldId: "email" })).toEqual([{ nodeId: "notes", fieldId: "mail", edgeId: "n-m" }]);
  });

  it("a table pin takes every line in; a key nothing points at, or a node that isn't there, gets none", () => {
    expect(referencesTo(t, { nodeId: "users" }).map((r) => r.edgeId)).toEqual(["o-u", "n-u", "n-m", "u-u"]);
    expect(referencesTo(t, { nodeId: "logs", fieldId: "id" })).toEqual([]);
    expect(referencesTo(t, { nodeId: "ghost", fieldId: "id" })).toEqual([]);
  });
});

/**
 * UML notation on a data model: the two new end glyphs, the notation
 * setting that decides symbol versus number, the enumeration kind, and the
 * unique / derived field flags — from the schema through the importer.
 */
import { describe, expect, it } from "vitest";
import { edgeHeadPath, endNotation } from "./geometry";
import {
  buildSystemPrompt,
  EDGE_HEADS,
  KIND_DEFAULT_SIZE,
  NODE_KINDS,
  NOTATIONS,
  validateTemplate,
  type DiagramTemplate,
} from "./schema";
import { fieldRecords } from "./fields";
import { toNodeField } from "./folder/dialects/datamodel/fields";

const at = { x: 100, y: 50 };

describe("end glyphs", () => {
  it("adds UML's filled diamond and hollow triangle to the vocabulary", () => {
    expect(EDGE_HEADS).toContain("diamond-filled");
    expect(EDGE_HEADS).toContain("triangle");
    // The filled diamond is the hollow one's shape, solid — the whole owns the part.
    expect(edgeHeadPath("diamond-filled", at, 0).d).toBe(edgeHeadPath("diamond", at, 0).d);
    expect(edgeHeadPath("diamond-filled", at, 0).filled).toBe(true);
    expect(edgeHeadPath("diamond", at, 0).filled).toBe(false);
    // Generalization's triangle is an outline, apex at the attachment.
    const tri = edgeHeadPath("triangle", at, 0);
    expect(tri.filled).toBe(false);
    expect(tri.d.startsWith(`M ${at.x} ${at.y}`)).toBe(true);
    expect(tri.d.endsWith("Z")).toBe(true);
  });

  it("validates the new heads on an edge like any other", () => {
    const t = validateTemplate({
      version: 1,
      nodes: [
        { id: "a", label: "A", kind: "table", icon: "none", description: "", parentId: null, x: 0, y: 0, w: 200, h: 96 },
        { id: "b", label: "B", kind: "table", icon: "none", description: "", parentId: null, x: 400, y: 0, w: 200, h: 96 },
      ],
      edges: [
        { id: "own", source: "a", target: "b", label: "", style: "solid", color: "rose", startHead: "diamond-filled" },
        { id: "isa", source: "a", target: "b", label: "", style: "solid", color: "emerald", endHead: "triangle" },
        { id: "junk", source: "a", target: "b", label: "", style: "solid", color: "slate", endHead: "spade" },
      ],
    });
    expect(t.edges.map((e) => [e.startHead, e.endHead])).toEqual([
      ["diamond-filled", undefined],
      [undefined, "triangle"],
      [undefined, undefined],
    ]);
  });
});

describe("notation", () => {
  it("resolves each end to symbol, text, or both", () => {
    // Default: the symbol at the box and the text further in.
    expect(endNotation("0..1")).toEqual({ marker: "zero-one", text: "0..1" });
    expect(endNotation("0..1", "both")).toEqual({ marker: "zero-one", text: "0..1" });
    // Crow's foot: the symbol alone — but role text, which is no cardinality, still prints.
    expect(endNotation("*", "crowsfoot")).toEqual({ marker: "zero-many" });
    expect(endNotation("owns", "crowsfoot")).toEqual({ text: "owns" });
    // UML: never a symbol; the number is the multiplicity.
    expect(endNotation("1", "uml")).toEqual({ text: "1" });
    expect(endNotation("1..*", "uml")).toEqual({ text: "1..*" });
    // Nothing said, nothing drawn.
    expect(endNotation(undefined, "uml")).toEqual({});
    expect(endNotation("", "crowsfoot")).toEqual({});
  });

  it("is a document setting with a strict vocabulary", () => {
    expect(NOTATIONS).toEqual(["both", "uml", "crowsfoot"]);
    const doc = (notation: unknown): DiagramTemplate =>
      validateTemplate({ version: 1, nodes: [], edges: [], settings: { notation } });
    expect(doc("uml").settings).toEqual({ notation: "uml" });
    expect(doc("crowsfoot").settings).toEqual({ notation: "crowsfoot" });
    expect(doc("chen").settings).toBeUndefined();
  });
});

describe("enumeration kind", () => {
  it("is a built-in record kind with a size of its own", () => {
    expect(NODE_KINDS).toContain("enum");
    expect(KIND_DEFAULT_SIZE.enum).toEqual({ w: 180, h: 96 });
    const t = validateTemplate({
      version: 1,
      nodes: [
        {
          id: "status",
          label: "OrderStatus",
          kind: "enum",
          icon: "none",
          description: "",
          parentId: null,
          x: 0,
          y: 0,
          w: 180,
          h: 96,
          fields: [{ id: "new", name: "NEW" }, { id: "paid", name: "PAID" }],
        },
      ],
      edges: [],
    });
    expect(t.nodes[0]!.kind).toBe("enum");
    expect(t.nodes[0]!.fields?.map((f) => f.name)).toEqual(["NEW", "PAID"]);
  });

  it("is offered to the model alongside the UML glyphs", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('kind "enum"');
    expect(prompt).toContain('"diamond-filled"');
    expect(prompt).toContain('"triangle"');
    expect(prompt).toContain("aggregation");
    expect(prompt).toContain("generalization");
  });
});

describe("field flags", () => {
  const table = (fields: unknown[]) =>
    validateTemplate({
      version: 1,
      nodes: [
        { id: "t", label: "T", kind: "table", icon: "none", description: "", parentId: null, x: 0, y: 0, w: 230, h: 96, fields },
      ],
      edges: [],
    }).nodes[0]!;

  it("keeps unique and derived as booleans and drops anything else", () => {
    const t = table([
      { id: "email", name: "email", type: "citext", unique: true },
      { id: "total", name: "total", type: "money", derived: true },
      { id: "junk", name: "junk", unique: "yes", derived: 1 },
    ]);
    expect(t.fields).toEqual([
      { id: "email", name: "email", type: "citext", unique: true },
      { id: "total", name: "total", type: "money", derived: true },
      { id: "junk", name: "junk" },
    ]);
  });

  it("are read off a data model's fields by the folder importer", () => {
    // A formula field is computed, never stored: derived.
    expect(toNodeField({ name: "total", type: "currency", formula: "qty * price" })).toMatchObject({ derived: true });
    expect(toNodeField({ name: "flag", type: "boolean", calculated: true })).toMatchObject({ derived: true });
    // Unique is worth saying on a column; a primary key is unique by definition.
    expect(toNodeField({ name: "email", type: "string", unique: true })).toMatchObject({ unique: true });
    expect(toNodeField({ name: "id", type: "id", primaryKey: true, unique: true }).unique).toBeUndefined();
    expect(toNodeField({ name: "plain", type: "string" })).toEqual({ id: "plain", name: "plain", type: "string" });
  });

  it("reach the field records the grid and the exports read", () => {
    const node = table([
      { id: "email", name: "email", type: "citext", unique: true },
      { id: "total", name: "total", type: "money", derived: true },
    ]);
    const records = fieldRecords(node);
    expect(records.find((r) => r.id === "email")).toMatchObject({ unique: true });
    expect(records.find((r) => r.id === "total")).toMatchObject({ derived: true });
    expect(records.find((r) => r.id === "email")!.derived).toBeUndefined();
  });
});

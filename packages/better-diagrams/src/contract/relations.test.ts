/**
 * relations.test.ts — the relationship-kind vocabulary: what each kind
 * dresses a line with, how a registry relabels or extends it, and how the
 * `relation` field rides through the document.
 */
import { describe, expect, it } from "vitest";
import {
  FALLBACK_RELATION,
  RELATION_KINDS,
  RELATION_KIND_ORDER,
  relationDressing,
  resolveRelationKinds,
} from "./relations";
import { buildSystemPrompt, fromReactFlow, toReactFlow, validateTemplate, type DiagramTemplate } from "./schema";
import { mergeTemplate, splitTemplate } from "./presentation";

const doc = (edge: Record<string, unknown>): DiagramTemplate =>
  validateTemplate({
    version: 1,
    nodes: [
      { id: "a", label: "A", kind: "table", icon: "none", description: "", parentId: null, x: 0, y: 0, w: 230, h: 120, fields: [{ id: "id", name: "id", key: "pk" }, { id: "b_id", name: "b_id", key: "fk" }] },
      { id: "b", label: "B", kind: "table", icon: "none", description: "", parentId: null, x: 500, y: 0, w: 230, h: 120, fields: [{ id: "id", name: "id", key: "pk" }] },
    ],
    edges: [{ id: "e1", source: "a", target: "b", label: "", style: "solid", color: "slate", startField: "b_id", endField: "id", ...edge }],
  } as unknown as DiagramTemplate);

describe("the vocabulary", () => {
  it("draws an identifying relationship solid and the rest dashed or dotted, each in its own colour", () => {
    expect(RELATION_KIND_ORDER).toEqual(["composition", "aggregation", "reference", "hierarchy", "polymorphic", "generalization"]);
    // UML's glyphs: a filled diamond owns, a hollow one shares, a hollow triangle points at the type extended.
    expect(RELATION_KINDS.composition).toMatchObject({ style: "solid", color: "rose", startHead: "diamond-filled", startLabel: "*", endLabel: "1" });
    expect(RELATION_KINDS.aggregation).toMatchObject({ style: "solid", color: "sky", startHead: "diamond", startLabel: "*", endLabel: "0..1" });
    expect(RELATION_KINDS.generalization).toMatchObject({ style: "solid", color: "emerald", endHead: "triangle" });
    expect(RELATION_KINDS.generalization!.startLabel).toBeUndefined();
    expect(RELATION_KINDS.generalization!.endLabel).toBeUndefined();
    expect(RELATION_KINDS.reference).toMatchObject({ style: "dashed", color: "slate", startLabel: "*", endLabel: "0..1" });
    expect(RELATION_KINDS.hierarchy).toMatchObject({ style: "dashed", color: "violet" });
    expect(RELATION_KINDS.polymorphic).toMatchObject({ style: "dotted", color: "amber" });
    // Every kind has words a legend can show and a tooltip can explain.
    for (const def of Object.values(RELATION_KINDS)) {
      expect(def.label).toBeTruthy();
      expect(def.description).toBeTruthy();
    }
  });

  it("dresses a line with exactly the fields the kind sets", () => {
    expect(relationDressing(RELATION_KINDS.composition!)).toEqual({ style: "solid", color: "rose", startHead: "diamond-filled", startLabel: "*", endLabel: "1" });
    // No glyph on a reference: the key must not say `startHead: undefined`.
    expect(relationDressing(RELATION_KINDS.reference!)).toEqual({ style: "dashed", color: "slate", startLabel: "*", endLabel: "0..1" });
    expect(relationDressing(FALLBACK_RELATION)).toEqual({ style: "dashed", color: "slate" });
  });
});

describe("resolveRelationKinds", () => {
  it("relabels a built-in without touching its line, adds a kind over the fallback, and removes on null", () => {
    const { kinds, order } = resolveRelationKinds({
      composition: { label: "Master-detail" },
      ownership: { label: "Ownership", color: "emerald" },
      polymorphic: null,
    });
    expect(kinds.composition).toMatchObject({ label: "Master-detail", style: "solid", color: "rose", startHead: "diamond-filled" });
    expect(kinds.ownership).toMatchObject({ label: "Ownership", style: "dashed", color: "emerald" });
    expect(kinds.polymorphic).toBeUndefined();
    // Built-ins keep their order; additions follow.
    expect(order).toEqual(["composition", "aggregation", "reference", "hierarchy", "generalization", "ownership"]);
  });

  it("names an unlabelled addition after its id", () => {
    expect(resolveRelationKinds({ "many-to-many": { style: "dotted" } }).kinds["many-to-many"]!.label).toBe("Many To Many");
  });

  it("is the built-ins untouched with nothing to apply", () => {
    const { kinds, order } = resolveRelationKinds(undefined);
    expect(kinds).toEqual(RELATION_KINDS);
    expect(order).toEqual([...RELATION_KIND_ORDER]);
  });
});

describe("the relation field", () => {
  it("survives validation trimmed, and is stripped when blank", () => {
    expect(doc({ relation: " composition " }).edges[0].relation).toBe("composition");
    expect("relation" in doc({ relation: "" }).edges[0]).toBe(false);
    expect("relation" in doc({ relation: 7 }).edges[0]).toBe(false);
    expect("relation" in doc({}).edges[0]).toBe(false);
  });

  it("is a free vocabulary — a kind nobody registered is kept for the registry to name", () => {
    expect(doc({ relation: "ownership" }).edges[0].relation).toBe("ownership");
  });

  it("round-trips the canvas and rides the split as CONTENT", () => {
    const t = doc({ relation: "composition" });
    const rf = toReactFlow(t);
    expect(rf.edges[0].data.relation).toBe("composition");
    expect(JSON.stringify(fromReactFlow(rf.nodes, rf.edges, { base: t }))).toBe(JSON.stringify(t));
    const { content, presentation } = splitTemplate(t);
    expect(content.edges[0].relation).toBe("composition");
    expect(JSON.stringify(presentation)).not.toContain("composition");
    expect(mergeTemplate(content, presentation)).toEqual(t);
  });

  it("is offered to the model, with a registry's extra kinds appended", () => {
    expect(buildSystemPrompt()).toContain('"relation":"composition|aggregation|reference|hierarchy|polymorphic|generalization"');
    expect(buildSystemPrompt({ relations: ["ownership"] })).toContain('"relation":"composition|aggregation|reference|hierarchy|polymorphic|generalization|ownership"');
    expect(buildSystemPrompt()).toContain('Omit "relation" on an architecture edge');
  });
});

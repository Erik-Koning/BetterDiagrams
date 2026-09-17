/**
 * field-routes.test.ts — the path panel's model: routes for two pins,
 * between/reachable for more, keep-sets, and the structural memo key.
 */
import { describe, expect, it } from "vitest";
import { validateTemplate, type DiagramTemplate } from "../contract/schema";
import { PAIRWISE_PIN_CAP, computeRouteView, structureSignature } from "./field-routes";

const table = (id: string, label: string, fields: string[]) => ({
  id, label, kind: "table", icon: "none", description: "", parentId: null, x: 0, y: 0, w: 230, h: 120,
  fields: fields.map((f) => ({ id: f, name: f })),
});
const fk = (id: string, source: string, target: string, field: string) => ({
  id, source, target, label: "", style: "solid", color: "slate", startField: field, endField: "Id",
});

/** contact → account, case → account, case → contact, comment → case, task → contact, island alone. */
const DOC: DiagramTemplate = validateTemplate({
  version: 1,
  nodes: [
    table("contact", "Contact", ["Id", "AccountId", "OwnerId"]),
    table("account", "Account", ["Id"]),
    table("case", "Case", ["Id", "AccountId", "ContactId"]),
    table("comment", "Comment", ["Id", "ParentId"]),
    table("task", "Task", ["Id", "WhoId"]),
    table("island", "Island", ["Id"]),
  ],
  edges: [
    fk("c-a", "contact", "account", "AccountId"),
    fk("k-a", "case", "account", "AccountId"),
    fk("k-c", "case", "contact", "ContactId"),
    fk("m-k", "comment", "case", "ParentId"),
    fk("t-c", "task", "contact", "WhoId"),
  ],
});
const COLORS = ["sky", "emerald", "amber"] as const;

describe("computeRouteView — two pins", () => {
  it("lists routes shortest first with titles and cycle colours, and the tables between", () => {
    const view = computeRouteView(
      DOC,
      { pins: [{ nodeId: "comment", fieldId: "ParentId" }, { nodeId: "account", fieldId: "Id" }], undirected: true, mode: "between" },
      COLORS,
    );
    expect(view.kind).toBe("pair");
    expect(view.routes.map((r) => [r.title, r.hops, r.color])).toEqual([
      ["Comment.ParentId → Case → Account.Id", 2, "sky"],
      ["Comment.ParentId → Case → Contact → Account.Id", 3, "emerald"],
    ]);
    // The key carrying each hop.
    expect(view.routes.map((r) => r.keys)).toEqual([["ParentId", "AccountId"], ["ParentId", "ContactId", "AccountId"]]);
    expect(view.betweenNodes.sort()).toEqual(["case", "contact"]);
    // task is within reach of both ends but a dead end — tier 2, not tier 1.
    expect(view.corridorExtra).toEqual(["task"]);
    expect(view.keep).toBeNull();
    expect(view.truncated).toBe(false);
    expect(view.constrainedFallback).toEqual([]);
    expect(view.reachable.get("task")).toBe(2); // nearest start: account → contact → task
    expect(view.keyUse!.keys.slice(0, 2).map((k) => [k.ref.fieldId, k.routes])).toEqual([["ParentId", 2], ["AccountId", 1]]);
  });

  it("a table pin is a bare end: no field to hold to, no fallback note, label-only title", () => {
    const view = computeRouteView(
      DOC,
      { pins: [{ nodeId: "comment", fieldId: "ParentId" }, { nodeId: "account" }], undirected: true, mode: "between" },
      COLORS,
    );
    expect(view.routes[0].title).toBe("Comment.ParentId → Case → Account");
    expect(view.constrainedFallback).toEqual([]);
    const both = computeRouteView(DOC, { pins: [{ nodeId: "comment" }, { nodeId: "account" }], undirected: true, mode: "between" }, COLORS);
    expect(both.routes[0].title).toBe("Comment → Case → Account");
  });

  it("reports a pin that anchors nothing, and honours direction", () => {
    const view = computeRouteView(
      DOC,
      { pins: [{ nodeId: "comment", fieldId: "Nope" }, { nodeId: "account", fieldId: "Id" }], undirected: false, mode: "between" },
      COLORS,
    );
    expect(view.constrainedFallback).toEqual([{ nodeId: "comment", fieldId: "Nope" }]);
    expect(view.routes).toHaveLength(2);
    const reversed = computeRouteView(
      DOC,
      { pins: [{ nodeId: "account", fieldId: "Id" }, { nodeId: "comment", fieldId: "ParentId" }], undirected: false, mode: "between" },
      COLORS,
    );
    expect(reversed.routes).toEqual([]);
  });
});

describe("computeRouteView — three or more pins", () => {
  const pins = [
    { nodeId: "comment", fieldId: "ParentId" },
    { nodeId: "task", fieldId: "WhoId" },
    { nodeId: "account", fieldId: "Id" },
  ];

  it("between mode keeps the pins and every table on a pairwise route", () => {
    const view = computeRouteView(DOC, { pins, undirected: true, mode: "between" }, COLORS);
    expect(view.kind).toBe("many");
    expect(view.routes).toEqual([]);
    expect(view.betweenNodes.sort()).toEqual(["case", "contact"]);
    expect([...view.keep!].sort()).toEqual(["account", "case", "comment", "contact", "task"]);
    expect(view.keep!.has("island")).toBe(false);
    expect([...view.keepEdges!].sort()).toEqual(["c-a", "k-a", "k-c", "m-k", "t-c"]);
  });

  it("reachable mode keeps everything the pins reach", () => {
    const view = computeRouteView(DOC, { pins, undirected: true, mode: "reachable" }, COLORS);
    expect(view.keep!.has("island")).toBe(false);
    expect(view.keep!.size).toBe(5);
    expect(view.reachable.get("comment")).toBe(0);
    expect(view.reachable.get("case")).toBe(1);
  });

  it("caps pairwise mode and says how many pins it left out", () => {
    const many = Array.from({ length: PAIRWISE_PIN_CAP + 2 }, (_, i) => ({ nodeId: i % 2 ? "contact" : "case", fieldId: `F${i}` }));
    const view = computeRouteView(DOC, { pins: many, undirected: true, mode: "between" }, COLORS);
    expect(view.pinsIgnored).toBe(2);
    expect(view.constrainedFallback).toHaveLength(PAIRWISE_PIN_CAP);
  });

  it("fewer than two pins is an empty view", () => {
    expect(computeRouteView(DOC, { pins: [], undirected: true, mode: "between" }, COLORS).routes).toEqual([]);
  });
});

describe("memo keys", () => {
  it("structureSignature ignores positions and labels, sees endpoints and anchors", () => {
    const moved = { ...DOC, nodes: DOC.nodes.map((n) => ({ ...n, x: n.x + 100, label: `${n.label}!` })) };
    expect(structureSignature(moved)).toBe(structureSignature(DOC));
    const rewired = { ...DOC, edges: DOC.edges.map((e) => (e.id === "t-c" ? { ...e, startField: "Other" } : e)) };
    expect(structureSignature(rewired)).not.toBe(structureSignature(DOC));
  });

});

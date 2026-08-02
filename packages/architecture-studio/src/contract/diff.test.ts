/**
 * Tests for the semantic template diff — id matching, positional-move
 * blindness, and the changed-field lists the Compare view reports.
 */
import { describe, expect, it } from "vitest";
import { diffTemplates } from "./diff";
import { EXAMPLE_ZONED_TEMPLATE, validateTemplate, type DiagramTemplate } from "./schema";

const node = (over: Record<string, unknown> = {}) =>
  ({
    id: "n",
    label: "N",
    kind: "service",
    icon: "box",
    description: "",
    parentId: null,
    x: 0,
    y: 0,
    w: 170,
    h: 76,
    ...over,
  }) as DiagramTemplate["nodes"][number];

const edge = (over: Record<string, unknown> = {}) =>
  ({
    id: "e",
    source: "a",
    target: "b",
    label: "",
    style: "solid",
    color: "slate",
    ...over,
  }) as DiagramTemplate["edges"][number];

const doc = (nodes: unknown[], edges: unknown[] = [], zones?: unknown[]): DiagramTemplate =>
  ({ version: 1, nodes, edges, ...(zones ? { zones } : {}) }) as DiagramTemplate;

describe("diffTemplates", () => {
  it("reports nothing for identical documents", () => {
    const d = diffTemplates(EXAMPLE_ZONED_TEMPLATE, EXAMPLE_ZONED_TEMPLATE);
    expect(d.summary).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  it("detects added, removed, and changed nodes by id", () => {
    const base = doc([node({ id: "a" }), node({ id: "b", label: "Old" })]);
    const current = doc([node({ id: "b", label: "New" }), node({ id: "c" })]);
    const d = diffTemplates(base, current);
    expect(d.nodes.added).toEqual(["c"]);
    expect(d.nodes.removed).toEqual(["a"]);
    expect(d.nodes.changed).toEqual([{ id: "b", fields: ["label"] }]);
    expect(d.summary).toEqual({ added: 1, removed: 1, changed: 1 });
  });

  it("ignores pure moves and resizes", () => {
    const base = doc([node({ id: "a", x: 0, y: 0, w: 170 })]);
    const current = doc([node({ id: "a", x: 500, y: 300, w: 220 })]);
    expect(diffTemplates(base, current).summary.changed).toBe(0);
  });

  it("lists every changed semantic field, sorted", () => {
    const base = doc([node({ id: "a", team: "Core" })]);
    const current = doc([node({ id: "a", team: "Data", status: "deprecated", tags: ["x"] })]);
    expect(diffTemplates(base, current).nodes.changed[0].fields).toEqual([
      "status",
      "tags",
      "team",
    ]);
  });

  it("diffs edges and zones too, ignoring labelT and points", () => {
    const base = validateTemplate({
      version: 1,
      zones: [
        { id: "z", label: "Zone", shape: "rect", x: 0, y: 0, w: 500, h: 400, providers: ["azure", "aws"], provider: "azure" },
      ],
      nodes: [node({ id: "a" }), node({ id: "b", x: 300 })],
      edges: [edge({ labelT: 0.3 })],
    });
    const current = validateTemplate({
      ...base,
      zones: [{ ...base.zones![0], provider: "aws" }],
      edges: [{ ...base.edges[0], labelT: 0.8, tech: "gRPC" }],
    });
    const d = diffTemplates(base, current);
    expect(d.zones.changed).toEqual([{ id: "z", fields: ["provider"] }]);
    expect(d.edges.changed).toEqual([{ id: "e", fields: ["tech"] }]);
  });

  it("honours a custom ignore list", () => {
    const base = doc([node({ id: "a", label: "Old" })]);
    const current = doc([node({ id: "a", label: "New" })]);
    expect(diffTemplates(base, current, { ignore: ["label"] }).summary.changed).toBe(0);
  });
});

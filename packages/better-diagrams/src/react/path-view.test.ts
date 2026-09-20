/**
 * path-view.test.ts — the pure pass that flags the canvas for lit paths.
 */
import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { toReactFlow, validateTemplate } from "../contract/schema";
import { applyPathView, buildPathGlowIndex, glowShadow } from "./path-view";

const DOC = validateTemplate({
  version: 1,
  nodes: [
    { id: "a", label: "A", kind: "service", x: 0, y: 0 },
    { id: "b", label: "B", kind: "service", x: 300, y: 0 },
    { id: "c", label: "C", kind: "service", x: 600, y: 0 },
    { id: "box", label: "Box", kind: "group", x: 0, y: 200, w: 300, h: 200 },
    { id: "inner", label: "Inner", kind: "service", parentId: "box", x: 20, y: 40 },
  ],
  edges: [
    { id: "ab", source: "a", target: "b" },
    { id: "bc", source: "b", target: "c" },
    { id: "ai", source: "a", target: "inner" },
  ],
  paths: [
    { id: "p1", title: "One", steps: ["a", "b", "c"] },
    { id: "p2", title: "Two", steps: ["c", "b"], color: "rose" },
  ],
});

const rf = () => {
  const { nodes, edges } = toReactFlow(DOC);
  return { nodes: nodes as Node[], edges: edges as Edge[] };
};

describe("buildPathGlowIndex", () => {
  it("is null when nothing is lit, or nothing to light", () => {
    expect(buildPathGlowIndex(DOC, [])).toBeNull();
    expect(buildPathGlowIndex(DOC, ["nope"])).toBeNull();
    expect(buildPathGlowIndex({ ...DOC, paths: undefined }, ["p1"])).toBeNull();
  });

  it("resolves each lit path into per-element entries with the path's stable colour", () => {
    const index = buildPathGlowIndex(DOC, ["p2"])!;
    // p2 is the second path: its own colour wins over the cycle's "emerald".
    expect(index.nodes.get("c")).toEqual([{ pathId: "p2", color: "rose", step: 0, steps: 3, animate: true }]);
    expect(index.edges.get("bc")).toEqual([{ pathId: "p2", color: "rose", step: 1, steps: 3, reversed: true, animate: true }]);
    expect(index.nodes.get("a")).toBeUndefined();
  });

  it("stacks entries for an element on several lit paths", () => {
    const index = buildPathGlowIndex(DOC, ["p2", "p1"])!;
    expect(index.nodes.get("b")!.map((g) => g.pathId)).toEqual(["p1", "p2"]);
    // p1 is the first path and has no colour of its own: sky, the cycle's first.
    expect(index.nodes.get("b")![0].color).toBe("sky");
  });

  it("moves only the shortest lit path — or the route singled out", () => {
    // p1 has five steps, p2 three: p2 moves, p1 keeps a still halo.
    const both = buildPathGlowIndex(DOC, ["p1", "p2"])!;
    expect(both.nodes.get("b")!.map((g) => [g.pathId, g.animate ?? false])).toEqual([["p1", false], ["p2", true]]);
    expect(both.edges.get("ab")![0].animate).toBeUndefined();
    // A singled-out route moves whatever its length.
    const long = { id: "r", title: "Long", steps: ["a", "b", "c", "d", "e"] };
    const bright = buildPathGlowIndex(DOC, ["p2"], [long], { bright: true })!;
    expect(bright.nodes.get("a")!.find((g) => g.pathId === "r")!.animate).toBe(true);
    expect(bright.nodes.get("c")!.find((g) => g.pathId === "p2")!.animate).toBeUndefined();
  });
});

describe("applyPathView", () => {
  it("returns the inputs untouched when nothing is lit", () => {
    const { nodes, edges } = rf();
    const out = applyPathView(nodes, edges, null);
    expect(out.nodes).toBe(nodes);
    expect(out.edges).toBe(edges);
  });

  it("flags members and leaves everything else by identity", () => {
    const { nodes, edges } = rf();
    const out = applyPathView(nodes, edges, buildPathGlowIndex(DOC, ["p1"]));
    const b = out.nodes.find((n) => n.id === "b")!;
    expect(b.className).toBe("as-path-node");
    const style = b.style as Record<string, unknown>;
    expect(style["--as-path-ink"]).toBe("var(--as-edge-sky)");
    expect(style["--as-path-step"]).toBe(2);
    expect(style["--as-path-steps"]).toBe(5);
    expect(String(style["--as-path-shadow"])).toContain("var(--as-edge-sky)");
    // toReactFlow's own wrapper style survives.
    expect(style.width).toBe(nodes.find((n) => n.id === "b")!.style!.width);

    const ab = out.edges.find((e) => e.id === "ab")!;
    expect(ab.className).toBe("as-path-edge");
    expect(ab.data!.pathGlow).toEqual([{ pathId: "p1", color: "sky", step: 1, steps: 5, animate: true }]);

    const inner = nodes.find((n) => n.id === "inner")!;
    expect(out.nodes.find((n) => n.id === "inner")).toBe(inner);
    expect(out.edges.find((e) => e.id === "ai")).toBe(edges.find((e) => e.id === "ai"));
  });

  it("appends to an existing class rather than replacing it", () => {
    const { nodes, edges } = rf();
    const flagged = nodes.map((n) => (n.id === "a" ? { ...n, className: "as-future" } : n));
    const out = applyPathView(flagged, edges, buildPathGlowIndex(DOC, ["p1"]));
    expect(out.nodes.find((n) => n.id === "a")!.className).toBe("as-future as-path-node");
  });

  it("reaches a lit element through the ids a view gives it", () => {
    const { nodes, edges } = rf();
    const index = buildPathGlowIndex(DOC, ["p1"]);
    const synthetic = [
      { ...nodes[0], id: "ghost:b" },
      { ...nodes[0], id: "boundary:b" },
      { ...nodes[0], id: "zone:b" },
    ];
    const outNodes = applyPathView(synthetic, [], index).nodes;
    expect(outNodes[0].className).toBe("as-path-node");
    expect(outNodes[1].className).toBe("as-path-node");
    expect(outNodes[2]).toBe(synthetic[2]); // a zone is never on a path
    const outEdges = applyPathView([], [{ ...edges[0], id: "collapsed:ab" }, { ...edges[0], id: "ghost:ab" }], index).edges;
    expect(outEdges.every((e) => e.className === "as-path-edge")).toBe(true);
  });
});

describe("glowShadow", () => {
  it("draws one ring per path, each wider than the last", () => {
    const one = glowShadow([{ pathId: "p", color: "sky", step: 0, steps: 1 }]);
    expect(one.split(", 0 0 ").length).toBe(2);
    expect(one).toContain("0 0 0 1.5px var(--as-edge-sky)");
    expect(one).toContain("var(--as-glow-blur) 2px");
    expect(one).toContain("var(--as-glow-alpha)");
    const two = glowShadow([
      { pathId: "p", color: "sky", step: 0, steps: 1 },
      { pathId: "q", color: "rose", step: 0, steps: 1 },
    ]);
    expect(two).toContain("var(--as-glow-blur) 6px color-mix(in srgb, var(--as-edge-rose)");
  });
});

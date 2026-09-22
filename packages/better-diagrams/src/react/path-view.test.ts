/**
 * path-view.test.ts — the pure pass that flags the canvas for lit paths.
 */
import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { toReactFlow, validateTemplate, type DiagramTemplate } from "../contract/schema";
import { scopedView } from "../contract/scope";
import { applyOutsideView, applyPathView, buildPathGlowIndex, canvasStandIns, glowShadow, keptOnCanvas, representatives } from "./path-view";

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

/**
 * Stand-ins: a route through a group's hidden contents, seen from the level
 * above. Root holds A, B and group G; G holds X, Y and X2. The route is
 * A → X → Y → B, and A's OTHER line into G (to X2) is declared first, so the
 * re-routed line into the chip borrows that edge's id rather than the route's.
 */
const NESTED = validateTemplate({
  version: 1,
  nodes: [
    // A carries the field its line into G is anchored on, so the anchor
    // survives validation and a bright route has a key to name.
    { id: "a", label: "A", kind: "table", x: 0, y: 0, fields: [{ id: "x_id", name: "x_id", key: "fk" }] },
    { id: "g", label: "G", kind: "group", x: 300, y: 0, w: 400, h: 200, collapsed: true },
    { id: "x", label: "X", kind: "service", parentId: "g", x: 20, y: 20 },
    { id: "y", label: "Y", kind: "service", parentId: "g", x: 220, y: 20 },
    { id: "x2", label: "X2", kind: "service", parentId: "g", x: 20, y: 120 },
    { id: "b", label: "B", kind: "service", x: 800, y: 0 },
  ],
  edges: [
    { id: "a-x2", source: "a", target: "x2" },
    { id: "a-x", source: "a", target: "x", startField: "x_id" },
    { id: "x-y", source: "x", target: "y" },
    { id: "y-b", source: "y", target: "b" },
  ],
  paths: [{ id: "r", title: "Route", steps: ["a", "x", "y", "b"] }],
}) as DiagramTemplate;
const expanded = (t: DiagramTemplate): DiagramTemplate => ({
  ...t,
  nodes: t.nodes.map((n) => (n.id === "g" ? { ...n, collapsed: false } : n)),
});
const canvasOf = (t: DiagramTemplate) => {
  const { nodes, edges } = toReactFlow(t);
  return { nodes: nodes as Node[], edges: edges as Edge[] };
};
const litNodes = (nodes: Node[]) => nodes.filter((n) => n.className?.includes("as-path-node")).map((n) => n.id);
const litEdges = (edges: Edge[]) => edges.filter((e) => e.className?.includes("as-path-edge")).map((e) => e.id);
const inside = (nodes: Node[], id: string) =>
  (nodes.find((n) => n.id === id)!.domAttributes as Record<string, string> | undefined)?.["data-path-inside"];

describe("representatives", () => {
  it("maps a drawn node to what draws it, and a hidden one to the chip folding it", () => {
    const { nodes } = canvasOf(NESTED);
    const reps = representatives(NESTED, nodes.map((n) => n.id));
    expect(reps.get("a")).toBe("a");
    expect(reps.get("g")).toBe("g");
    expect(reps.get("x")).toBe("g");
    expect(reps.get("y")).toBe("g");
    expect(reps.get("x2")).toBe("g");
  });

  it("at a drilled level: ghosts for the outside, the boundary for the focus, and never the boundary for a hidden child", () => {
    const level = scopedView(NESTED, "g");
    const { nodes } = canvasOf(level);
    const reps = representatives(NESTED, nodes.map((n) => n.id));
    expect(reps.get("a")).toBe("ghost:a");
    expect(reps.get("b")).toBe("ghost:b");
    expect(reps.get("g")).toBe("boundary:g");
    expect(reps.get("x")).toBe("x");
    // A child of the focus missing from its own level is missing for some
    // other reason than depth — nothing stands for it.
    const withoutY = nodes.filter((n) => n.id !== "y");
    expect(representatives(NESTED, withoutY.map((n) => n.id)).has("y")).toBe(false);
  });

  it("refuses an open frame: a child hidden by something other than depth lights nothing", () => {
    const { nodes } = canvasOf(expanded(NESTED));
    const withoutX = nodes.filter((n) => n.id !== "x");
    const reps = representatives(NESTED, withoutX.map((n) => n.id));
    expect(reps.has("x")).toBe(false);
    expect(reps.get("y")).toBe("y");
  });

  it("a card whose children are its next level stands for them", () => {
    const levels = validateTemplate({
      version: 1,
      nodes: [
        { id: "sys", label: "System", kind: "service", x: 0, y: 0 },
        { id: "api", label: "API", kind: "service", parentId: "sys", x: 0, y: 0 },
      ],
      edges: [],
    }) as DiagramTemplate;
    const { nodes } = canvasOf(levels);
    expect(nodes.map((n) => n.id)).toEqual(["sys"]);
    expect(representatives(levels, ["sys"]).get("api")).toBe("sys");
  });
});

describe("applyPathView through stand-ins", () => {
  const index = () => buildPathGlowIndex(NESTED, ["r"])!;

  it("from the level above, a route through a collapsed group lights the chip and both lines into it", () => {
    const { nodes, edges } = canvasOf(NESTED);
    // Without the document: the route breaks at the chip, and the line in
    // borrows another edge's id so it stays dark. This is what used to show.
    const before = applyPathView(nodes, edges, index());
    expect(litNodes(before.nodes)).toEqual(["a", "b"]);
    expect(litEdges(before.edges)).toEqual(["collapsed:y-b"]);

    const out = applyPathView(nodes, edges, index(), canvasStandIns(NESTED, nodes, edges));
    expect(litNodes(out.nodes)).toEqual(["a", "g", "b"]);
    expect(litEdges(out.edges)).toEqual(["collapsed:a-x2", "collapsed:y-b"]);
    // The chip says how many of the route's elements it hides, and takes
    // the earliest of their places in the walk; its sibling X2 is not on it.
    expect(inside(out.nodes, "g")).toBe("2");
    const style = out.nodes.find((n) => n.id === "g")!.style as Record<string, unknown>;
    expect(style["--as-path-step"]).toBe(2);
    expect(style["--as-path-steps"]).toBe(7);
    expect(inside(out.nodes, "a")).toBeUndefined();
    // The line's glow is the route's own hop, once, animating with it.
    const line = out.edges.find((e) => e.id === "collapsed:a-x2")!;
    expect(line.data!.pathGlow).toEqual([{ pathId: "r", color: "sky", step: 1, steps: 7, animate: true }]);
  });

  it("a bright stand-in line names the key of the edge it bundles, not of the edge lending it an id", () => {
    const { nodes, edges } = canvasOf(NESTED);
    const route = { id: "~r", title: "Route", steps: ["a", "x", "y", "b"] };
    const out = applyPathView(nodes, edges, buildPathGlowIndex(NESTED, [], [route], { bright: true }), canvasStandIns(NESTED, nodes, edges));
    const line = out.edges.find((e) => e.id === "collapsed:a-x2")!;
    expect(line.className).toBe("as-path-edge as-path-edge--bright");
    expect(line.data!.routeKey).toBe("x_id");
  });

  it("with the group expanded, nothing changes: every member is drawn under its own id", () => {
    const doc = expanded(NESTED);
    const { nodes, edges } = canvasOf(doc);
    const out = applyPathView(nodes, edges, index(), canvasStandIns(doc, nodes, edges));
    expect(out).toEqual(applyPathView(nodes, edges, index()));
    expect(litNodes(out.nodes)).toEqual(["a", "b", "x", "y"]);
    expect(nodes.filter((n) => inside(out.nodes, n.id) !== undefined)).toEqual([]);
  });

  it("drilled into the group, the ghosts and ghost lines light — as before", () => {
    const { nodes, edges } = canvasOf(scopedView(NESTED, "g"));
    const out = applyPathView(nodes, edges, index(), canvasStandIns(NESTED, nodes, edges));
    expect(litNodes(out.nodes)).toEqual(["x", "y", "ghost:a", "ghost:b"]);
    expect(litEdges(out.edges)).toEqual(["ghost:a-x", "x-y", "ghost:y-b"]);
    expect(out).toEqual(applyPathView(nodes, edges, index()));
  });

  it("an element on the path in its own right keeps its own step ahead of what it hides", () => {
    // G itself is a step of the path (a=0, g=1 — no line joins them), and
    // hides X (2) and Y — its own place wins.
    const viaG = validateTemplate({ ...NESTED, paths: [{ id: "p", title: "P", steps: ["a", "g", "x", "y", "b"] }] }) as DiagramTemplate;
    const { nodes, edges } = canvasOf(viaG);
    const out = applyPathView(nodes, edges, buildPathGlowIndex(viaG, ["p"])!, canvasStandIns(viaG, nodes, edges));
    const g = out.nodes.find((n) => n.id === "g")!;
    expect((g.style as Record<string, unknown>)["--as-path-step"]).toBe(1);
    expect(inside(out.nodes, "g")).toBe("2");
    // One halo ring: a path counts once on a node however many of its hops
    // the node hides.
    expect(String((g.style as Record<string, unknown>)["--as-path-shadow"]).split(", 0 0 ").length).toBe(2);
  });

  it("leaves the canvas by identity when nothing lit is hidden", () => {
    const { nodes, edges } = canvasOf(NESTED);
    const only = buildPathGlowIndex(NESTED, [], [{ id: "~ab", title: "AB", steps: ["a", "b"] }]);
    const out = applyPathView(nodes, edges, only, canvasStandIns(NESTED, nodes, edges));
    expect(out.nodes.find((n) => n.id === "g")).toBe(nodes.find((n) => n.id === "g"));
    expect(out.edges.find((e) => e.id === "collapsed:a-x2")).toBe(edges.find((e) => e.id === "collapsed:a-x2"));
  });
});

describe("applyOutsideView through stand-ins", () => {
  it("keeps a re-routed line when any edge it bundles is kept", () => {
    const { nodes, edges } = canvasOf(NESTED);
    const keep = new Set(["a-x", "y-b"]);
    // By id alone, the line into the chip borrowed a-x2's name and fades.
    const byId = applyOutsideView(edges, keep);
    expect(byId.find((e) => e.id === "collapsed:a-x2")!.className).toBe("as-edge--outside");
    const out = applyOutsideView(edges, keep, canvasStandIns(NESTED, nodes, edges));
    expect(out.find((e) => e.id === "collapsed:a-x2")).toBe(edges.find((e) => e.id === "collapsed:a-x2"));
    expect(out.find((e) => e.id === "collapsed:y-b")).toBe(edges.find((e) => e.id === "collapsed:y-b"));
    // Nothing in the bundle kept: the line fades like any other.
    const none = applyOutsideView(edges, new Set(["y-b"]), canvasStandIns(NESTED, nodes, edges));
    expect(none.find((e) => e.id === "collapsed:a-x2")!.className).toBe("as-edge--outside");
  });
});

describe("keptOnCanvas", () => {
  it("adds the chip that hides a kept table, and hands back the same set when nothing hides one", () => {
    const { nodes } = canvasOf(NESTED);
    const reps = representatives(NESTED, nodes.map((n) => n.id));
    const keep = new Set(["a", "y"]);
    const widened = keptOnCanvas(keep, reps);
    expect([...widened].sort()).toEqual(["a", "g", "y"]);
    expect(keep.size).toBe(2);
    const drawn = new Set(["a", "b"]);
    expect(keptOnCanvas(drawn, reps)).toBe(drawn);
  });
});

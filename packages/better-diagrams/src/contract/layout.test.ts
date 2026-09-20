/**
 * Arrange modes: "flow" (the default, left to right by proximity) and
 * "untangle" (the same skeleton, optimised so lines neither cross each other
 * nor run through boxes they do not touch).
 */
import { describe, expect, it } from "vitest";
import { autoLayout, hasOverlaps } from "./layout";
import { validateTemplate, type DiagramNode, type DiagramTemplate } from "./schema";

const node = (id: string, over: Partial<DiagramNode> = {}) => ({
  id,
  label: id.toUpperCase(),
  kind: "service",
  icon: "box",
  description: "",
  parentId: null,
  x: 0,
  y: 0,
  w: 170,
  h: 76,
  ...over,
});
const edge = (source: string, target: string) => ({
  id: `${source}-${target}`,
  source,
  target,
  label: "",
  style: "solid",
  color: "slate",
});

const doc = (
  nodes: ReturnType<typeof node>[],
  edges: ReturnType<typeof edge>[],
  extra: Record<string, unknown> = {},
): DiagramTemplate => validateTemplate({ version: 1, nodes, edges, ...extra });

type Pt = { x: number; y: number };
const centreOf = (t: DiagramTemplate, id: string): Pt => {
  const n = t.nodes.find((x) => x.id === id)!;
  return { x: n.x + n.w / 2, y: n.y + n.h / 2 };
};
/** Do two segments properly cross (touching at an endpoint does not count)? */
const cross = (a: Pt, b: Pt, c: Pt, d: Pt): boolean => {
  const orient = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
};
/** Does the centre-to-centre line of an edge pass through a box it does not touch? */
const lineThroughBox = (t: DiagramTemplate, source: string, target: string, id: string): boolean => {
  const a = centreOf(t, source);
  const b = centreOf(t, target);
  const n = t.nodes.find((x) => x.id === id)!;
  // Liang–Barsky clip of the segment against the box.
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const checks: Array<[number, number]> = [
    [-dx, a.x - n.x],
    [dx, n.x + n.w - a.x],
    [-dy, a.y - n.y],
    [dy, n.y + n.h - a.y],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return false;
  }
  return true;
};
/** Every pair of lines (centre to centre) that cross. */
const crossings = (t: DiagramTemplate): number => {
  let n = 0;
  for (let i = 0; i < t.edges.length; i += 1) {
    for (let j = i + 1; j < t.edges.length; j += 1) {
      const p = t.edges[i]!;
      const q = t.edges[j]!;
      if (new Set([p.source, p.target, q.source, q.target]).size < 4) continue;
      if (cross(centreOf(t, p.source), centreOf(t, p.target), centreOf(t, q.source), centreOf(t, q.target))) n += 1;
    }
  }
  return n;
};

describe("arrange modes", () => {
  it("flow is the default, and naming it changes nothing", () => {
    const t = doc([node("a"), node("b"), node("c")], [edge("a", "b"), edge("a", "c")]);
    expect(autoLayout(t, { mode: "flow" })).toEqual(autoLayout(t));
  });

  it("untangle removes a crossing that only re-ordering the first rank can fix", () => {
    // Document order puts a above b above c; x and y are ordered by their
    // predecessors, which ties — so flow leaves a→y crossing b→x. Only
    // moving b (or a and c) in the FIRST rank untangles it, which takes the
    // upward sweep flow does not make.
    const t = doc(
      [node("a"), node("b"), node("c"), node("x"), node("y")],
      [edge("a", "y"), edge("b", "x"), edge("c", "y")],
    );
    expect(crossings(autoLayout(t))).toBeGreaterThan(0);
    expect(crossings(autoLayout(t, { mode: "untangle" }))).toBe(0);
  });

  it("untangle gives a line that skips a rank a lane of its own", () => {
    // a→b→c plus a→c: in flow all three sit on one spine, so the long line
    // runs straight through b.
    const t = doc([node("a"), node("b"), node("c")], [edge("a", "b"), edge("b", "c"), edge("a", "c")]);
    expect(lineThroughBox(autoLayout(t), "a", "c", "b")).toBe(true);
    const untangled = autoLayout(t, { mode: "untangle" });
    expect(lineThroughBox(untangled, "a", "c", "b")).toBe(false);
    // Still left to right, still no boxes on top of each other.
    const [a, b, c] = ["a", "b", "c"].map((id) => untangled.nodes.find((n) => n.id === id)!);
    expect(a.x).toBeLessThan(b.x);
    expect(b.x).toBeLessThan(c.x);
    expect(hasOverlaps(untangled)).toBe(false);
  });

  it("pulls a node next to the one thing it feeds instead of stretching the line", () => {
    // a→b→c→d, and x→d: x is a source, but its only line goes to the last
    // rank, so it belongs beside c — not in the first column with a.
    const t = doc(
      [node("a"), node("b"), node("c"), node("d"), node("x")],
      [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("x", "d")],
    );
    for (const mode of ["flow", "untangle"] as const) {
      const out = autoLayout(t, { mode });
      const at = (id: string) => out.nodes.find((n) => n.id === id)!;
      expect(at("x").x).toBe(at("c").x);
      expect(at("x").x).toBeLessThan(at("d").x);
    }
    // A node with as many lines in as out stays put: nothing is gained.
    const even = doc([node("a"), node("m"), node("z")], [edge("a", "m"), edge("m", "z")]);
    const out = autoLayout(even);
    const xs = ["a", "m", "z"].map((id) => out.nodes.find((n) => n.id === id)!.x);
    expect(xs[0]).toBeLessThan(xs[1]!);
    expect(xs[1]).toBeLessThan(xs[2]!);
  });

  it("untangle parks boxes no line touches after the flow", () => {
    const t = doc([node("lonely"), node("a"), node("b")], [edge("a", "b")]);
    const out = autoLayout(t, { mode: "untangle" });
    const at = (id: string) => out.nodes.find((n) => n.id === id)!;
    expect(at("lonely").x).toBeGreaterThan(at("b").x);
    // Flow, by contrast, ranks it as a source next to a.
    const flow = autoLayout(t);
    expect(flow.nodes.find((n) => n.id === "lonely")!.x).toBe(flow.nodes.find((n) => n.id === "a")!.x);
  });

  it("the document's settings.arrange drives a Tidy that names no mode", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges = [edge("a", "b"), edge("b", "c"), edge("a", "c")];
    const stored = doc(nodes, edges, { settings: { arrange: "untangle" } });
    expect(stored.settings).toEqual({ arrange: "untangle" });
    expect(autoLayout(stored).nodes).toEqual(autoLayout(stored, { mode: "untangle" }).nodes);
    // An explicit option still wins over the document.
    expect(autoLayout(stored, { mode: "flow" }).nodes).toEqual(autoLayout(doc(nodes, edges)).nodes);
    // Junk is dropped like any other setting.
    expect(doc(nodes, edges, { settings: { arrange: "spiral" } }).settings).toBeUndefined();
  });

  it("untangle grows a group around its members, lane included", () => {
    const t = doc(
      [
        node("g", { kind: "group", w: 100, h: 100 }),
        node("a", { parentId: "g" }),
        node("b", { parentId: "g" }),
        node("c", { parentId: "g" }),
      ],
      [edge("a", "b"), edge("b", "c"), edge("a", "c")],
      { settings: { arrange: "untangle" } },
    );
    const out = autoLayout(t);
    const g = out.nodes.find((n) => n.id === "g")!;
    for (const id of ["a", "b", "c"]) {
      const n = out.nodes.find((x) => x.id === id)!;
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w).toBeLessThanOrEqual(g.w);
      expect(n.y + n.h).toBeLessThanOrEqual(g.h);
    }
  });

  it("untangle handles a big tangled graph without overlaps, and stays deterministic", () => {
    const nodes: ReturnType<typeof node>[] = [];
    const edges: ReturnType<typeof edge>[] = [];
    for (let i = 0; i < 60; i += 1) nodes.push(node(`n${i}`));
    // A pseudo-random but fixed wiring, cycles included.
    let seed = 7;
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let i = 0; i < 120; i += 1) {
      const s = Math.floor(rnd() * 60);
      const d = Math.floor(rnd() * 60);
      if (s !== d) edges.push({ ...edge(`n${s}`, `n${d}`), id: `e${i}` });
    }
    const t = doc(nodes, edges);
    const first = autoLayout(t, { mode: "untangle" });
    expect(hasOverlaps(first)).toBe(false);
    expect(first.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
    expect(autoLayout(t, { mode: "untangle" })).toEqual(first);
    // Fewer crossings than the one-pass flow — the whole point.
    expect(crossings(first)).toBeLessThanOrEqual(crossings(autoLayout(t)));
  });
});

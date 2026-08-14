/**
 * Edge path specs: pinned anchors and waypoints — validation, geometry, and
 * the staleness policy (what happens to a hand-drawn route when the things
 * around it move).
 */
import { describe, expect, it } from "vitest";
import {
  fromReactFlow,
  toReactFlow,
  validateTemplate,
  type DiagramTemplate,
} from "./schema";
import { edgeGeometryFor, floatingEdgeGeometry, type Box } from "./geometry";
import { copyFragment, pasteFragment } from "./clipboard";
import { autoLayout } from "./layout";
import { scaleZoneMembers } from "./schema";

const doc = (edgeOver: Record<string, unknown> = {}, nodeOver: Record<string, unknown>[] = []): DiagramTemplate =>
  validateTemplate({
    version: 1,
    nodes: [
      { id: "a", label: "A", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 100, h: 50, ...(nodeOver[0] ?? {}) },
      { id: "b", label: "B", kind: "service", icon: "box", description: "", parentId: null, x: 300, y: 0, w: 100, h: 50, ...(nodeOver[1] ?? {}) },
    ],
    edges: [{ id: "e1", source: "a", target: "b", label: "", style: "solid", color: "slate", ...edgeOver }],
  });

describe("edge path spec validation", () => {
  it("keeps a valid anchor and strips the centred t", () => {
    const t = doc({ start: { side: "left", t: 0.25 }, end: { side: "top", t: 0.5 } });
    expect(t.edges[0].start).toEqual({ side: "left", t: 0.25 });
    // t 0.5 is the default — never stored.
    expect(t.edges[0].end).toEqual({ side: "top" });
  });

  it("drops an anchor with an unknown side and clamps t into 0..1", () => {
    const t = doc({ start: { side: "middle" }, end: { side: "right", t: 4 } });
    expect(t.edges[0].start).toBeUndefined();
    expect(t.edges[0].end).toEqual({ side: "right", t: 1 });
  });

  it("rounds waypoints, drops junk pairs, and caps the list", () => {
    const t = doc({ points: [[10.4, 19.6], ["x", 2], [Infinity, 3], [5, 6]] });
    expect(t.edges[0].points).toEqual([
      [10, 20],
      [5, 6],
    ]);
    const many = doc({ points: Array.from({ length: 40 }, (_, i) => [i, i]) });
    expect(many.edges[0].points).toHaveLength(16);
  });

  it("stores nothing for an empty or absent spec", () => {
    const t = doc({ points: [], start: null });
    expect("points" in t.edges[0]).toBe(false);
    expect("start" in t.edges[0]).toBe(false);
  });

  it("is idempotent: validating twice is byte-identical", () => {
    const once = doc({ start: { side: "bottom", t: 0.2 }, points: [[150, 120]] });
    expect(JSON.stringify(validateTemplate(once))).toBe(JSON.stringify(once));
  });

  it("round-trips through React Flow untouched", () => {
    const t = doc({ start: { side: "bottom", t: 0.2 }, end: { side: "left" }, points: [[150, 120]] });
    const rf = toReactFlow(t);
    expect(rf.edges[0].data.start).toEqual({ side: "bottom", t: 0.2 });
    const back = fromReactFlow(rf.nodes, rf.edges, { meta: t.meta });
    expect(JSON.stringify(back)).toBe(JSON.stringify(t));
  });

  it("drops the spec from collapse-rerouted edges — it describes hidden boxes", () => {
    const t = validateTemplate({
      version: 1,
      nodes: [
        { id: "g", label: "G", kind: "group", icon: "none", description: "", parentId: null, collapsed: true, x: 0, y: 0, w: 400, h: 300 },
        { id: "inner", label: "I", kind: "service", icon: "box", description: "", parentId: "g", x: 30, y: 60, w: 170, h: 76 },
        { id: "out", label: "O", kind: "service", icon: "box", description: "", parentId: null, x: 600, y: 0, w: 170, h: 76 },
      ],
      edges: [
        { id: "e1", source: "inner", target: "out", label: "", style: "solid", color: "slate", start: { side: "right" }, points: [[500, 100]] },
      ],
    });
    const rf = toReactFlow(t);
    const rerouted = rf.edges.find((e) => e.id.startsWith("collapsed:"));
    expect(rerouted).toBeDefined();
    expect(rerouted!.data.start).toBeUndefined();
    expect(rerouted!.data.points).toBeUndefined();
  });
});

describe("spec geometry", () => {
  const source: Box = { x: 0, y: 0, width: 100, height: 50 };
  const target: Box = { x: 300, y: 0, width: 100, height: 50 };

  it("pins endpoints to the chosen side and fraction", () => {
    const geo = edgeGeometryFor("curved", source, target, 0.5, {
      start: { side: "bottom" },
      end: { side: "left", t: 0.25 },
    });
    expect(geo.at(0)).toEqual({ x: 50, y: 50 });
    expect(geo.tip).toEqual({ x: 300, y: 12.5 });
  });

  it("threads the curve through every waypoint", () => {
    const geo = edgeGeometryFor("curved", source, target, 0.5, { points: [[200, 200]] });
    let best = Infinity;
    for (let i = 0; i <= 100; i++) {
      const q = geo.at(i / 100);
      best = Math.min(best, Math.hypot(q.x - 200, q.y - 200));
    }
    expect(best).toBeLessThan(1);
  });

  it("keeps every orthogonal segment axis-aligned through free waypoints", () => {
    const geo = edgeGeometryFor("orthogonal", source, target, 0.5, { points: [[180, 170], [260, 90]] });
    const pts = geo.path
      .split(/[ML]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split(" ").map(Number));
    expect(pts.length).toBeGreaterThan(3);
    for (let i = 1; i < pts.length; i++) {
      const straight = pts[i][0] === pts[i - 1][0] || pts[i][1] === pts[i - 1][1];
      expect(straight, `segment ${i} is diagonal`).toBe(true);
    }
    // And it still passes through the waypoints.
    expect(pts).toContainEqual([180, 170]);
    expect(pts).toContainEqual([260, 90]);
  });

  it("chooses the exit side toward the first waypoint, not the far box", () => {
    // Target is to the RIGHT, but the route dives BELOW the source first.
    const geo = edgeGeometryFor("curved", source, target, 0.5, { points: [[50, 300]] });
    const origin = geo.at(0);
    expect(origin.y).toBe(50); // bottom side, not the right side (x=100).
  });

  it("is byte-identical to the floating router when the spec is empty", () => {
    const spec = edgeGeometryFor("curved", source, target, 0.5, {});
    const floating = floatingEdgeGeometry(source, target, 0.5);
    expect(spec.path).toBe(floating.path);
  });
});

describe("route staleness policy", () => {
  it("paste offsets waypoints with the nodes they run between", () => {
    const t = doc({ points: [[150, 120]] });
    const fragment = copyFragment(t, ["a", "b"]);
    const pasted = pasteFragment(t, fragment, { makeId: (p) => `${p}_copy` });
    const copy = pasted.template.edges.find((e) => e.id !== "e1");
    expect(copy?.points).toEqual([[178, 148]]);
  });

  it("tidy clears waypoints but keeps pinned anchors", () => {
    const t = doc({ start: { side: "bottom" }, points: [[150, 120]] });
    const tidied = autoLayout(t);
    expect(tidied.edges[0].points).toBeUndefined();
    expect(tidied.edges[0].start).toEqual({ side: "bottom" });
  });

  it("zone scaling carries a route whose endpoints both scaled", () => {
    const t = validateTemplate({
      version: 1,
      zones: [{ id: "z1", label: "Z", provider: "aws", providers: ["aws"], x: 0, y: 0, w: 400, h: 300 }],
      nodes: [
        { id: "a", label: "A", kind: "service", icon: "box", description: "", parentId: null, zoneId: "z1", x: 20, y: 60, w: 100, h: 50 },
        { id: "b", label: "B", kind: "service", icon: "box", description: "", parentId: null, zoneId: "z1", x: 250, y: 60, w: 100, h: 50 },
        { id: "c", label: "C", kind: "service", icon: "box", description: "", parentId: null, x: 600, y: 0, w: 100, h: 50 },
      ],
      edges: [
        { id: "e1", source: "a", target: "b", label: "", style: "solid", color: "slate", points: [[100, 100]] },
        { id: "e2", source: "a", target: "c", label: "", style: "solid", color: "slate", points: [[500, 40]] },
      ],
    });
    const scaled = scaleZoneMembers(t, "z1", { x: 0, y: 0, w: 400, h: 300 }, { x: 0, y: 0, w: 800, h: 600 });
    // Both ends inside: the route rides the transform.
    expect(scaled.edges[0].points).toEqual([[200, 200]]);
    // One end outside: half a transform would bend it unpredictably — untouched.
    expect(scaled.edges[1].points).toEqual([[500, 40]]);
  });
});

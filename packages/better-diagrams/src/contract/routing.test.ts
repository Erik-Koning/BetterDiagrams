/**
 * Edge path specs: pinned anchors and waypoints — validation, geometry, and
 * the staleness policy (what happens to a hand-drawn route when the things
 * around it move).
 */
import { describe, expect, it } from "vitest";
import {
  DIAGRAM_SYSTEM_PROMPT,
  fromReactFlow,
  toReactFlow,
  validateTemplate,
  type DiagramTemplate,
} from "./schema";
import {
  anchorFromPoint,
  edgeGeometryFor,
  edgeHeadPath,
  floatingEdgeGeometry,
  type Box,
} from "./geometry";
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

  it("keeps every orthogonal segment axis-aligned, elbows rounded, through free waypoints", () => {
    const geo = edgeGeometryFor("orthogonal", source, target, 0.5, { points: [[180, 170], [260, 90]] });
    // The path is straight strokes joined by small Q arcs at the elbows.
    // Every STRAIGHT stroke must stay axis-aligned; each arc's control point
    // is the sharp corner itself, so the route still turns exactly at the
    // waypoints it was given.
    expect(geo.path).toContain("Q"); // the elbows are rounded
    const tokens = geo.path.match(/[MLQ][^MLQ]+/g)!;
    let prev: number[] | null = null;
    const passes: number[][] = [];
    for (const token of tokens) {
      const nums = token.slice(1).trim().replace(/,/g, " ").split(/\s+/).map(Number);
      if (token[0] === "Q") {
        // The arc's control point IS the sharp corner it rounds.
        passes.push([nums[0], nums[1]]);
        prev = [nums[2], nums[3]];
        continue;
      }
      const pt = [nums[0], nums[1]];
      if (token[0] === "L" && prev) {
        const straight = pt[0] === prev[0] || pt[1] === prev[1];
        expect(straight, `stroke to ${pt} is diagonal`).toBe(true);
      }
      passes.push(pt);
      prev = pt;
    }
    // A waypoint is either a rounded corner (Q control) or sits mid-stroke.
    expect(passes).toContainEqual([180, 170]);
    expect(passes).toContainEqual([260, 90]);
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

describe("spline continuity through waypoints", () => {
  const source: Box = { x: 0, y: 0, width: 100, height: 50 };
  const target: Box = { x: 300, y: 0, width: 100, height: 50 };

  /** The path's cubic segments, with the running start point attached. */
  function parseCubics(path: string) {
    const chunks = path.split("C").map((s) => s.trim().replace(/,/g, "").split(/\s+/).map(Number));
    let a = { x: chunks[0][1], y: chunks[0][2] };
    return chunks.slice(1).map((c) => {
      const seg = { a, c1: { x: c[0], y: c[1] }, c2: { x: c[2], y: c[3] }, b: { x: c[4], y: c[5] } };
      a = seg.b;
      return seg;
    });
  }

  /** Assert the line leaves each dot at the same angle it entered. */
  function expectG1(path: string) {
    const segs = parseCubics(path);
    for (let i = 1; i < segs.length; i++) {
      const entry = { x: segs[i - 1].b.x - segs[i - 1].c2.x, y: segs[i - 1].b.y - segs[i - 1].c2.y };
      const exit = { x: segs[i].c1.x - segs[i].a.x, y: segs[i].c1.y - segs[i].a.y };
      const cross = entry.x * exit.y - entry.y * exit.x;
      const dot = entry.x * exit.x + entry.y * exit.y;
      const scale = Math.max(1, Math.hypot(entry.x, entry.y) * Math.hypot(exit.x, exit.y));
      // Parallel (zero cross product) and pointing the same way — one angle
      // through the dot, whatever the two sides' magnitudes.
      expect(Math.abs(cross) / scale, `kink at joint ${i} of ${path}`).toBeLessThan(1e-9);
      expect(dot, `reversal at joint ${i} of ${path}`).toBeGreaterThan(0);
    }
  }

  it("keeps one tangent angle through every dot — entry and exit agree", () => {
    expectG1(edgeGeometryFor("curved", source, target, 0.5, { points: [[130, 90], [260, 140]] }).path);
    // Wildly unequal chords — a dot just past the box next to a long reach.
    expectG1(edgeGeometryFor("curved", source, target, 0.5, { points: [[120, 60]] }).path);
    // Pinned anchors change the launch directions, not the continuity.
    expectG1(
      edgeGeometryFor("curved", source, target, 0.5, {
        start: { side: "bottom" },
        end: { side: "top", t: 0.2 },
        points: [[90, 160], [280, -40]],
      }).path,
    );
  });

  it("a dot dropped just past the box no longer wiggles the line backwards", () => {
    // Everything on this route travels rightward. The uniform Catmull-Rom
    // tangent (half the neighbour chord, on both sides) used to overshoot the
    // short first segment and drag the line back left before the dot — an
    // S-wiggle that read as the curve breaking at the handle.
    const geo = edgeGeometryFor("curved", source, target, 0.5, { points: [[120, 60]] });
    let prev = -Infinity;
    for (let i = 0; i <= 200; i++) {
      const { x } = geo.at(i / 200);
      expect(x, `backtrack at t=${i / 200}`).toBeGreaterThanOrEqual(prev - 0.5);
      prev = Math.max(prev, x);
    }
  });
});

describe("straight routing", () => {
  const source: Box = { x: 0, y: 0, width: 100, height: 50 };
  const target: Box = { x: 300, y: 0, width: 100, height: 50 };

  it("validates, stores, and round-trips routing: straight", () => {
    const t = doc({ routing: "straight" });
    expect(t.edges[0].routing).toBe("straight");
    expect(JSON.stringify(validateTemplate(t))).toBe(JSON.stringify(t));
  });

  it("draws one straight stroke between the facing sides with no spec", () => {
    const geo = edgeGeometryFor("straight", source, target, 0.5);
    expect(geo.path).toBe("M 100 25 L 300 25");
    expect(geo.tip).toEqual({ x: 300, y: 25 });
  });

  it("runs straight strokes through every waypoint", () => {
    const geo = edgeGeometryFor("straight", source, target, 0.5, { points: [[200, 200]] });
    // Both exits face the waypoint below, so the line leaves both bottoms.
    expect(geo.path).toBe("M 50 50 L 200 200 L 350 50");
  });

  it("honours pinned anchors", () => {
    const geo = edgeGeometryFor("straight", source, target, 0.5, {
      start: { side: "top", t: 0.25 },
      end: { side: "bottom" },
    });
    expect(geo.path).toBe("M 25 0 L 350 50");
  });

  it("is advertised to the model alongside the other routings", () => {
    expect(DIAGRAM_SYSTEM_PROMPT).toContain("curved|orthogonal|straight");
  });
});

describe("self-loops", () => {
  const box: Box = { x: 100, y: 100, width: 120, height: 60 };

  it("routes a loop out the right face and back into the top", () => {
    const geo = edgeGeometryFor("curved", box, box, 0.5);
    const o = geo.at(0);
    expect(o.x).toBe(220);
    expect(o.y).toBeCloseTo(100 + 60 * 0.3, 5);
    expect(geo.tip).toEqual({ x: 100 + 120 * 0.7, y: 100 });
    // The loop genuinely leaves the box in between.
    let escaped = false;
    for (let i = 0; i <= 100; i++) {
      const q = geo.at(i / 100);
      if (q.x > 225 || q.y < 95) escaped = true;
    }
    expect(escaped).toBe(true);
  });

  it("reaches the canvas — kept by validation AND by toReactFlow", () => {
    const t = doc({ target: "a" });
    expect(t.edges[0].target).toBe("a");
    const rf = toReactFlow(t);
    expect(rf.edges).toHaveLength(1);
    expect(rf.edges[0].source).toBe("a");
    expect(rf.edges[0].target).toBe("a");
  });

  it("collapse still swallows internal wiring — only REROUTED self-maps drop", () => {
    const t = validateTemplate({
      version: 1,
      nodes: [
        { id: "g", label: "G", kind: "group", icon: "none", description: "", parentId: null, collapsed: true, x: 0, y: 0, w: 400, h: 300 },
        { id: "in1", label: "1", kind: "service", icon: "box", description: "", parentId: "g", x: 20, y: 60, w: 170, h: 76 },
        { id: "in2", label: "2", kind: "service", icon: "box", description: "", parentId: "g", x: 20, y: 160, w: 170, h: 76 },
      ],
      edges: [
        { id: "internal", source: "in1", target: "in2", label: "", style: "solid", color: "slate" },
      ],
    });
    // The internal edge maps chip→chip: a view artifact, never a loop.
    expect(toReactFlow(t).edges).toHaveLength(0);
  });

  it("honours pinned anchors and waypoints on a loop", () => {
    const geo = edgeGeometryFor("curved", box, box, 0.5, {
      start: { side: "bottom" },
      end: { side: "left", t: 0.5 },
      points: [[60, 220]],
    });
    expect(geo.at(0)).toEqual({ x: 136, y: 160 });
    expect(geo.tip).toEqual({ x: 100, y: 130 });
    let best = Infinity;
    for (let i = 0; i <= 100; i++) {
      const q = geo.at(i / 100);
      best = Math.min(best, Math.hypot(q.x - 60, q.y - 220));
    }
    expect(best).toBeLessThan(1);
  });
});

describe("end glyphs (edgeHeadPath)", () => {
  it("draws the classic arrow backward from the attachment — nodes can't cover it", () => {
    const { d, filled } = edgeHeadPath("arrow", { x: 100, y: 50 }, 0);
    expect(filled).toBe(true);
    // Travelling +x into the box at (100,50): the whole glyph stays at x ≤ 100.
    expect(d).toBe("M 100 50 L 91 45.5 L 91 54.5 Z");
  });

  it("strokes the hollow glyphs", () => {
    for (const head of ["open", "diamond", "circle", "bar"] as const) {
      expect(edgeHeadPath(head, { x: 0, y: 0 }, 0).filled).toBe(false);
    }
  });

  it("validates, stores, and round-trips explicit heads — junk is dropped", () => {
    const t = doc({ startHead: "diamond", endHead: "wiggly" });
    expect(t.edges[0].startHead).toBe("diamond");
    expect("endHead" in t.edges[0]).toBe(false);
    const rf = toReactFlow(t);
    expect(rf.edges[0].data.startHead).toBe("diamond");
    const back = fromReactFlow(rf.nodes, rf.edges, { meta: t.meta });
    expect(JSON.stringify(back)).toBe(JSON.stringify(t));
  });
});

describe("dangling arrows (point nodes)", () => {
  const raw = {
    version: 1,
    nodes: [
      { id: "a", label: "A", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 100, h: 50 },
      { id: "p", label: "", kind: "point", icon: "none", description: "", parentId: null, x: 300, y: 100 },
    ],
    edges: [{ id: "e1", source: "a", target: "p", label: "", style: "solid", color: "slate" }],
  };

  it("validates a point node and its edge like any other", () => {
    const t = validateTemplate(raw);
    expect(t.nodes[1].kind).toBe("point");
    // The kind's own default size fills in: a 12px dot, not a service card.
    expect(t.nodes[1].w).toBe(12);
    expect(t.nodes[1].h).toBe(12);
    expect(t.edges).toHaveLength(1);
  });

  it("maps point nodes to their own React Flow type and round-trips", () => {
    const t = validateTemplate(raw);
    const rf = toReactFlow(t);
    expect(rf.nodes.find((n) => n.id === "p")?.type).toBe("point");
    const back = fromReactFlow(rf.nodes, rf.edges, { meta: t.meta });
    expect(JSON.stringify(back)).toBe(JSON.stringify(t));
  });
});

describe("anchorFromPoint", () => {
  const box: Box = { x: 100, y: 100, width: 200, height: 100 };

  it("picks the nearest side and the fraction along it", () => {
    expect(anchorFromPoint(box, { x: 150, y: 95 })).toEqual({ side: "top", t: 0.25 });
    expect(anchorFromPoint(box, { x: 90, y: 150 })).toEqual({ side: "left", t: 0.5 });
    expect(anchorFromPoint(box, { x: 310, y: 175 })).toEqual({ side: "right", t: 0.75 });
  });

  it("projects a far-away point back onto the perimeter", () => {
    expect(anchorFromPoint(box, { x: 200, y: 500 })).toEqual({ side: "bottom", t: 0.5 });
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

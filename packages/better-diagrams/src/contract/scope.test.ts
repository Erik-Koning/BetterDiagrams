/**
 * Scoped views: the derivation rules and THE law — lifting a scoped canvas
 * yields the base document byte-for-byte. Everything scopedView strips or
 * forces, liftScopedReactFlow must restore; these tests are the proof.
 */
import { describe, expect, it } from "vitest";
import {
  BOUNDARY_NODE_PREFIX,
  GHOST_NODE_PREFIX,
  isCollapsedEdgeId,
  isGhostEdgeId,
  isGhostNodeId,
  toReactFlow,
  validateTemplate,
  type DiagramTemplate,
  type RFEdgeLike,
} from "./schema";
import { drillableIds, focusPath, liftScopedReactFlow, scopedView } from "./scope";

const node = (over: Record<string, unknown> = {}) => ({
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
});

/**
 * The kitchen-sink document: a card parent with drill detail (nested group
 * chip, authentically collapsed group, card grandchild), an expanded group at
 * root, zones, waypoints and anchors in every position, converging externals,
 * and a saved per-view ghost placement.
 */
const DOC: DiagramTemplate = validateTemplate({
  version: 1,
  meta: {
    title: "Drill",
    routing: "orthogonal",
    views: { pay: { nodes: { "ghost:web": { x: 120, y: 40, w: 170, h: 76 } } } },
  },
  zones: [
    { id: "cloud", label: "Cloud", shape: "rect", provider: "aws", providers: ["aws"], x: 500, y: 0, w: 900, h: 700 },
  ],
  nodes: [
    node({ id: "web", x: 100, y: 100 }),
    node({ id: "ops", x: 100, y: 300 }),
    node({ id: "pay", label: "Payments", x: 600, y: 100, zoneId: "cloud", date: "2026-06-15" }),
    node({ id: "vpc", label: "VPC", kind: "group", x: 900, y: 300, w: 400, h: 300, zoneId: "cloud" }),
    node({ id: "db", parentId: "vpc", x: 30, y: 60, zoneId: "cloud" }),
    node({ id: "db2", parentId: "vpc", x: 230, y: 60, zoneId: "cloud" }),
    // pay's drill level
    node({ id: "api", parentId: "pay", x: 28, y: 52, zoneId: "cloud" }),
    node({ id: "auth", parentId: "pay", x: 28, y: 260 }),
    node({ id: "auth-inner", parentId: "auth", x: 10, y: 10 }),
    node({ id: "workers", kind: "group", parentId: "pay", x: 320, y: 52, w: 300, h: 200 }),
    node({ id: "w1", parentId: "workers", x: 20, y: 60 }),
    node({ id: "cache", kind: "group", collapsed: true, parentId: "pay", x: 320, y: 320, w: 200, h: 150 }),
    node({ id: "cc", parentId: "cache", x: 10, y: 50 }),
  ],
  edges: [
    { id: "e-int", source: "api", target: "auth", label: "verifies", labelT: 0.3, start: { side: "right" }, points: [[110, 200]] },
    { id: "e-cross", source: "web", target: "api", label: "calls", tech: "HTTPS", end: { side: "left" } },
    { id: "e-cross2", source: "auth", target: "db", label: "reads" },
    { id: "e-conv1", source: "w1", target: "ops", label: "alerts" },
    { id: "e-conv2", source: "workers", target: "ops", label: "logs" },
    { id: "e-focus", source: "pay", target: "web", label: "redirects" },
    { id: "e-grand", source: "api", target: "w1", label: "enqueues" },
    { id: "e-deep", source: "cc", target: "auth", label: "warms" },
    { id: "e-vpc", source: "db", target: "db2", label: "replicates", points: [[1000, 420]] },
  ],
}) as DiagramTemplate;

const lift = (focusId: string, doc = DOC) => {
  const rf = toReactFlow(scopedView(doc, focusId));
  return liftScopedReactFlow(rf.nodes, rf.edges, focusId, { base: doc, meta: doc.meta });
};

describe("THE law — lift(toReactFlow(scopedView(t,f))) ≡ t", () => {
  it("holds for a card focus", () => {
    expect(JSON.stringify(lift("pay"))).toBe(JSON.stringify(DOC));
  });

  it("holds for a group focus (root-space waypoints restored)", () => {
    expect(JSON.stringify(lift("vpc"))).toBe(JSON.stringify(DOC));
  });

  it("holds for a nested focus and an empty leaf focus", () => {
    expect(JSON.stringify(lift("workers"))).toBe(JSON.stringify(DOC));
    expect(JSON.stringify(lift("web"))).toBe(JSON.stringify(DOC));
  });
});

describe("scopedView — nodes", () => {
  const view = scopedView(DOC, "pay");
  const byId = new Map(view.nodes.map((n) => [n.id, n]));

  it("emits boundary first: locked group wearing the focus's identity", () => {
    const boundary = view.nodes[0];
    expect(boundary.id).toBe(`${BOUNDARY_NODE_PREFIX}pay`);
    expect(boundary.kind).toBe("group");
    expect(boundary.label).toBe("Payments");
    expect(boundary.locked).toBe(true);
  });

  it("children keep their stored coords verbatim — coordinate identity", () => {
    expect(byId.get("api")).toMatchObject({ x: 28, y: 52, parentId: null, zoneId: null });
    expect(byId.get("auth")).toMatchObject({ x: 28, y: 260 });
  });

  it("one level per view: group child forced to chip, card child stays a card", () => {
    expect(byId.get("workers")!.collapsed).toBe(true);
    expect(byId.get("cache")!.collapsed).toBe(true); // authentic collapse kept
    expect(byId.get("auth")!.collapsed).toBeUndefined(); // card grandparent
    expect(byId.has("w1")).toBe(false);
    expect(byId.has("auth-inner")).toBe(false);
    expect(byId.has("cc")).toBe(false);
  });

  it("boundary wraps children at render size (chips small)", () => {
    const boundary = byId.get(`${BOUNDARY_NODE_PREFIX}pay`)!;
    for (const id of ["api", "auth", "workers", "cache"]) {
      const child = byId.get(id)!;
      expect(child.x).toBeGreaterThanOrEqual(boundary.x);
      expect(child.y).toBeGreaterThanOrEqual(boundary.y);
    }
    // `workers` renders as a 180×44 chip; the frame owes nothing to its
    // stored 300×200 body.
    expect(boundary.x + boundary.w).toBeLessThan(320 + 300 + 28);
  });

  it("derives ghosts with the outside element's identity and effective date", () => {
    const web = byId.get(`${GHOST_NODE_PREFIX}web`)!;
    expect(web.label).toBe("N");
    expect(byId.get(`${GHOST_NODE_PREFIX}db`)!.label).toBe("N");
    // A ghost's saved per-view placement wins over the derived column.
    expect([web.x, web.y]).toEqual([120, 40]);
  });

  it("columns ghosts by direction — senders left, receivers right", () => {
    const noViews = validateTemplate({
      ...JSON.parse(JSON.stringify(DOC)),
      meta: { title: "Drill", routing: "orthogonal" },
    });
    const v = scopedView(noViews, "pay");
    const boundary = v.nodes.find((n) => n.id === `${BOUNDARY_NODE_PREFIX}pay`)!;
    const web = v.nodes.find((n) => n.id === `${GHOST_NODE_PREFIX}web`)!;
    const ops = v.nodes.find((n) => n.id === `${GHOST_NODE_PREFIX}ops`)!;
    expect(web.x + web.w).toBeLessThan(boundary.x); // sends into the level
    expect(ops.x).toBeGreaterThan(boundary.x + boundary.w); // only receives
  });

  it("no zones in a scoped view; empty focus gets a fallback frame", () => {
    expect(scopedView(DOC, "pay").zones).toBeUndefined();
    const empty = scopedView(DOC, "web");
    const boundary = empty.nodes.find((n) => n.id === `${BOUNDARY_NODE_PREFIX}web`)!;
    expect(boundary.w).toBeGreaterThanOrEqual(160);
    expect(boundary.h).toBeGreaterThanOrEqual(120);
    // The leaf's external contracts still show: pay stands in for api.
    expect(empty.nodes.some((n) => n.id === `${GHOST_NODE_PREFIX}pay`)).toBe(true);
  });

  it("marks the doc as a view and throws on an unknown focus", () => {
    expect(scopedView(DOC, "pay").meta?.scopedFocus).toBe("pay");
    expect("views" in (scopedView(DOC, "pay").meta ?? {})).toBe(false);
    expect(() => scopedView(DOC, "nope")).toThrow(/unknown focus/);
  });

  it("is pure and deterministic", () => {
    const before = JSON.stringify(DOC);
    const a = JSON.stringify(scopedView(DOC, "pay"));
    const b = JSON.stringify(scopedView(DOC, "pay"));
    expect(a).toBe(b);
    expect(JSON.stringify(DOC)).toBe(before);
  });
});

describe("scopedView — edges", () => {
  const view = scopedView(DOC, "pay");
  const edge = (id: string) => view.edges.find((e) => e.id === id);

  it("interior edges are verbatim under a card focus — waypoints included", () => {
    expect(edge("e-int")).toMatchObject({
      source: "api",
      target: "auth",
      label: "verifies",
      labelT: 0.3,
      start: { side: "right" },
      points: [[110, 200]],
    });
  });

  it("a group focus drops interior waypoints (root-space numbers)", () => {
    const vpc = scopedView(DOC, "vpc");
    const rep = vpc.edges.find((e) => e.id === "e-vpc")!;
    expect(rep.points).toBeUndefined();
    expect(rep.label).toBe("replicates");
  });

  it("a single crossing edge keeps its payload and inside-end anchor", () => {
    const cross = edge("ghost:e-cross")!;
    expect(cross).toMatchObject({
      source: `${GHOST_NODE_PREFIX}web`,
      target: "api",
      label: "calls",
      tech: "HTTPS",
      end: { side: "left" },
    });
    expect(cross.start).toBeUndefined();
  });

  it("converging externals summarize into one blank stand-in", () => {
    const conv = view.edges.filter((e) => e.target === `${GHOST_NODE_PREFIX}ops`);
    expect(conv).toHaveLength(1);
    expect(conv[0].id).toBe("ghost:e-conv1");
    expect(conv[0].source).toBe("workers");
    expect(conv[0].label).toBe("");
  });

  it("the focus's own edges land on the boundary", () => {
    const own = edge("ghost:e-focus")!;
    expect(own.source).toBe(`${BOUNDARY_NODE_PREFIX}pay`);
    expect(own.target).toBe(`${GHOST_NODE_PREFIX}web`);
  });

  it("grandchild edges remap to the level anchor, blanked", () => {
    expect(edge("ghost:e-grand")).toMatchObject({ source: "api", target: "workers", label: "" });
    expect(edge("ghost:e-deep")).toMatchObject({ source: "cache", target: "auth", label: "" });
    expect(edge("e-grand")).toBeUndefined();
  });

  it("every crossing edge appears exactly once", () => {
    const keys = view.edges.map((e) => `${e.source}→${e.target}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("the view doc renders through toReactFlow without collapse re-routing", () => {
    const rf = toReactFlow(scopedView(DOC, "pay"));
    // Chips have no children in the VIEW doc, so nothing needs rerouting.
    expect(rf.edges.some((e) => isCollapsedEdgeId(e.id))).toBe(false);
    expect(rf.nodes.some((n) => isGhostNodeId(n.id))).toBe(true);
  });
});

describe("liftScopedReactFlow — edits write through", () => {
  it("a child drag writes plain document coordinates", () => {
    const rf = toReactFlow(scopedView(DOC, "pay"));
    const nodes = rf.nodes.map((n) =>
      n.id === "api" ? { ...n, position: { x: 90, y: 75 } } : n,
    );
    const out = liftScopedReactFlow(nodes, rf.edges, "pay", { base: DOC, meta: DOC.meta });
    expect(out.nodes.find((n) => n.id === "api")).toMatchObject({
      x: 90,
      y: 75,
      parentId: "pay",
      zoneId: "cloud",
    });
    // Nothing else moved — byte-identical outside the dragged node.
    const strip = (t: DiagramTemplate) => ({
      ...t,
      nodes: t.nodes.filter((n) => n.id !== "api"),
    });
    expect(JSON.stringify(strip(out))).toBe(JSON.stringify(strip(DOC)));
  });

  it("an edge drawn to a ghost is stored against the real node", () => {
    const rf = toReactFlow(scopedView(DOC, "pay"));
    const drawn: RFEdgeLike = { id: "fresh", source: "auth", target: `${GHOST_NODE_PREFIX}web`, data: {} };
    const out = liftScopedReactFlow(rf.nodes, [...rf.edges, drawn], "pay", { base: DOC, meta: DOC.meta });
    expect(out.edges.find((e) => e.id === "fresh")).toMatchObject({ source: "auth", target: "web" });
  });

  it("an edge drawn to the boundary is an edge to the focus node", () => {
    const rf = toReactFlow(scopedView(DOC, "pay"));
    const drawn: RFEdgeLike = { id: "up", source: "api", target: `${BOUNDARY_NODE_PREFIX}pay`, data: {} };
    const out = liftScopedReactFlow(rf.nodes, [...rf.edges, drawn], "pay", { base: DOC, meta: DOC.meta });
    expect(out.edges.find((e) => e.id === "up")).toMatchObject({ source: "api", target: "pay" });
  });

  it("a node added at canvas root becomes a child of the focus", () => {
    const rf = toReactFlow(scopedView(DOC, "pay"));
    const added = {
      id: "fresh-node",
      position: { x: 40, y: 400 },
      data: { label: "Fresh", kind: "service", icon: "box", description: "" },
    };
    const out = liftScopedReactFlow([...rf.nodes, added], rf.edges, "pay", { base: DOC, meta: DOC.meta });
    expect(out.nodes.find((n) => n.id === "fresh-node")).toMatchObject({
      parentId: "pay",
      x: 40,
      y: 400,
    });
  });

  it("deleting an interior edge on the canvas deletes it from the document", () => {
    const rf = toReactFlow(scopedView(DOC, "pay"));
    const out = liftScopedReactFlow(
      rf.nodes,
      rf.edges.filter((e) => e.id !== "e-int"),
      "pay",
      { base: DOC, meta: DOC.meta },
    );
    expect(out.edges.some((e) => e.id === "e-int")).toBe(false);
    expect(out.edges.some((e) => e.id === "e-cross")).toBe(true); // carried
  });

  it("deleting a derived ghost edge on the canvas resurrects nothing extra", () => {
    const rf = toReactFlow(scopedView(DOC, "pay"));
    const out = liftScopedReactFlow(
      rf.nodes,
      rf.edges.filter((e) => !isGhostEdgeId(e.id)),
      "pay",
      { base: DOC, meta: DOC.meta },
    );
    // Ghost edges are stand-ins; the originals carry through untouched.
    expect(JSON.stringify(out)).toBe(JSON.stringify(DOC));
  });

  it("bails to a plain lift when the boundary is missing", () => {
    const rf = toReactFlow(DOC);
    const out = liftScopedReactFlow(rf.nodes, rf.edges, "pay", { base: DOC, meta: DOC.meta });
    // No boundary on this canvas — nothing gets re-anchored under pay.
    expect(out.nodes.find((n) => n.id === "web")!.parentId).toBeNull();
  });
});

describe("drillableIds / focusPath", () => {
  it("lists every parent in document order", () => {
    expect(drillableIds(DOC)).toEqual(["pay", "vpc", "auth", "workers", "cache"]);
  });

  it("walks ancestors root-first, excluding the node itself", () => {
    expect(focusPath(DOC, "w1")).toEqual(["pay", "workers"]);
    expect(focusPath(DOC, "pay")).toEqual([]);
    expect(focusPath(DOC, "auth-inner")).toEqual(["pay", "auth"]);
  });
});

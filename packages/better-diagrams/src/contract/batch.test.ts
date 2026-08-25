/**
 * Tests for the professional/C4 batch: new schema fields, orthogonal routing,
 * collapse, and their round-trips. The collapse suite is the critical one —
 * it guards the same data-loss class as the provider-toggle bugs.
 */
import { describe, expect, it } from "vitest";
import {
  COLLAPSED_SIZE,
  assignZonesByGeometry,
  buildSystemPrompt,
  fromReactFlow,
  hiddenByCollapse,
  hiddenInline,
  isCollapsedEdgeId,
  templateBounds,
  toReactFlow,
  EDGE_Z_INDEX,
  validateTemplate,
  visibleAnchor,
  type DiagramTemplate,
} from "./schema";
import {
  edgeGeometryFor,
  floatingEdgeGeometry,
  nearestTOnCurve,
  orthogonalEdgeGeometry,
  startAngle,
} from "./geometry";
import { autoLayout, hasOverlaps, placeUnpositioned } from "./layout";
import { inlineContents, nestContents } from "./nesting";
import { scopedView } from "./scope";

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

describe("new node fields", () => {
  it("dedupes and trims tags, dropping empties", () => {
    const t = validateTemplate({ nodes: [node({ tags: [" pci ", "pci", "", "gdpr", 42] })] });
    expect(t.nodes[0].tags).toEqual(["pci", "gdpr", "42"]);
  });

  it("omits an empty tags array entirely", () => {
    const t = validateTemplate({ nodes: [node({ tags: [] })] });
    expect("tags" in t.nodes[0]).toBe(false);
  });

  it("trims url and drops a blank one", () => {
    expect(validateTemplate({ nodes: [node({ url: "  https://x.io/adr/1  " })] }).nodes[0].url).toBe(
      "https://x.io/adr/1",
    );
    expect("url" in validateTemplate({ nodes: [node({ url: "   " })] }).nodes[0]).toBe(false);
  });

  it("trims team and drops a blank one", () => {
    expect(validateTemplate({ nodes: [node({ team: "  Payments  " })] }).nodes[0].team).toBe(
      "Payments",
    );
    expect("team" in validateTemplate({ nodes: [node({ team: "   " })] }).nodes[0]).toBe(false);
    expect("team" in validateTemplate({ nodes: [node({ team: 7 })] }).nodes[0]).toBe(false);
  });

  it("keeps a valid status and strips the default 'active'", () => {
    expect(validateTemplate({ nodes: [node({ status: "deprecated" })] }).nodes[0].status).toBe(
      "deprecated",
    );
    // `active` is the default — never stored, so old docs stay byte-identical.
    expect("status" in validateTemplate({ nodes: [node({ status: "active" })] }).nodes[0]).toBe(
      false,
    );
    expect("status" in validateTemplate({ nodes: [node({ status: "zombie" })] }).nodes[0]).toBe(
      false,
    );
  });

  it("keeps locked only when literally true", () => {
    expect(validateTemplate({ nodes: [node({ locked: true })] }).nodes[0].locked).toBe(true);
    expect("locked" in validateTemplate({ nodes: [node({ locked: "yes" })] }).nodes[0]).toBe(false);
  });

  it("keeps `plain` only on annotation kinds, and only when literally true", () => {
    const t = validateTemplate({
      nodes: [
        node({ id: "note", kind: "text", plain: true }),
        node({ id: "svc", plain: true }),
        node({ id: "note2", kind: "text", plain: "yes" }),
      ],
    });
    expect(t.nodes.find((n) => n.id === "note")!.plain).toBe(true);
    // Boxed is the default for notes, and meaningless on a service.
    expect("plain" in t.nodes.find((n) => n.id === "svc")!).toBe(false);
    expect("plain" in t.nodes.find((n) => n.id === "note2")!).toBe(false);
  });

  it("keeps collapsed only on container kinds", () => {
    const t = validateTemplate({
      nodes: [node({ id: "g", kind: "group", collapsed: true }), node({ id: "s", collapsed: true })],
    });
    expect(t.nodes.find((n) => n.id === "g")!.collapsed).toBe(true);
    // A collapsed service is meaningless and would still hide "descendants".
    expect("collapsed" in t.nodes.find((n) => n.id === "s")!).toBe(false);
  });

  it("stores text layout only when it differs from the default", () => {
    const t = validateTemplate({
      nodes: [
        node({ id: "a", textAlign: "center", textVAlign: "bottom", wrap: true }),
        // The defaults, written out explicitly — none should persist, or every
        // pre-existing document would grow three keys on its next save.
        node({ id: "b", textAlign: "left", textVAlign: "middle", wrap: false }),
        node({ id: "c", textAlign: "diagonal" }),
      ],
    });
    expect(t.nodes.find((n) => n.id === "a")).toMatchObject({
      textAlign: "center",
      textVAlign: "bottom",
      wrap: true,
    });
    const plain = t.nodes.find((n) => n.id === "b")!;
    expect("textAlign" in plain).toBe(false);
    expect("textVAlign" in plain).toBe(false);
    expect("wrap" in plain).toBe(false);
    // An unknown value is repaired to the default rather than kept.
    expect("textAlign" in t.nodes.find((n) => n.id === "c")!).toBe(false);
  });

  it("grows a wrapped node's height to hold every line, and only when wrapping", () => {
    const long = "A deliberately long component label that cannot fit on one line";
    const t = validateTemplate({
      nodes: [
        node({ id: "wrapped", label: long, wrap: true }),
        node({ id: "clipped", label: long }),
      ],
    });
    // The unwrapped node is untouched: one ellipsised line never resizes a box.
    expect(t.nodes.find((n) => n.id === "clipped")!.h).toBe(76);
    expect(t.nodes.find((n) => n.id === "wrapped")!.h).toBeGreaterThan(76);
  });

  it("does not grow a wrapped node whose label already fits", () => {
    const t = validateTemplate({ nodes: [node({ id: "s", label: "API", wrap: true })] });
    expect(t.nodes.find((n) => n.id === "s")!.h).toBe(76);
  });

  it("keeps frame styling only on container kinds, and only when non-default", () => {
    const t = validateTemplate({
      nodes: [
        node({ id: "frame", kind: "group", fill: false, outline: "none" }),
        node({ id: "default", kind: "group", fill: true, outline: "dashed" }),
        node({ id: "leaf", fill: false, outline: "none" }),
      ],
    });
    expect(t.nodes.find((n) => n.id === "frame")).toMatchObject({
      fill: false,
      outline: "none",
    });
    // Dashed-and-filled is how a group has always drawn, so nothing persists.
    const untouched = t.nodes.find((n) => n.id === "default")!;
    expect("fill" in untouched).toBe(false);
    expect("outline" in untouched).toBe(false);
    // A leaf draws its own shape; a frame style there would mean nothing.
    const leaf = t.nodes.find((n) => n.id === "leaf")!;
    expect("fill" in leaf).toBe(false);
    expect("outline" in leaf).toBe(false);
  });

  it("folds a colour's alpha into the container's opacity, as zones do", () => {
    const t = validateTemplate({
      nodes: [
        node({ id: "a", kind: "group", color: "#38BDF8/40" }),
        node({ id: "b", kind: "group", color: "#abc" }),
      ],
    });
    expect(t.nodes.find((n) => n.id === "a")).toMatchObject({ color: "#38bdf8", opacity: 0.4 });
    // No alpha anywhere means no stored opacity — the default still applies.
    const b = t.nodes.find((n) => n.id === "b")!;
    expect(b.color).toBe("#aabbcc");
    expect("opacity" in b).toBe(false);
  });

  it("round-trips the new fields through React Flow", () => {
    const t = validateTemplate({
      nodes: [
        node({ id: "a", textAlign: "center", textVAlign: "top", wrap: true, fontSize: 20 }),
        node({ id: "g", kind: "group", fill: false, outline: "dotted", color: "#8b5cf6" }),
      ],
    });
    const rf = toReactFlow(t);
    const back = fromReactFlow(rf.nodes, rf.edges);
    expect(back.nodes.find((n) => n.id === "a")).toMatchObject({
      textAlign: "center",
      textVAlign: "top",
      wrap: true,
      fontSize: 20,
    });
    expect(back.nodes.find((n) => n.id === "g")).toMatchObject({
      fill: false,
      outline: "dotted",
      color: "#8b5cf6",
    });
  });
});

describe("meta version tag", () => {
  it("trims the tag, drops blanks, and whitelists the position", () => {
    const t = validateTemplate({
      nodes: [],
      edges: [],
      meta: { versionTag: "  v2.1 ", versionTagPosition: "bottom-left" },
    });
    expect(t.meta?.versionTag).toBe("v2.1");
    expect(t.meta?.versionTagPosition).toBe("bottom-left");

    const bad = validateTemplate({
      nodes: [],
      edges: [],
      meta: { versionTag: "   ", versionTagPosition: "middle" },
    });
    expect("versionTag" in (bad.meta ?? {})).toBe(false);
    expect("versionTagPosition" in (bad.meta ?? {})).toBe(false);
  });
});

describe("new edge fields", () => {
  const pair = [node({ id: "a" }), node({ id: "b", x: 300 })];

  it("trims tech, floors seq, and strips defaults", () => {
    const t = validateTemplate({
      nodes: pair,
      edges: [
        { id: "e", source: "a", target: "b", tech: " JSON/HTTPS ", seq: 2.9, direction: "forward" },
      ],
    });
    expect(t.edges[0].tech).toBe("JSON/HTTPS");
    expect(t.edges[0].seq).toBe(2);
    // Default direction is stripped so old documents stay byte-identical.
    expect("direction" in t.edges[0]).toBe(false);
  });

  it("keeps both/none directions and drops invalid ones", () => {
    const t = validateTemplate({
      nodes: pair,
      edges: [
        { id: "b1", source: "a", target: "b", direction: "both" },
        { id: "b2", source: "a", target: "b", direction: "sideways" },
      ],
    });
    expect(t.edges.find((e) => e.id === "b1")!.direction).toBe("both");
    expect("direction" in t.edges.find((e) => e.id === "b2")!).toBe(false);
  });

  it("drops a non-positive seq", () => {
    const t = validateTemplate({
      nodes: pair,
      edges: [{ id: "e", source: "a", target: "b", seq: 0 }],
    });
    expect("seq" in t.edges[0]).toBe(false);
  });

  it("keeps a valid routing override and drops garbage", () => {
    const t = validateTemplate({
      nodes: pair,
      edges: [
        { id: "r1", source: "a", target: "b", routing: "orthogonal" },
        { id: "r2", source: "a", target: "b", routing: "zigzag" },
      ],
    });
    expect(t.edges.find((e) => e.id === "r1")!.routing).toBe("orthogonal");
    expect("routing" in t.edges.find((e) => e.id === "r2")!).toBe(false);
  });

  it("round-trips every new field through React Flow", () => {
    const doc = validateTemplate({
      meta: { routing: "orthogonal" },
      nodes: [
        node({ id: "a", tags: ["pci"], url: "https://x.io", team: "Payments", status: "planned", locked: true }),
        node({ id: "b", x: 300 }),
      ],
      edges: [
        {
          id: "e",
          source: "a",
          target: "b",
          tech: "gRPC",
          direction: "both",
          seq: 3,
          routing: "curved",
        },
      ],
    }) as DiagramTemplate;

    const { nodes, edges } = toReactFlow(doc);
    const back = fromReactFlow(nodes, edges, { base: doc, meta: doc.meta });

    expect(back.nodes.find((n) => n.id === "a")).toMatchObject({
      tags: ["pci"],
      url: "https://x.io",
      team: "Payments",
      status: "planned",
      locked: true,
    });
    expect(back.edges[0]).toMatchObject({
      tech: "gRPC",
      direction: "both",
      seq: 3,
      routing: "curved",
    });
    expect(back.meta?.routing).toBe("orthogonal");
  });

  it("resolves routing for the renderer without baking the default onto edges", () => {
    const doc = validateTemplate({
      meta: { routing: "orthogonal" },
      nodes: pair,
      edges: [
        { id: "inherits", source: "a", target: "b" },
        { id: "own", source: "a", target: "b", routing: "curved" },
      ],
    }) as DiagramTemplate;

    const { nodes, edges } = toReactFlow(doc);
    expect(edges.find((e) => e.id === "inherits")!.data.routingResolved).toBe("orthogonal");
    expect(edges.find((e) => e.id === "own")!.data.routingResolved).toBe("curved");

    // The inherited edge must come back with NO routing of its own — writing
    // the resolved value back would freeze it against future default changes.
    const back = fromReactFlow(nodes, edges, { base: doc, meta: doc.meta });
    expect("routing" in back.edges.find((e) => e.id === "inherits")!).toBe(false);
    expect(back.edges.find((e) => e.id === "own")!.routing).toBe("curved");
  });

  it("locked nodes come out non-draggable in React Flow", () => {
    const doc = validateTemplate({ nodes: [node({ id: "a", locked: true })] });
    const { nodes } = toReactFlow(doc);
    expect((nodes[0] as { draggable?: boolean }).draggable).toBe(false);
  });
});

describe("stacking: a node on top of a node", () => {
  const z = (nodes: ReturnType<typeof toReactFlow>["nodes"], id: string) =>
    nodes.find((n) => n.id === id)!.zIndex!;
  const ez = (edges: ReturnType<typeof toReactFlow>["edges"], id: string) =>
    edges.find((e) => e.id === id)!.zIndex!;

  /** A big card with a small one sitting inside it, and a bystander. */
  const nested = () =>
    validateTemplate({
      version: 1,
      nodes: [
        { id: "big", label: "Big", kind: "service", x: 0, y: 0, w: 400, h: 300 },
        { id: "small", label: "Small", kind: "service", x: 40, y: 40, w: 170, h: 76 },
        { id: "far", label: "Far", kind: "service", x: 700, y: 0, w: 170, h: 76 },
      ],
      edges: [
        { id: "in-out", source: "small", target: "far" },
        { id: "out-out", source: "big", target: "far" },
      ],
    }) as DiagramTemplate;

  it("paints the contained node above the one containing it", () => {
    const { nodes } = toReactFlow(nested());
    expect(z(nodes, "small")).toBeGreaterThan(z(nodes, "big"));
    expect(z(nodes, "big")).toBe(z(nodes, "far"));
  });

  it("lifts that node's edges clear of the card it sits on", () => {
    const { nodes, edges } = toReactFlow(nested());
    // Above the card it has to escape…
    expect(ez(edges, "in-out")).toBeGreaterThan(z(nodes, "big"));
    // …and still under the cards in its own band.
    expect(ez(edges, "in-out")).toBeLessThan(z(nodes, "small"));
    // An edge between two unstacked nodes is where it always was.
    expect(ez(edges, "out-out")).toBe(EDGE_Z_INDEX);
  });

  it("a chain of three stacks in order", () => {
    const doc = validateTemplate({
      version: 1,
      nodes: [
        { id: "outer", label: "O", kind: "service", x: 0, y: 0, w: 600, h: 400 },
        { id: "mid", label: "M", kind: "service", x: 20, y: 20, w: 400, h: 300 },
        { id: "inner", label: "I", kind: "service", x: 40, y: 40, w: 170, h: 76 },
      ],
      edges: [],
    }) as DiagramTemplate;
    const { nodes } = toReactFlow(doc);
    expect(z(nodes, "inner")).toBeGreaterThan(z(nodes, "mid"));
    expect(z(nodes, "mid")).toBeGreaterThan(z(nodes, "outer"));
  });

  it("a note dropped on a card rides above it", () => {
    const doc = validateTemplate({
      version: 1,
      nodes: [
        { id: "card", label: "Card", kind: "service", x: 0, y: 0, w: 400, h: 300 },
        { id: "note", label: "A remark", kind: "text", x: 40, y: 40, w: 300, h: 60 },
      ],
      edges: [],
    }) as DiagramTemplate;
    const { nodes } = toReactFlow(doc);
    expect(z(nodes, "note")).toBeGreaterThan(z(nodes, "card"));
  });

  it("a GROUP is not a stack: its children and their wiring stay put", () => {
    // The common case, and the one that must not change — group frames are
    // the band edges already travel over.
    const doc = validateTemplate({
      version: 1,
      nodes: [
        { id: "g", label: "G", kind: "group", x: 0, y: 0, w: 600, h: 400 },
        { id: "a", label: "A", kind: "service", parentId: "g", x: 40, y: 40, w: 170, h: 76 },
        { id: "b", label: "B", kind: "service", parentId: "g", x: 300, y: 40, w: 170, h: 76 },
      ],
      edges: [{ id: "e", source: "a", target: "b" }],
    }) as DiagramTemplate;
    const { nodes, edges } = toReactFlow(doc);
    expect(z(nodes, "g")).toBeLessThan(EDGE_Z_INDEX);
    expect(ez(edges, "e")).toBe(EDGE_Z_INDEX);
    expect(z(nodes, "a")).toBeGreaterThan(EDGE_Z_INDEX);
  });

  it("a smaller card overlapping a bigger one sits on it, wiring included", () => {
    // The half of the ask containment alone missed: dropped on another card
    // and left hanging over its edge is still ON it.
    const doc = validateTemplate({
      version: 1,
      nodes: [
        { id: "host", label: "Host", kind: "service", x: 0, y: 0, w: 400, h: 300 },
        // 70% of this box lies over `host`; the rest hangs off the right.
        { id: "on", label: "On", kind: "service", x: 260, y: 40, w: 200, h: 100 },
        { id: "far", label: "Far", kind: "service", x: 800, y: 0, w: 170, h: 76 },
      ],
      edges: [{ id: "e", source: "on", target: "far" }],
    }) as DiagramTemplate;
    const { nodes, edges } = toReactFlow(doc);
    expect(z(nodes, "on")).toBeGreaterThan(z(nodes, "host"));
    expect(ez(edges, "e")).toBeGreaterThan(z(nodes, "host"));
    expect(ez(edges, "e")).toBeLessThan(z(nodes, "on"));
  });

  it("a card merely grazing another's corner is not on it", () => {
    // Incidental overlap must not lift a node's wiring over its neighbour.
    const doc = validateTemplate({
      version: 1,
      nodes: [
        { id: "host", label: "Host", kind: "service", x: 0, y: 0, w: 400, h: 300 },
        { id: "graze", label: "Graze", kind: "service", x: 380, y: 280, w: 170, h: 76 },
      ],
      edges: [],
    }) as DiagramTemplate;
    const { nodes } = toReactFlow(doc);
    expect(z(nodes, "graze")).toBe(z(nodes, "host"));
  });

  it("same-size overlap is a tie — document order decides", () => {
    const doc = validateTemplate({
      version: 1,
      nodes: [
        { id: "a", label: "A", kind: "service", x: 0, y: 0, w: 200, h: 100 },
        { id: "b", label: "B", kind: "service", x: 100, y: 50, w: 200, h: 100 },
        // Same box as A: neither contains the other.
        { id: "c", label: "C", kind: "service", x: 0, y: 0, w: 200, h: 100 },
      ],
      edges: [],
    }) as DiagramTemplate;
    const { nodes } = toReactFlow(doc);
    expect(z(nodes, "a")).toBe(z(nodes, "b"));
    expect(z(nodes, "a")).toBe(z(nodes, "c"));
    // Later in the document still paints later.
    expect(nodes.findIndex((n) => n.id === "c")).toBeGreaterThan(
      nodes.findIndex((n) => n.id === "a"),
    );
  });
});

describe("orthogonal geometry", () => {
  const a = { x: 0, y: 0, width: 100, height: 60 };
  const b = { x: 400, y: 200, width: 100, height: 60 };

  it("starts and ends on the facing box edges", () => {
    const geo = orthogonalEdgeGeometry(a, b);
    expect(geo.at(0)).toEqual({ x: 100, y: 30 }); // right side of a
    expect(geo.at(1)).toEqual({ x: 400, y: 230 }); // left side of b
    expect(geo.tip).toEqual({ x: 400, y: 230 });
  });

  it("produces only axis-aligned segments", () => {
    const geo = orthogonalEdgeGeometry(a, b);
    // Sample densely; consecutive points must never move in both axes at once.
    let prev = geo.at(0);
    for (let i = 1; i <= 40; i++) {
      const p = geo.at(i / 40);
      const dx = Math.abs(p.x - prev.x);
      const dy = Math.abs(p.y - prev.y);
      expect(Math.min(dx, dy)).toBeLessThan(1e-6);
      prev = p;
    }
  });

  it("is arc-length parameterised (uniform spacing)", () => {
    const geo = orthogonalEdgeGeometry(a, b);
    const d = (t1: number, t2: number) => {
      const p = geo.at(t1);
      const r = geo.at(t2);
      return Math.abs(r.x - p.x) + Math.abs(r.y - p.y); // Manhattan = arc length here
    };
    expect(d(0, 0.25)).toBeCloseTo(d(0.25, 0.5), 5);
    expect(d(0.5, 0.75)).toBeCloseTo(d(0.75, 1), 5);
  });

  it("supports label dragging through the generic sampler", () => {
    const geo = orthogonalEdgeGeometry(a, b);
    const nearStart = nearestTOnCurve(geo, geo.at(0.2));
    expect(nearStart).toBeGreaterThan(0.1);
    expect(nearStart).toBeLessThan(0.35);
  });

  it("dispatches by routing name", () => {
    expect(edgeGeometryFor("orthogonal", a, b).path).toContain("L");
    expect(edgeGeometryFor("curved", a, b).path).toContain("C");
    expect(edgeGeometryFor(undefined, a, b).path).toContain("C");
  });

  it("startAngle points back into the source for both geometries", () => {
    for (const geo of [orthogonalEdgeGeometry(a, b), floatingEdgeGeometry(a, b)]) {
      // Travel is rightward at the source, so the reversed angle faces left.
      expect(Math.abs(startAngle(geo))).toBeGreaterThan(Math.PI / 2);
    }
  });
});

describe("collapse", () => {
  const doc = () =>
    validateTemplate({
      nodes: [
        node({ id: "g", kind: "group", collapsed: true, x: 0, y: 0, w: 400, h: 300 }),
        node({ id: "inner", parentId: "g", x: 20, y: 60 }),
        node({ id: "deep-group", kind: "group", parentId: "g", x: 200, y: 60, w: 150, h: 120 }),
        node({ id: "deepest", parentId: "deep-group", x: 10, y: 40 }),
        node({ id: "outside", x: 600, y: 100 }),
      ],
      edges: [
        { id: "in-out", source: "inner", target: "outside" },
        { id: "deep-out", source: "deepest", target: "outside" },
        { id: "internal", source: "inner", target: "deepest" },
      ],
    }) as DiagramTemplate;

  it("hides all descendants, not the collapsed group itself", () => {
    const hidden = hiddenByCollapse(doc());
    expect([...hidden].sort()).toEqual(["deep-group", "deepest", "inner"]);
  });

  it("anchors a hidden node to its nearest visible ancestor", () => {
    const t = doc();
    const byId = new Map(t.nodes.map((n) => [n.id, n]));
    const hidden = hiddenByCollapse(t);
    expect(visibleAnchor("deepest", byId, hidden)).toBe("g");
    expect(visibleAnchor("outside", byId, hidden)).toBe("outside");
  });

  it("renders the chip, hides children, and re-routes their edges once", () => {
    const { nodes, edges } = toReactFlow(doc());
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain("g");
    expect(ids).not.toContain("inner");
    expect(ids).not.toContain("deepest");

    const chip = nodes.find((n) => n.id === "g")!;
    expect(chip.width).toBe(COLLAPSED_SIZE.w);
    expect(chip.height).toBe(COLLAPSED_SIZE.h);

    // Two hidden edges converge on the same chip→outside pair: drawn once,
    // synthetic id, no misleading label. Internal wiring disappears.
    const rerouted = edges.filter((e) => isCollapsedEdgeId(e.id));
    expect(rerouted).toHaveLength(1);
    expect(rerouted[0].source).toBe("g");
    expect(rerouted[0].target).toBe("outside");
    expect(edges.some((e) => e.id === "internal")).toBe(false);
  });

  it("round-trips without losing children, originals, or the stored size", () => {
    const t = doc();
    const { nodes, edges } = toReactFlow(t);
    const back = fromReactFlow(nodes, edges, { base: t });

    expect(back.nodes).toHaveLength(t.nodes.length);
    expect(back.edges.map((e) => e.id).sort()).toEqual(["deep-out", "in-out", "internal"]);
    // THE guard: the chip's 180×44 must never overwrite the expanded size.
    expect(back.nodes.find((n) => n.id === "g")).toMatchObject({ w: 400, h: 300, collapsed: true });
  });

  it("expand restores everything exactly", () => {
    let t = doc();
    // Collapse round-trip, then expand and round-trip again.
    let rf = toReactFlow(t);
    t = fromReactFlow(rf.nodes, rf.edges, { base: t });
    t = {
      ...t,
      nodes: t.nodes.map((n) => (n.id === "g" ? { ...n, collapsed: false } : n)),
    };
    rf = toReactFlow(t);
    expect(rf.nodes.map((n) => n.id)).toContain("inner");
    expect(rf.nodes.find((n) => n.id === "g")!.width).toBe(400);
    const back = fromReactFlow(rf.nodes, rf.edges, { base: t });
    expect(back.nodes).toHaveLength(5);
    expect(back.edges).toHaveLength(3);
  });

  it("carries collapse-hidden nodes even in ghost mode", () => {
    // Ghost mode reveals provider-hidden nodes (allNodesPresent) but NOT
    // collapsed children — they must still be carried, or editing while a
    // group is collapsed with ghosts on would delete its contents.
    const t = doc();
    const { nodes, edges } = toReactFlow(t, { showHidden: true });
    expect(nodes.map((n) => n.id)).not.toContain("inner");
    const back = fromReactFlow(nodes, edges, { base: t, allNodesPresent: true });
    expect(back.nodes).toHaveLength(t.nodes.length);
  });

  it("autoLayout survives a collapsed group untouched", () => {
    const out = autoLayout(doc());
    expect(out.nodes).toHaveLength(5);
    for (const n of out.nodes) {
      expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
    }
  });
});

describe("nesting a group's contents one level deeper", () => {
  // The point of the transform is what the RENDERERS then do with it, which
  // nothing in the transform itself arranges: it only changes a kind.
  const doc = () =>
    validateTemplate({
      nodes: [
        node({ id: "out", x: 0, y: 0 }),
        { id: "g", label: "G", kind: "group", icon: "none", description: "", parentId: null, x: 300, y: 0, w: 400, h: 300 },
        node({ id: "a", parentId: "g", x: 24, y: 48 }),
        node({ id: "b", parentId: "g", x: 24, y: 160 }),
      ],
      edges: [
        { id: "in", source: "out", target: "a", label: "calls" },
        { id: "wire", source: "a", target: "b", label: "enqueue" },
      ],
    }) as DiagramTemplate;

  it("hides the contents on this level and lands the arrow on the card", () => {
    const nested = nestContents(doc(), "g");
    const { nodes, edges } = toReactFlow(nested);

    expect(nodes.map((n) => n.id)).toEqual(["out", "g"]);
    // The crossing edge now reaches the card; the internal wiring is gone
    // from this level entirely.
    expect(edges).toHaveLength(1);
    expect({ source: edges[0].source, target: edges[0].target }).toEqual({ source: "out", target: "g" });
    // …and being the only edge on that pair, it still says what it does.
    expect(edges[0].data.label).toBe("calls");
    expect(isCollapsedEdgeId(edges[0].id)).toBe(true);
  });

  it("shows the same contents, wired as before, one level down", () => {
    const level = scopedView(nestContents(doc(), "g"), "g");

    expect(level.nodes.map((n) => n.id)).toEqual(["boundary:g", "a", "b", "ghost:out"]);
    // The interior edge is emitted verbatim — it is this level's own wiring.
    expect(level.edges.find((e) => e.id === "wire")).toMatchObject({
      source: "a",
      target: "b",
      label: "enqueue",
    });
  });

  it("puts everything back", () => {
    const back = inlineContents(nestContents(doc(), "g"), "g");
    const { nodes, edges } = toReactFlow(back);

    expect(nodes.map((n) => n.id)).toEqual(["out", "g", "a", "b"]);
    // Both edges land on the real nodes again, with their own ids.
    expect(edges.map((e) => e.id).sort()).toEqual(["in", "wire"]);
  });
});

describe("what a re-routed edge is allowed to say", () => {
  /** Two nodes inside a collapsed group; `fan` decides how many arrows cross. */
  const doc = (fan: 1 | 2) =>
    validateTemplate({
      nodes: [
        node({ id: "out", x: 0, y: 0 }),
        { id: "g", label: "G", kind: "group", icon: "none", description: "", parentId: null, collapsed: true, x: 300, y: 0, w: 400, h: 300 },
        node({ id: "a", parentId: "g", x: 24, y: 48 }),
        node({ id: "b", parentId: "g", x: 24, y: 160 }),
      ],
      edges: [
        { id: "e1", source: "out", target: "a", label: "reads", tech: "SQL" },
        ...(fan === 2 ? [{ id: "e2", source: "out", target: "b", label: "writes" }] : []),
      ],
    }) as DiagramTemplate;

  it("keeps its own words when it is the only edge on the pair", () => {
    const [edge] = toReactFlow(doc(1)).edges;
    expect({ source: edge.source, target: edge.target }).toEqual({ source: "out", target: "g" });
    expect(edge.data.label).toBe("reads");
    expect(edge.data.tech).toBe("SQL");
  });

  it("says nothing when it is standing in for several", () => {
    // "reads" would be a claim about one of the two lines it now draws.
    const edges = toReactFlow(doc(2)).edges;
    expect(edges).toHaveLength(1);
    expect(edges[0].data.label).toBe("");
    expect(edges[0].data.tech).toBeUndefined();
  });

  it("still drops what describes the boxes it no longer touches", () => {
    const withAnchors = doc(1);
    Object.assign(withAnchors.edges[0], {
      start: { side: "right", t: 0.5 },
      startLabel: "0..*",
      points: [[100, 100]],
    });
    const [edge] = toReactFlow(withAnchors).edges;
    expect(edge.data.start).toBeUndefined();
    expect(edge.data.startLabel).toBeUndefined();
    expect(edge.data.points).toBeUndefined();
  });
});

describe("drill-in (children of non-container parents)", () => {
  // A service with internal detail: its children live in its own drilled
  // canvas (small local coords), never inline. Behaves like a permanently
  // collapsed group that still renders as its normal card.
  const doc = () =>
    validateTemplate({
      zones: [
        { id: "z1", label: "Z", shape: "rect", provider: "aws", providers: ["aws"], x: 0, y: 0, w: 300, h: 200 },
      ],
      nodes: [
        node({ id: "card", kind: "service", x: 600, y: 40 }),
        node({ id: "c1", parentId: "card", x: 28, y: 52, zoneId: "z1" }),
        node({ id: "c2", parentId: "card", x: 28, y: 160 }),
        node({ id: "grand", parentId: "c2", x: 10, y: 10 }),
        node({ id: "ext", x: 900, y: 40 }),
      ],
      edges: [
        { id: "x1", source: "c1", target: "ext" },
        { id: "x2", source: "grand", target: "ext" },
        { id: "wire", source: "c1", target: "c2" },
      ],
    }) as DiagramTemplate;

  it("hides the whole drill subtree, not the card itself", () => {
    const hidden = hiddenByCollapse(doc());
    expect([...hidden].sort()).toEqual(["c1", "c2", "grand"]);
  });

  it("hiddenInline matches, and ignores transient collapse flags", () => {
    const t = doc();
    expect([...hiddenInline(t)].sort()).toEqual(["c1", "c2", "grand"]);

    // Collapsing a group elsewhere must not change which LEVEL a node is on.
    const withGroup = validateTemplate({
      nodes: [
        node({ id: "g", kind: "group", collapsed: true, x: 0, y: 0, w: 300, h: 200 }),
        node({ id: "in", parentId: "g", x: 20, y: 60 }),
      ],
    });
    expect(hiddenByCollapse(withGroup).has("in")).toBe(true);
    expect(hiddenInline(withGroup).size).toBe(0);
  });

  it("renders the card at its stored size, children absent, edges rerouted once", () => {
    const { nodes, edges } = toReactFlow(doc());
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain("card");
    expect(ids).not.toContain("c1");
    expect(ids).not.toContain("grand");

    // A card parent is NOT a chip: normal renderer, stored size.
    const card = nodes.find((n) => n.id === "card")!;
    expect(card.type).toBe("shape");
    expect(card.width).toBe(170);
    expect(card.height).toBe(76);

    // Both crossing edges converge on card→ext: one synthetic stand-in.
    const rerouted = edges.filter((e) => isCollapsedEdgeId(e.id));
    expect(rerouted).toHaveLength(1);
    expect(rerouted[0].source).toBe("card");
    expect(rerouted[0].target).toBe("ext");
    expect(edges.some((e) => e.id === "wire")).toBe(false);
  });

  it("round-trips without losing children or original edges", () => {
    const t = doc();
    const { nodes, edges } = toReactFlow(t);
    const back = fromReactFlow(nodes, edges, { base: t });
    expect(back.nodes).toHaveLength(t.nodes.length);
    expect(back.edges.map((e) => e.id).sort()).toEqual(["wire", "x1", "x2"]);
    expect(back.nodes.find((n) => n.id === "c1")).toMatchObject({ parentId: "card", x: 28, y: 52 });
  });

  it("carries drill children even in ghost mode", () => {
    const t = doc();
    const { nodes, edges } = toReactFlow(t, { showHidden: true });
    expect(nodes.map((n) => n.id)).not.toContain("c1");
    const back = fromReactFlow(nodes, edges, { base: t, allNodesPresent: true });
    expect(back.nodes).toHaveLength(t.nodes.length);
  });

  it("keeps a drill child's declared zone despite meaningless drill coords", () => {
    const t = doc();
    // c1's absolute centre (628+85, 92+38) is far outside z1's box, and c2's
    // is nowhere near it either — yet membership must pass through verbatim:
    // drill coords are in the card's own canvas, not root space.
    const out = assignZonesByGeometry(t);
    expect(out.nodes.find((n) => n.id === "c1")!.zoneId).toBe("z1");
    expect(out.nodes.find((n) => n.id === "c2")!.zoneId).toBeNull();
  });

  it("excludes drill children from templateBounds", () => {
    const t = doc();
    const b = templateBounds(t);
    // ext at (900,40,170,76) is the right edge; drill children must not
    // stretch the box even when their local coords would.
    expect(b.maxX).toBe(1070);
    const deep = validateTemplate({
      nodes: [
        node({ id: "card", kind: "service", x: 0, y: 0 }),
        node({ id: "far", parentId: "card", x: 5000, y: 5000 }),
      ],
    });
    expect(templateBounds(deep).maxX).toBe(170);
  });

  it("fromReactFlow strips derived view elements defensively", () => {
    const t = doc();
    const { nodes, edges } = toReactFlow(t);
    const polluted = [
      ...nodes,
      { id: "boundary:card", position: { x: 0, y: 0 }, data: { label: "Card", kind: "group" } },
      { id: "ghost:ext", position: { x: -200, y: 0 }, data: { label: "Ext", kind: "service" } },
    ];
    const pollutedEdges = [...edges, { id: "ghost:x9", source: "c1", target: "ghost:ext", data: {} }];
    const back = fromReactFlow(polluted as never, pollutedEdges as never, { base: t });
    expect(back.nodes.some((n) => n.id.startsWith("boundary:") || n.id.startsWith("ghost:"))).toBe(false);
    expect(back.edges.some((e) => e.id.startsWith("ghost:"))).toBe(false);
    expect(back.nodes).toHaveLength(t.nodes.length);
  });

  it("carryZones keeps base zones when the canvas holds none", () => {
    const t = doc();
    const { nodes, edges } = toReactFlow(t);
    const noZones = nodes.filter((n) => !n.id.startsWith("zone:"));
    const withCarry = fromReactFlow(noZones, edges, { base: t, carryZones: true });
    expect(withCarry.zones?.map((z) => z.id)).toEqual(["z1"]);
    const withoutCarry = fromReactFlow(noZones, edges, { base: t });
    expect(withoutCarry.zones ?? []).toHaveLength(0);
  });

  it("autoLayout never moves drill children or resizes the card", () => {
    const out = autoLayout(doc());
    const card = out.nodes.find((n) => n.id === "card")!;
    expect([card.w, card.h]).toEqual([170, 76]);
    expect(out.nodes.find((n) => n.id === "c1")).toMatchObject({ x: 28, y: 52 });
    expect(out.nodes.find((n) => n.id === "grand")).toMatchObject({ x: 10, y: 10 });
  });

  it("autoLayout keeps waypoints on routes wholly inside a drill space", () => {
    const t = validateTemplate({
      nodes: [
        node({ id: "card", kind: "service", x: 0, y: 0 }),
        node({ id: "a", parentId: "card", x: 20, y: 60 }),
        node({ id: "b", parentId: "card", x: 20, y: 200 }),
        node({ id: "out", x: 400, y: 0 }),
      ],
      edges: [
        { id: "inner", source: "a", target: "b", points: [[100, 150]] },
        { id: "cross", source: "a", target: "out", points: [[300, 40]] },
      ],
    }) as DiagramTemplate;
    const out = autoLayout(t);
    expect(out.edges.find((e) => e.id === "inner")!.points).toEqual([[100, 150]]);
    expect(out.edges.find((e) => e.id === "cross")!.points).toBeUndefined();
  });

  it("placeUnpositioned stacks a new drill child in card space without bloating the card", () => {
    const t = validateTemplate({
      ...JSON.parse(JSON.stringify(doc())),
      nodes: [
        ...doc().nodes,
        node({ id: "newcomer", parentId: "card", x: 0, y: 0 }),
      ],
    }) as DiagramTemplate;
    const placed = placeUnpositioned(t, ["newcomer"]);
    const m = placed.nodes.find((n) => n.id === "newcomer")!;
    const c2 = placed.nodes.find((n) => n.id === "c2")!;
    // Below the occupied drill-space bounds, in local coordinates.
    expect(m.x).toBe(28);
    expect(m.y).toBeGreaterThan(c2.y + c2.h);
    // The card itself never grows for drill contents.
    expect(placed.nodes.find((n) => n.id === "card")).toMatchObject({ w: 170, h: 76 });
  });

  it("hasOverlaps sees card-vs-card overlap and ignores drill children", () => {
    const overlapping = validateTemplate({
      nodes: [
        node({ id: "cardA", kind: "service", x: 0, y: 0 }),
        node({ id: "childA", parentId: "cardA", x: 20, y: 60 }),
        node({ id: "cardB", kind: "service", x: 50, y: 20 }),
      ],
    }) as DiagramTemplate;
    expect(hasOverlaps(overlapping)).toBe(true);

    const clean = validateTemplate({
      nodes: [
        node({ id: "cardA", kind: "service", x: 0, y: 0 }),
        // Drill coords that would "overlap" the neighbour if read as root space.
        node({ id: "childA", parentId: "cardA", x: 400, y: 10 }),
        node({ id: "other", x: 400, y: 0 }),
      ],
    }) as DiagramTemplate;
    expect(hasOverlaps(clean)).toBe(false);
  });

  it("viewHidden carries the stated set and REPLACES the collapse rule", () => {
    // Root-level elements a scoped view leaves off the canvas: without the
    // opt their absence reads as deletion (allNodesPresent), with it they
    // carry — the collapse rules play no part here.
    const t = validateTemplate({
      nodes: [node({ id: "a", x: 0, y: 0 }), node({ id: "b", x: 300, y: 0 })],
      edges: [{ id: "ab", source: "a", target: "b" }],
    });
    const { nodes } = toReactFlow(t);
    const subset = nodes.filter((n) => n.id === "a");
    const back = fromReactFlow(subset, [], {
      base: t,
      viewHidden: { nodes: new Set(["b"]), edges: new Set(["ab"]) },
      allNodesPresent: true,
    });
    expect(back.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(back.edges.map((e) => e.id)).toEqual(["ab"]);

    const withoutOpt = fromReactFlow(subset, [], { base: t, allNodesPresent: true });
    expect(withoutOpt.nodes.map((n) => n.id)).toEqual(["a"]);

    // REPLACE semantics: a drill child absent from the canvas would normally
    // be carried by the collapse rule — under viewHidden the view's word is
    // final and its absence means the user deleted it.
    const drill = doc();
    const rf = toReactFlow(drill);
    const back2 = fromReactFlow(rf.nodes, rf.edges, {
      base: drill,
      viewHidden: { nodes: new Set(), edges: new Set() },
      allNodesPresent: true,
    });
    expect(back2.nodes.some((n) => n.id === "c1")).toBe(false);
  });
});

describe("prompt", () => {
  it("advertises the new vocabulary", () => {
    const prompt = buildSystemPrompt();
    for (const term of ["tags", "url", "team", "tech", "seq", "direction", "routing", "orthogonal"]) {
      expect(prompt, term).toContain(term);
    }
  });

  it("teaches decomposition neutrally — supported, never encouraged", () => {
    for (const prompt of [buildSystemPrompt(), buildSystemPrompt({ geometry: false })]) {
      expect(prompt).toContain("parentId may reference ANY existing node");
      expect(prompt).toContain("the next C4 level");
      expect(prompt).toContain("Do NOT decompose a component into children unless the user explicitly asks");
      // The node budget is per level, so depth never fights breadth.
      expect(prompt).toContain("6-14 nodes per level");
      expect(prompt).not.toContain("6-14 nodes total");
    }
    // Drill-space coordinate rule rides the geometry branch only.
    expect(buildSystemPrompt()).toContain("small local coordinates starting near 0,0");
    expect(buildSystemPrompt({ geometry: false })).not.toContain("small local coordinates");
  });
});

describe("refine message focus scope", () => {
  it("frames the drilled-in component without touching the default shape", async () => {
    const { buildRefineMessage } = await import("./llm");
    const doc = validateTemplate({ nodes: [node({ id: "pay", label: "Payments" })] });
    const plain = buildRefineMessage(doc, "add a cache");
    expect(plain).toContain("CURRENT DIAGRAM TEMPLATE:");
    expect(plain).not.toContain("drilled into");

    const scoped = buildRefineMessage(doc, "add a cache", {
      focus: { id: "pay", label: "Payments" },
    });
    expect(scoped).toContain('drilled into "Payments" (node id "pay")');
    expect(scoped).toContain('new internal parts get parentId "pay"');
    expect(scoped).toContain("keep every existing id");
    // The instruction still arrives after the scope framing.
    expect(scoped.indexOf("add a cache")).toBeGreaterThan(scoped.indexOf("drilled into"));
  });
});

describe("layout frames", () => {
  /** A card whose drill space is piled at the origin, plus a root flow. */
  const piled = () =>
    validateTemplate({
      nodes: [
        node({ id: "card", kind: "service", x: 0, y: 0 }),
        node({ id: "a", parentId: "card", x: 0, y: 0 }),
        node({ id: "b", parentId: "card", x: 0, y: 0 }),
        node({ id: "out1", x: 0, y: 0 }),
        node({ id: "out2", x: 0, y: 0 }),
      ],
      edges: [
        { id: "inner", source: "a", target: "b" },
        { id: "outer", source: "out1", target: "out2" },
      ],
    }) as DiagramTemplate;

  it("arranges the visible canvas by default, drill spaces untouched", () => {
    const out = autoLayout(piled());
    // The root flow ranked left-to-right…
    expect(out.nodes.find((n) => n.id === "out2")!.x).toBeGreaterThan(
      out.nodes.find((n) => n.id === "out1")!.x,
    );
    // …and the level behind the card was left exactly as it was.
    expect(out.nodes.find((n) => n.id === "a")).toMatchObject({ x: 0, y: 0 });
    expect(out.nodes.find((n) => n.id === "b")).toMatchObject({ x: 0, y: 0 });
  });

  it('"all" arranges every level without resizing the card', () => {
    const out = autoLayout(piled(), { frames: "all" });
    const a = out.nodes.find((n) => n.id === "a")!;
    const b = out.nodes.find((n) => n.id === "b")!;
    expect([a.x, a.y]).not.toEqual([b.x, b.y]);
    expect(b.x).toBeGreaterThan(a.x); // the drill space ranks by its own edges
    // The card still shows its own footprint on the level above.
    expect(out.nodes.find((n) => n.id === "card")).toMatchObject({ w: 170, h: 76 });
  });

  it("a drill-scoped tidy touches that level and nothing else", () => {
    const before = piled();
    const out = autoLayout(before, { frames: { drill: "card" } });
    const a = out.nodes.find((n) => n.id === "a")!;
    const b = out.nodes.find((n) => n.id === "b")!;
    expect([a.x, a.y]).not.toEqual([b.x, b.y]);
    // The visible canvas is byte-identical — nothing the user could see moved.
    for (const id of ["card", "out1", "out2"]) {
      expect(out.nodes.find((n) => n.id === id)).toEqual(
        before.nodes.find((n) => n.id === id),
      );
    }
  });

  it("clears only the waypoints whose frame was re-ranked", () => {
    const t = validateTemplate({
      ...JSON.parse(JSON.stringify(piled())),
      edges: [
        { id: "inner", source: "a", target: "b", points: [[10, 20]] },
        { id: "outer", source: "out1", target: "out2", points: [[300, 40]] },
      ],
    }) as DiagramTemplate;
    const rootTidy = autoLayout(t);
    expect(rootTidy.edges.find((e) => e.id === "inner")!.points).toEqual([[10, 20]]);
    expect(rootTidy.edges.find((e) => e.id === "outer")!.points).toBeUndefined();

    const drillTidy = autoLayout(t, { frames: { drill: "card" } });
    expect(drillTidy.edges.find((e) => e.id === "inner")!.points).toBeUndefined();
    expect(drillTidy.edges.find((e) => e.id === "outer")!.points).toEqual([[300, 40]]);
  });

  it("hasOverlaps judges each frame on its own", () => {
    // A level piled at its origin needs tidying as much as a messy canvas.
    expect(hasOverlaps(piled())).toBe(true);

    // But identical LOCAL coordinates in two different levels never collide.
    const clean = validateTemplate({
      nodes: [
        node({ id: "c1", kind: "service", x: 0, y: 0 }),
        node({ id: "x", parentId: "c1", x: 28, y: 52 }),
        node({ id: "c2", kind: "service", x: 400, y: 0 }),
        node({ id: "y", parentId: "c2", x: 28, y: 52 }),
      ],
    }) as DiagramTemplate;
    expect(hasOverlaps(clean)).toBe(false);
  });
});

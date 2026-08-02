/**
 * Tests for the professional/C4 batch: new schema fields, orthogonal routing,
 * collapse, and their round-trips. The collapse suite is the critical one —
 * it guards the same data-loss class as the provider-toggle bugs.
 */
import { describe, expect, it } from "vitest";
import {
  COLLAPSED_SIZE,
  buildSystemPrompt,
  fromReactFlow,
  hiddenByCollapse,
  isCollapsedEdgeId,
  toReactFlow,
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
import { autoLayout } from "./layout";

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

describe("prompt", () => {
  it("advertises the new vocabulary", () => {
    const prompt = buildSystemPrompt();
    for (const term of ["tags", "url", "team", "tech", "seq", "direction", "routing", "orthogonal"]) {
      expect(prompt, term).toContain(term);
    }
  });
});

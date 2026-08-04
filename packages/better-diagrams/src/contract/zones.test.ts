import { describe, expect, it } from "vitest";
import {
  EXAMPLE_TEMPLATE,
  EXAMPLE_ZONED_TEMPLATE,
  activeScenario,
  buildSystemPrompt,
  fromReactFlow,
  setAllZoneProviders,
  setZoneProvider,
  templateBounds,
  templateProviders,
  toReactFlow,
  validateTemplate,
  visibleElements,
  type DiagramTemplate,
} from "./schema";
import { containZonePoints, pointInZone, zoneAt, type DiagramZone, type ZonePoint } from "./zones";

const zone = (over: Partial<DiagramZone> = {}): Record<string, unknown> => ({
  id: "z",
  label: "Z",
  shape: "rounded",
  x: 0,
  y: 0,
  w: 400,
  h: 300,
  providers: ["azure", "aws"],
  provider: "azure",
  ...over,
});

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

describe("zone validation", () => {
  it("omits the zones key entirely when there are none", () => {
    // Back-compat: a zone-less document must round-trip byte-identical to what
    // it was before zones existed.
    const t = validateTemplate({ nodes: [node()] });
    expect("zones" in t).toBe(false);
    expect(JSON.parse(JSON.stringify(t))).toEqual({
      version: 1,
      nodes: [expect.objectContaining({ id: "n", zoneId: null })],
      edges: [],
    });
  });

  it("suffixes duplicate zone ids", () => {
    const t = validateTemplate({ zones: [zone({ id: "a" }), zone({ id: "a" })], nodes: [] });
    expect(t.zones!.map((z) => z.id)).toEqual(["a", "a_2"]);
  });

  it("falls back to the first supported provider when the active one is unsupported", () => {
    const t = validateTemplate({
      zones: [zone({ providers: ["aws", "gcp"], provider: "azure" })],
      nodes: [],
    });
    expect(t.zones![0].provider).toBe("aws");
  });

  it("gives a zone with no providers at least one", () => {
    const t = validateTemplate({ zones: [zone({ providers: [], provider: "gcp" })], nodes: [] });
    expect(t.zones![0].providers).toEqual(["gcp"]);
    expect(t.zones![0].provider).toBe("gcp");
  });

  it("keeps registry-defined provider ids it does not recognise", () => {
    // Dropping them would silently destroy the author's intent.
    const t = validateTemplate({
      zones: [zone({ providers: ["fly", "render"], provider: "render" })],
      nodes: [],
    });
    expect(t.zones![0].providers).toEqual(["fly", "render"]);
    expect(t.zones![0].provider).toBe("render");
  });

  it("repairs an unknown shape", () => {
    const t = validateTemplate({
      zones: [zone({ shape: "trapezoid" as DiagramZone["shape"] })],
      nodes: [],
    });
    expect(t.zones![0].shape).toBe("rounded");
  });

  it("clamps polygon points into the normalised box", () => {
    const t = validateTemplate({
      zones: [zone({ shape: "polygon", points: [[-3, 0.5], [2, 0.2], [0.5, 9]] })],
      nodes: [],
    });
    expect(t.zones![0].points).toEqual([
      [0, 0.5],
      [1, 0.2],
      [0.5, 1],
    ]);
  });

  it("substitutes a default outline for a degenerate polygon", () => {
    const t = validateTemplate({
      zones: [zone({ shape: "polygon", points: [[0, 0], [1, 1]] })],
      nodes: [],
    });
    expect(t.zones![0].points!.length).toBeGreaterThanOrEqual(3);
  });

  it("nulls a zoneId that points at a missing zone", () => {
    const t = validateTemplate({ zones: [zone({ id: "real" })], nodes: [node({ zoneId: "ghost" })] });
    expect(t.nodes[0].zoneId).toBeNull();
  });

  it("drops an empty node providers list rather than hiding the node everywhere", () => {
    const t = validateTemplate({ zones: [zone()], nodes: [node({ zoneId: "z", providers: [] })] });
    expect(t.nodes[0].providers).toBeUndefined();
  });
});

describe("visibleElements", () => {
  const template = validateTemplate({
    zones: [zone({ id: "r", providers: ["azure", "aws"], provider: "azure" })],
    nodes: [
      node({ id: "always", zoneId: "r" }),
      node({ id: "az", zoneId: "r", providers: ["azure"] }),
      node({ id: "aws", zoneId: "r", providers: ["aws"] }),
      node({ id: "outside", zoneId: null, providers: ["gcp"] }),
    ],
    edges: [
      { id: "e-az", source: "always", target: "az" },
      { id: "e-aws", source: "always", target: "aws" },
    ],
  }) as DiagramTemplate;

  it("hides nodes whose providers exclude the zone's active one", () => {
    const v = visibleElements(template);
    expect(v.nodes.has("az")).toBe(true);
    expect(v.nodes.has("aws")).toBe(false);
    expect(v.nodes.has("always")).toBe(true);
  });

  it("ignores providers on a node that is not on any zone", () => {
    // Without a zone there is no provider to compare against, so hiding it
    // would make the node unreachable with no way to bring it back.
    expect(visibleElements(template).nodes.has("outside")).toBe(true);
  });

  it("hides edges that lose an endpoint", () => {
    const v = visibleElements(template);
    expect(v.edges.has("e-az")).toBe(true);
    expect(v.edges.has("e-aws")).toBe(false);
  });

  it("reveals the other node when the provider flips", () => {
    const flipped = setZoneProvider(template, "r", "aws");
    const v = visibleElements(flipped);
    expect(v.nodes.has("aws")).toBe(true);
    expect(v.nodes.has("az")).toBe(false);
  });

  it("cascades hiding through parentId", () => {
    // Hiding a group must hide what is nested inside it, or orphaned children
    // would float over the canvas with no container.
    const t = validateTemplate({
      zones: [zone({ id: "r", providers: ["azure", "aws"], provider: "aws" })],
      nodes: [
        node({ id: "g", kind: "group", zoneId: "r", providers: ["azure"] }),
        // `child` must be a container too, or validation nulls the
        // grandchild's parentId and there is no chain left to cascade down.
        node({ id: "child", kind: "group", parentId: "g" }),
        node({ id: "grandchild", parentId: "child" }),
      ],
    });
    const v = visibleElements(t);
    expect(v.nodes.has("g")).toBe(false);
    expect(v.nodes.has("child")).toBe(false);
    expect(v.nodes.has("grandchild")).toBe(false);
    expect(v.hiddenNodeCount).toBe(3);
  });
});

describe("shape containment", () => {
  it("treats a rect as its bounding box", () => {
    const z = validateTemplate({ zones: [zone({ shape: "rect" })], nodes: [] }).zones![0];
    expect(pointInZone(z, 10, 10)).toBe(true);
    expect(pointInZone(z, 399, 299)).toBe(true);
    expect(pointInZone(z, 401, 10)).toBe(false);
  });

  it("excludes the corners of an ellipse", () => {
    const z = validateTemplate({ zones: [zone({ shape: "ellipse" })], nodes: [] }).zones![0];
    expect(pointInZone(z, 200, 150)).toBe(true); // centre
    expect(pointInZone(z, 5, 5)).toBe(false); // top-left corner is outside
  });

  it("excludes the clipped corners of a hexagon", () => {
    const z = validateTemplate({ zones: [zone({ shape: "hexagon" })], nodes: [] }).zones![0];
    expect(pointInZone(z, 200, 150)).toBe(true);
    expect(pointInZone(z, 2, 2)).toBe(false);
  });

  it("respects a concave polygon's notch", () => {
    // A U shape: the gap between the arms must not count as inside.
    const z = validateTemplate({
      zones: [
        zone({
          shape: "polygon",
          points: [[0, 0], [0.3, 0], [0.3, 0.7], [0.7, 0.7], [0.7, 0], [1, 0], [1, 1], [0, 1]],
        }),
      ],
      nodes: [],
    }).zones![0];
    expect(pointInZone(z, 0.5 * 400, 0.9 * 300)).toBe(true); // the base
    expect(pointInZone(z, 0.5 * 400, 0.3 * 300)).toBe(false); // the notch
  });
});

describe("containZonePoints", () => {
  const box = { x: 100, y: 50, w: 400, h: 200 };

  it("returns null when every point already fits", () => {
    const points: ZonePoint[] = [
      [0, 0],
      [1, 0],
      [0.5, 1],
    ];
    expect(containZonePoints(box, points)).toBeNull();
  });

  it("grows right/down and renormalises without moving the shape", () => {
    // One vertex dragged 30% past the right edge and 50% past the bottom.
    const grown = containZonePoints(box, [
      [0, 0],
      [1.3, 0],
      [0.5, 1.5],
    ])!;
    expect(grown.x).toBe(100);
    expect(grown.y).toBe(50);
    expect(grown.w).toBeCloseTo(400 * 1.3);
    expect(grown.h).toBeCloseTo(200 * 1.5);
    // The dragged vertex sits on the new edges; everything is back in 0..1.
    expect(grown.points[1][0]).toBeCloseTo(1);
    expect(grown.points[2][1]).toBeCloseTo(1);
    for (const [px, py] of grown.points) {
      expect(px).toBeGreaterThanOrEqual(0);
      expect(px).toBeLessThanOrEqual(1);
      expect(py).toBeGreaterThanOrEqual(0);
      expect(py).toBeLessThanOrEqual(1);
    }
    // The unmoved vertex keeps its ABSOLUTE position: x + p*w is unchanged.
    expect(grown.x + grown.points[0][0] * grown.w).toBeCloseTo(100);
  });

  it("grows left/up by moving the box origin", () => {
    const grown = containZonePoints(box, [
      [-0.25, 0],
      [1, -0.1],
      [0.5, 1],
    ])!;
    expect(grown.x).toBeCloseTo(100 - 0.25 * 400);
    expect(grown.y).toBeCloseTo(50 - 0.1 * 200);
    expect(grown.w).toBeCloseTo(400 * 1.25);
    expect(grown.h).toBeCloseTo(200 * 1.1);
    // The right edge of the box did not move.
    expect(grown.x + grown.w).toBeCloseTo(100 + 400);
  });
});

describe("zoneAt", () => {
  const host = validateTemplate({
    zones: [
      zone({ id: "host", x: 0, y: 0, w: 900, h: 600, z: 0 }),
      zone({ id: "island", x: 400, y: 300, w: 200, h: 150, z: 1 }),
    ],
    nodes: [],
  }).zones!;

  it("gives an overlapping point to the higher-z zone", () => {
    expect(zoneAt(host, 450, 350)?.id).toBe("island");
  });

  it("gives a non-overlapping point to the host", () => {
    expect(zoneAt(host, 100, 100)?.id).toBe("host");
  });

  it("returns null outside every zone", () => {
    expect(zoneAt(host, 5000, 5000)).toBeNull();
  });

  it("breaks a z tie by picking the smaller zone", () => {
    const tied = validateTemplate({
      zones: [
        zone({ id: "big", x: 0, y: 0, w: 900, h: 600, z: 0 }),
        zone({ id: "small", x: 400, y: 300, w: 200, h: 150, z: 0 }),
      ],
      nodes: [],
    }).zones!;
    expect(zoneAt(tied, 450, 350)?.id).toBe("small");
  });
});

describe("React Flow mapping", () => {
  it("emits zone nodes first, behind everything, under a prefixed id", () => {
    const { nodes } = toReactFlow(EXAMPLE_ZONED_TEMPLATE);
    expect(nodes[0].id).toBe("zone:region");
    expect(nodes[0].type).toBe("zone");
    expect(nodes[0].zIndex).toBeLessThan(0);
    // The island stacks above its host but still behind every real node.
    const island = nodes.find((n) => n.id === "zone:vendor")!;
    expect(island.zIndex).toBeGreaterThan(nodes[0].zIndex!);
    expect(island.zIndex).toBeLessThan(0);
  });

  it("omits nodes hidden by the active provider", () => {
    const { nodes, edges } = toReactFlow(EXAMPLE_ZONED_TEMPLATE); // azure
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain("sql-az");
    expect(ids).not.toContain("sql-aws");
    expect(ids).not.toContain("sql-gcp");
    expect(edges.map((e) => e.id)).not.toContain("z3");
  });

  it("swaps which database renders when the region flips to AWS", () => {
    const aws = setZoneProvider(EXAMPLE_ZONED_TEMPLATE, "region", "aws");
    const ids = toReactFlow(aws).nodes.map((n) => n.id);
    expect(ids).toContain("sql-aws");
    expect(ids).not.toContain("sql-az");
    // Redis exists on azure and aws, so it stays.
    expect(ids).toContain("cache");
  });

  it("drops the cache on GCP but keeps the island untouched", () => {
    const gcp = setZoneProvider(EXAMPLE_ZONED_TEMPLATE, "region", "gcp");
    const ids = toReactFlow(gcp).nodes.map((n) => n.id);
    expect(ids).toContain("sql-gcp");
    expect(ids).not.toContain("cache");
    // The SaaS island has its own provider and is unaffected.
    expect(ids).toContain("pay");
  });

  it("can render every node regardless of selection", () => {
    const { nodes } = toReactFlow(EXAMPLE_ZONED_TEMPLATE, { applyVisibility: false });
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain("sql-az");
    expect(ids).toContain("sql-aws");
    expect(ids).toContain("sql-gcp");
  });
});

describe("fromReactFlow preserves hidden nodes", () => {
  it("carries hidden nodes through an edit — the data-loss guard", () => {
    // toReactFlow omits hidden nodes. Without `base`, deriving the template
    // back would delete them, so toggling a zone to AWS and back would
    // permanently destroy every Azure-only node.
    const { nodes, edges } = toReactFlow(EXAMPLE_ZONED_TEMPLATE);
    const back = fromReactFlow(nodes, edges, { base: EXAMPLE_ZONED_TEMPLATE });

    expect(back.nodes).toHaveLength(EXAMPLE_ZONED_TEMPLATE.nodes.length);
    expect(back.edges).toHaveLength(EXAMPLE_ZONED_TEMPLATE.edges.length);
    for (const id of ["sql-az", "sql-aws", "sql-gcp", "cache"]) {
      expect(back.nodes.find((n) => n.id === id), `${id} survived`).toBeTruthy();
    }
  });

  it("loses hidden nodes without a base, which is why base exists", () => {
    const { nodes, edges } = toReactFlow(EXAMPLE_ZONED_TEMPLATE);
    const back = fromReactFlow(nodes, edges);
    expect(back.nodes.find((n) => n.id === "sql-aws")).toBeUndefined();
  });

  it("survives a full toggle round-trip in both directions", () => {
    let t: DiagramTemplate = EXAMPLE_ZONED_TEMPLATE;
    for (const provider of ["aws", "gcp", "azure", "aws"]) {
      t = setZoneProvider(t, "region", provider);
      const { nodes, edges } = toReactFlow(t);
      t = fromReactFlow(nodes, edges, { base: t });
    }
    expect(t.nodes).toHaveLength(EXAMPLE_ZONED_TEMPLATE.nodes.length);
    expect(t.edges).toHaveLength(EXAMPLE_ZONED_TEMPLATE.edges.length);
  });

  it("round-trips zone geometry and provider selection", () => {
    const { nodes, edges } = toReactFlow(EXAMPLE_ZONED_TEMPLATE);
    const back = fromReactFlow(nodes, edges, { base: EXAMPLE_ZONED_TEMPLATE });
    for (const original of EXAMPLE_ZONED_TEMPLATE.zones!) {
      expect(back.zones!.find((z) => z.id === original.id)).toMatchObject({
        label: original.label,
        shape: original.shape,
        x: original.x,
        y: original.y,
        w: original.w,
        h: original.h,
        provider: original.provider,
        providers: original.providers,
      });
    }
  });

  it("still honours a deletion — base must not resurrect removed nodes", () => {
    const { nodes, edges } = toReactFlow(EXAMPLE_ZONED_TEMPLATE);
    // Drop a *visible* node, as the delete action would.
    const without = nodes.filter((n) => n.id !== "cdn");
    const back = fromReactFlow(without, edges, { base: EXAMPLE_ZONED_TEMPLATE });
    expect(back.nodes.find((n) => n.id === "cdn")).toBeUndefined();
  });
});

describe("scenario helpers", () => {
  it("lists every provider any zone offers", () => {
    expect(templateProviders(EXAMPLE_ZONED_TEMPLATE)).toEqual(["azure", "aws", "gcp", "saas"]);
  });

  it("reports a mixed scenario as null", () => {
    expect(activeScenario(EXAMPLE_ZONED_TEMPLATE)).toBeNull();
  });

  it("reports a uniform scenario", () => {
    const t = validateTemplate({
      zones: [zone({ id: "a", provider: "aws" }), zone({ id: "b", provider: "aws" })],
      nodes: [],
    });
    expect(activeScenario(t)).toBe("aws");
  });

  it("leaves zones that do not offer the provider alone", () => {
    // The SaaS island cannot become AWS; forcing it would misrepresent it.
    const all = setAllZoneProviders(EXAMPLE_ZONED_TEMPLATE, "aws");
    expect(all.zones!.find((z) => z.id === "region")!.provider).toBe("aws");
    expect(all.zones!.find((z) => z.id === "vendor")!.provider).toBe("saas");
  });
});

describe("bounds and prompt", () => {
  it("includes zones, which usually extend past the nodes", () => {
    const b = templateBounds(EXAMPLE_ZONED_TEMPLATE);
    expect(b.minX).toBeLessThanOrEqual(40);
    expect(b.minY).toBeLessThanOrEqual(40);
    expect(b.maxX).toBeGreaterThanOrEqual(980);
  });

  it("is unchanged for a zone-less template", () => {
    // minX from the "End User" node at x:30, minY from the VPC group at y:40.
    expect(templateBounds(EXAMPLE_TEMPLATE)).toEqual({
      minX: 30,
      minY: 40,
      maxX: 1200,
      maxY: 520,
    });
  });

  it("describes zones so a model can author them", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("zones");
    expect(prompt).toContain("zoneId");
    expect(prompt).toContain("azure");
    expect(prompt).toContain("polygon");
  });

  it("advertises registry-contributed providers", () => {
    expect(buildSystemPrompt({ providers: ["fly", "render"] })).toContain("fly");
  });
});

describe("zone style overrides", () => {
  const validate = (over: Partial<DiagramZone> | Record<string, unknown>) =>
    validateTemplate({ version: 1, zones: [zone(over as Partial<DiagramZone>)], nodes: [], edges: [] })
      .zones![0];

  it("normalises colour to canonical lowercase #rrggbb", () => {
    expect(validate({ color: "#38BDF8" }).color).toBe("#38bdf8");
    expect(validate({ color: "#3bf" }).color).toBe("#33bbff");
    expect(validate({ color: "  #38bdf8  " }).color).toBe("#38bdf8");
  });

  it("drops a colour that is not a hex colour", () => {
    for (const bad of ["sky", "rgb(1,2,3)", "#38bdf", "#38bdf8ff00", 42, null, ""]) {
      expect("color" in validate({ color: bad as never })).toBe(false);
    }
  });

  it("folds an alpha carried on the colour into opacity", () => {
    // /NN percent form.
    const slash = validate({ color: "#38bdf8/40" });
    expect(slash.color).toBe("#38bdf8");
    expect(slash.opacity).toBeCloseTo(0.4);
    // CSS 8-digit hex form: 0x33 / 255 = 0.2.
    const eight = validate({ color: "#38bdf833" });
    expect(eight.color).toBe("#38bdf8");
    expect(eight.opacity).toBeCloseTo(0.2);
  });

  it("lets an explicit opacity beat the colour's alpha", () => {
    const z = validate({ color: "#38bdf8/40", opacity: 0.1 });
    expect(z.opacity).toBeCloseTo(0.1);
  });

  it("stores outline only when it differs from solid", () => {
    expect("outline" in validate({ outline: "solid" })).toBe(false);
    expect("outline" in validate({ outline: "wavy" as never })).toBe(false);
    expect(validate({ outline: "dashed" }).outline).toBe("dashed");
    expect(validate({ outline: "dotted" }).outline).toBe("dotted");
    expect(validate({ outline: "none" }).outline).toBe("none");
  });

  it("stores fill only when opted out", () => {
    expect("fill" in validate({ fill: true })).toBe(false);
    expect("fill" in validate({ fill: "no" as never })).toBe(false);
    expect(validate({ fill: false }).fill).toBe(false);
  });

  it("is idempotent — a canonicalised document validates to itself", () => {
    // "#38BDF8/40" is deliberately NOT byte-identical (it canonicalises); the
    // invariant is that a second pass changes nothing further.
    const raw = { version: 1, zones: [zone({ color: "#38BDF8/40", outline: "dashed", fill: false } as never)], nodes: [], edges: [] };
    const once = validateTemplate(raw);
    const twice = validateTemplate(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("round-trips an already-canonical styled zone byte-identical", () => {
    const doc = validateTemplate({
      version: 1,
      zones: [zone({ color: "#22c55e", outline: "dotted", fill: false, opacity: 0.3 } as never)],
      nodes: [],
      edges: [],
    });
    expect(JSON.stringify(validateTemplate(doc))).toBe(JSON.stringify(doc));
    // And through the canvas adapters.
    const rf = toReactFlow(doc);
    const back = fromReactFlow(rf.nodes, rf.edges, { base: doc });
    expect(back.zones![0].color).toBe("#22c55e");
    expect(back.zones![0].outline).toBe("dotted");
    expect(back.zones![0].fill).toBe(false);
  });

  it("advertises colour and outline in the generated prompt", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('"color":"#38bdf8"');
    expect(prompt).toContain('"outline":"solid|dashed|dotted|none"');
  });
});

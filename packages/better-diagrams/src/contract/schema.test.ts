import { describe, expect, it } from "vitest";
import {
  EXAMPLE_TEMPLATE,
  buildSystemPrompt,
  fromReactFlow,
  parseLlmTemplate,
  scaleZoneMembers,
  templateBounds,
  toReactFlow,
  validateTemplate,
  type DiagramTemplate,
} from "./schema";
import { buildSequencePrompt, validateSequence } from "./sequence";

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

describe("validateTemplate", () => {
  it("throws only when there is no nodes array", () => {
    expect(() => validateTemplate({})).toThrow(/nodes/);
    expect(() => validateTemplate(null)).toThrow(/nodes/);
    expect(validateTemplate({ nodes: [] })).toEqual({ version: 1, nodes: [], edges: [] });
  });

  it("repairs unknown kinds and icons instead of failing", () => {
    const t = validateTemplate({ nodes: [node({ kind: "wormhole", icon: "banana" })] });
    expect(t.nodes[0].kind).toBe("service");
    expect(t.nodes[0].icon).toBe("none");
  });

  it("accepts kinds and icons contributed by a registry", () => {
    const t = validateTemplate(
      { nodes: [node({ kind: "lambda", icon: "sparkle" })] },
      { knownKinds: ["lambda"], knownIcons: ["sparkle"] },
    );
    expect(t.nodes[0].kind).toBe("lambda");
    expect(t.nodes[0].icon).toBe("sparkle");
  });

  it("suffixes duplicate ids rather than dropping nodes", () => {
    const t = validateTemplate({ nodes: [node({ id: "a" }), node({ id: "a" }), node({ id: "a" })] });
    expect(t.nodes.map((n) => n.id)).toEqual(["a", "a_2", "a_3"]);
  });

  it("nulls a parentId that points at a missing node", () => {
    const t = validateTemplate({ nodes: [node({ id: "a", parentId: "ghost" })] });
    expect(t.nodes[0].parentId).toBeNull();
  });

  it("nulls a parentId that points at a non-container", () => {
    const t = validateTemplate({
      nodes: [node({ id: "svc", kind: "service" }), node({ id: "b", parentId: "svc" })],
    });
    expect(t.nodes.find((n) => n.id === "b")!.parentId).toBeNull();
  });

  it("nulls a self-parent", () => {
    const t = validateTemplate({ nodes: [node({ id: "g", kind: "group", parentId: "g" })] });
    expect(t.nodes[0].parentId).toBeNull();
  });

  // The original implementation only guarded traversal with a depth counter,
  // which stopped the hang but left an unrenderable document behind.
  it("breaks a two-node parent cycle and leaves a valid forest", () => {
    const t = validateTemplate({
      nodes: [
        node({ id: "a", kind: "group", parentId: "b" }),
        node({ id: "b", kind: "group", parentId: "a" }),
      ],
    });
    const roots = t.nodes.filter((n) => n.parentId === null);
    expect(roots).toHaveLength(1);
    expect(hasCycle(t)).toBe(false);
  });

  it("breaks a three-node parent cycle", () => {
    const t = validateTemplate({
      nodes: [
        node({ id: "a", kind: "group", parentId: "b" }),
        node({ id: "b", kind: "group", parentId: "c" }),
        node({ id: "c", kind: "group", parentId: "b" }),
      ],
    });
    expect(hasCycle(t)).toBe(false);
  });

  it("keeps a legitimate deep nesting intact", () => {
    const t = validateTemplate({
      nodes: [
        node({ id: "outer", kind: "group" }),
        node({ id: "inner", kind: "group", parentId: "outer" }),
        node({ id: "leaf", parentId: "inner" }),
      ],
    });
    expect(t.nodes.find((n) => n.id === "inner")!.parentId).toBe("outer");
    expect(t.nodes.find((n) => n.id === "leaf")!.parentId).toBe("inner");
  });

  it("drops edges that reference missing nodes, and self-edges", () => {
    const t = validateTemplate({
      nodes: [node({ id: "a" }), node({ id: "b" })],
      edges: [
        { id: "ok", source: "a", target: "b" },
        { id: "ghost", source: "a", target: "nope" },
        { id: "self", source: "a", target: "a" },
      ],
    });
    expect(t.edges.map((e) => e.id)).toEqual(["ok"]);
  });

  it("clamps labelT and defaults bad edge styles", () => {
    const t = validateTemplate({
      nodes: [node({ id: "a" }), node({ id: "b" })],
      edges: [{ id: "e", source: "a", target: "b", labelT: 99, style: "zigzag", color: "puce" }],
    });
    expect(t.edges[0].labelT).toBe(0.85);
    expect(t.edges[0].style).toBe("solid");
    expect(t.edges[0].color).toBe("slate");
  });

  it("substitutes defaults for NaN and missing geometry", () => {
    const t = validateTemplate({
      nodes: [{ id: "a", kind: "group", x: "abc", y: undefined, w: null, h: NaN }],
    });
    expect(t.nodes[0]).toMatchObject({ x: 0, y: 0, w: 320, h: 240 });
  });

  it("round-trips meta untouched", () => {
    const t = validateTemplate({ nodes: [], meta: { title: "X", ownerId: 7 } });
    expect(t.meta).toEqual({ title: "X", ownerId: 7 });
  });
});

describe("parseLlmTemplate", () => {
  it("strips markdown fences", () => {
    const reply = '```json\n{"version":1,"nodes":[{"id":"a","kind":"service"}],"edges":[]}\n```';
    expect(parseLlmTemplate(reply).nodes[0].id).toBe("a");
  });

  it("ignores prose around the JSON object", () => {
    const reply = 'Sure! Here you go:\n{"version":1,"nodes":[{"id":"a"}],"edges":[]}\nHope that helps.';
    expect(parseLlmTemplate(reply).nodes).toHaveLength(1);
  });

  it("heals lightly damaged JSON instead of rejecting it", () => {
    expect(parseLlmTemplate('{"nodes": [}').nodes).toHaveLength(0);
  });

  it("salvages a reply cut off by max_tokens", () => {
    // A truncated reply parses to whatever survived — visibly incomplete on
    // the canvas, which beats an error the user can't act on.
    expect(parseLlmTemplate('{"version":1,"nodes":[{"id":"a"').nodes[0].id).toBe("a");
  });

  it("reports unhealable damage with position and cause", () => {
    expect(() => parseLlmTemplate('{"kind":"client","icon":y React 18+ app"}')).toThrow(
      /Unreadable JSON at line 1.*re-copy/s,
    );
  });

  it("reports a reply with no JSON at all", () => {
    expect(() => parseLlmTemplate("I cannot help with that.")).toThrow(/No JSON object/);
  });
});

describe("React Flow round-trip", () => {
  it("preserves the document through toReactFlow → fromReactFlow", () => {
    const { nodes, edges } = toReactFlow(EXAMPLE_TEMPLATE);
    const back = fromReactFlow(nodes, edges, { meta: EXAMPLE_TEMPLATE.meta });

    expect(back.nodes).toHaveLength(EXAMPLE_TEMPLATE.nodes.length);
    expect(back.edges).toHaveLength(EXAMPLE_TEMPLATE.edges.length);
    expect(back.meta).toEqual(EXAMPLE_TEMPLATE.meta);

    for (const original of EXAMPLE_TEMPLATE.nodes) {
      const result = back.nodes.find((n) => n.id === original.id)!;
      expect(result).toMatchObject({
        label: original.label,
        kind: original.kind,
        icon: original.icon,
        description: original.description,
        parentId: original.parentId,
        x: original.x,
        y: original.y,
        w: original.w,
        h: original.h,
      });
    }
    for (const original of EXAMPLE_TEMPLATE.edges) {
      expect(back.edges.find((e) => e.id === original.id)).toMatchObject({
        source: original.source,
        target: original.target,
        label: original.label,
        style: original.style,
        color: original.color,
      });
    }
  });

  it("emits parents before children so sub-flows lay out", () => {
    const { nodes } = toReactFlow(EXAMPLE_TEMPLATE);
    const seen = new Set<string>();
    for (const n of nodes) {
      if (n.parentId) expect(seen.has(n.parentId)).toBe(true);
      seen.add(n.id);
    }
  });

  it("does not pin children inside their parent", () => {
    // `extent: "parent"` would make it impossible to drag a node out of a group.
    const { nodes } = toReactFlow(EXAMPLE_TEMPLATE);
    const child = nodes.find((n) => n.id === "api")!;
    expect(child.parentId).toBe("vpc");
    expect("extent" in child).toBe(false);
  });

  it("maps container and annotation kinds to the right renderers", () => {
    const { nodes } = toReactFlow(EXAMPLE_TEMPLATE);
    expect(nodes.find((n) => n.id === "vpc")!.type).toBe("group");
    expect(nodes.find((n) => n.id === "note")!.type).toBe("annotation");
    expect(nodes.find((n) => n.id === "api")!.type).toBe("shape");
  });

  it("reads dimensions from measured state when width/height are absent", () => {
    // This is what live React Flow state looks like after the DOM is measured.
    const back = fromReactFlow(
      [
        {
          id: "a",
          type: "shape",
          position: { x: 5, y: 6 },
          measured: { width: 201, height: 88 },
          data: { label: "A", kind: "service", icon: "box", description: "" },
        },
      ],
      [],
    );
    expect(back.nodes[0]).toMatchObject({ w: 201, h: 88, x: 5, y: 6 });
  });

  it("prefers an explicit width over a stale measured value", () => {
    const back = fromReactFlow(
      [
        {
          id: "a",
          type: "shape",
          position: { x: 0, y: 0 },
          width: 300,
          measured: { width: 170, height: 76 },
          data: { label: "A", kind: "service", icon: "box", description: "" },
        },
      ],
      [],
    );
    expect(back.nodes[0].w).toBe(300);
  });
});

describe("templateBounds", () => {
  it("resolves child coordinates through the parent chain", () => {
    const t = validateTemplate({
      nodes: [
        node({ id: "g", kind: "group", x: 100, y: 100, w: 400, h: 400 }),
        node({ id: "c", parentId: "g", x: 50, y: 50, w: 100, h: 100 }),
      ],
    });
    const b = templateBounds(t);
    expect(b).toEqual({ minX: 100, minY: 100, maxX: 500, maxY: 500 });
  });

  it("returns a zero box for an empty diagram", () => {
    expect(templateBounds({ version: 1, nodes: [], edges: [] })).toEqual({
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
    });
  });
});

describe("buildSystemPrompt", () => {
  it("advertises exactly the vocabulary the validator accepts", () => {
    const prompt = buildSystemPrompt();
    for (const kind of ["service", "database", "group", "text"]) {
      expect(prompt).toContain(kind);
    }
  });

  it("includes registry-contributed kinds so extensions are LLM-authorable", () => {
    const prompt = buildSystemPrompt({ kinds: ["lambda", "s3"] });
    expect(prompt).toContain("lambda");
    expect(prompt).toContain("s3");
  });

  it("appends domain rules verbatim", () => {
    expect(buildSystemPrompt({ extraRules: "- Always put the CDN first." })).toContain(
      "- Always put the CDN first.",
    );
  });
});

/** Detect any remaining parent cycle — the invariant every consumer relies on. */
function hasCycle(t: DiagramTemplate): boolean {
  const byId = new Map(t.nodes.map((n) => [n.id, n]));
  for (const start of t.nodes) {
    const seen = new Set<string>([start.id]);
    let cursor = start.parentId ? byId.get(start.parentId) : undefined;
    while (cursor) {
      if (seen.has(cursor.id)) return true;
      seen.add(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
  }
  return false;
}

describe("lifecycle stages: stubbed and dark", () => {
  const node = (status: string) => ({
    id: "n",
    label: "N",
    kind: "service",
    icon: "box",
    description: "",
    parentId: null,
    status,
    x: 0,
    y: 0,
    w: 170,
    h: 76,
  });

  it("persists the new stages and still strips active", () => {
    for (const status of ["stubbed", "dark"]) {
      const t = validateTemplate({ version: 1, nodes: [node(status)], edges: [] });
      expect(t.nodes[0].status).toBe(status);
    }
    const active = validateTemplate({ version: 1, nodes: [node("active")], edges: [] });
    expect("status" in active.nodes[0]).toBe(false);
  });

  it("advertises the full vocabulary in both generated prompts", () => {
    const expected = "proposed|planned|stubbed|dark|active|deprecated|retired";
    expect(buildSystemPrompt()).toContain(expected);
    expect(buildSequencePrompt()).toContain(expected);
    // And the participant skeleton actually carries the field — the validator
    // accepted status all along, but the model was never told.
    expect(buildSequencePrompt()).toContain('"status"');
  });

  it("round-trips a stubbed participant through sequence validation", () => {
    const seq = validateSequence({
      version: 1,
      participants: [{ id: "p", label: "P", kind: "service", status: "dark" }],
      messages: [],
    });
    expect(seq.participants[0].status).toBe("dark");
  });
});

describe("scaleZoneMembers", () => {
  const zone = (over: Record<string, unknown> = {}) => ({
    id: "z",
    label: "Zone",
    shape: "rounded" as const,
    x: 100,
    y: 100,
    w: 400,
    h: 300,
    providers: ["aws"],
    provider: "aws",
    ...over,
  });
  const base = (): DiagramTemplate =>
    ({
      version: 1,
      zones: [zone()],
      nodes: [
        node({ id: "a", zoneId: "z", x: 150, y: 150, w: 170, h: 76 }),
        node({ id: "out", zoneId: null, x: 800, y: 800 }),
      ],
      edges: [{ id: "e1", source: "a", target: "out", label: "", style: "solid", color: "sky" }],
    }) as DiagramTemplate;
  const before = { x: 100, y: 100, w: 400, h: 300 };

  it("scales member positions and sizes per axis", () => {
    // Width doubles, height halves.
    const after = { x: 100, y: 100, w: 800, h: 150 };
    const out = scaleZoneMembers(base(), "z", before, after);
    const a = out.nodes.find((n) => n.id === "a")!;
    expect(a.x).toBe(100 + (150 - 100) * 2);
    expect(a.y).toBe(100 + (150 - 100) * 0.5);
    expect(a.w).toBe(340);
    expect(a.h).toBe(52); // 38 clamped up to the shape minimum
    expect(out.zones![0]).toMatchObject(after);
  });

  it("anchors on the new origin when the box moved (left-handle resize)", () => {
    const after = { x: 0, y: 100, w: 500, h: 300 };
    const out = scaleZoneMembers(base(), "z", before, after);
    const a = out.nodes.find((n) => n.id === "a")!;
    expect(a.x).toBe(0 + (150 - 100) * 1.25);
    expect(a.y).toBe(150); // y axis untouched
  });

  it("clamps sizes per kind class, honoring custom kind options", () => {
    const doc: DiagramTemplate = {
      ...base(),
      nodes: [
        node({ id: "g", kind: "group", zoneId: "z", x: 120, y: 120, w: 320, h: 240 }),
        node({ id: "t", kind: "text", zoneId: "z", x: 130, y: 130, w: 300, h: 60 }),
        node({ id: "pod", kind: "pod", zoneId: "z", x: 140, y: 140, w: 200, h: 150 }),
      ],
    };
    const after = { x: 100, y: 100, w: 40, h: 30 }; // 0.1x both axes
    const out = scaleZoneMembers(doc, "z", before, after, { containerKinds: ["group", "pod"] });
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get("g")).toMatchObject({ w: 160, h: 120 });
    expect(byId.get("t")).toMatchObject({ w: 80, h: 28 });
    expect(byId.get("pod")).toMatchObject({ w: 160, h: 120 }); // custom container kind
  });

  it("scales descendants' relative offsets without double-shifting", () => {
    const doc: DiagramTemplate = {
      ...base(),
      nodes: [
        node({ id: "g", kind: "group", zoneId: "z", x: 150, y: 150, w: 320, h: 240 }),
        node({ id: "child", parentId: "g", x: 40, y: 30, w: 170, h: 76 }),
        node({ id: "grand", parentId: "child", x: 10, y: 8, w: 170, h: 76 }),
      ],
    };
    const after = { x: 100, y: 100, w: 800, h: 600 }; // 2x both
    const out = scaleZoneMembers(doc, "z", before, after);
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get("g")).toMatchObject({ x: 200, y: 200, w: 640, h: 480 });
    // Children keep parent-relative coords, scaled — not shifted by the zone.
    expect(byId.get("child")).toMatchObject({ x: 80, y: 60, w: 340, h: 152 });
    expect(byId.get("grand")).toMatchObject({ x: 20, y: 16 });
  });

  it("leaves non-members, other zones, and edges untouched; locked members scale", () => {
    const doc: DiagramTemplate = {
      ...base(),
      zones: [zone(), zone({ id: "other", x: 900, y: 900 })],
      nodes: [
        node({ id: "a", zoneId: "z", locked: true, x: 150, y: 150 }),
        node({ id: "out", zoneId: null, x: 800, y: 800 }),
      ],
    };
    const after = { x: 100, y: 100, w: 800, h: 600 };
    const out = scaleZoneMembers(doc, "z", before, after);
    expect(out.nodes.find((n) => n.id === "out")).toEqual(doc.nodes[1]);
    expect(out.zones![1]).toEqual(doc.zones![1]);
    expect(out.edges).toBe(doc.edges);
    expect(out.nodes.find((n) => n.id === "a")!.x).toBe(200); // locked scales too
  });

  it("an explicit memberIds list overrides stale zoneId membership", () => {
    const doc = base();
    // Pretend the derive already stripped a's zoneId mid-drag.
    doc.nodes = doc.nodes.map((n) => (n.id === "a" ? { ...n, zoneId: null } : n));
    const after = { x: 100, y: 100, w: 800, h: 300 };
    const out = scaleZoneMembers(doc, "z", before, after, { memberIds: ["a"] });
    expect(out.nodes.find((n) => n.id === "a")!.x).toBe(200);
  });

  it("passes a degenerate axis through instead of producing NaN", () => {
    const out = scaleZoneMembers(base(), "z", { ...before, w: 0 }, { x: 100, y: 100, w: 800, h: 600 });
    const a = out.nodes.find((n) => n.id === "a")!;
    expect(a.x).toBe(150); // x axis untouched
    expect(a.y).toBe(200); // y axis still scales
    expect(Number.isFinite(a.w)).toBe(true);
  });

  it("returns the same reference when there is nothing to do", () => {
    const doc = base();
    expect(scaleZoneMembers(doc, "nope", before, before)).toBe(doc);
    const memberless: DiagramTemplate = { ...doc, nodes: [doc.nodes[1]] };
    expect(scaleZoneMembers(memberless, "z", before, before)).toBe(memberless);
  });

  it("writes the zone box and keeps polygon points byte-identical", () => {
    const points: [number, number][] = [
      [0, 0.25],
      [0.5, 0],
      [1, 0.25],
      [1, 1],
      [0, 1],
    ];
    const doc: DiagramTemplate = { ...base(), zones: [zone({ shape: "polygon", points })] };
    const after = { x: 50, y: 50, w: 800, h: 600 };
    const out = scaleZoneMembers(doc, "z", before, after);
    expect(out.zones![0]).toMatchObject(after);
    expect(out.zones![0].points).toBe(points);
  });
});

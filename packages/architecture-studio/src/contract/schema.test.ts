import { describe, expect, it } from "vitest";
import {
  EXAMPLE_TEMPLATE,
  buildSystemPrompt,
  fromReactFlow,
  parseLlmTemplate,
  templateBounds,
  toReactFlow,
  validateTemplate,
  type DiagramTemplate,
} from "./schema";

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

  it("reports malformed JSON clearly", () => {
    expect(() => parseLlmTemplate('{"nodes": [}')).toThrow(/malformed JSON/);
  });

  it("distinguishes a truncated reply from a non-JSON one", () => {
    // A max_tokens cutoff looks like this; the fix is more output tokens.
    expect(() => parseLlmTemplate('{"version":1,"nodes":[{"id":"a"')).toThrow(/truncated/);
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

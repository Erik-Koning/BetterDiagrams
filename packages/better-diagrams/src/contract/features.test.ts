/**
 * Tests for the second round of work: geometry-driven zone membership,
 * clipboard, layout, edge scoping, migration, and ghost mode.
 */
import { describe, expect, it } from "vitest";
import {
  CURRENT_VERSION,
  EXAMPLE_ZONED_TEMPLATE,
  assignZonesByGeometry,
  fromReactFlow,
  migrateTemplate,
  setZoneProvider,
  snapNodesIntoZones,
  toReactFlow,
  validateTemplate,
  visibleElements,
  type DiagramTemplate,
} from "./schema";
import { autoLayout, hasOverlaps } from "./layout";
import { copyFragment, duplicateWithConnections, pasteFragment, parseFragment } from "./clipboard";

const zone = (over: Record<string, unknown> = {}) => ({
  id: "z",
  label: "Z",
  shape: "rounded",
  x: 0,
  y: 0,
  w: 600,
  h: 400,
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

describe("assignZonesByGeometry", () => {
  it("enrols a node the zone was dragged over", () => {
    // The gap: dragging a *zone* over existing nodes left them un-enrolled, so
    // they looked enclosed but the provider toggle ignored them.
    const before = validateTemplate({
      zones: [zone({ x: 1000, y: 1000 })],
      nodes: [node({ id: "a", x: 100, y: 100 })],
    });
    expect(before.nodes[0].zoneId).toBeNull();

    const moved = { ...before, zones: [{ ...before.zones![0], x: 0, y: 0 }] };
    expect(assignZonesByGeometry(moved).nodes[0].zoneId).toBe("z");
  });

  it("un-enrols a node the zone was dragged away from", () => {
    const t = validateTemplate({
      zones: [zone()],
      nodes: [node({ id: "a", x: 100, y: 100, zoneId: "z" })],
    });
    const moved = { ...t, zones: [{ ...t.zones![0], x: 5000, y: 5000 }] };
    expect(assignZonesByGeometry(moved).nodes[0].zoneId).toBeNull();
  });

  it("clears every zoneId when the last zone is deleted", () => {
    const t = validateTemplate({ zones: [zone()], nodes: [node({ id: "a", zoneId: "z" })] });
    const without = assignZonesByGeometry({ ...t, zones: [] });
    expect(without.nodes[0].zoneId).toBeNull();
  });

  it("gives an overlapped node to the zone on top", () => {
    const t = validateTemplate({
      zones: [
        zone({ id: "host", x: 0, y: 0, w: 900, h: 600, z: 0 }),
        zone({ id: "island", x: 300, y: 200, w: 200, h: 150, z: 1 }),
      ],
      nodes: [node({ id: "a", x: 340, y: 240, w: 100, h: 50 })],
    });
    expect(assignZonesByGeometry(t).nodes[0].zoneId).toBe("island");
  });

  it("returns the same object when nothing changed", () => {
    const t = validateTemplate({ zones: [zone()], nodes: [node({ id: "a", x: 100, y: 100 })] });
    const once = assignZonesByGeometry(t);
    expect(assignZonesByGeometry(once)).toBe(once);
  });
});

describe("snapNodesIntoZones", () => {
  it("moves a node into the zone it claims", () => {
    // What LLM output looks like: right membership, wrong coordinates.
    const t = validateTemplate({
      zones: [zone()],
      nodes: [node({ id: "a", zoneId: "z", x: 4000, y: 4000 })],
    });
    const snapped = snapNodesIntoZones(t);
    expect(snapped.nodes[0].zoneId).toBe("z");
    expect(snapped.nodes[0].x).toBeLessThan(600);
    expect(snapped.nodes[0].y).toBeLessThan(400);
  });

  it("leaves a node that is already inside alone", () => {
    const t = validateTemplate({
      zones: [zone()],
      nodes: [node({ id: "a", zoneId: "z", x: 100, y: 100 })],
    });
    expect(snapNodesIntoZones(t).nodes[0]).toMatchObject({ x: 100, y: 100 });
  });

  it("does not move a node positioned relative to a group", () => {
    // Its coordinates belong to the group's space; moving them would fight the
    // group's own layout. Membership is corrected by geometry instead.
    const t = validateTemplate({
      zones: [zone()],
      nodes: [
        node({ id: "g", kind: "group", x: 4000, y: 4000, w: 300, h: 200 }),
        node({ id: "child", parentId: "g", zoneId: "z", x: 20, y: 40 }),
      ],
    });
    const snapped = snapNodesIntoZones(t);
    expect(snapped.nodes.find((n) => n.id === "child")).toMatchObject({ x: 20, y: 40 });
    expect(snapped.nodes.find((n) => n.id === "child")!.zoneId).toBeNull();
  });

  it("keeps a node bigger than its zone inside the box rather than producing NaN", () => {
    const t = validateTemplate({
      zones: [zone({ w: 100, h: 100 })],
      nodes: [node({ id: "a", zoneId: "z", x: 9000, y: 9000, w: 400, h: 300 })],
    });
    const snapped = snapNodesIntoZones(t);
    expect(Number.isFinite(snapped.nodes[0].x)).toBe(true);
    expect(Number.isFinite(snapped.nodes[0].y)).toBe(true);
  });
});

describe("edge provider scoping", () => {
  const build = (provider: string) =>
    validateTemplate({
      zones: [zone({ id: "r", providers: ["azure", "aws"], provider })],
      nodes: [node({ id: "a", zoneId: "r" }), node({ id: "b", zoneId: "r", x: 300 })],
      edges: [
        { id: "always", source: "a", target: "b" },
        { id: "aws-only", source: "a", target: "b", providers: ["aws"] },
      ],
    }) as DiagramTemplate;

  it("hides an edge absent from the active provider", () => {
    const v = visibleElements(build("azure"));
    expect(v.edges.has("always")).toBe(true);
    expect(v.edges.has("aws-only")).toBe(false);
  });

  it("shows it once the provider matches", () => {
    expect(visibleElements(build("aws")).edges.has("aws-only")).toBe(true);
  });

  it("ignores providers when neither endpoint is zoned", () => {
    // No zone means no provider to compare against — same rule as for nodes.
    const t = validateTemplate({
      nodes: [node({ id: "a" }), node({ id: "b", x: 300 })],
      edges: [{ id: "e", source: "a", target: "b", providers: ["gcp"] }],
    });
    expect(visibleElements(t).edges.has("e")).toBe(true);
  });

  it("drops an empty providers list", () => {
    const t = validateTemplate({
      nodes: [node({ id: "a" }), node({ id: "b", x: 300 })],
      edges: [{ id: "e", source: "a", target: "b", providers: [] }],
    });
    expect(t.edges[0].providers).toBeUndefined();
  });

  it("survives the React Flow round-trip", () => {
    const t = build("aws");
    const { nodes, edges } = toReactFlow(t);
    const back = fromReactFlow(nodes, edges, { base: t });
    expect(back.edges.find((e) => e.id === "aws-only")!.providers).toEqual(["aws"]);
  });
});

describe("migrateTemplate", () => {
  it("treats a missing version as v1 rather than failing", () => {
    expect(migrateTemplate({ nodes: [] }).version).toBe(CURRENT_VERSION);
  });

  it("refuses a document from a newer build instead of mangling it", () => {
    // Coercing would drop fields a future release added, turning "open an old
    // client" into silent data loss on the next save.
    expect(() => migrateTemplate({ version: 99, nodes: [] })).toThrow(/newer version/i);
  });

  it("names both versions in the error so the message is actionable", () => {
    expect(() => migrateTemplate({ version: 7, nodes: [] })).toThrow(/v7[\s\S]*v1|v1[\s\S]*v7/);
  });

  it("runs through validateTemplate transparently", () => {
    expect(validateTemplate({ version: 1, nodes: [] }).version).toBe(1);
    expect(() => validateTemplate({ version: 42, nodes: [] })).toThrow(/newer version/i);
  });
});

describe("clipboard", () => {
  const template = validateTemplate({
    zones: [zone({ id: "r" })],
    nodes: [
      node({ id: "g", kind: "group", x: 0, y: 0, w: 400, h: 300, zoneId: "r" }),
      node({ id: "child", parentId: "g", x: 20, y: 60 }),
      node({ id: "solo", x: 500, y: 40 }),
    ],
    edges: [{ id: "e", source: "child", target: "solo" }],
  }) as DiagramTemplate;

  it("pulls descendants in with a copied container", () => {
    // Copying a group without its children would paste an empty box.
    const fragment = copyFragment(template, ["g"]);
    expect(fragment.nodes.map((n) => n.id).sort()).toEqual(["child", "g"]);
  });

  it("drops edges with only one end in the selection", () => {
    expect(copyFragment(template, ["g"]).edges).toHaveLength(0);
    expect(copyFragment(template, ["g", "solo"]).edges.map((e) => e.id)).toEqual(["e"]);
  });

  it("carries the zones the fragment references", () => {
    expect(copyFragment(template, ["g"]).zones?.map((z) => z.id)).toEqual(["r"]);
  });

  it("pastes under fresh ids, leaving the originals untouched", () => {
    const fragment = copyFragment(template, ["g", "solo"]);
    const { template: next, newNodeIds } = pasteFragment(template, fragment);
    expect(next.nodes).toHaveLength(template.nodes.length + 3);
    for (const id of newNodeIds) expect(template.nodes.find((n) => n.id === id)).toBeUndefined();
  });

  it("rewrites internal references rather than pointing at the originals", () => {
    const fragment = copyFragment(template, ["g", "solo"]);
    const { template: next, newNodeIds } = pasteFragment(template, fragment);
    const pastedChild = next.nodes.find((n) => newNodeIds.includes(n.id) && n.parentId);
    expect(pastedChild).toBeTruthy();
    // The copy's parent must be the copied group, not the original.
    expect(pastedChild!.parentId).not.toBe("g");
    expect(newNodeIds).toContain(pastedChild!.parentId!);

    const pastedEdge = next.edges.find((e) => e.id !== "e");
    expect(newNodeIds).toContain(pastedEdge!.source);
    expect(newNodeIds).toContain(pastedEdge!.target);
  });

  it("duplicateWithConnections re-attaches boundary edges to the clone", () => {
    const { template: next, newNodeIds } = duplicateWithConnections(template, ["solo"]);
    expect(newNodeIds).toHaveLength(1);
    const clone = newNodeIds[0];

    // The boundary edge child→solo is mirrored as child→clone…
    const mirrored = next.edges.filter((e) => e.id !== "e");
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0].source).toBe("child");
    expect(mirrored[0].target).toBe(clone);
    // …and the original line is untouched.
    expect(next.edges.find((e) => e.id === "e")).toMatchObject({ source: "child", target: "solo" });
  });

  it("duplicateWithConnections clones internal edges between the copies", () => {
    const { template: next, newNodeIds } = duplicateWithConnections(template, ["g", "solo"]);
    // child→solo is internal to the selection: it clones copy-to-copy, and
    // there are no boundary edges to mirror.
    const mirrored = next.edges.filter((e) => e.id !== "e");
    expect(mirrored).toHaveLength(1);
    expect(newNodeIds).toContain(mirrored[0].source);
    expect(newNodeIds).toContain(mirrored[0].target);
  });

  it("pasteFragment exposes the id map", () => {
    const fragment = copyFragment(template, ["solo"]);
    const { idMap, newNodeIds } = pasteFragment(template, fragment);
    expect(idMap["solo"]).toBe(newNodeIds[0]);
  });

  it("copies a zone as a subject with its member nodes", () => {
    const fragment = copyFragment(template, [], { zones: ["r"] });
    // g lives in r; child comes along as g's descendant.
    expect(fragment.nodes.map((n) => n.id).sort()).toEqual(["child", "g"]);
    expect(fragment.zones?.map((z) => z.id)).toEqual(["r"]);
    expect(fragment.meta?.zoneSubjects).toEqual(["r"]);
  });

  it("pasting a subject zone clones it under a fresh id and re-zones the members", () => {
    const fragment = copyFragment(template, [], { zones: ["r"] });
    const { template: next, newNodeIds, newZoneIds } = pasteFragment(template, fragment);

    // Same diagram, but the zone was the SUBJECT — it clones, never reuses.
    expect(next.zones).toHaveLength(2);
    expect(newZoneIds).toHaveLength(1);
    expect(newZoneIds[0]).not.toBe("r");

    const clonedMember = next.nodes.find((n) => newNodeIds.includes(n.id) && n.zoneId);
    expect(clonedMember!.zoneId).toBe(newZoneIds[0]);
  });

  it("ride-along zones are still reused, not cloned", () => {
    const fragment = copyFragment(template, ["g"]);
    const { template: next, newZoneIds } = pasteFragment(template, fragment);
    expect(next.zones).toHaveLength(1);
    expect(newZoneIds).toHaveLength(0);
  });

  it("duplicateWithConnections clones a zone's members and mirrors their boundary edges", () => {
    const { template: next, newNodeIds } = duplicateWithConnections(template, [], {
      zones: ["r"],
    });
    expect(next.zones).toHaveLength(2);
    // child→solo is a boundary edge: mirrored from the cloned child to the
    // untouched outside neighbour.
    const mirrored = next.edges.filter((e) => e.id !== "e");
    expect(mirrored).toHaveLength(1);
    expect(newNodeIds).toContain(mirrored[0].source);
    expect(mirrored[0].target).toBe("solo");
  });

  it("reuses an existing zone rather than cloning it", () => {
    const fragment = copyFragment(template, ["g"]);
    const { template: next } = pasteFragment(template, fragment);
    expect(next.zones).toHaveLength(1);
    const pasted = next.nodes.find((n) => n.id !== "g" && n.kind === "group");
    expect(pasted!.zoneId).toBe("r");
  });

  it("offsets roots but not children, so the copy isn't double-shifted", () => {
    const fragment = copyFragment(template, ["g"]);
    const { template: next, newNodeIds } = pasteFragment(template, fragment, { offset: 30 });
    const group = next.nodes.find((n) => newNodeIds.includes(n.id) && !n.parentId)!;
    const child = next.nodes.find((n) => newNodeIds.includes(n.id) && n.parentId)!;
    expect(group.x).toBe(30);
    expect(child.x).toBe(20); // unchanged: it moves with its parent
  });

  it("pasting twice yields two independent copies", () => {
    const fragment = copyFragment(template, ["solo"]);
    const first = pasteFragment(template, fragment);
    const second = pasteFragment(first.template, fragment);
    expect(second.template.nodes).toHaveLength(template.nodes.length + 2);
    expect(first.newNodeIds[0]).not.toBe(second.newNodeIds[0]);
  });

  it("parses a fragment back from clipboard text", () => {
    const text = JSON.stringify(copyFragment(template, ["solo"]));
    expect(parseFragment(text)?.nodes).toHaveLength(1);
  });

  it("returns null for text that is not a diagram", () => {
    expect(parseFragment("hello")).toBeNull();
    expect(parseFragment('{"foo":1}')).toBeNull();
  });

  it("validates a parsed fragment against the caller's registry", () => {
    // Without the options, an extension kind is coerced to "service" — which
    // is what every cross-tab paste used to do.
    const text = JSON.stringify({ version: 1, nodes: [node({ id: "x", kind: "lambda" })], edges: [] });
    expect(parseFragment(text)?.nodes[0].kind).toBe("service");
    expect(parseFragment(text, { knownKinds: ["lambda"] })?.nodes[0].kind).toBe("lambda");
  });

  it("absolutizes a copied child so re-rooting doesn't teleport it", () => {
    // `child` is stored at 20,60 RELATIVE to `g` at 0,0 — move the group and
    // the relative coordinates alone would paste the copy somewhere else.
    const moved = validateTemplate({
      ...template,
      nodes: template.nodes.map((n) => (n.id === "g" ? { ...n, x: 520, y: 40 } : n)),
    }) as DiagramTemplate;

    // Copied WITHOUT its parent: the fragment must carry absolute coordinates.
    const alone = copyFragment(moved, ["child"]);
    expect(alone.nodes[0]).toMatchObject({ x: 540, y: 100 });

    // Copied WITH its parent it stays parent-relative — the parent moves it.
    const withParent = copyFragment(moved, ["g"]);
    expect(withParent.nodes.find((n) => n.id === "child")).toMatchObject({ x: 20, y: 60 });
  });

  it("lands a re-rooted copy beside the original rather than at the origin", () => {
    const moved = validateTemplate({
      ...template,
      nodes: template.nodes.map((n) => (n.id === "g" ? { ...n, x: 520, y: 40 } : n)),
    }) as DiagramTemplate;
    const { template: next, newNodeIds } = pasteFragment(moved, copyFragment(moved, ["child"]), {
      offset: 60,
    });
    expect(next.nodes.find((n) => n.id === newNodeIds[0])).toMatchObject({
      x: 600,
      y: 160,
      parentId: null,
    });
  });

  it("stacks a cloned subject zone above its source so it claims its members", () => {
    // zoneAt breaks a z/area tie by keeping the zone it saw first — always the
    // original. Without a higher z the clone hands its members straight back
    // the next time membership is derived from geometry, and ends up empty.
    const fragment = copyFragment(template, [], { zones: ["r"] });
    const { template: next, newZoneIds } = pasteFragment(template, fragment);
    const clone = next.zones!.find((z) => z.id === newZoneIds[0])!;
    const original = next.zones!.find((z) => z.id === "r")!;
    expect(clone.z ?? 0).toBeGreaterThan(original.z ?? 0);
  });

  it("survives a deterministic makeId instead of spinning forever", () => {
    const fragment = copyFragment(template, ["solo"]);
    const once = pasteFragment(template, fragment, { makeId: (p) => `${p}_copy` });
    expect(once.newNodeIds).toEqual(["solo_copy"]);
    // The second paste collides on every id the generator can produce.
    const twice = pasteFragment(once.template, fragment, { makeId: (p) => `${p}_copy` });
    expect(twice.newNodeIds[0]).not.toBe("solo_copy");
    expect(twice.template.nodes).toHaveLength(template.nodes.length + 2);
  });
});

describe("autoLayout", () => {
  it("separates nodes that were stacked on top of each other", () => {
    const messy = validateTemplate({
      nodes: [
        node({ id: "a", x: 0, y: 0 }),
        node({ id: "b", x: 0, y: 0 }),
        node({ id: "c", x: 0, y: 0 }),
      ],
      edges: [
        { id: "e1", source: "a", target: "b" },
        { id: "e2", source: "b", target: "c" },
      ],
    });
    expect(hasOverlaps(messy)).toBe(true);
    expect(hasOverlaps(autoLayout(messy))).toBe(false);
  });

  it("ranks a chain left to right", () => {
    const t = autoLayout(
      validateTemplate({
        nodes: [node({ id: "a" }), node({ id: "b" }), node({ id: "c" })],
        edges: [
          { id: "e1", source: "a", target: "b" },
          { id: "e2", source: "b", target: "c" },
        ],
      }),
    );
    const x = (id: string) => t.nodes.find((n) => n.id === id)!.x;
    expect(x("a")).toBeLessThan(x("b"));
    expect(x("b")).toBeLessThan(x("c"));
  });

  it("keeps zoned nodes inside their zone", () => {
    // The whole reason this is written in-package rather than delegated to
    // dagre: a layout that moved nodes out of their zone would change which
    // provider hides them.
    const t = autoLayout(EXAMPLE_ZONED_TEMPLATE);
    const zones = new Map((t.zones ?? []).map((z) => [z.id, z]));
    for (const n of t.nodes) {
      if (!n.zoneId) continue;
      const z = zones.get(n.zoneId)!;
      expect(n.x, `${n.id} left edge`).toBeGreaterThanOrEqual(z.x);
      expect(n.y, `${n.id} top edge`).toBeGreaterThanOrEqual(z.y);
      expect(n.x + n.w, `${n.id} right edge`).toBeLessThanOrEqual(z.x + z.w);
      expect(n.y + n.h, `${n.id} bottom edge`).toBeLessThanOrEqual(z.y + z.h);
    }
  });

  it("grows a zone that is too small for its contents", () => {
    const t = validateTemplate({
      zones: [zone({ id: "r", w: 200, h: 120 })],
      nodes: [
        node({ id: "a", zoneId: "r" }),
        node({ id: "b", zoneId: "r" }),
        node({ id: "c", zoneId: "r" }),
      ],
      edges: [
        { id: "e1", source: "a", target: "b" },
        { id: "e2", source: "b", target: "c" },
      ],
    });
    const out = autoLayout(t);
    expect(out.zones![0].w).toBeGreaterThan(200);
  });

  it("does not move a zone's origin", () => {
    const out = autoLayout(EXAMPLE_ZONED_TEMPLATE);
    for (const original of EXAMPLE_ZONED_TEMPLATE.zones!) {
      const after = out.zones!.find((z) => z.id === original.id)!;
      expect({ x: after.x, y: after.y }).toEqual({ x: original.x, y: original.y });
    }
  });

  it("lays group children out inside the group and grows it", () => {
    const t = validateTemplate({
      nodes: [
        node({ id: "g", kind: "group", x: 0, y: 0, w: 200, h: 120 }),
        node({ id: "a", parentId: "g" }),
        node({ id: "b", parentId: "g" }),
      ],
      edges: [{ id: "e", source: "a", target: "b" }],
    });
    const out = autoLayout(t);
    const g = out.nodes.find((n) => n.id === "g")!;
    expect(g.w).toBeGreaterThan(200);
    for (const id of ["a", "b"]) {
      const n = out.nodes.find((m) => m.id === id)!;
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w).toBeLessThanOrEqual(g.w);
    }
  });

  it("terminates on a cyclic graph", () => {
    // Kahn's algorithm leaves cycle members unranked rather than looping.
    const t = validateTemplate({
      nodes: [node({ id: "a" }), node({ id: "b" }), node({ id: "c" })],
      edges: [
        { id: "e1", source: "a", target: "b" },
        { id: "e2", source: "b", target: "c" },
        { id: "e3", source: "c", target: "a" },
      ],
    });
    const out = autoLayout(t);
    expect(out.nodes).toHaveLength(3);
    for (const n of out.nodes) expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
  });

  it("handles an empty diagram", () => {
    expect(autoLayout(validateTemplate({ nodes: [] })).nodes).toEqual([]);
  });

  it("preserves node count, edges, and provider selection", () => {
    const out = autoLayout(EXAMPLE_ZONED_TEMPLATE);
    expect(out.nodes).toHaveLength(EXAMPLE_ZONED_TEMPLATE.nodes.length);
    expect(out.edges).toHaveLength(EXAMPLE_ZONED_TEMPLATE.edges.length);
    expect(out.zones!.find((z) => z.id === "region")!.provider).toBe("azure");
  });
});

describe("hasOverlaps", () => {
  it("is false for a tidy diagram", () => {
    expect(hasOverlaps(autoLayout(EXAMPLE_ZONED_TEMPLATE))).toBe(false);
  });

  it("ignores a container overlapping its own children", () => {
    const t = validateTemplate({
      nodes: [
        node({ id: "g", kind: "group", x: 0, y: 0, w: 400, h: 300 }),
        node({ id: "a", parentId: "g", x: 20, y: 60 }),
      ],
    });
    expect(hasOverlaps(t)).toBe(false);
  });

  it("flags a node sitting outside the zone it claims", () => {
    const t = validateTemplate({
      zones: [zone()],
      nodes: [node({ id: "a", zoneId: "z", x: 5000, y: 5000 })],
    });
    expect(hasOverlaps(t)).toBe(true);
  });
});

describe("ghost mode", () => {
  it("keeps hidden nodes on the canvas, flagged", () => {
    const { nodes } = toReactFlow(EXAMPLE_ZONED_TEMPLATE, { showHidden: true });
    const rds = nodes.find((n) => n.id === "sql-aws")!;
    expect(rds).toBeTruthy();
    expect((rds.data as { ghost?: boolean }).ghost).toBe(true);
    // The one the active provider shows is not a ghost.
    expect((nodes.find((n) => n.id === "sql-az")!.data as { ghost?: boolean }).ghost).toBeUndefined();
  });

  it("omits them entirely when ghost mode is off", () => {
    const { nodes } = toReactFlow(EXAMPLE_ZONED_TEMPLATE);
    expect(nodes.find((n) => n.id === "sql-aws")).toBeUndefined();
  });

  it("renders a ghost's edges so it still shows what it connects to", () => {
    const { edges } = toReactFlow(EXAMPLE_ZONED_TEMPLATE, { showHidden: true });
    expect(edges.map((e) => e.id)).toContain("z3"); // api → RDS
  });

  it("lets a ghosted node be deleted rather than resurrecting it", () => {
    // With every node present, an absent one can only mean a deletion — so the
    // hidden-node carry-through has to be off, or deleting a ghost would undo
    // itself on the next derivation.
    const { nodes, edges } = toReactFlow(EXAMPLE_ZONED_TEMPLATE, { showHidden: true });
    const without = nodes.filter((n) => n.id !== "sql-aws");
    const back = fromReactFlow(without, edges, {
      base: EXAMPLE_ZONED_TEMPLATE,
      allNodesPresent: true,
    });
    expect(back.nodes.find((n) => n.id === "sql-aws")).toBeUndefined();
    // Everything else survives.
    expect(back.nodes).toHaveLength(EXAMPLE_ZONED_TEMPLATE.nodes.length - 1);
  });

  it("still carries hidden nodes through when ghost mode is off", () => {
    const { nodes, edges } = toReactFlow(EXAMPLE_ZONED_TEMPLATE);
    const back = fromReactFlow(nodes, edges, { base: EXAMPLE_ZONED_TEMPLATE });
    expect(back.nodes).toHaveLength(EXAMPLE_ZONED_TEMPLATE.nodes.length);
  });

  it("does not persist the ghost flag", () => {
    const { nodes, edges } = toReactFlow(EXAMPLE_ZONED_TEMPLATE, { showHidden: true });
    const back = fromReactFlow(nodes, edges, {
      base: EXAMPLE_ZONED_TEMPLATE,
      allNodesPresent: true,
    });
    // `ghost` describes the current view, not the document.
    expect(JSON.stringify(back)).not.toContain("ghost");
  });

  it("re-flags correctly after a provider switch", () => {
    const aws = setZoneProvider(EXAMPLE_ZONED_TEMPLATE, "region", "aws");
    const { nodes } = toReactFlow(aws, { showHidden: true });
    const ghost = (id: string) => (nodes.find((n) => n.id === id)!.data as { ghost?: boolean }).ghost;
    expect(ghost("sql-az")).toBe(true);
    expect(ghost("sql-aws")).toBeUndefined();
  });
});

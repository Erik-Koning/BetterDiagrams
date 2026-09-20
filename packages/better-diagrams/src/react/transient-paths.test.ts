/**
 * transient-paths.test.ts — routes a search found light up beside the
 * document's own paths without ever entering `template.paths`.
 */
import { describe, expect, it } from "vitest";
import { validateTemplate } from "../contract/schema";
import { applyPathView, buildPathGlowIndex, transientPathColors } from "./path-view";
import type { Edge, Node } from "@xyflow/react";

const node = (id: string) => ({
  id, label: id, kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76,
});
const edge = (id: string, source: string, target: string) => ({
  id, source, target, label: "", style: "solid", color: "slate",
});
const DOC = validateTemplate({
  version: 1,
  nodes: ["a", "b", "c", "d"].map(node),
  edges: [edge("ab", "a", "b"), edge("bc", "b", "c"), edge("cd", "c", "d")],
  paths: [{ id: "p1", title: "One", steps: ["a", "b"] }],
});

describe("buildPathGlowIndex with transient paths", () => {
  it("lights a transient route in its own colour beside a lit document path", () => {
    const index = buildPathGlowIndex(DOC, ["p1"], [{ id: "~route:0", title: "b → d", steps: ["b", "c", "d"], color: "rose" }])!;
    expect(index.nodes.get("a")!.map((g) => g.color)).toEqual(["sky"]);
    expect(index.nodes.get("b")!.map((g) => [g.pathId, g.color])).toEqual([["p1", "sky"], ["~route:0", "rose"]]);
    expect(index.nodes.get("d")!.map((g) => [g.pathId, g.step, g.steps])).toEqual([["~route:0", 4, 5]]);
    expect(index.edges.get("cd")!.map((g) => g.color)).toEqual(["rose"]);
    expect(index.edges.get("ab")!.map((g) => g.pathId)).toEqual(["p1"]);
  });

  it("lights transient routes alone, and never recolours document paths", () => {
    const alone = buildPathGlowIndex(DOC, [], [{ id: "~route:0", title: "", steps: ["c", "d"], color: "amber" }])!;
    expect([...alone.nodes.keys()]).toEqual(["c", "d"]);
    expect(alone.nodes.get("c")![0].color).toBe("amber");
    const doc = buildPathGlowIndex(DOC, ["p1"], [{ id: "~route:0", title: "", steps: ["a", "b"], color: "violet" }])!;
    expect(doc.nodes.get("a")!.find((g) => g.pathId === "p1")!.color).toBe("sky");
    expect(buildPathGlowIndex(DOC, [], [])).toBeNull();
    expect(buildPathGlowIndex(DOC, [], [{ id: "~x", title: "", steps: ["nope"], color: "rose" }])).toBeNull();
  });
});

describe("bright routes", () => {
  it("marks extras bright on request, never document paths, and names the key on each lit hop", () => {
    const index = buildPathGlowIndex(DOC, ["p1"], [{ id: "~route:0", title: "", steps: ["b", "c", "d"], color: "rose" }], { bright: true })!;
    expect(index.nodes.get("b")!.map((g) => [g.pathId, g.bright ?? false])).toEqual([["p1", false], ["~route:0", true]]);
    expect(index.edges.get("cd")![0].bright).toBe(true);
    expect(buildPathGlowIndex(DOC, [], [{ id: "~route:0", title: "", steps: ["c", "d"], color: "rose" }])!.edges.get("cd")![0].bright).toBeUndefined();

    const nodes: Node[] = ["a", "b", "c", "d"].map((id) => ({ id, position: { x: 0, y: 0 }, data: {} }));
    const edges: Edge[] = [
      { id: "ab", source: "a", target: "b", data: { startField: "b_id" } },
      { id: "bc", source: "b", target: "c", data: { data: { model: { field: "c_ref" } } } },
      { id: "cd", source: "c", target: "d", data: {} },
    ];
    const view = applyPathView(nodes, edges, index);
    const byId = Object.fromEntries(view.edges.map((e) => [e.id, e]));
    // ab is on the document path only: palette glow, no key.
    expect(byId.ab.className).toBe("as-path-edge");
    expect((byId.ab.data as { routeKey?: string }).routeKey).toBeUndefined();
    // bc and cd are on the bright route: the row anchor, then the dialect's field; none → no badge.
    expect(byId.bc.className).toBe("as-path-edge as-path-edge--bright");
    expect((byId.bc.data as { routeKey?: string }).routeKey).toBe("c_ref");
    expect((byId.cd.data as { routeKey?: string }).routeKey).toBeUndefined();
    const b = view.nodes.find((n) => n.id === "b")!;
    // The first glow on b is the document path — palette ink; d is bright-only.
    expect((b.style as Record<string, string>)["--as-path-ink"]).toBe("var(--as-edge-sky)");
    const d = view.nodes.find((n) => n.id === "d")!;
    expect((d.style as Record<string, string>)["--as-path-ink"]).toBe("var(--as-route)");
  });
});

describe("transientPathColors", () => {
  it("starts where the document's next path would, skipping lit colours", () => {
    expect(transientPathColors(2, ["sky"], 1)).toEqual(["emerald", "amber"]);
    expect(transientPathColors(3, [], 4)).toEqual(["violet", "slate", "sky"]);
    expect(transientPathColors(2, ["emerald", "amber"], 1)).toEqual(["rose", "violet"]);
  });

  it("wraps past the cycle, and falls back to the full cycle when everything is taken", () => {
    expect(transientPathColors(7, [], 0)).toHaveLength(7);
    expect(transientPathColors(7, [], 0)[6]).toBe("sky");
    expect(transientPathColors(2, ["sky", "emerald", "amber", "rose", "violet", "slate"], 2)).toEqual(["amber", "rose"]);
    expect(transientPathColors(0, [], 0)).toEqual([]);
    expect(transientPathColors(1, [], -1)).toEqual(["slate"]);
  });
});

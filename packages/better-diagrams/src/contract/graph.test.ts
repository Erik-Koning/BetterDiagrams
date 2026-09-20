/**
 * graph.test.ts — finding walks: BFS, k-shortest, all simple routes, the
 * neighbourhood, and the bridge back to a `DiagramPath`.
 */
import { describe, expect, it } from "vitest";
import { validateTemplate } from "./schema";
import { resolvePath } from "./paths";
import {
  allSimplePaths,
  neighbourhood,
  sameWalk,
  shortestPath,
  shortestPaths,
  walkLength,
  walkToPath,
} from "./graph";

const node = (id: string) => ({
  id,
  label: id,
  kind: "service",
  icon: "box",
  description: "",
  parentId: null,
  x: 0,
  y: 0,
  w: 170,
  h: 76,
});
const edge = (id: string, source: string, target: string, over: Record<string, unknown> = {}) => ({
  id,
  source,
  target,
  label: "",
  style: "solid",
  color: "slate",
  ...over,
});

/**
 *   a → b → c → d        (ab, bc, cd)
 *   a → c                (ac: a shortcut)
 *   b → d                (bd)
 *   b ⇒ c a second time  (bc2: parallel)
 *   d → a                (da: a cycle back)
 *   c ↔ e                (ce: direction "both")
 *   x                    (isolated)
 *   c ↺                  (cc: self-loop)
 */
const DOC = validateTemplate({
  version: 1,
  nodes: ["a", "b", "c", "d", "e", "x"].map(node),
  edges: [
    edge("ab", "a", "b"),
    edge("bc", "b", "c"),
    edge("cd", "c", "d"),
    edge("ac", "a", "c"),
    edge("bd", "b", "d"),
    edge("bc2", "b", "c"),
    edge("da", "d", "a"),
    edge("ce", "c", "e", { direction: "both" }),
    edge("cc", "c", "c"),
  ],
});

describe("shortestPath", () => {
  it("finds the fewest-hop route, honouring direction", () => {
    // Two 2-hop routes exist; the one BFS reaches first in document order wins.
    expect(shortestPath(DOC, "a", "d")).toEqual({ nodes: ["a", "b", "d"], edges: ["ab", "bd"] });
    // e is reachable from c via the two-way edge, and back again.
    expect(shortestPath(DOC, "e", "d")).toEqual({ nodes: ["e", "c", "d"], edges: ["ce", "cd"] });
    // b → a only exists through the cycle d → a.
    expect(shortestPath(DOC, "b", "a")).toEqual({ nodes: ["b", "d", "a"], edges: ["bd", "da"] });
  });

  it("returns null for unreachable, unknown, or isolated endpoints", () => {
    expect(shortestPath(DOC, "a", "x")).toBeNull();
    expect(shortestPath(DOC, "a", "nope")).toBeNull();
    expect(shortestPath(DOC, "x", "a")).toBeNull();
  });

  it("a node to itself is one node and no edges", () => {
    expect(shortestPath(DOC, "c", "c")).toEqual({ nodes: ["c"], edges: [] });
  });

  it("ties break by document order", () => {
    // b → d directly (bd) and b → c → d; bd is one hop, unique. From a to c:
    // ac is one hop — but among the 2-hop a→b→c routes, bc comes before bc2.
    expect(shortestPaths(DOC, "a", "c", 2)[1]).toEqual({ nodes: ["a", "b", "c"], edges: ["ab", "bc"] });
  });

  it("`undirected` ignores arrows", () => {
    expect(shortestPath(DOC, "d", "c")).toEqual({ nodes: ["d", "a", "c"], edges: ["da", "ac"] });
    expect(shortestPath(DOC, "d", "c", { undirected: true })).toEqual({ nodes: ["d", "c"], edges: ["cd"] });
  });

  it("filters bar edges and nodes without touching the endpoints", () => {
    expect(shortestPath(DOC, "a", "d", { edgeFilter: (e) => e.id !== "ac" })).toEqual({
      nodes: ["a", "b", "d"],
      edges: ["ab", "bd"],
    });
    expect(shortestPath(DOC, "a", "d", { nodeFilter: (n) => n.id !== "c" && n.id !== "b" })).toBeNull();
    // A filter that excludes an endpoint is overridden for it (and `b` is out).
    expect(shortestPath(DOC, "a", "d", { nodeFilter: (n) => n.id === "c" })).toEqual({
      nodes: ["a", "c", "d"],
      edges: ["ac", "cd"],
    });
  });
});

describe("shortestPaths (k)", () => {
  it("returns the k best simple routes, shortest first, parallel edges distinct", () => {
    const walks = shortestPaths(DOC, "a", "d", 10);
    expect(walks.map((w) => w.edges)).toEqual([
      ["ab", "bd"],
      ["ac", "cd"],
      ["ab", "bc", "cd"],
      ["ab", "bc2", "cd"],
    ]);
    expect(walks.map(walkLength)).toEqual([2, 2, 3, 3]);
  });

  it("stops at k and never revisits a node", () => {
    expect(shortestPaths(DOC, "a", "d", 2)).toHaveLength(2);
    for (const w of shortestPaths(DOC, "a", "d", 10)) {
      expect(new Set(w.nodes).size).toBe(w.nodes.length);
    }
  });

  it("is empty when there is no route or k < 1", () => {
    expect(shortestPaths(DOC, "a", "x", 3)).toEqual([]);
    expect(shortestPaths(DOC, "a", "d", 0)).toEqual([]);
  });

  it("agrees with the exhaustive search on a bigger random graph", () => {
    // A seeded LCG so the case is reproducible without a fixture file.
    let seed = 7;
    const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const ids = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const edges: ReturnType<typeof edge>[] = [];
    for (let i = 0; i < 40; i++) {
      const s = ids[Math.floor(rand() * ids.length)];
      const t = ids[Math.floor(rand() * ids.length)];
      edges.push(edge(`e${i}`, s, t));
    }
    const doc = validateTemplate({ version: 1, nodes: ids.map(node), edges });
    const all = allSimplePaths(doc, "n0", "n11", { maxDepth: 12, limit: 10_000 });
    const k = shortestPaths(doc, "n0", "n11", 6);
    expect(k.length).toBe(Math.min(6, all.length));
    // Same multiset of lengths as the first k of the exhaustive list.
    expect(k.map(walkLength)).toEqual(all.slice(0, k.length).map(walkLength));
    // And every one of them is genuinely a route the exhaustive search knows.
    for (const w of k) expect(all.some((p) => sameWalk(p, w))).toBe(true);
  });
});

describe("allSimplePaths", () => {
  it("enumerates every simple route, shortest first, bounded by depth and limit", () => {
    const all = allSimplePaths(DOC, "a", "d");
    expect(all.map((w) => w.edges)).toEqual([
      ["ab", "bd"],
      ["ac", "cd"],
      ["ab", "bc", "cd"],
      ["ab", "bc2", "cd"],
    ]);
    expect(allSimplePaths(DOC, "a", "d", { maxDepth: 2 })).toHaveLength(2);
    expect(allSimplePaths(DOC, "a", "d", { limit: 1 })).toHaveLength(1);
  });

  it("never walks the self-loop or through the target twice", () => {
    for (const w of allSimplePaths(DOC, "a", "d")) {
      expect(w.edges).not.toContain("cc");
      expect(w.nodes.filter((id) => id === "d")).toHaveLength(1);
    }
  });
});

describe("neighbourhood", () => {
  it("reaches by hop count with distances, and includes every edge among the reached", () => {
    const one = neighbourhood(DOC, "b", 1);
    expect([...one.nodes.entries()]).toEqual([
      ["b", 0],
      ["c", 1],
      ["d", 1],
    ]);
    // cd joins two reached nodes even though the search never walked it; the
    // self-loop on c is inside the set too.
    expect(one.edges).toEqual(["bc", "cd", "bd", "bc2", "cc"]);

    const two = neighbourhood(DOC, "b", 2);
    expect(two.nodes.get("a")).toBe(2);
    expect(two.nodes.get("e")).toBe(2);
    expect(two.nodes.has("x")).toBe(false);
  });

  it("accepts several starts and honours `undirected`", () => {
    expect([...neighbourhood(DOC, ["a", "x"], 0).nodes.keys()]).toEqual(["a", "x"]);
    expect(neighbourhood(DOC, "a", 1).nodes.has("d")).toBe(false);
    expect(neighbourhood(DOC, "a", 1, { undirected: true }).nodes.get("d")).toBe(1);
  });
});

describe("walkToPath", () => {
  it("names an edge only where the pair is joined by several, and resolves back", () => {
    const walk = { nodes: ["a", "b", "c", "d"], edges: ["ab", "bc2", "cd"] };
    const path = walkToPath(DOC, walk, { id: "p", title: "Long way", color: "rose" });
    expect(path).toEqual({ id: "p", title: "Long way", steps: ["a", "b", "bc2", "c", "d"], color: "rose" });
    const resolved = resolvePath(DOC, path);
    expect(resolved.steps.filter((s) => s.kind === "edge").map((s) => s.id)).toEqual(walk.edges);
    expect(resolved.steps.filter((s) => s.kind === "node").map((s) => s.id)).toEqual(walk.nodes);
  });

  it("defaults the title to the endpoints", () => {
    expect(walkToPath(DOC, shortestPath(DOC, "a", "d")!, { id: "p" }).title).toBe("a → d");
  });

  it("survives validation as a document path", () => {
    const path = walkToPath(DOC, shortestPath(DOC, "a", "d")!, { id: "p" });
    const doc = validateTemplate({ ...DOC, paths: [path] });
    expect(doc.paths).toEqual([path]);
  });
});

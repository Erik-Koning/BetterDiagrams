/**
 * paths.test.ts — the `paths` array: validation, the walk resolver, and the
 * places the rest of the contract has to carry it through.
 */
import { describe, expect, it } from "vitest";
import {
  EXAMPLE_ZONED_TEMPLATE,
  TEMPLATE_KEYS,
  buildSystemPrompt,
  fromReactFlow,
  toReactFlow,
  validateTemplate,
  type DiagramTemplate,
} from "./schema";
import { PATH_COLOR_CYCLE, PATH_KEYS, pathColor, resolvePath, validatePaths } from "./paths";

const node = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  label: id.toUpperCase(),
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
const edge = (id: string, source: string, target: string) => ({
  id,
  source,
  target,
  label: "",
  style: "solid",
  color: "slate",
});

/** a → b → c, with a second edge between b and c and a self-loop on c. */
const DOC = validateTemplate({
  version: 1,
  nodes: [node("a"), node("b"), node("c"), node("d")],
  edges: [edge("ab", "a", "b"), edge("bc", "b", "c"), edge("cb", "c", "b"), edge("cc", "c", "c"), edge("cd", "c", "d")],
});

describe("validateTemplate — paths", () => {
  it("keeps a well-formed path in canonical key order", () => {
    const t = validateTemplate({
      ...DOC,
      paths: [{ description: " the read path ", color: "rose", steps: ["a", "b"], title: " Read ", id: "read" }],
    });
    expect(t.paths).toEqual([
      { id: "read", title: "Read", steps: ["a", "b"], color: "rose", description: "the read path" },
    ]);
    expect(Object.keys(t.paths![0])).toEqual(["id", "title", "steps", "color", "description"]);
  });

  it("omits the key entirely when there are no paths, so old documents round-trip", () => {
    expect("paths" in validateTemplate({ ...DOC })).toBe(false);
    expect("paths" in validateTemplate({ ...DOC, paths: [] })).toBe(false);
    expect("paths" in validateTemplate({ ...DOC, paths: "nope" })).toBe(false);
  });

  it("drops steps that name nothing, and a path left with none", () => {
    const t = validateTemplate({
      ...DOC,
      paths: [
        { id: "p", title: "P", steps: ["a", "ghost", "ab", 7, null, "b", "b"] },
        { id: "empty", title: "Nothing", steps: ["ghost"] },
        { id: "no-steps", title: "Nothing" },
      ],
    });
    expect(t.paths).toEqual([{ id: "p", title: "P", steps: ["a", "ab", "b"] }]);
  });

  it("coerces numeric ids, titles a nameless path by its id, and suffixes duplicates", () => {
    const t = validateTemplate({
      ...DOC,
      paths: [
        { id: 1, steps: ["a"] },
        { id: "1", title: "", steps: ["b"] },
        { id: "1", steps: ["c"] },
      ],
    });
    expect(t.paths!.map((p) => [p.id, p.title])).toEqual([
      ["1", "1"],
      ["1_2", "1_2"],
      ["1_3", "1_3"],
    ]);
  });

  it("forgets a colour outside the edge palette, and an empty description", () => {
    const t = validateTemplate({
      ...DOC,
      paths: [{ id: "p", title: "P", steps: ["a"], color: "teal", description: "  " }],
    });
    expect(t.paths).toEqual([{ id: "p", title: "P", steps: ["a"] }]);
  });

  it("judges steps against the FINAL ids — a dropped node leaves every path", () => {
    const t = validateTemplate({
      ...DOC,
      edges: [...DOC.edges, edge("dangling", "a", "nowhere")],
      paths: [{ id: "p", title: "P", steps: ["a", "dangling", "nowhere", "b"] }],
    });
    expect(t.paths).toEqual([{ id: "p", title: "P", steps: ["a", "b"] }]);
  });

  it("is a known top-level key, and the path keys are exported for the lint", () => {
    expect(TEMPLATE_KEYS).toContain("paths");
    expect(PATH_KEYS).toEqual(["id", "title", "steps", "color", "description"]);
  });

  it("is in the prompt, so a model can emit one", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('"paths":[{"id":"slug","title":"Name","steps":[');
    expect(prompt).toContain("PATHS:");
  });

  it("keeps the example's paths, and validating is idempotent on them", () => {
    expect(EXAMPLE_ZONED_TEMPLATE.paths).toHaveLength(2);
    const once = validateTemplate(EXAMPLE_ZONED_TEMPLATE);
    expect(once.paths).toEqual(EXAMPLE_ZONED_TEMPLATE.paths);
    expect(JSON.stringify(validateTemplate(once))).toBe(JSON.stringify(once));
  });
});

describe("validatePaths on its own", () => {
  it("takes the vocabulary as a parameter", () => {
    const out = validatePaths([{ id: "p", title: "P", steps: ["x", "y"], color: "sky" }], {
      nodeIds: new Set(["x"]),
      edgeIds: new Set(["y"]),
      colors: ["sky"],
    });
    expect(out).toEqual([{ id: "p", title: "P", steps: ["x", "y"], color: "sky" }]);
  });
});

describe("fromReactFlow — paths ride through", () => {
  const WITH_PATHS: DiagramTemplate = validateTemplate({
    ...DOC,
    paths: [{ id: "p", title: "P", steps: ["a", "b", "c"] }],
  });

  it("carries the base document's paths, since the canvas has no representation of them", () => {
    const rf = toReactFlow(WITH_PATHS);
    const back = fromReactFlow(rf.nodes, rf.edges, { base: WITH_PATHS });
    expect(back.paths).toEqual(WITH_PATHS.paths);
  });

  it("prefers paths handed in explicitly", () => {
    const rf = toReactFlow(WITH_PATHS);
    const back = fromReactFlow(rf.nodes, rf.edges, {
      base: WITH_PATHS,
      paths: [{ id: "other", title: "Other", steps: ["c", "d"] }],
    });
    expect(back.paths).toEqual([{ id: "other", title: "Other", steps: ["c", "d"] }]);
  });

  it("drops a deleted node from the walk", () => {
    const rf = toReactFlow(WITH_PATHS);
    const back = fromReactFlow(
      rf.nodes.filter((n) => n.id !== "b"),
      rf.edges.filter((e) => e.source !== "b" && e.target !== "b"),
      { base: WITH_PATHS, allNodesPresent: true },
    );
    expect(back.paths).toEqual([{ id: "p", title: "P", steps: ["a", "c"] }]);
  });

  it("carries nothing when the base has none", () => {
    const rf = toReactFlow(DOC);
    expect("paths" in fromReactFlow(rf.nodes, rf.edges, { base: DOC })).toBe(false);
    expect("paths" in fromReactFlow(rf.nodes, rf.edges)).toBe(false);
  });
});

describe("resolvePath", () => {
  const steps = (ids: string[]) => resolvePath(DOC, { id: "p", steps: ids }).steps;

  it("infers the one edge between consecutive nodes, walked the way it points", () => {
    expect(steps(["a", "b"])).toEqual([
      { kind: "node", id: "a", index: 0 },
      { kind: "edge", id: "ab", index: 1 },
      { kind: "node", id: "b", index: 2 },
    ]);
  });

  it("marks an edge walked against its arrow as reversed", () => {
    expect(steps(["b", "a"])).toEqual([
      { kind: "node", id: "b", index: 0 },
      { kind: "edge", id: "ab", index: 1, reversed: true },
      { kind: "node", id: "a", index: 2 },
    ]);
  });

  it("refuses to guess between parallel edges — the nodes stay adjacent", () => {
    expect(steps(["b", "c"]).map((s) => s.id)).toEqual(["b", "c"]);
  });

  it("takes an explicit edge id between them, in either direction", () => {
    expect(steps(["b", "cb", "c"])).toEqual([
      { kind: "node", id: "b", index: 0 },
      { kind: "edge", id: "cb", index: 1, reversed: true },
      { kind: "node", id: "c", index: 2 },
    ]);
    expect(steps(["b", "bc", "c"]).map((s) => s.reversed ?? false)).toEqual([false, false, false]);
  });

  it("brings an edge's endpoints with it when it is named on its own", () => {
    expect(steps(["ab"]).map((s) => s.id)).toEqual(["a", "ab", "b"]);
    // Chained edges join at their shared node; the owed far end is not repeated.
    expect(steps(["ab", "bc", "cd"]).map((s) => s.id)).toEqual(["a", "ab", "b", "bc", "c", "cd", "d"]);
  });

  it("stands on the near end when the walk arrives at an edge from its target", () => {
    // Standing on c, `bc` is walked backwards to b.
    expect(steps(["c", "bc"])).toEqual([
      { kind: "node", id: "c", index: 0 },
      { kind: "edge", id: "bc", index: 1, reversed: true },
      { kind: "node", id: "b", index: 2 },
    ]);
  });

  it("pushes an owed endpoint before a node that is not it, and infers on from there", () => {
    // `ab` owes b; the next step is d, so b is placed, then b → d has no edge.
    expect(steps(["ab", "d"]).map((s) => s.id)).toEqual(["a", "ab", "b", "d"]);
    // `ab` owes b; b and c are joined by two edges, so they stay adjacent.
    expect(steps(["ab", "c"]).map((s) => s.id)).toEqual(["a", "ab", "b", "c"]);
    // Whereas c → d has exactly one.
    expect(steps(["bc", "d"]).map((s) => s.id)).toEqual(["b", "bc", "c", "cd", "d"]);
  });

  it("never reverses a self-loop, and walks it back onto the same node", () => {
    expect(steps(["c", "cc"])).toEqual([
      { kind: "node", id: "c", index: 0 },
      { kind: "edge", id: "cc", index: 1 },
      { kind: "node", id: "c", index: 2 },
    ]);
  });

  it("reads an id in both namespaces as the edge only when standing on a node it touches", () => {
    const both = validateTemplate({
      version: 1,
      nodes: [node("x"), node("y"), node("link")],
      edges: [edge("link", "x", "y"), edge("yl", "y", "link")],
    });
    const walk = (ids: string[]) => resolvePath(both, { id: "p", steps: ids }).steps.map((s) => `${s.kind}:${s.id}`);
    // Standing on x, "link" is the edge x → y.
    expect(walk(["x", "link"])).toEqual(["node:x", "edge:link", "node:y"]);
    // Cold, "link" is the node.
    expect(walk(["link"])).toEqual(["node:link"]);
    // Standing on y — which the edge touches — it is still the edge.
    expect(walk(["y", "link"])).toEqual(["node:y", "edge:link", "node:x"]);
  });

  it("collapses repeats and skips ids the document does not know", () => {
    expect(steps(["a", "a", "zzz", "b", "b"]).map((s) => s.id)).toEqual(["a", "ab", "b"]);
    expect(steps([])).toEqual([]);
  });

  it("numbers steps consecutively from the start", () => {
    expect(steps(["a", "b", "bc", "c", "d"]).map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("pathColor", () => {
  it("honours the path's own colour, else cycles by index among all paths", () => {
    expect(pathColor({ color: "amber" }, 0)).toBe("amber");
    expect(PATH_COLOR_CYCLE.map((_, i) => pathColor({}, i))).toEqual([...PATH_COLOR_CYCLE]);
    expect(pathColor({}, PATH_COLOR_CYCLE.length)).toBe(PATH_COLOR_CYCLE[0]);
    expect(PATH_COLOR_CYCLE[PATH_COLOR_CYCLE.length - 1]).toBe("slate");
  });
});

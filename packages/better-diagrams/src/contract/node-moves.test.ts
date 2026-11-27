/** `nodeMoves`: which nodes sit somewhere else between two versions of a document. */
import { describe, expect, it } from "vitest";
import { nodeMoves } from "./diff";
import { EXAMPLE_TEMPLATE } from "./schema";
import { updateNode } from "./edit";

describe("nodeMoves", () => {
  it("lists a node whose x or y changed, with where it was and is", () => {
    const after = updateNode(EXAMPLE_TEMPLATE, "db", { x: 1100, y: 90 });
    expect(nodeMoves(EXAMPLE_TEMPLATE, after)).toEqual([
      { nodeId: "db", from: { x: 1030, y: 110, parentId: null }, to: { x: 1100, y: 90, parentId: null } },
    ]);
    expect(nodeMoves(EXAMPLE_TEMPLATE, EXAMPLE_TEMPLATE)).toEqual([]);
  });

  it("lists a moved frame and not the cards carried inside it", () => {
    const after = updateNode(EXAMPLE_TEMPLATE, "vpc", { x: 600 });
    expect(nodeMoves(EXAMPLE_TEMPLATE, after).map((m) => m.nodeId)).toEqual(["vpc"]);
  });

  it("counts going into or out of a container as a move", () => {
    const after = updateNode(EXAMPLE_TEMPLATE, "db", { parentId: "vpc" });
    expect(nodeMoves(EXAMPLE_TEMPLATE, after)).toEqual([
      expect.objectContaining({ nodeId: "db", from: expect.objectContaining({ parentId: null }), to: expect.objectContaining({ parentId: "vpc" }) }),
    ]);
  });

  it("doesn't call an added or removed node moved, nor a change that isn't of place", () => {
    const after = {
      ...updateNode(EXAMPLE_TEMPLATE, "db", { label: "Aurora", w: 300 }),
      nodes: [...EXAMPLE_TEMPLATE.nodes.filter((n) => n.id !== "cache").map((n) => (n.id === "db" ? { ...n, label: "Aurora", w: 300 } : n)), { ...EXAMPLE_TEMPLATE.nodes[0]!, id: "fresh", x: 5 }],
    };
    expect(nodeMoves(EXAMPLE_TEMPLATE, after)).toEqual([]);
  });
});

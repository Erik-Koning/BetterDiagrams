/**
 * Resizing one node of a multi-selection resizes them all — the change
 * fan-out behind it, as a pure function over React Flow's change list.
 */
import { describe, expect, it } from "vitest";
import type { Node, NodeChange } from "@xyflow/react";
import { createRegistry } from "./create-registry";
import { fanOutResize, nodeSizeFloor } from "./resize";
import { NODE_MIN_SIZE, fieldsBoxHeight, toZoneNodeId } from "../contract/schema";

const registry = createRegistry();

const node = (id: string, over: Partial<Node> & { data?: Record<string, unknown> } = {}): Node => ({
  id,
  type: "shape",
  position: { x: 0, y: 0 },
  width: 170,
  height: 76,
  selected: true,
  ...over,
  data: { label: id, kind: "service", icon: "box", description: "", ...(over.data ?? {}) },
});

/** What the resizer emits mid-drag for `id`. */
const resize = (id: string, width: number, height: number, resizing = true): NodeChange => ({
  id,
  type: "dimensions",
  resizing,
  setAttributes: true,
  dimensions: { width, height },
});

const dims = (changes: NodeChange[]) =>
  changes
    .filter((c): c is Extract<NodeChange, { type: "dimensions" }> => c.type === "dimensions")
    .map((c) => [c.id, c.dimensions!.width, c.dimensions!.height, c.resizing]);

describe("fanOutResize", () => {
  it("repeats a selected node's resize for every other selected node", () => {
    const nodes = [node("a"), node("b"), node("c", { selected: false })];
    const out = fanOutResize([resize("a", 240, 120)], nodes, registry);
    expect(dims(out)).toEqual([
      ["a", 240, 120, true],
      ["b", 240, 120, true],
    ]);
  });

  it("passes the resize END along too, so followers leave the resizing state", () => {
    const out = fanOutResize([resize("a", 240, 120, false)], [node("a"), node("b")], registry);
    expect(dims(out)).toEqual([
      ["a", 240, 120, false],
      ["b", 240, 120, false],
    ]);
  });

  it("leaves React Flow's own measurements alone — they carry no resizing flag", () => {
    // What the ResizeObserver reports on mount, for every node. Fanning
    // that out would stamp one box's DOM size onto its neighbours.
    const measured: NodeChange = { id: "a", type: "dimensions", dimensions: { width: 170, height: 76 } };
    const out = fanOutResize([measured], [node("a"), node("b")], registry);
    expect(out).toEqual([measured]);
  });

  it("does nothing for a single selection or an unselected node", () => {
    expect(dims(fanOutResize([resize("a", 240, 120)], [node("a"), node("b", { selected: false })], registry)))
      .toEqual([["a", 240, 120, true]]);
    const unselected = [node("a", { selected: false }), node("b"), node("c")];
    expect(dims(fanOutResize([resize("a", 240, 120)], unselected, registry))).toEqual([["a", 240, 120, true]]);
  });

  it("skips zones, ghosts, boundary frames, points, and locked nodes", () => {
    const nodes = [
      node("a"),
      node(toZoneNodeId("region"), { type: "zone", data: { zone: { id: "region" } } as never }),
      node("ghost:x", { data: { kind: "service" } }),
      node("boundary:x", { type: "group", data: { kind: "group" } }),
      node("dot", { type: "point", width: 12, height: 12, data: { kind: "point" } }),
      node("pinned", { data: { locked: true } }),
      node("b"),
    ];
    expect(dims(fanOutResize([resize("a", 240, 120)], nodes, registry)).map(([id]) => id)).toEqual(["a", "b"]);
  });

  it("reaches peers of the same size class only — cards follow cards, frames frames, notes notes", () => {
    const nodes = [
      node("card"),
      node("card2", { data: { kind: "database" } }),
      node("frame", { type: "group", data: { kind: "group" }, width: 400, height: 300 }),
      node("frame2", { type: "group", data: { kind: "group" }, width: 300, height: 200 }),
      node("note", { type: "annotation", data: { kind: "text" } }),
      node("note2", { type: "annotation", data: { kind: "text" } }),
    ];
    const ids = (id: string, w: number, h: number) =>
      dims(fanOutResize([resize(id, w, h)], nodes, registry)).map(([i]) => i);
    expect(ids("card", 240, 120)).toEqual(["card", "card2"]);
    expect(ids("frame", 500, 350)).toEqual(["frame", "frame2"]);
    expect(ids("note", 200, 60)).toEqual(["note", "note2"]);
  });

  it("never drags the resized node's own container or contents along", () => {
    // A band across a group selects the frame and its contents together.
    const nodes = [
      node("outer", { type: "group", data: { kind: "group" }, width: 600, height: 400 }),
      node("group", { type: "group", parentId: "outer", data: { kind: "group" }, width: 400, height: 300 }),
      node("inner", { parentId: "group", position: { x: 24, y: 48 } }),
      node("deep", { parentId: "group", position: { x: 24, y: 140 } }),
      node("peer"),
      node("peerFrame", { type: "group", data: { kind: "group" }, width: 300, height: 200 }),
    ];
    // Resizing the frame reaches the other frame, not the cards inside it
    // nor the frame around it…
    expect(dims(fanOutResize([resize("group", 500, 350)], nodes, registry)).map(([id]) => id)).toEqual([
      "group",
      "peerFrame",
    ]);
    // …and resizing a card inside reaches its sibling and the card outside,
    // never the frames it sits in.
    expect(dims(fanOutResize([resize("inner", 200, 90)], nodes, registry)).map(([id]) => id)).toEqual([
      "inner",
      "deep",
      "peer",
    ]);
  });

  it("holds each follower to its own floor", () => {
    const rows = [
      { id: "id", name: "id", type: "uuid", key: "pk" as const, required: true },
      { id: "n", name: "name", type: "text" },
      { id: "e", name: "email", type: "text" },
    ];
    const nodes = [
      node("a"),
      node("table", { data: { kind: "table", fields: rows } }),
      node("group", { type: "group", data: { kind: "group" }, width: 400, height: 300 }),
      node("child", { parentId: "group", selected: false, position: { x: 200, y: 100 } }),
      node("note", { type: "annotation", data: { kind: "text" } }),
    ];
    // Dragged down to the smallest card React Flow's floor allows.
    const out = fanOutResize([resize("a", NODE_MIN_SIZE.shape.w, NODE_MIN_SIZE.shape.h)], nodes, registry);
    const byId = Object.fromEntries(dims(out).map(([id, w, h]) => [id, [w, h]]));
    // The table keeps room for its rows.
    expect(byId.table).toEqual([NODE_MIN_SIZE.shape.w, fieldsBoxHeight(rows.length, false)]);
    // A frame's floor is its children (200 + 170 + pad, 100 + 76 + pad); a
    // note's is its own, smaller, minimum.
    expect(nodeSizeFloor(nodes[2]!, registry, nodes, 100)).toEqual({
      w: Math.max(NODE_MIN_SIZE.group.w, 200 + 170 + 12),
      h: Math.max(NODE_MIN_SIZE.group.h, 100 + 76 + 12),
    });
    expect(nodeSizeFloor(nodes[4]!, registry, nodes, 80)).toEqual({ ...NODE_MIN_SIZE.annotation });
  });
});

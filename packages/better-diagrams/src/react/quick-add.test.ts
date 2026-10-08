import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { QUICK_ADD_GAP, addBeside, growFramesToFit, quickAddSpot } from "./quick-add";

const card = (id: string, x: number, y: number, extra: Partial<Node> = {}): Node => ({
  id,
  type: "shape",
  position: { x, y },
  width: 170,
  height: 76,
  data: { label: id, kind: "service" },
  ...extra,
});

const frame = (id: string, x: number, y: number, w: number, h: number, extra: Partial<Node> = {}): Node => ({
  id,
  type: "group",
  position: { x, y },
  width: w,
  height: h,
  style: { width: w, height: h },
  data: { label: id, kind: "group" },
  ...extra,
});

const SOURCE = { x: 0, y: 0, w: 170, h: 76 };
const SIZE = { w: 170, h: 76 };

describe("quickAddSpot", () => {
  it("goes straight out on each side, centred so the arrow is level", () => {
    expect(quickAddSpot(SOURCE, SIZE, "right", [])).toEqual({ x: 170 + QUICK_ADD_GAP, y: 0 });
    expect(quickAddSpot(SOURCE, SIZE, "left", [])).toEqual({ x: -QUICK_ADD_GAP - 170, y: 0 });
    expect(quickAddSpot(SOURCE, SIZE, "bottom", [])).toEqual({ x: 0, y: 76 + QUICK_ADD_GAP });
    expect(quickAddSpot(SOURCE, SIZE, "top", [])).toEqual({ x: 0, y: -QUICK_ADD_GAP - 76 });
  });

  it("centres a box of another size on the source's axis", () => {
    expect(quickAddSpot(SOURCE, { w: 230, h: 120 }, "right", [])).toEqual({ x: 260, y: -22 });
    expect(quickAddSpot(SOURCE, { w: 230, h: 120 }, "bottom", [])).toEqual({ x: -30, y: 166 });
  });

  it("fans out beside a box already on that side — below it first", () => {
    const taken = { x: 260, y: 0, w: 170, h: 76 };
    expect(quickAddSpot(SOURCE, SIZE, "right", [taken])).toEqual({ x: 260, y: 104 });
    // …and above once below is taken too.
    const below = { x: 260, y: 104, w: 170, h: 76 };
    expect(quickAddSpot(SOURCE, SIZE, "right", [taken, below])).toEqual({ x: 260, y: -104 });
  });

  it("never lands on the other side of the source", () => {
    const wall = { x: 200, y: -2000, w: 4000, h: 4000 };
    const at = quickAddSpot(SOURCE, SIZE, "right", [wall]);
    expect(at.x).toBeGreaterThanOrEqual(170 + QUICK_ADD_GAP);
  });
});

describe("growFramesToFit", () => {
  it("widens a frame to hold a child past its right edge, with Tidy's inset", () => {
    const nodes = [frame("f", 0, 0, 300, 200), card("a", 28, 52, { parentId: "f" }), card("n", 400, 52, { parentId: "f" })];
    const grown = growFramesToFit(nodes, "n");
    expect(grown[0]).toMatchObject({ width: 400 + 170 + 28, height: 200, position: { x: 0, y: 0 } });
    expect(grown[0]!.style).toMatchObject({ width: 598, height: 200 });
  });

  it("grows up and left by moving the origin, and keeps every child where it was on screen", () => {
    const nodes = [frame("f", 100, 100, 300, 200), card("a", 28, 52, { parentId: "f" }), card("n", -200, 52, { parentId: "f" })];
    const grown = growFramesToFit(nodes, "n");
    const [f, a, n] = grown;
    expect(f!.position).toEqual({ x: 100 - 228, y: 100 });
    // Absolute positions unchanged.
    expect(f!.position.x + a!.position.x).toBe(128);
    expect(f!.position.x + n!.position.x).toBe(-100);
    expect(n!.position.x).toBe(28);
  });

  it("keeps no more inset than the frame already gives its other children", () => {
    // `a` sits 20px under the label; a box level with it is not a reason to grow.
    const nodes = [frame("f", 0, 0, 600, 200), card("a", 28, 20, { parentId: "f" }), card("n", 300, 20, { parentId: "f" })];
    expect(growFramesToFit(nodes, "n")).toEqual(nodes);
  });

  it("grows each enclosing frame in turn", () => {
    const nodes = [
      frame("outer", 0, 0, 500, 300),
      frame("inner", 28, 52, 300, 200, { parentId: "outer" }),
      card("n", 400, 52, { parentId: "inner" }),
    ];
    const [outer, inner] = growFramesToFit(nodes, "n");
    expect(inner!.width).toBe(598);
    expect(outer!.width).toBe(28 + 598 + 28);
  });

  it("leaves a collapsed frame alone", () => {
    const nodes = [frame("f", 0, 0, 180, 44, { data: { label: "f", kind: "group", collapsed: true } }), card("n", 400, 0, { parentId: "f" })];
    expect(growFramesToFit(nodes, "n")).toEqual(nodes);
  });
});

describe("addBeside", () => {
  const fresh = (): Node => ({ ...card("new", 0, 0), selected: true });

  it("adds the box as the only selection, beside the source", () => {
    const next = addBeside([card("a", 0, 0, { selected: true })], "a", "right", fresh())!;
    expect(next.map((n) => [n.id, !!n.selected])).toEqual([
      ["a", false],
      ["new", true],
    ]);
    expect(next[1]!.position).toEqual({ x: 260, y: 0 });
  });

  it("puts the box in the source's frame, in that frame's coordinates, and grows the frame", () => {
    const nodes = [frame("f", 100, 100, 300, 200), card("a", 28, 52, { parentId: "f", zIndex: 1001 })];
    const next = addBeside(nodes, "a", "right", fresh())!;
    const added = next.find((n) => n.id === "new")!;
    expect(added).toMatchObject({ parentId: "f", position: { x: 28 + 170 + QUICK_ADD_GAP, y: 52 }, zIndex: 1001 });
    expect(next[0]!.width).toBe(288 + 170 + 28);
  });

  it("does not treat the frames around the source as in the way", () => {
    const nodes = [frame("f", 0, 0, 1000, 400), card("a", 28, 52, { parentId: "f" })];
    expect(addBeside(nodes, "a", "right", fresh())!.find((n) => n.id === "new")!.position).toEqual({ x: 288, y: 52 });
  });

  it("steps around a frame the source is not in", () => {
    const nodes = [card("a", 0, 0), frame("other", 220, -100, 300, 300)];
    const added = addBeside(nodes, "a", "right", fresh())!.find((n) => n.id === "new")!;
    expect(added.parentId).toBeUndefined();
    const box = { x: added.position.x, y: added.position.y, w: 170, h: 76 };
    const clear = box.x >= 520 || box.y >= 200 || box.y + box.h <= -100;
    expect(clear).toBe(true);
  });

  it("joins the zone its centre lands in", () => {
    const next = addBeside([card("a", 0, 0)], "a", "bottom", fresh(), (x, y) => (y > 100 ? `z@${x},${y}` : null))!;
    expect((next[1]!.data as { zoneId?: string }).zoneId).toBe("z@85,204");
  });

  it("is null when the source is not on the canvas", () => {
    expect(addBeside([card("a", 0, 0)], "gone", "right", fresh())).toBeNull();
  });
});

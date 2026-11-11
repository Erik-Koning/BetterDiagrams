/**
 * The layout by distance: boxes that are joined sit near each other, every line
 * that runs with the flow still ends downstream of where it starts, nothing is
 * on top of anything, and it is the same picture every time.
 */
import { describe, expect, it } from "vitest";
import { acyclicOrder, layered, type PlaceItem, type PlaceLink, type PlaceOptions } from "../autoplace";
import { stressBlock } from "./stress";

const item = (id: string, w = 170, h = 76): PlaceItem => ({ id, w, h });
const link = (source: string, target: string, more: Partial<PlaceLink> = {}): PlaceLink => ({ source, target, ...more });
const opts = (flow: PlaceOptions["flow"] = "right"): PlaceOptions => ({ algorithm: "layered", flow, rankGap: 96, nodeGap: 40, shape: "any" });
const reading = (items: readonly PlaceItem[], links: readonly PlaceLink[]) =>
  acyclicOrder(
    items.map((i) => i.id),
    links.filter((l) => !l.tether),
  );

/** A seeded graph with a direction to it. */
function dag(n: number, m: number, seed: number): { items: PlaceItem[]; links: PlaceLink[] } {
  let s = seed;
  const random = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const items = Array.from({ length: n }, (_, i) => item(`n${i}`));
  const links: PlaceLink[] = [];
  const seen = new Set<string>();
  // A spine, so it is one piece; then lines forward at random.
  for (let i = 1; i < n; i += 1) {
    const from = Math.floor(random() * i);
    links.push(link(`n${from}`, `n${i}`));
    seen.add(`${from},${i}`);
  }
  while (links.length < m) {
    const a = Math.floor(random() * n);
    const b = Math.floor(random() * n);
    if (a >= b || seen.has(`${a},${b}`)) continue;
    seen.add(`${a},${b}`);
    links.push(link(`n${a}`, `n${b}`));
  }
  return { items, links };
}

const overlapping = (placed: ReadonlyArray<{ x: number; y: number; w: number; h: number }>) =>
  placed.some((a, i) => placed.some((b, j) => j > i && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));

describe("laid out by distance", () => {
  it("nothing lands on anything, and every box is placed once", () => {
    for (const seed of [3, 11, 29]) {
      const { items, links } = dag(16, 26, seed);
      const block = stressBlock(items, links, opts(), reading(items, links))!;
      expect(block.placed.map((p) => p.id).sort()).toEqual(items.map((i) => i.id).sort());
      expect(overlapping(block.placed)).toBe(false);
      expect(Math.min(...block.placed.map((p) => p.x))).toBe(0);
      expect(Math.min(...block.placed.map((p) => p.y))).toBe(0);
    }
  });

  it("every line that runs with the flow ends wholly downstream of where it starts, whichever way the flow runs", () => {
    const { items, links } = dag(14, 22, 7);
    for (const flow of ["right", "down", "left", "up"] as const) {
      const block = stressBlock(items, links, opts(flow), reading(items, links))!;
      const at = new Map(block.placed.map((p) => [p.id, p]));
      for (const l of links) {
        const s = at.get(l.source)!;
        const t = at.get(l.target)!;
        const ahead = flow === "right" ? t.x >= s.x + s.w : flow === "left" ? t.x + t.w <= s.x : flow === "down" ? t.y >= s.y + s.h : t.y + t.h <= s.y;
        expect(ahead).toBe(true);
      }
    }
  });

  it("is the same picture every time", () => {
    const { items, links } = dag(14, 22, 13);
    const once = stressBlock(items, links, opts(), reading(items, links));
    expect(stressBlock(items, links, opts(), reading(items, links))).toEqual(once);
  });

  it("puts joined boxes nearer each other than ranks do, when ranks string them out", () => {
    // One box feeding three tall stacks: ranked, the stacks share a column and the lines to its ends are long.
    const items = [item("hub"), item("a", 170, 420), item("b", 170, 420), item("c", 170, 420), item("tail")];
    const links = [link("hub", "a"), link("hub", "b"), link("hub", "c"), link("b", "tail")];
    const reach = (placed: ReadonlyArray<{ id: string; x: number; y: number; w: number; h: number }>) => {
      const at = new Map(placed.map((p) => [p.id, p]));
      return links.reduce((sum, l) => {
        const s = at.get(l.source)!;
        const t = at.get(l.target)!;
        return sum + Math.hypot(t.x + t.w / 2 - s.x - s.w / 2, t.y + t.h / 2 - s.y - s.h / 2);
      }, 0);
    };
    const byDistance = stressBlock(items, links, opts(), reading(items, links))!;
    const ranked = layered(items, links, opts());
    expect(reach(byDistance.placed)).toBeLessThan(reach(ranked.placed));
    expect(overlapping(byDistance.placed)).toBe(false);
  });

  it("a line that closes a loop is left free to run back, and one that only tethers holds nothing", () => {
    const items = ["a", "b", "c"].map((id) => item(id));
    const loop = [link("a", "b"), link("b", "c"), link("c", "a")];
    const block = stressBlock(items, loop, opts(), reading(items, loop))!;
    const x = (id: string) => block.placed.find((p) => p.id === id)!.x;
    expect(x("a")).toBeLessThan(x("b"));
    expect(x("b")).toBeLessThan(x("c"));
    const tethered = [link("a", "b"), link("b", "c"), link("c", "a", { tether: true })];
    expect(overlapping(stressBlock(items, tethered, opts(), reading(items, tethered))!.placed)).toBe(false);
  });

  it("leaves a piece too small to need it, or too big to afford it, to the ranked layout", () => {
    const two = [item("a"), item("b")];
    expect(stressBlock(two, [link("a", "b")], opts(), reading(two, [link("a", "b")]))).toBeNull();
    const { items, links } = dag(161, 200, 5);
    expect(stressBlock(items, links, opts(), reading(items, links))).toBeNull();
  });
});

/**
 * Lines that go round, given their sides and depths together: nested arcs sit
 * inside one another, arcs that would cross on one side are split across two,
 * and an arc keeps clear of the lines it would cut across.
 */
import { describe, expect, it } from "vitest";
import { arcCrossings, pageArcs, type Arc } from "./arcs";

const arc = (id: string, from: number, to: number, more: Partial<Arc> = {}): Arc => ({
  id,
  from,
  to,
  wallLow: 0,
  wallHigh: 170,
  tollLow: 0,
  tollHigh: 0,
  natural: "low",
  ...more,
});

describe("which side", () => {
  it("an arc on its own takes the side it would have anyway", () => {
    expect(pageArcs([arc("a", 0, 300)]).get("a")).toEqual({ side: "low", depth: 1 });
    expect(pageArcs([arc("a", 0, 300, { natural: "high" })]).get("a")).toEqual({ side: "high", depth: 1 });
  });

  it("two arcs whose spans interleave go to opposite sides, so they don't cross", () => {
    const arcs = [arc("a", 0, 300), arc("b", 150, 450)];
    const pages = pageArcs(arcs);
    expect(pages.get("a")!.side).not.toBe(pages.get("b")!.side);
    expect(arcCrossings(arcs, pages)).toBe(0);
  });

  it("three that all interleave can't all be kept apart: one crossing, not three", () => {
    const arcs = [arc("a", 0, 300), arc("b", 100, 400), arc("c", 200, 500)];
    expect(arcCrossings(arcs, pageArcs(arcs))).toBe(1);
  });

  it("goes round the side with no lines to cut across, whatever side it would have taken", () => {
    const pages = pageArcs([arc("a", 0, 300, { tollLow: 2, natural: "low" })]);
    expect(pages.get("a")!.side).toBe("high");
  });

  it("arcs round different things don't count as crossing, even on one side with spans that interleave", () => {
    // Both barred from the high side by the lines there, so both take the low one.
    const arcs = [arc("a", 0, 300, { tollHigh: 2 }), arc("b", 150, 450, { wallLow: 600, wallHigh: 770, tollHigh: 2 })];
    const pages = pageArcs(arcs);
    expect(pages.get("a")).toEqual({ side: "low", depth: 1 });
    expect(pages.get("b")).toEqual({ side: "low", depth: 1 });
    expect(arcCrossings(arcs, pages)).toBe(0);
  });

  it("runs either way round: an arc back against the flow is paged like one ahead", () => {
    const arcs = [arc("ahead", 0, 300), arc("back", 450, 150)];
    const pages = pageArcs(arcs);
    expect(pages.get("ahead")!.side).not.toBe(pages.get("back")!.side);
  });
});

describe("sharing the two sides", () => {
  it("with nothing else to choose by, arcs are shared out between the sides, not stacked on one", () => {
    // Four arcs clear of each other, all of which would take the low side left to themselves.
    const row = [arc("a", 0, 200), arc("b", 300, 500), arc("c", 600, 800), arc("d", 900, 1100)];
    const sides = [...pageArcs(row).values()].map((p) => p.side);
    expect(sides.filter((side) => side === "low")).toHaveLength(2);
  });

  it("but never at the price of a crossing", () => {
    // Nested like brackets on one side: nothing crosses. Barred from the other side by the lines there.
    const nested = [arc("outer", 0, 900, { tollHigh: 1 }), arc("inner", 300, 600, { tollHigh: 1 })];
    const pages = pageArcs(nested);
    expect(pages.get("outer")!.side).toBe("low");
    expect(pages.get("inner")!.side).toBe("low");
    expect(arcCrossings(nested, pages)).toBe(0);
  });
});

describe("how far out", () => {
  it("an arc that spans another on its side goes outside it", () => {
    const barred = { tollHigh: 2 };
    const pages = pageArcs([arc("outer", 0, 900, barred), arc("inner", 300, 600, barred), arc("innermost", 400, 500, barred)]);
    expect([pages.get("innermost")!.depth, pages.get("inner")!.depth, pages.get("outer")!.depth]).toEqual([1, 2, 3]);
    expect(new Set([...pages.values()].map((p) => p.side)).size).toBe(1);
  });

  it("arcs clear of each other along the flow share the innermost place", () => {
    const pages = pageArcs([arc("a", 0, 300), arc("b", 400, 600), arc("c", 700, 900)]);
    expect([...pages.values()].map((p) => p.depth)).toEqual([1, 1, 1]);
  });

  it("two that meet end to end at a box don't share a place, or they read as one line running past it", () => {
    // Both barred from the high side, so they have to share the low one.
    const pages = pageArcs([arc("into", 0, 300, { tollHigh: 9 }), arc("onward", 300, 600, { tollHigh: 9 })]);
    expect(pages.get("into")!.side).toBe("low");
    expect(pages.get("onward")!.side).toBe("low");
    expect(pages.get("into")!.depth).not.toBe(pages.get("onward")!.depth);
  });

  it("two forced onto one side that overlap never share a depth", () => {
    // Both sides cost the same to cross, and the high side is barred to both.
    const arcs = [arc("a", 0, 300, { tollHigh: 9 }), arc("b", 150, 450, { tollHigh: 9 })];
    const pages = pageArcs(arcs);
    expect(pages.get("a")!.side).toBe("low");
    expect(pages.get("b")!.side).toBe("low");
    expect(pages.get("a")!.depth).not.toBe(pages.get("b")!.depth);
  });
});

describe("many arcs", () => {
  // A ladder of twenty arcs, each interleaving the next: past the size every split is tried.
  const ladder = Array.from({ length: 20 }, (_, i) => arc(`a${i}`, i * 100, i * 100 + 150));

  it("are split so that neighbours alternate, the same way every time", () => {
    const pages = pageArcs(ladder);
    expect(arcCrossings(ladder, pages)).toBe(0);
    expect([...pageArcs(ladder).entries()]).toEqual([...pages.entries()]);
  });

  it("never share a depth where they overlap on one side", () => {
    const tangle = Array.from({ length: 16 }, (_, i) => arc(`t${i}`, (i * 37) % 500, ((i * 37) % 500) + 120 + (i % 5) * 90));
    const pages = pageArcs(tangle);
    for (let i = 0; i < tangle.length; i += 1) {
      for (let j = i + 1; j < tangle.length; j += 1) {
        const a = tangle[i]!;
        const b = tangle[j]!;
        const overlap = Math.min(a.from, a.to) < Math.max(b.from, b.to) && Math.min(b.from, b.to) < Math.max(a.from, a.to);
        if (overlap && pages.get(a.id)!.side === pages.get(b.id)!.side) {
          expect(pages.get(a.id)!.depth).not.toBe(pages.get(b.id)!.depth);
        }
      }
    }
  });
});

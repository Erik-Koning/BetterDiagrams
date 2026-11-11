/**
 * The flow measures, each on a picture small enough to work out by hand: what
 * it counts, what it doesn't, and that it reads the picture rather than the
 * document's opinion of itself.
 */
import { describe, expect, it } from "vitest";
import { layoutStability, measureFlow } from "./metrics";
import { validateTemplate, type DiagramTemplate } from "../schema";

const box = (id: string, x: number, y: number, more: Record<string, unknown> = {}) => ({
  id,
  label: id,
  kind: "service",
  x,
  y,
  w: 170,
  h: 76,
  ...more,
});
const line = (source: string, target: string, more: Record<string, unknown> = {}) => ({
  id: `${source}-${target}`,
  source,
  target,
  label: "",
  routing: "straight",
  ...more,
});
const doc = (nodes: unknown[], edges: unknown[] = [], more: Record<string, unknown> = {}): DiagramTemplate =>
  validateTemplate({ version: 1, nodes, edges, ...more });

/** a → b → c → d, left to right, dead level. */
const chain = doc(
  [box("a", 0, 0), box("b", 300, 0), box("c", 600, 0), box("d", 900, 0)],
  [line("a", "b"), line("b", "c"), line("c", "d")],
);

describe("which way a picture reads", () => {
  it("is read off the lines, whichever way they run", () => {
    expect(measureFlow(chain).axis).toBe("right");
    const down = doc([box("a", 0, 0), box("b", 0, 200), box("c", 0, 400)], [line("a", "b"), line("b", "c")]);
    expect(measureFlow(down).axis).toBe("down");
    const leftward = doc([box("a", 600, 0), box("b", 300, 0), box("c", 0, 0)], [line("a", "b"), line("b", "c")]);
    expect(measureFlow(leftward).axis).toBe("left");
  });

  it("is the one asked for when one is, and the picture is measured against that", () => {
    const m = measureFlow(chain, { axis: "left" });
    expect(m.axis).toBe("left");
    expect(m.backward).toBe(3);
    expect(m.flowConsistency).toBe(0);
  });
});

describe("direction", () => {
  it("a chain drawn in order runs wholly with the flow, in at one face and out at the other", () => {
    const m = measureFlow(chain);
    expect(m).toMatchObject({ directed: 3, backward: 0, flat: 0, backwardNeeded: 0, flowConsistency: 1, portDiscipline: 1 });
  });

  it("counts a line whose target sits upstream, and the distance it travels back", () => {
    // d is drawn before c, so c → d runs back and b → c overshoots.
    const m = measureFlow(
      doc(
        [box("a", 0, 0), box("b", 300, 0), box("d", 600, 0), box("c", 900, 0)],
        [line("a", "b"), line("b", "c", { points: [[750, 160]] }), line("c", "d", { points: [[750, -90]] })],
      ),
    );
    expect(m.backward).toBe(1);
    expect(m.flowConsistency).toBeGreaterThan(0.5);
    expect(m.flowConsistency).toBeLessThan(1);
  });

  it("says how many lines have to run back whatever is done: one for each loop", () => {
    const loop = doc(
      [box("a", 0, 0), box("b", 300, 0), box("c", 600, 0), box("x", 0, 300), box("y", 300, 300)],
      [line("a", "b"), line("b", "c"), line("c", "a", { points: [[385, 160]] }), line("x", "y"), line("y", "x", { points: [[235, 460]] })],
    );
    const m = measureFlow(loop);
    expect(m.backwardNeeded).toBe(2);
    expect(m.backward).toBe(2);
    expect(measureFlow(chain).backwardNeeded).toBe(0);
  });

  it("tells a return line running back from a main line turned round", () => {
    // a → b → c with c → a closing the loop: drawn in order, the line back is the loop's own.
    const inOrder = doc(
      [box("a", 0, 0), box("b", 300, 0), box("c", 600, 0)],
      [line("a", "b"), line("b", "c"), line("c", "a", { points: [[385, 160]] })],
    );
    expect(measureFlow(inOrder, { axis: "right" })).toMatchObject({ backward: 1, turned: 0 });
    // The same loop drawn starting from b: now a → b, which a reader follows forward, runs back.
    const rotated = doc(
      [box("a", 600, 0), box("b", 0, 0), box("c", 300, 0)],
      [line("a", "b", { points: [[385, 160]] }), line("b", "c"), line("c", "a")],
    );
    expect(measureFlow(rotated, { axis: "right" })).toMatchObject({ backward: 1, turned: 1 });
  });

  it("a line with no direction, or both, is nobody's to call backward", () => {
    const m = measureFlow(doc([box("a", 300, 0), box("b", 0, 0), box("c", 600, 0)], [line("a", "b", { direction: "none" }), line("a", "c")]));
    expect(m).toMatchObject({ directed: 1, backward: 0 });
  });

  it("two boxes level along the flow are joined by a flat line, not a backward one", () => {
    const m = measureFlow(doc([box("a", 0, 0), box("b", 300, 0), box("c", 300, 200)], [line("a", "b"), line("b", "c")]), { axis: "right" });
    expect(m).toMatchObject({ flat: 1, backward: 0 });
  });

  it("a forward line that leaves by the wrong face is counted against the ports", () => {
    const wrong = doc([box("a", 0, 0), box("b", 400, 0)], [line("a", "b", { start: { side: "top", t: 0.5 }, routing: "curved" })]);
    expect(measureFlow(wrong, { axis: "right" }).portDiscipline).toBe(0.5);
  });

  it("a box that only sends belongs at the start, and one that only receives at the end", () => {
    const placed = doc(
      [box("in", 0, 0), box("mid", 300, 0), box("out", 600, 0)],
      [line("in", "mid"), line("mid", "out")],
    );
    expect(measureFlow(placed).sourceSinkPlacement).toBe(1);
    // A second input drawn level with the middle of the flow.
    const late = doc(
      [box("in", 0, 0), box("mid", 300, 0), box("out", 600, 0), box("in2", 300, 200)],
      [line("in", "mid"), line("mid", "out"), line("in2", "out")],
    );
    expect(measureFlow(late, { axis: "right" }).sourceSinkPlacement).toBeCloseTo(2 / 3);
  });
});

describe("lines", () => {
  const crossed = (y: number) =>
    doc(
      [box("a", 0, 0), box("b", 600, 300), box("c", 0, y), box("d", 600, 0)],
      [line("a", "b"), line("c", "d")],
    );

  it("counts crossings, and how far from square they are", () => {
    const square = measureFlow(crossed(300));
    expect(square.crossings).toBe(1);
    const shallow = measureFlow(
      doc(
        [box("a", 0, 0), box("b", 900, 60), box("c", 0, 60), box("d", 900, 0)],
        [line("a", "b"), line("c", "d")],
      ),
    );
    expect(shallow.crossings).toBe(1);
    expect(shallow.crossingAngle).toBeGreaterThan(square.crossingAngle);
    expect(measureFlow(chain)).toMatchObject({ crossings: 0, crossingAngle: 0 });
  });

  it("a straight line turns through nothing, and an elbow through a right angle", () => {
    expect(measureFlow(chain).bends).toBe(0);
    const elbow = doc([box("a", 0, 0), box("b", 600, 400)], [line("a", "b", { points: [[685, 38]] })]);
    expect(measureFlow(elbow).bends).toBeCloseTo(1, 1);
  });

  it("lines of one length have no spread, and a long one among short ones has", () => {
    expect(measureFlow(chain).lengthSpread).toBeCloseTo(0, 5);
    const uneven = doc([box("a", 0, 0), box("b", 300, 0), box("c", 2000, 0)], [line("a", "b"), line("b", "c")]);
    expect(measureFlow(uneven).lengthSpread).toBeGreaterThan(0.5);
  });
});

describe("the shape of the whole", () => {
  it("a main path drawn level is straight, and one that wanders is less so", () => {
    expect(measureFlow(chain).spineStraightness).toBe(1);
    const wandering = doc(
      [box("a", 0, 0), box("b", 300, 200), box("c", 600, 0), box("d", 900, 200)],
      [line("a", "b"), line("b", "c"), line("c", "d")],
    );
    expect(measureFlow(wandering).spineStraightness).toBeLessThan(0.9);
  });

  it("evenly spaced ranks are even, and one gap out of step isn't", () => {
    expect(measureFlow(chain).rankEvenness).toBe(1);
    const uneven = doc(
      [box("a", 0, 0), box("b", 300, 0), box("c", 600, 0), box("d", 1500, 0)],
      [line("a", "b"), line("b", "c"), line("c", "d")],
    );
    expect(measureFlow(uneven).rankEvenness).toBeLessThan(0.6);
  });

  it("a fan drawn evenly about its source mirrors, and one drawn to one side doesn't", () => {
    const fan = (ys: number[]) =>
      doc(
        [box("s", 0, 200), ...ys.map((y, i) => box(`t${i}`, 400, y))],
        ys.map((_, i) => line("s", `t${i}`)),
      );
    expect(measureFlow(fan([0, 200, 400]), { axis: "right" }).symmetry).toBe(1);
    expect(measureFlow(fan([200, 330, 520]), { axis: "right" }).symmetry).toBeLessThan(0.8);
  });

  it("near in the graph and near on the page is low stress; a neighbour drawn far off is high", () => {
    const even = measureFlow(chain).stress!;
    const stretched = measureFlow(
      doc([box("a", 0, 0), box("b", 300, 0), box("c", 3000, 0), box("d", 3300, 0)], [line("a", "b"), line("b", "c"), line("c", "d")]),
    ).stress!;
    expect(even).toBeCloseTo(0, 5);
    expect(stretched).toBeGreaterThan(even + 0.05);
  });

  it("lines spread round a box resolve well, and lines leaving it side by side don't", () => {
    const star = doc(
      [box("hub", 400, 400), box("n", 400, 0), box("e", 900, 400), box("s", 400, 800), box("w", -100, 400)],
      [line("hub", "n"), line("hub", "e"), line("hub", "s"), line("hub", "w")],
    );
    const sheaf = doc(
      [box("hub", 0, 400), box("p", 900, 380), box("q", 900, 400), box("r", 900, 420)],
      [line("hub", "p"), line("hub", "q"), line("hub", "r")],
    );
    expect(measureFlow(star).angularResolution).toBeGreaterThan(measureFlow(sheaf).angularResolution + 0.5);
  });

  it("a group its boxes fill is compact, and one mostly empty isn't", () => {
    const grouped = (w: number, h: number) =>
      doc([box("g", 0, 0, { kind: "group", w, h }), box("in", 30, 60, { parentId: "g" }), box("in2", 230, 60, { parentId: "g" })]);
    expect(measureFlow(grouped(430, 170)).groupCompactness).toBeGreaterThan(0.35);
    expect(measureFlow(grouped(1600, 900)).groupCompactness).toBeLessThan(0.05);
  });

  it("an empty document, one box, and boxes with no lines all measure without complaint", () => {
    for (const t of [doc([]), doc([box("a", 0, 0)]), doc([box("a", 0, 0), box("b", 300, 0)])]) {
      const m = measureFlow(t);
      for (const value of Object.values(m)) {
        if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
      }
      expect(m).toMatchObject({ crossings: 0, backward: 0, flowConsistency: 1, portDiscipline: 1 });
    }
  });
});

describe("how much of the old picture is left", () => {
  it("a picture slid across the canvas hasn't changed", () => {
    const slid = { ...chain, nodes: chain.nodes.map((n) => ({ ...n, x: n.x + 500, y: n.y - 200 })) };
    expect(layoutStability(chain, slid)).toEqual({ moved: 0, orderKept: 1 });
  });

  it("boxes that trade places have moved, and their order with them", () => {
    const swapped = { ...chain, nodes: chain.nodes.map((n) => (n.id === "a" ? { ...n, x: 900 } : n.id === "d" ? { ...n, x: 0 } : n)) };
    const s = layoutStability(chain, swapped);
    expect(s.moved).toBeGreaterThan(1);
    expect(s.orderKept).toBeLessThan(0.5);
  });
});

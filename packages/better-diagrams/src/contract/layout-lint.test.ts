/**
 * The layout linter: each rule catches its defect on the lines as actually drawn,
 * none of them has an opinion about a diagram's shape, and a clean picture is
 * clean. The label rectangle is held to what the renderer really draws.
 */
import { describe, expect, it } from "vitest";
import { edgeGeometryFor } from "./geometry";
import {
  LAYOUT_LINT_RULES,
  LAYOUT_RULE_IDS,
  LAYOUT_RULES,
  buildScene,
  edgeWordsRect,
  lintLayout,
  type LayoutRuleId,
} from "./layout-lint";
import { BUILTIN_LINT_RULES, lintTemplate } from "./lint";
import { validateTemplate, type DiagramTemplate } from "./schema";
import { edgeLabelLayout } from "../react/shapes";

const service = (id: string, x: number, y: number, more: Record<string, unknown> = {}) => ({
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
  ...more,
});
const doc = (nodes: unknown[], edges: unknown[] = [], more: Record<string, unknown> = {}): DiagramTemplate =>
  validateTemplate({ version: 1, nodes, edges, ...more });
const count = (t: DiagramTemplate, rule: LayoutRuleId) => lintLayout(t).counts[rule] ?? 0;

describe("what each rule catches", () => {
  it("boxes on boxes, and boxes that nearly touch", () => {
    const t = doc([service("a", 0, 0), service("b", 100, 20), service("c", 400, 0), service("d", 574, 0)]);
    expect(count(t, "box-overlap")).toBe(1);
    expect(count(t, "box-too-close")).toBe(1);
  });

  it("a line through a box it doesn't touch", () => {
    const t = doc([service("a", 0, 0), service("b", 300, 0), service("c", 600, 0)], [line("a", "c")]);
    const report = lintLayout(t);
    expect(report.counts["line-through-box"]).toBe(1);
    expect(report.findings[0]).toMatchObject({ rule: "line-through-box", severity: "error", nodeIds: ["b"], edgeIds: ["a-c"] });
  });

  it("not a line that merely passes near a box", () => {
    const t = doc([service("a", 0, 0), service("b", 300, 200), service("c", 600, 0)], [line("a", "c")]);
    expect(count(t, "line-through-box")).toBe(0);
  });

  it("not a line into a box inside the frame it crosses", () => {
    const t = doc(
      [service("out", 0, 80), service("g", 300, 0, { kind: "group", w: 300, h: 240 }), service("in", 60, 80, { parentId: "g" })],
      [line("out", "in")],
    );
    expect(count(t, "line-through-box")).toBe(0);
  });

  it("crossings, on the curve as drawn", () => {
    const t = doc(
      [service("a", 0, 0), service("b", 0, 300), service("c", 500, 0), service("d", 500, 300)],
      [line("a", "d"), line("b", "c")],
    );
    expect(count(t, "line-crossing")).toBe(1);
  });

  it("lines on top of each other, but not a bundle meeting its box", () => {
    const apart = doc([service("a", 0, 0), service("b", 300, 0)], [line("a", "b"), line("b", "a")]);
    expect(count(apart, "line-overlap")).toBe(0);
    const stacked = doc(
      [service("a", 0, 0), service("b", 800, 0), service("c", 300, 200), service("d", 600, 200)],
      [
        line("a", "b", { routing: "straight" }),
        line("c", "d", { routing: "straight", points: [[350, 38], [550, 38]] }),
      ],
    );
    expect(count(stacked, "line-overlap")).toBe(1);
  });

  it("words on a box, on other words, and on a title", () => {
    const onBox = doc(
      [service("a", 0, 0), service("b", 180, 0), service("c", 60, -10, { w: 60, h: 30 })],
      [line("a", "b", { label: "a very long label indeed" })],
    );
    expect(count(onBox, "words-collision")).toBeGreaterThan(0);
    const both = doc(
      [service("a", 0, 0), service("b", 400, 0)],
      [line("a", "b", { id: "one", label: "first words" }), line("a", "b", { id: "two", label: "other words" })],
    );
    expect(count(both, "words-collision")).toBe(1);
  });

  it("a line over a container's name", () => {
    const t = doc(
      [service("out", 10, -200), service("g", 0, 0, { kind: "group", label: "A group with a name", w: 400, h: 240 }), service("in", 180, 100, { parentId: "g", w: 170 })],
      [line("out", "in", { points: [[60, 10]], start: { side: "bottom" }, end: { side: "left" } })],
    );
    expect(count(t, "line-over-title")).toBeGreaterThan(0);
  });

  it("a box out of its group, out of its zone, or straddling someone else's", () => {
    const group = doc([service("g", 0, 0, { kind: "group", w: 200, h: 120 }), service("in", 500, 0, { parentId: "g" })]);
    expect(count(group, "outside-container")).toBe(1);
    const zone = doc([service("m", 900, 0, { zoneId: "z" })], [], { zones: [{ id: "z", label: "Z", shape: "rect", x: 0, y: 0, w: 200, h: 120 }] });
    expect(lintLayout(validateTemplate({ ...zone, nodes: zone.nodes.map((n) => ({ ...n, x: 900 })) })).counts["outside-container"]).toBe(1);
    const stray = doc([service("g", 0, 0, { kind: "group", w: 300, h: 300 }), service("in", 30, 60, { parentId: "g" }), service("other", 150, 150)]);
    expect(count(stray, "intruder")).toBeGreaterThan(0);
  });

  it("zones that partly overlap, but not an island inside its host", () => {
    const zone = (id: string, x: number, y: number, w: number, h: number) => ({ id, label: id, shape: "rect", x, y, w, h });
    expect(count(doc([], [], { zones: [zone("a", 0, 0, 300, 300), zone("b", 200, 0, 300, 300)] }), "region-collision")).toBe(1);
    expect(count(doc([], [], { zones: [zone("a", 0, 0, 600, 600), zone("b", 100, 100, 100, 100)] }), "region-collision")).toBe(0);
  });

  it("text that doesn't fit, unless it's wrapped", () => {
    const long = "A label far too long for the box it sits in";
    expect(count(doc([service("a", 0, 0, { label: long })]), "text-clipped")).toBe(1);
    expect(count(doc([service("a", 0, 0, { label: long, wrap: true })]), "text-clipped")).toBe(0);
  });

  it("near misses read as mistakes; exact alignment doesn't", () => {
    expect(count(doc([service("a", 0, 0), service("b", 300, 6)]), "near-alignment")).toBe(1);
    expect(count(doc([service("a", 0, 0), service("b", 300, 0)]), "near-alignment")).toBe(0);
    // Different heights with their tops or bottoms level are aligned on purpose.
    expect(count(doc([service("a", 0, 0), service("b", 300, 0, { h: 90 })]), "near-alignment")).toBe(0);
  });

  it("gaps that nearly match in one row", () => {
    expect(count(doc([service("a", 0, 0), service("b", 200, 0), service("c", 600, 0)]), "uneven-spacing")).toBe(1);
    expect(count(doc([service("a", 0, 0), service("b", 300, 0), service("c", 600, 0)]), "uneven-spacing")).toBe(0);
  });

  it("a frame much bigger than what's in it", () => {
    const t = doc([service("g", 0, 0, { kind: "group", w: 1200, h: 900 }), service("in", 30, 60, { parentId: "g" })]);
    expect(count(t, "loose-container")).toBe(1);
  });
});

describe("no rule has an opinion about shape", () => {
  const chain = (n: number, stepX: number, stepY: number) =>
    doc(
      Array.from({ length: n }, (_, i) => service(`s${i}`, i * stepX, i * stepY)),
      Array.from({ length: n - 1 }, (_, i) => line(`s${i}`, `s${i + 1}`)),
    );

  it("a very long picture and a very tall one score the same as a short one", () => {
    expect(lintLayout(chain(40, 270, 0)).score).toBe(100);
    expect(lintLayout(chain(40, 0, 176)).score).toBe(100);
  });

  it("no rule mentions aspect, ratio or a size limit", () => {
    for (const rule of LAYOUT_RULE_IDS) {
      expect(LAYOUT_RULES[rule].description).not.toMatch(/aspect|ratio|too wide|too tall|too many/i);
    }
  });
});

describe("the score", () => {
  it("a clean picture is 100, and defects take it down in order of how much they hurt", () => {
    const clean = doc([service("a", 0, 0), service("b", 300, 0)], [line("a", "b")]);
    expect(lintLayout(clean).score).toBe(100);
    const overlap = doc([service("a", 0, 0), service("b", 20, 10)]);
    const nearMiss = doc([service("a", 0, 0), service("b", 300, 4)]);
    expect(lintLayout(overlap).score).toBeLessThan(lintLayout(nearMiss).score);
  });

  it("one rule can't sink the whole score", () => {
    const mess = doc(Array.from({ length: 40 }, (_, i) => service(`n${i}`, i, i)));
    expect(lintLayout(mess).counts["box-overlap"]).toBeGreaterThan(40);
    expect(lintLayout(mess).score).toBeGreaterThanOrEqual(100 - LAYOUT_RULES["box-overlap"].cap - 20);
  });

  it("findings come worst first", () => {
    const t = doc([service("a", 0, 0), service("b", 20, 10), service("c", 400, 4), service("d", 700, 0)], [line("a", "d")]);
    const order = { error: 0, warning: 1, info: 2 };
    const ranks = lintLayout(t).findings.map((f) => order[f.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("a box can opt out of a rule with the usual tag", () => {
    const t = doc([service("a", 0, 0, { tags: ["lint-ignore:box-overlap"] }), service("b", 20, 10, { tags: ["lint-ignore:box-overlap"] })]);
    expect(count(t, "box-overlap")).toBe(0);
  });

  it("each canvas is measured on its own, and only when asked", () => {
    const t = doc([
      service("card", 0, 0),
      service("other", 300, 0),
      service("k1", 0, 0, { parentId: "card" }),
      service("k2", 10, 10, { parentId: "card" }),
    ]);
    expect(lintLayout(t).counts["box-overlap"] ?? 0).toBe(0);
    const all = lintLayout(t, { frames: "all" });
    expect(all.counts["box-overlap"]).toBe(1);
    expect(all.findings.find((f) => f.rule === "box-overlap")?.frame).toBe("card");
    expect(lintLayout(t, { frames: { drill: "card" } }).counts["box-overlap"]).toBe(1);
  });
});

describe("what it counts as drawn", () => {
  it("skips what isn't on screen: hidden providers, dependencies, what's folded", () => {
    const t = doc(
      [
        service("a", 0, 0, { zoneId: "z" }),
        service("hidden", 0, 0, { zoneId: "z", providers: ["azure"] }),
        service("b", 400, 0, { zoneId: "z" }),
        service("c", 200, 0, { zoneId: "z" }),
      ],
      [line("a", "b", { relation: "dependency" })],
      { zones: [{ id: "z", label: "Z", shape: "rect", provider: "aws", providers: ["aws", "azure"], x: -40, y: -80, w: 900, h: 400 }] },
    );
    const report = lintLayout(t);
    expect(report.counts["box-overlap"] ?? 0).toBe(0);
    expect(report.counts["line-through-box"] ?? 0).toBe(0);
  });

  it("a line into a folded group is drawn to its chip", () => {
    const t = doc(
      [service("a", 0, 0), service("g", 400, 0, { kind: "group", collapsed: true, w: 300, h: 200 }), service("in", 40, 60, { parentId: "g" })],
      [line("a", "in")],
    );
    const scene = buildScene(t);
    expect(scene.lines[0]!.target.id).toBe("g");
    expect(scene.boxes.map((b) => b.id)).not.toContain("in");
  });

  it("isn't changed by measuring", () => {
    const t = doc([service("a", 0, 0), service("b", 20, 10)], [line("a", "b")]);
    const before = JSON.stringify(t);
    lintLayout(t);
    expect(JSON.stringify(t)).toBe(before);
  });
});

describe("the words' rectangle matches what the renderer draws", () => {
  const box = (x: number, y: number) => ({ x, y, width: 170, height: 76 });
  const cases: Array<[string, { label?: string; tech?: string; seq?: number; date?: string }, ReturnType<typeof box>]> = [
    ["across", { label: "reads" }, box(400, 0)],
    ["across, wrapped", { label: "reads and writes the orders" }, box(240, 0)],
    ["across, with tech", { label: "reads", tech: "SQL" }, box(400, 0)],
    ["beside", { label: "reads" }, box(0, 300)],
    ["beside, with tech", { label: "reads and writes orders", tech: "gRPC" }, box(0, 300)],
  ];
  for (const [name, edge, target] of cases) {
    it(name, () => {
      const geo = edgeGeometryFor(undefined, box(0, 0), target, 0.5);
      const words = edgeLabelLayout(geo, 0.5, { label: edge.label, tech: !!edge.tech, date: !!edge.date, seq: !!edge.seq }, 11, "mono");
      const rect = edgeWordsRect(geo, 0.5, edge)!;
      expect(words.lines.length).toBeGreaterThan(0);
      // The first and last baselines sit inside the rectangle, as does the line's left edge.
      const left = words.anchor === "middle" ? words.x - rect.w / 2 : words.x;
      expect(left).toBeCloseTo(rect.x, 0);
      for (const baseline of words.baselines) {
        expect(baseline).toBeGreaterThanOrEqual(rect.y - 1);
        expect(baseline).toBeLessThanOrEqual(rect.y + rect.h + 1);
      }
    });
  }
});

describe("as lint rules", () => {
  it("can be added to the Checks menu, and aren't by default", () => {
    const t = doc([service("a", 0, 0), service("b", 20, 10)]);
    expect(lintTemplate(t).some((f) => f.rule.startsWith("layout/"))).toBe(false);
    const findings = lintTemplate(t, { ...BUILTIN_LINT_RULES, ...LAYOUT_LINT_RULES });
    expect(findings.some((f) => f.rule === "layout/box-overlap")).toBe(true);
  });

  it("stay quick on a big model", () => {
    const n = 300;
    const t = doc(
      Array.from({ length: n }, (_, i) => service(`n${i}`, (i % 20) * 240, Math.floor(i / 20) * 130)),
      Array.from({ length: n - 1 }, (_, i) => line(`n${i}`, `n${(i * 7) % n}`)),
    );
    const started = performance.now();
    lintLayout(t);
    expect(performance.now() - started).toBeLessThan(4000);
  });
});

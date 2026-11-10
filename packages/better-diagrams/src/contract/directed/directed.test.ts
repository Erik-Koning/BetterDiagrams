/**
 * The directed arrangement as a whole: it is an arrangement like the others
 * (nothing lost, nothing overlapping, locks and groups honoured, the same every
 * time), it draws what it says it draws (nested arcs, two-lane traffic, a
 * centred collector), and its priority trades what it says it trades.
 */
import { describe, expect, it } from "vitest";
import { directedCost, directedLayout, directedWeights } from "./index";
import { measureFlow } from "./metrics";
import { autoPlace } from "../arrange";
import { ARRANGE_FIXTURES } from "../arrange.fixtures";
import { autoLayout } from "../layout";
import { lintLayout } from "../layout-lint";
import { DIRECTED_METHODS, DIRECTED_PRIORITIES, validateTemplate, type DiagramTemplate } from "../schema";
import { validateTemplateReport } from "../validation-report";

const box = (id: string, more: Record<string, unknown> = {}) => ({ id, label: id, kind: "service", x: 0, y: 0, w: 170, h: 76, ...more });
const line = (source: string, target: string, more: Record<string, unknown> = {}) => ({ id: `${source}-${target}`, source, target, label: "", ...more });
const doc = (nodes: unknown[], edges: unknown[] = [], more: Record<string, unknown> = {}): DiagramTemplate =>
  validateTemplate({ version: 1, nodes, edges, ...more });
const chain = (n: number) => Array.from({ length: n - 1 }, (_, i) => line(`s${i}`, `s${i + 1}`));
const stages = (n: number) => Array.from({ length: n }, (_, i) => box(`s${i}`));
const at = (t: DiagramTemplate, id: string) => t.nodes.find((n) => n.id === id)!;

/** Eight stages in a row, and six lines that skip ahead past one or more of them. */
const shortcuts = doc(stages(8), [...chain(8), line("s0", "s2"), line("s1", "s4"), line("s2", "s5"), line("s3", "s6"), line("s0", "s5"), line("s4", "s7")]);

describe("an arrangement like the others", () => {
  for (const [name, make] of Object.entries(ARRANGE_FIXTURES)) {
    it(`${name}: nothing lost, nothing on top of anything, everything inside what holds it`, () => {
      const before = validateTemplate(make());
      const asGiven = JSON.stringify(before);
      const after = directedLayout(before, { method: "layered", frames: "all" });
      expect(after.nodes.map((n) => n.id).sort()).toEqual(before.nodes.map((n) => n.id).sort());
      expect(after.edges.map((e) => e.id).sort()).toEqual(before.edges.map((e) => e.id).sort());
      expect(after.nodes.map((n) => `${n.id}>${n.parentId ?? ""}`).sort()).toEqual(before.nodes.map((n) => `${n.id}>${n.parentId ?? ""}`).sort());
      const report = lintLayout(after, { frames: "all" });
      expect(report.counts["box-overlap"]).toBeUndefined();
      expect(report.counts["outside-container"]).toBeUndefined();
      // The document handed in is not the one handed back.
      expect(JSON.stringify(before)).toBe(asGiven);
    });
  }

  it("gives the same picture every time, by every method", () => {
    for (const method of DIRECTED_METHODS) {
      const once = directedLayout(shortcuts, { method });
      expect(JSON.stringify(directedLayout(shortcuts, { method }))).toBe(JSON.stringify(once));
    }
  });

  it("moves nothing locked", () => {
    const locked = doc(
      [box("a", { x: 40, y: 500, locked: true }), box("b"), box("c"), box("d")],
      [line("a", "b"), line("b", "c"), line("c", "d"), line("a", "d")],
    );
    const after = directedLayout(locked);
    expect(at(after, "a")).toMatchObject({ x: 40, y: 500 });
  });

  it("an empty document, one box, and boxes with no lines are arranged without complaint", () => {
    expect(directedLayout(doc([])).nodes).toEqual([]);
    expect(directedLayout(doc([box("a")])).nodes).toHaveLength(1);
    const loose = directedLayout(doc([box("a"), box("b"), box("c")]));
    expect(lintLayout(loose).counts["box-overlap"]).toBeUndefined();
  });

  it("is what Tidy does for a document that says so, and the document goes on saying so", () => {
    const chosen = { ...shortcuts, settings: { arrange: "directed" as const, directed: { priority: "balanced" as const, method: "layered" as const } } };
    const tidied = autoLayout(chosen);
    expect(tidied.settings).toEqual(chosen.settings);
    expect(JSON.stringify(tidied.nodes)).toBe(JSON.stringify(directedLayout(chosen).nodes));
    expect(JSON.stringify(tidied.nodes)).toBe(JSON.stringify(directedLayout(shortcuts, { priority: "balanced", method: "layered" }).nodes));
  });
});

describe("what it draws", () => {
  it("lines that skip ahead down a column nest on both sides of it, where Best fit piles them on one", () => {
    const directed = directedLayout(shortcuts, { method: "layered" });
    const flow = measureFlow(directed);
    expect(flow.backward).toBe(0);
    // All but the few pixels an arc gives up turning its corners.
    expect(flow.flowConsistency).toBeGreaterThan(0.97);
    // Three of the six interleave each other, so one side can't hold them all apart: two crossings is the least there is.
    expect(flow.crossings).toBeLessThanOrEqual(2);
    expect(flow.overlaps).toBe(0);
    expect(measureFlow(autoPlace(shortcuts)).crossings).toBeGreaterThan(flow.crossings * 2);
    const sides = new Set(directed.edges.filter((e) => e.points?.length).map((e) => e.start?.side));
    expect(sides.size).toBe(2);
  });

  it("a box that collects a fan sits in the middle of it", () => {
    const workers = Array.from({ length: 5 }, (_, i) => `w${i}`);
    const fan = doc(
      [box("router"), ...workers.map((id) => box(id)), box("collector")],
      [...workers.map((id) => line("router", id)), ...workers.map((id) => line(id, "collector"))],
    );
    const after = directedLayout(fan, { method: "layered", direction: "right" });
    const middle = workers.reduce((sum, id) => sum + at(after, id).y, 0) / workers.length;
    expect(Math.abs(at(after, "collector").y - middle)).toBeLessThanOrEqual(1);
    expect(Math.abs(at(after, "router").y - middle)).toBeLessThanOrEqual(1);
    expect(measureFlow(after).crossings).toBe(0);
  });

  it("and of an even one too: no worker is singled out to run dead level", () => {
    const workers = Array.from({ length: 6 }, (_, i) => `w${i}`);
    const fan = doc(
      [box("router"), ...workers.map((id) => box(id)), box("collector")],
      [...workers.map((id) => line("router", id)), ...workers.map((id) => line(id, "collector"))],
    );
    const after = directedLayout(fan, { method: "layered", direction: "right" });
    const middle = workers.reduce((sum, id) => sum + at(after, id).y, 0) / workers.length;
    expect(Math.abs(at(after, "collector").y - middle)).toBeLessThanOrEqual(1);
    expect(Math.abs(at(after, "router").y - middle)).toBeLessThanOrEqual(1);
  });

  it("arcs sharing a side of a box leave it level and in order, each from a place of its own", () => {
    const after = directedLayout(shortcuts, { method: "layered", direction: "down" });
    const arcs = after.edges.filter((e) => (e.points?.length ?? 0) >= 6);
    expect(arcs.length).toBeGreaterThanOrEqual(5);
    for (const arc of arcs) {
      const source = at(after, arc.source);
      const target = at(after, arc.target);
      // The corner starts level with where the line leaves the box, to the pixel.
      const leaves = source.y + source.h * (arc.start!.t ?? 0.5);
      const arrives = target.y + target.h * (arc.end!.t ?? 0.5);
      expect(leaves).toBeLessThan(arc.points![0]![1]);
      expect(arrives).toBeGreaterThan(arc.points![5]![1]);
    }
    // No two ends on one side of one box at the same place.
    const places = new Map<string, number[]>();
    for (const arc of arcs) {
      for (const [box, anchor] of [[arc.source, arc.start!], [arc.target, arc.end!]] as const) {
        const key = `${box}|${anchor.side}`;
        places.set(key, [...(places.get(key) ?? []), anchor.t ?? 0.5]);
      }
    }
    for (const ts of places.values()) expect(new Set(ts.map((t) => t.toFixed(3))).size).toBe(ts.length);
  });

  it("a line that skips a rank runs level through the channel kept for it, and turns only in the gaps", () => {
    const ids = ["s1", "s2", "s3", "m1", "m2", "m3", "t1", "t2", "t3"];
    const ranks = doc(
      ids.map((id) => box(id)),
      [line("s1", "m1"), line("s2", "m2"), line("s3", "m3"), line("m1", "t1"), line("m2", "t2"), line("m3", "t3"), line("s1", "t3")],
    );
    const after = directedLayout(ranks, { method: "layered", direction: "right" });
    const long = after.edges.find((e) => e.id === "s1-t3")!;
    expect(long.start).toMatchObject({ side: "right", auto: true });
    expect(long.end).toMatchObject({ side: "left", auto: true });
    // Out and back in: four points at one height, spanning the rank it skips.
    expect(long.points).toHaveLength(4);
    expect(new Set(long.points!.map(([, y]) => y)).size).toBe(1);
    const middle = ["m1", "m2", "m3"].map((id) => at(after, id));
    const [x0, y] = long.points![0]!;
    const x1 = long.points![3]![0];
    expect(x0).toBeLessThanOrEqual(Math.min(...middle.map((m) => m.x)));
    expect(x1).toBeGreaterThanOrEqual(Math.max(...middle.map((m) => m.x + m.w)));
    for (const m of middle) expect(y < m.y || y > m.y + m.h).toBe(true);
    expect(lintLayout(after).counts["line-through-box"]).toBeUndefined();
    // Best fit draws the same line as it always has: across, and bent round what's in the way.
    const plain = autoPlace(ranks, { direction: "right" }).edges.find((e) => e.id === "s1-t3")!.points ?? [];
    expect(plain.length === 4 && new Set(plain.map(([, py]) => py)).size === 1).toBe(false);
  });

  it("a tree is drawn as a tree: every parent level with the middle of its children", () => {
    const tree = doc(
      ["root", "a", "b", "a1", "a2", "a3", "b1", "b2"].map((id) => box(id)),
      [line("root", "a"), line("root", "b"), line("a", "a1"), line("a", "a2"), line("a", "a3"), line("b", "b1"), line("b", "b2")],
    );
    const after = directedLayout(tree, { direction: "right" });
    const mid = (...ids: string[]) => ids.reduce((sum, id) => sum + at(after, id).y, 0) / ids.length;
    expect(Math.abs(at(after, "a").y - mid("a1", "a2", "a3"))).toBeLessThanOrEqual(1);
    expect(Math.abs(at(after, "b").y - mid("b1", "b2"))).toBeLessThanOrEqual(1);
    expect(Math.abs(at(after, "root").y - mid("a", "b"))).toBeLessThanOrEqual(1);
    expect(measureFlow(after)).toMatchObject({ crossings: 0, backward: 0 });
  });

  it("traffic both ways between neighbours is two lanes of one road, face to face", () => {
    const road = doc([box("client"), box("gateway"), box("orders")], [line("client", "gateway"), line("gateway", "client"), line("gateway", "orders"), line("orders", "gateway")]);
    const after = directedLayout(road, { method: "layered", direction: "right" });
    const answer = after.edges.find((e) => e.id === "gateway-client")!;
    expect(answer.start).toMatchObject({ side: "left" });
    expect(answer.end).toMatchObject({ side: "right" });
    expect(answer.points).toBeUndefined();
    expect(lintLayout(after).counts["line-overlap"]).toBeUndefined();
    expect(measureFlow(after).crossings).toBe(0);
  });

  it("a loop still starts where the document starts it, with its return lines the ones that run back", () => {
    const loop = doc(
      ["plan", "build", "test", "stage", "release", "monitor"].map((id) => box(id)),
      [line("plan", "build"), line("build", "test"), line("test", "stage"), line("stage", "release"), line("release", "monitor"), line("test", "build"), line("monitor", "plan"), line("stage", "build")],
    );
    for (const method of DIRECTED_METHODS) {
      const after = directedLayout(loop, { method, direction: "right" });
      const flow = measureFlow(after, { axis: "right" });
      expect(flow.turned).toBe(0);
      expect(at(after, "plan").x).toBeLessThan(at(after, "build").x);
      expect(at(after, "build").x).toBeLessThan(at(after, "monitor").x);
    }
  });

  it("an arc is a bracket: its corners, and between them a run that is dead straight", () => {
    const skip = doc(stages(5), [...chain(5), line("s0", "s4")]);
    const after = directedLayout(skip, { method: "layered", direction: "down" });
    const arc = after.edges.find((e) => e.id === "s0-s4")!;
    expect(arc.points).toHaveLength(6);
    // The four points that hold the run all sit at one distance out.
    expect(new Set(arc.points!.slice(1, 5).map(([x]) => x)).size).toBe(1);
    expect(arc.start?.side).toBe(arc.end?.side);
  });
});

describe("what it trades", () => {
  it("each priority's two weights multiply to one, from nine for one to one for nine", () => {
    for (const priority of DIRECTED_PRIORITIES) {
      const w = directedWeights(priority);
      expect(w.crossing * w.direction).toBeCloseTo(1, 10);
    }
    expect(directedWeights("crossings").crossing / directedWeights("crossings").direction).toBeCloseTo(9);
    expect(directedWeights("direction").direction / directedWeights("direction").crossing).toBeCloseTo(9);
    expect(directedWeights("balanced")).toEqual({ crossing: 1, direction: 1 });
  });

  it("crossings above all never crosses more than direction above all, which never runs more lines backward", () => {
    for (const name of ["mesh", "flowchart", "ring", "zonesCloud"]) {
      const t = validateTemplate(ARRANGE_FIXTURES[name]!());
      const crossings = measureFlow(directedLayout(t, { priority: "crossings", method: "layered" }));
      const direction = measureFlow(directedLayout(t, { priority: "direction", method: "layered" }));
      expect(crossings.crossings).toBeLessThanOrEqual(direction.crossings);
      expect(direction.backward).toBeLessThanOrEqual(crossings.backward);
    }
  });

  it("best of all is never plainly beaten by one of the methods it is the best of", () => {
    const weights = directedWeights("mostly-crossings");
    for (const name of ["pipeline", "mesh", "bipartite", "flowchart"]) {
      const t = validateTemplate(ARRANGE_FIXTURES[name]!());
      // Read one way, so the three are judged on the same footing.
      const costOf = (method: (typeof DIRECTED_METHODS)[number]) => {
        const arranged = directedLayout(t, { method, direction: "right" });
        return directedCost(lintLayout(arranged), measureFlow(arranged, { axis: "right" }), weights);
      };
      const best = costOf("best");
      // A later way has to be plainly better to displace an earlier one, which is the slack here.
      for (const method of ["layered", "anneal"] as const) expect(best).toBeLessThanOrEqual(costOf(method) / 0.97 + 1e-6);
    }
  });

  it("a backward line costs more the further toward direction the priority goes, and a crossing less", () => {
    const crossed = doc([box("a", { x: 0, y: 0 }), box("b", { x: 600, y: 300 }), box("c", { x: 0, y: 300 }), box("d", { x: 600, y: 0 })], [line("a", "b", { routing: "straight" }), line("c", "d", { routing: "straight" })]);
    const back = doc([box("a", { x: 600, y: 0 }), box("b", { x: 0, y: 0 }), box("c", { x: 0, y: 300 }), box("d", { x: 600, y: 300 })], [line("a", "b", { routing: "straight" }), line("c", "d", { routing: "straight" })]);
    const cost = (t: DiagramTemplate, priority: (typeof DIRECTED_PRIORITIES)[number]) => directedCost(lintLayout(t), measureFlow(t, { axis: "right" }), directedWeights(priority));
    expect(cost(crossed, "crossings")).toBeGreaterThan(cost(crossed, "direction"));
    expect(cost(back, "direction")).toBeGreaterThan(cost(back, "crossings"));
    expect(cost(crossed, "crossings")).toBeGreaterThan(cost(back, "crossings"));
    expect(cost(back, "direction")).toBeGreaterThan(cost(crossed, "direction"));
  });
});

describe("in the document", () => {
  it("keeps the choices it knows, and drops what it doesn't", () => {
    const kept = doc([], [], { settings: { arrange: "directed", directed: { priority: "direction", method: "anneal" } } });
    expect(kept.settings).toEqual({ arrange: "directed", directed: { priority: "direction", method: "anneal" } });
    const dropped = doc([], [], { settings: { directed: { priority: "sideways", method: "magic", extra: 1 } } });
    expect(dropped.settings).toBeUndefined();
  });

  it("says so when a choice isn't one it knows", () => {
    const raw = { version: 1, nodes: [], edges: [], settings: { arrange: "directed", directed: { priority: "sideways", method: "anneal" } } };
    const report = validateTemplateReport(raw);
    expect(report.issues.some((i) => i.path === "/settings/directed/priority")).toBe(true);
    expect(report.issues.some((i) => i.path === "/settings/directed/method")).toBe(false);
  });
});

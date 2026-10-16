import { describe, expect, it } from "vitest";
import {
  MIN_BAR_W,
  besideDates,
  UNSCHEDULED_GAP,
  dateAtX,
  dayX,
  fitRoadmapAxis,
  hasRoadmapWork,
  roadmapAxisOf,
  roadmapDragPatch,
  roadmapLayout,
  roadmapTickUnit,
  roadmapTicks,
  settleRoadmap,
  unscheduledEdge,
  type RoadmapAxis,
} from "./roadmap";
import type { DiagramEdge, DiagramNode, DiagramTemplate } from "./schema";

const node = (id: string, over: Partial<DiagramNode> = {}): DiagramNode => ({
  id,
  label: id,
  kind: "task",
  icon: "none",
  description: "",
  parentId: null,
  x: 0,
  y: 0,
  w: 200,
  h: 84,
  ...over,
});
const group = (id: string, over: Partial<DiagramNode> = {}) => node(id, { kind: "group", w: 320, h: 240, ...over });
const milestone = (id: string, over: Partial<DiagramNode> = {}) => node(id, { kind: "milestone", w: 170, h: 96, ...over });

const AXIS: RoadmapAxis = { from: "2026-03-01", dayWidth: 10 };
const plan = (nodes: DiagramNode[], extra: Partial<DiagramTemplate> = {}): DiagramTemplate =>
  ({
    version: 1,
    nodes,
    edges: [],
    settings: { arrange: "roadmap", roadmap: AXIS },
    ...extra,
  }) as DiagramTemplate;

const at = (doc: DiagramTemplate, id: string) => {
  const n = doc.nodes.find((m) => m.id === id)!;
  return { x: n.x, y: n.y, w: n.w, h: n.h };
};

describe("the axis", () => {
  it("maps a date to the x its day begins at, and any x in that day back to it", () => {
    expect(dayX(AXIS, "2026-03-01")).toBe(0);
    expect(dayX(AXIS, "2026-03-11")).toBe(100);
    expect(dayX(AXIS, "2026-02-28")).toBe(-10);
    expect(dateAtX(AXIS, 100)).toBe("2026-03-11");
    expect(dateAtX(AXIS, 109)).toBe("2026-03-11");
    expect(dateAtX(AXIS, -1)).toBe("2026-02-28");
  });

  it("fits from the first of the earliest month, a day wide enough to spread the plan over a few screens", () => {
    const doc = plan([node("a", { startDate: "2026-03-14", date: "2026-04-02" }), milestone("m", { date: "2026-06-10" })]);
    // Mar 1 … Jun 10 is 102 days: 2400 / 102 ≈ 23.5.
    expect(fitRoadmapAxis(doc)).toEqual({ from: "2026-03-01", dayWidth: 24 });
  });

  it("caps the day width on a short plan, and starts an undated plan this month", () => {
    expect(fitRoadmapAxis(plan([node("a", { date: "2026-03-05" })]))).toEqual({ from: "2026-03-01", dayWidth: 40 });
    expect(fitRoadmapAxis(plan([node("a")]), { today: "2026-10-15" })).toEqual({ from: "2026-10-01", dayWidth: 8 });
  });

  it("reads a stored axis only when it is usable, with a whole day width in range", () => {
    expect(roadmapAxisOf(plan([]))).toEqual(AXIS);
    const withAxis = (roadmap: unknown) => ({ settings: { roadmap } }) as unknown as DiagramTemplate;
    expect(roadmapAxisOf(withAxis({ from: "2026-3-1", dayWidth: 10.4 }))).toEqual({ from: "2026-03-01", dayWidth: 10 });
    expect(roadmapAxisOf(withAxis({ from: "2026-03-01", dayWidth: 0 }))?.dayWidth).toBe(1);
    expect(roadmapAxisOf(withAxis({ from: "soon", dayWidth: 10 }))).toBeNull();
    expect(roadmapAxisOf(withAxis({ from: "2026-03-01" }))).toBeNull();
  });
});

describe("roadmapLayout", () => {
  it("runs a task from its start to the end of its due day", () => {
    const doc = roadmapLayout(plan([node("a", { startDate: "2026-03-02", date: "2026-03-21" })]));
    expect(at(doc, "a")).toMatchObject({ x: 10, w: 200 });
  });

  it("keeps a short task readable, on its due edge", () => {
    const doc = roadmapLayout(plan([node("a", { startDate: "2026-03-10", date: "2026-03-11" })]));
    expect(at(doc, "a")).toMatchObject({ x: 110 - MIN_BAR_W, w: MIN_BAR_W });
  });

  it("ends a task with no start on its due day, at the standard width, and ignores a start after the due date", () => {
    const doc = roadmapLayout(
      plan([
        node("a", { date: "2026-03-31", w: 640 }),
        node("b", { startDate: "2026-04-20", date: "2026-03-31" }),
      ]),
    );
    expect(at(doc, "a")).toMatchObject({ x: 110, w: 200 });
    expect(at(doc, "b")).toMatchObject({ x: 110, w: 200 });
  });

  it("centres a milestone on its day and keeps its size", () => {
    const doc = roadmapLayout(plan([milestone("m", { date: "2026-03-16" })]));
    expect(at(doc, "m")).toEqual({ x: 155 - 85, y: 0, w: 170, h: 96 });
  });

  it("stacks overlapping work in rows, earliest on top, and fits later work into the first row clear of it", () => {
    const doc = roadmapLayout(
      plan([
        node("late", { date: "2026-04-30" }),
        node("b", { startDate: "2026-03-05", date: "2026-03-25", assignees: ["Ana"] }),
        node("a", { startDate: "2026-03-01", date: "2026-03-20" }),
        node("c", { startDate: "2026-03-10", date: "2026-03-28" }),
      ]),
    );
    expect(at(doc, "a").y).toBe(0);
    expect(at(doc, "b").y).toBe(84 + 28);
    // b's assignee tabs hang 18px under it, so the next row clears them.
    expect(at(doc, "c").y).toBe(84 + 28 + 84 + 18 + 28);
    expect(at(doc, "late").y).toBe(0);
  });

  it("puts undated work in a column left of the earliest date", () => {
    const doc = roadmapLayout(plan([node("a", { date: "2026-03-20" }), node("u"), milestone("mu")]));
    const edge = -UNSCHEDULED_GAP;
    expect(at(doc, "u")).toMatchObject({ x: edge - 200 });
    expect(at(doc, "mu")).toMatchObject({ x: edge - 170 });
    expect(unscheduledEdge(doc, AXIS)).toBe(edge);
    expect(unscheduledEdge(plan([node("a", { date: "2026-03-20" })]), AXIS)).toBeNull();

    // Work dated before the axis starts pushes the column further left.
    const early = roadmapLayout(plan([node("a", { date: "2026-02-20" }), node("u")]));
    expect(at(early, "u").x).toBe(dayX(AXIS, "2026-02-21") - 200 - UNSCHEDULED_GAP - 200);
  });

  it("fits a frame round its work, with the children placed relative to it", () => {
    const doc = roadmapLayout(
      plan([
        group("s1"),
        node("a", { parentId: "s1", startDate: "2026-03-02", date: "2026-03-21" }),
        node("b", { parentId: "s1", startDate: "2026-03-11", date: "2026-03-31" }),
      ]),
    );
    expect(at(doc, "s1")).toEqual({ x: 10 - 28, y: 0, w: 310 - 10 + 56, h: 52 + 84 + 28 + 84 + 28 });
    expect(at(doc, "a")).toMatchObject({ x: 28, y: 52 });
    expect(at(doc, "b")).toMatchObject({ x: 28 + 90, y: 52 + 84 + 28 });
  });

  it("sets sprints that follow one another side by side, and stacks workstreams that overlap", () => {
    const sprints = roadmapLayout(
      plan([
        group("s1"),
        group("s2"),
        node("a", { parentId: "s1", startDate: "2026-03-02", date: "2026-03-13" }),
        node("b", { parentId: "s2", startDate: "2026-03-30", date: "2026-04-10" }),
      ]),
    );
    expect(at(sprints, "s1").y).toBe(0);
    expect(at(sprints, "s2").y).toBe(0);

    const streams = roadmapLayout(
      plan([
        group("web"),
        group("api"),
        node("a", { parentId: "web", startDate: "2026-03-02", date: "2026-04-13" }),
        node("b", { parentId: "api", startDate: "2026-03-09", date: "2026-04-10" }),
      ]),
    );
    expect(at(streams, "web").y).toBe(0);
    expect(at(streams, "api").y).toBe(at(streams, "web").h + 28);
  });

  it("keeps workstreams in the document's order, whichever starts first", () => {
    const doc = roadmapLayout(
      plan([
        group("web"),
        group("api"),
        node("a", { parentId: "web", startDate: "2026-03-09", date: "2026-04-13" }),
        // api starts earlier, and holds undated work that reaches further left still.
        node("b", { parentId: "api", startDate: "2026-03-02", date: "2026-04-10" }),
        node("u", { parentId: "api" }),
        milestone("ship", { date: "2026-05-01" }),
      ]),
    );
    expect(at(doc, "web").y).toBeLessThan(at(doc, "api").y);
    // Loose work goes first, in the top row, beside the first stream it clears.
    expect(at(doc, "ship").y).toBe(0);
  });

  it("nests a frame inside a frame, each relative to its own parent", () => {
    const doc = roadmapLayout(
      plan([
        group("phase"),
        group("epic", { parentId: "phase" }),
        node("a", { parentId: "epic", startDate: "2026-03-02", date: "2026-03-21" }),
      ]),
    );
    expect(at(doc, "epic")).toMatchObject({ x: 28, y: 52 });
    expect(at(doc, "a")).toMatchObject({ x: 28, y: 52 });
    expect(at(doc, "phase")).toMatchObject({ x: 10 - 56, y: 0 });
  });

  it("leaves zones, boxes outside the plan, and a card's own children where they are", () => {
    const doc = plan(
      [
        node("svc", { kind: "service", x: 900, y: 900, w: 170, h: 76, date: "2026-03-20" }),
        node("inner", { parentId: "svc", x: 5, y: 5, date: "2026-03-25" }),
        group("ops", { x: 700, y: 700 }),
        node("note", { kind: "service", parentId: "ops", x: 3, y: 4, w: 170, h: 76 }),
        node("a", { date: "2026-03-20" }),
      ],
      { zones: [{ id: "z", label: "Z", shape: "rect", providers: ["aws"], provider: "aws", x: 2000, y: 2000, w: 100, h: 100 }] as never },
    );
    const laid = roadmapLayout(doc);
    for (const id of ["svc", "inner", "ops", "note"]) expect(at(laid, id)).toEqual(at(doc, id));
    expect(laid.zones).toBe(doc.zones);
  });

  it("puts anything undated inside a plan's frame in the Unscheduled column, at its own size", () => {
    const doc = roadmapLayout(
      plan([
        group("s1"),
        node("a", { parentId: "s1", date: "2026-03-20" }),
        node("note", { kind: "text", parentId: "s1", w: 300, h: 60 }),
      ]),
    );
    expect(at(doc, "note")).toMatchObject({ w: 300, h: 60 });
    expect(at(doc, "s1").x + at(doc, "note").x).toBe(-UNSCHEDULED_GAP - 300);
  });

  it("returns the same document when nothing moves, and stores a freshly fitted axis", () => {
    const once = roadmapLayout(plan([node("a", { date: "2026-03-20" })]));
    expect(roadmapLayout(once)).toBe(once);

    const unfitted = plan([node("a", { date: "2026-03-20" })], { settings: { arrange: "roadmap" } as never });
    const fitted = roadmapLayout(unfitted);
    expect(roadmapAxisOf(fitted)).toEqual({ from: "2026-03-01", dayWidth: 40 });
  });

  it("refits on request, and moves root boxes the plan would cover below it", () => {
    const doc = plan([node("a", { date: "2026-03-20" }), node("title", { kind: "text", x: 650, y: 10, w: 300, h: 60 })]);
    const refit = roadmapLayout(doc, { refit: true });
    expect(roadmapAxisOf(refit)).toEqual({ from: "2026-03-01", dayWidth: 40 });
    expect(at(refit, "title")).toEqual({ x: 650, y: 84 + 56, w: 300, h: 60 });
    // An ordinary settle leaves it.
    expect(at(roadmapLayout(doc), "title")).toEqual(at(doc, "title"));
  });

  it("drops hand-routed waypoints only from lines whose ends moved", () => {
    const edges = [
      { id: "e1", source: "a", target: "b", label: "", style: "solid", color: "slate", points: [[5, 5]] },
      { id: "e2", source: "s", target: "t", label: "", style: "solid", color: "slate", points: [[9, 9]] },
    ] as DiagramEdge[];
    const doc = plan(
      [
        node("a", { date: "2026-03-20", x: 999 }),
        node("b", { date: "2026-03-28" }),
        node("s", { kind: "service", x: 0, y: 900 }),
        node("t", { kind: "service", x: 400, y: 900 }),
      ],
      { edges },
    );
    const laid = roadmapLayout(doc);
    expect(laid.edges[0]).not.toHaveProperty("points");
    expect(laid.edges[1]).toBe(edges[1]);
  });
});

describe("settleRoadmap", () => {
  it("leaves a document that isn't a roadmap alone", () => {
    const doc = plan([node("a", { date: "2026-03-20", x: 999 })], { settings: { arrange: "flow" } as never });
    expect(settleRoadmap(doc)).toBe(doc);
  });

  it("lays a roadmap out once — settling it again changes nothing", () => {
    const doc = plan([node("a", { date: "2026-03-20", x: 999 }), node("b", { startDate: "2026-03-02", date: "2026-03-09" })]);
    const settled = settleRoadmap(doc);
    expect(settled).not.toBe(doc);
    expect(settleRoadmap(settled)).toBe(settled);
  });

  it("re-reads zone membership from where the cards now sit", () => {
    const doc = plan([node("a", { date: "2026-03-20", x: 5000, zoneId: "z" })], {
      zones: [{ id: "z", label: "Z", shape: "rect", providers: ["aws"], provider: "aws", x: 4900, y: -100, w: 600, h: 400 }] as never,
    });
    expect(settleRoadmap(doc).nodes[0]!.zoneId).toBeNull();
  });
});

describe("roadmapDragPatch", () => {
  const doc = plan([
    group("s1"),
    node("a", { parentId: "s1", startDate: "2026-03-02", date: "2026-03-20" }),
    node("b", { parentId: "s1", date: "2026-03-25" }),
    node("u", { parentId: "s1" }),
    node("loose", { date: "2026-03-10" }),
    node("free"),
    milestone("mu"),
  ]);

  it("moves a dated card's start and due date together, by whole days", () => {
    expect(roadmapDragPatch(doc, AXIS, [{ id: "a", from: 100, to: 134 }])).toEqual(
      new Map([["a", { startDate: "2026-03-05", date: "2026-03-23" }]]),
    );
    expect(roadmapDragPatch(doc, AXIS, [{ id: "loose", from: 100, to: 60 }]).get("loose")).toEqual({ date: "2026-03-06" });
    expect(roadmapDragPatch(doc, AXIS, [{ id: "loose", from: 100, to: 104 }]).size).toBe(0);
  });

  it("dates an undated card by where it lands on the axis, and not in the Unscheduled column", () => {
    // A task's due day is where its right edge lands: 50 + 200 → Mar 25.
    expect(roadmapDragPatch(doc, AXIS, [{ id: "free", from: -248, to: 50 }]).get("free")).toEqual({ date: "2026-03-25" });
    // A milestone's is under its centre: 15 + 85 → Mar 11.
    expect(roadmapDragPatch(doc, AXIS, [{ id: "mu", from: -218, to: 15 }]).get("mu")).toEqual({ date: "2026-03-11" });
    expect(roadmapDragPatch(doc, AXIS, [{ id: "free", from: -248, to: -400 }]).size).toBe(0);
  });

  it("moves every dated card in a dragged frame, once, however the selection was made", () => {
    const patch = roadmapDragPatch(doc, AXIS, [
      { id: "s1", from: 0, to: 70 },
      { id: "a", from: 28, to: 98 },
    ]);
    expect(patch).toEqual(
      new Map([
        ["a", { startDate: "2026-03-09", date: "2026-03-27" }],
        ["b", { date: "2026-04-01" }],
      ]),
    );
  });

  it("leaves the dates of what the plan doesn't place", () => {
    const withExtras = plan([
      ...doc.nodes,
      node("svc", { kind: "service", date: "2026-03-10" }),
      node("card", { date: "2026-03-10" }),
      node("detail", { parentId: "card", date: "2026-03-12" }),
    ]);
    expect(roadmapDragPatch(withExtras, AXIS, [{ id: "svc", from: 0, to: 70 }]).size).toBe(0);
    expect([...roadmapDragPatch(withExtras, AXIS, [{ id: "card", from: 0, to: 70 }]).keys()]).toEqual(["card"]);
  });
});

describe("hasRoadmapWork", () => {
  it("is dated work — a dated service is not a plan", () => {
    expect(hasRoadmapWork(plan([node("a", { date: "2026-03-20" })]))).toBe(true);
    expect(hasRoadmapWork(plan([node("a", { startDate: "2026-03-20" })]))).toBe(true);
    expect(hasRoadmapWork(plan([node("a"), node("s", { kind: "service", date: "2026-03-20" })]))).toBe(false);
  });
});

describe("roadmapTicks", () => {
  it("picks the finest unit whose labels fit", () => {
    expect(roadmapTickUnit(10)).toBe("week");
    expect(roadmapTickUnit(3)).toBe("month");
    expect(roadmapTickUnit(1)).toBe("quarter");
    expect(roadmapTickUnit(0.3)).toBe("year");
  });

  it("labels months, naming the year on the first and on each January; quarters are the strong lines", () => {
    const axis = { from: "2026-11-01", dayWidth: 3 };
    const { unit, ticks } = roadmapTicks(axis, 10, dayX(axis, "2027-02-01"));
    expect(unit).toBe("month");
    expect(ticks.map((t) => t.label)).toEqual(["Nov ’26", "Dec", "Jan ’27", "Feb"]);
    expect(ticks.map((t) => t.major)).toEqual([false, false, true, false]);
    expect(ticks[1]!.full).toBe("Dec ’26");
    expect(ticks[0]!.x).toBe(0);
  });

  it("labels weeks by their Monday, the first one starting before the range", () => {
    // 2026-03-01 is a Sunday.
    const { unit, ticks } = roadmapTicks(AXIS, 0, dayX(AXIS, "2026-03-16"));
    expect(unit).toBe("week");
    expect(ticks.map((t) => t.label)).toEqual(["Feb 23 ’26", "Mar 2", "Mar 9", "Mar 16"]);
    expect(ticks.map((t) => t.major)).toEqual([false, true, false, false]);
    expect(ticks[1]!.full).toBe("Mar 2 ’26");
    expect(ticks[1]!.x).toBe(10);
  });

  it("labels quarters and years when zoomed out", () => {
    const axis = { from: "2026-01-01", dayWidth: 1 };
    expect(roadmapTicks(axis, 0, dayX(axis, "2026-12-31")).ticks.map((t) => t.label)).toEqual([
      "Q1 ’26",
      "Q2 ’26",
      "Q3 ’26",
      "Q4 ’26",
    ]);
    expect(roadmapTicks(axis, 0, dayX(axis, "2028-01-01"), 0.3).ticks.map((t) => t.label)).toEqual(["2026", "2027", "2028"]);
  });
});

describe("besideDates", () => {
  const bar = { kind: "task", startDate: "2026-03-02", date: "2026-03-06" };
  it("puts the next task after this one, as long, and the one before it ahead of it", () => {
    expect(besideDates(bar, "right")).toEqual({ startDate: "2026-03-07", date: "2026-03-11" });
    expect(besideDates(bar, "left")).toEqual({ startDate: "2026-02-25", date: "2026-03-01" });
  });
  it("puts work alongside on the same dates", () => {
    expect(besideDates(bar, "bottom")).toEqual({ startDate: "2026-03-02", date: "2026-03-06" });
  });
  it("moves a neighbour a week when the card has no length, and dates nothing from nothing", () => {
    expect(besideDates({ kind: "milestone", date: "2026-03-06" }, "right")).toEqual({ date: "2026-03-13" });
    expect(besideDates({ kind: "task", date: "2026-03-06" }, "left")).toEqual({ date: "2026-02-27" });
    expect(besideDates({ kind: "task" }, "right")).toEqual({});
  });
});

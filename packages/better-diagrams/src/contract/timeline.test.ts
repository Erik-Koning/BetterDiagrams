/**
 * Tests for dated elements and the timeline they define: normalisation,
 * display, the stop list, and what each stop shows in both documents.
 */
import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  dateToDay,
  dayToDate,
  daysBetween,
  isOverdue,
  nearestStop,
  openingCursor,
  effectiveNodeDates,
  formatDiagramDate,
  laterDate,
  normalizeDate,
  sequenceTimeline,
  sequenceTimelineView,
  templateTimeline,
  timelineStop,
  timelineView,
} from "./timeline";
import { validateTemplate, type DiagramTemplate } from "./schema";
import { validateSequence, type SequenceTemplate } from "./sequence";

const node = (over: Record<string, unknown> = {}) => ({
  id: "n",
  label: "N",
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

/** Nodes a/b/c dated March, June, September; `plain` carries no date. */
const roadmap = (): DiagramTemplate =>
  validateTemplate({
    version: 1,
    nodes: [
      node({ id: "plain" }),
      node({ id: "a", date: "2026-03-02" }),
      node({ id: "b", date: "2026-06-15" }),
      node({ id: "c", date: "2026-09-30" }),
    ],
    edges: [
      { id: "e1", source: "plain", target: "a", label: "", style: "solid", color: "slate" },
      { id: "e2", source: "a", target: "b", label: "", style: "solid", color: "slate" },
    ],
  });

describe("normalizeDate", () => {
  it("canonicalises separators and padding", () => {
    expect(normalizeDate("2026-3-4")).toBe("2026-03-04");
    expect(normalizeDate("2026/03/04")).toBe("2026-03-04");
    expect(normalizeDate("2026.3.4")).toBe("2026-03-04");
    expect(normalizeDate("  2026-03-04  ")).toBe("2026-03-04");
  });

  it("takes the first of the month when the day is missing", () => {
    expect(normalizeDate("2026-03")).toBe("2026-03-01");
  });

  it("clamps an impossible day into the month rather than rolling over", () => {
    expect(normalizeDate("2026-02-31")).toBe("2026-02-28");
    expect(normalizeDate("2024-02-31")).toBe("2024-02-29"); // leap year
    expect(normalizeDate("2026-04-31")).toBe("2026-04-30");
  });

  it("rejects anything that is not a date", () => {
    for (const bad of ["", "  ", "soon", "Q3", "2026-13-01", "2026-00-05", null, undefined, 42, {}]) {
      expect(normalizeDate(bad)).toBeUndefined();
    }
  });

  it("accepts a Date", () => {
    expect(normalizeDate(new Date(2026, 2, 4))).toBe("2026-03-04");
    expect(normalizeDate(new Date("nope"))).toBeUndefined();
  });

  it("orders lexicographically exactly as it orders chronologically", () => {
    const dates = ["2026-12-01", "2026-03-09", "2027-01-01", "2026-03-14"].map(
      (d) => normalizeDate(d)!,
    );
    expect([...dates].sort()).toEqual([
      "2026-03-09",
      "2026-03-14",
      "2026-12-01",
      "2027-01-01",
    ]);
  });
});

describe("formatDiagramDate", () => {
  it("shows a text month and a numeric day", () => {
    expect(formatDiagramDate("2026-03-14", { referenceYear: 2026 })).toBe("Mar 14");
    expect(formatDiagramDate("2026-01-01", { referenceYear: 2026 })).toBe("Jan 1");
    expect(formatDiagramDate("2026-12-31", { referenceYear: 2026 })).toBe("Dec 31");
  });

  it("adds a two-digit year only once the year stops being the reference", () => {
    expect(formatDiagramDate("2027-03-14", { referenceYear: 2026 })).toBe("Mar 14 ’27");
    expect(formatDiagramDate("2025-03-14", { referenceYear: 2026 })).toBe("Mar 14 ’25");
    expect(formatDiagramDate("2026-03-14", { referenceYear: 2026, year: "always" })).toBe(
      "Mar 14 ’26",
    );
    expect(formatDiagramDate("2027-03-14", { referenceYear: 2026, year: "never" })).toBe("Mar 14");
  });

  it("pads a single-digit year and returns nothing for no date", () => {
    expect(formatDiagramDate("2005-06-01", { referenceYear: 2026 })).toBe("Jun 1 ’05");
    expect(formatDiagramDate(undefined)).toBe("");
  });
});

describe("laterDate", () => {
  it("treats undefined as no constraint", () => {
    expect(laterDate("2026-03-01", undefined)).toBe("2026-03-01");
    expect(laterDate(undefined, "2026-03-01")).toBe("2026-03-01");
    expect(laterDate(undefined, undefined)).toBeUndefined();
    expect(laterDate("2026-03-01", "2026-06-01")).toBe("2026-06-01");
  });
});

describe("buildTimeline", () => {
  it("de-duplicates and sorts, and counts what carries no date", () => {
    const t = buildTimeline(["2026-06-15", undefined, "2026-03-02", "2026-06-15", null]);
    expect(t.stops).toEqual(["2026-03-02", "2026-06-15"]);
    expect(t.dated).toBe(3);
    expect(t.undated).toBe(2);
  });

  it("collects from every family of a template", () => {
    const t = templateTimeline(
      validateTemplate({
        version: 1,
        zones: [
          {
            id: "z",
            label: "Z",
            shape: "rounded",
            x: 0,
            y: 0,
            w: 900,
            h: 600,
            providers: ["aws"],
            provider: "aws",
            date: "2026-01-05",
          },
        ],
        nodes: [node({ id: "a", date: "2026-03-02" })],
        edges: [],
      }),
    );
    expect(t.stops).toEqual(["2026-01-05", "2026-03-02"]);
  });

  it("clamps a stop index into range and reports none for an undated document", () => {
    const t = templateTimeline(roadmap());
    expect(timelineStop(t, -5)).toBe("2026-03-02");
    expect(timelineStop(t, 99)).toBe("2026-09-30");
    expect(timelineStop(buildTimeline([]), 0)).toBeNull();
  });

  it("opens on today, held inside the plan's own span", () => {
    const t = templateTimeline(roadmap());
    // Between two stops: today is the answer, not the nearest stop.
    expect(openingCursor(t, "2026-07-01")).toBe("2026-07-01");
    expect(openingCursor(t, "2026-09-30")).toBe("2026-09-30");
    // Past the end, or entirely ahead: clamped, or the view would be identical
    // to not scrubbing / an empty diagram.
    expect(openingCursor(t, "2030-01-01")).toBe("2026-09-30");
    expect(openingCursor(t, "2020-01-01")).toBe("2026-03-02");
    expect(openingCursor(buildTimeline([]))).toBeNull();
  });
});

describe("timelineView — architecture", () => {
  it("is a no-op with no cursor", () => {
    const t = roadmap();
    const view = timelineView(t, null, "hide");
    expect(view.template).toBe(t);
    expect(view.futureCount).toBe(0);
  });

  it("at the FIRST stop shows only that date and the undated backdrop", () => {
    const view = timelineView(roadmap(), "2026-03-02", "hide");
    expect(view.template.nodes.map((n) => n.id).sort()).toEqual(["a", "plain"]);
    // The edge into the June node goes with it; the one between present nodes stays.
    expect(view.template.edges.map((e) => e.id)).toEqual(["e1"]);
  });

  it("at the LAST stop shows everything", () => {
    const t = roadmap();
    const view = timelineView(t, "2026-09-30", "hide");
    expect(view.template.nodes).toHaveLength(t.nodes.length);
    expect(view.futureCount).toBe(0);
  });

  it("hides in `hide` mode and marks in `dim` mode", () => {
    const t = roadmap();
    const hidden = timelineView(t, "2026-06-15", "hide");
    expect(hidden.template.nodes.map((n) => n.id)).not.toContain("c");
    expect(hidden.future.nodes.size).toBe(0);

    const dimmed = timelineView(t, "2026-06-15", "dim");
    expect(dimmed.template).toBe(t); // untouched
    expect([...dimmed.future.nodes]).toEqual(["c"]);
    expect(hidden.futureCount).toBe(dimmed.futureCount);
  });

  it("never shows a child before its container", () => {
    const t = validateTemplate({
      version: 1,
      nodes: [
        node({ id: "g", kind: "group", date: "2026-06-15", w: 400, h: 300 }),
        // Dated earlier than the boundary drawn around it.
        node({ id: "inner", parentId: "g", date: "2026-03-02" }),
      ],
      edges: [],
    });
    expect(effectiveNodeDates(t).get("inner")).toBe("2026-06-15");
    expect(timelineView(t, "2026-03-02", "hide").template.nodes).toHaveLength(0);
    expect(timelineView(t, "2026-06-15", "hide").template.nodes).toHaveLength(2);
  });

  it("hides an undated child once its container is in the future", () => {
    const t = validateTemplate({
      version: 1,
      nodes: [
        node({ id: "g", kind: "group", date: "2026-06-15", w: 400, h: 300 }),
        node({ id: "inner", parentId: "g" }),
      ],
      edges: [],
    });
    expect(timelineView(t, "2026-03-02", "hide").template.nodes).toHaveLength(0);
  });

  it("holds an edge back until both of its endpoints exist", () => {
    const t = roadmap();
    // e2 joins the March node to the June one and carries no date of its own.
    expect(timelineView(t, "2026-03-02", "dim").future.edges.has("e2")).toBe(true);
    expect(timelineView(t, "2026-06-15", "dim").future.edges.has("e2")).toBe(false);
  });

  it("lets an edge land after both of its endpoints", () => {
    const t = validateTemplate({
      version: 1,
      nodes: [node({ id: "a" }), node({ id: "b", x: 400 })],
      edges: [
        { id: "e", source: "a", target: "b", label: "", style: "solid", color: "slate", date: "2026-06-15" },
      ],
    });
    expect(timelineView(t, "2026-03-02", "hide").template.edges).toHaveLength(0);
    expect(timelineView(t, "2026-06-15", "hide").template.edges).toHaveLength(1);
  });

  it("does not date a zone's members from the zone", () => {
    const t = validateTemplate({
      version: 1,
      zones: [
        {
          id: "z",
          label: "Z",
          shape: "rounded",
          x: 0,
          y: 0,
          w: 900,
          h: 600,
          providers: ["aws"],
          provider: "aws",
          date: "2026-09-30",
        },
      ],
      nodes: [node({ id: "a", zoneId: "z" })],
      edges: [],
    });
    const view = timelineView(t, "2026-03-02", "hide");
    expect(view.template.zones ?? []).toHaveLength(0);
    // Membership is not containment — the node stays.
    expect(view.template.nodes.map((n) => n.id)).toEqual(["a"]);
  });

  it("produces a document that still validates", () => {
    const view = timelineView(roadmap(), "2026-03-02", "hide");
    expect(() => validateTemplate(view.template)).not.toThrow();
    expect(validateTemplate(view.template).nodes).toHaveLength(2);
  });
});

describe("sequenceTimelineView", () => {
  const flow = (): SequenceTemplate =>
    validateSequence({
      version: 1,
      participants: [
        { id: "u", label: "User", kind: "actor" },
        { id: "api", label: "API", kind: "service" },
        { id: "new", label: "Ledger", kind: "database", date: "2026-06-15" },
      ],
      messages: [
        { id: "m1", from: "u", to: "api", label: "call", style: "sync" },
        { id: "m2", from: "api", to: "new", label: "write", style: "sync" },
        { id: "m3", from: "api", to: "u", label: "audit", style: "reply", date: "2026-09-30" },
      ],
      activations: [{ id: "a1", participant: "new", from: "m2" }],
      fragments: [{ id: "f1", kind: "opt", label: "if enabled", from: "m2", to: "m3" }],
      notes: [{ id: "n1", text: "new ledger", side: "right", participant: "new", at: "m2" }],
    });

  it("collects the stops from both families", () => {
    expect(sequenceTimeline(flow()).stops).toEqual(["2026-06-15", "2026-09-30"]);
  });

  it("holds a message back until both of its participants exist", () => {
    const view = sequenceTimelineView(flow(), "2026-03-01", "hide");
    expect(view.template.participants.map((p) => p.id)).toEqual(["u", "api"]);
    expect(view.template.messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("drops constructs whose defining anchor is gone, degrades the rest", () => {
    const view = sequenceTimelineView(flow(), "2026-03-01", "hide");
    // a1's participant and f1's range are both gone; n1's participant too.
    expect(view.template.activations ?? []).toHaveLength(0);
    expect(view.template.fragments ?? []).toHaveLength(0);
    expect(view.template.notes ?? []).toHaveLength(0);
  });

  it("keeps a note but drops its dangling row anchor", () => {
    const t = validateSequence({
      version: 1,
      participants: [
        { id: "u", label: "User", kind: "actor" },
        { id: "api", label: "API", kind: "service" },
      ],
      messages: [
        { id: "m1", from: "u", to: "api", label: "call", style: "sync" },
        { id: "m2", from: "api", to: "u", label: "later", style: "reply", date: "2026-09-30" },
      ],
      notes: [{ id: "n1", text: "hi", side: "right", participant: "api", at: "m2" }],
    });
    const view = sequenceTimelineView(t, "2026-03-01", "hide");
    expect(view.template.notes).toHaveLength(1);
    expect(view.template.notes![0].at).toBeUndefined();
  });

  it("marks rather than removes in dim mode, with the same count", () => {
    const t = flow();
    const dimmed = sequenceTimelineView(t, "2026-03-01", "dim");
    expect(dimmed.template).toBe(t);
    expect([...dimmed.future.participants]).toEqual(["new"]);
    expect([...dimmed.future.messages].sort()).toEqual(["m2", "m3"]);
    expect(dimmed.futureCount).toBe(
      sequenceTimelineView(t, "2026-03-01", "hide").futureCount,
    );
  });

  it("marks the constructs that `hide` mode would have dropped", () => {
    // The two modes must agree about what is not there yet: anything hide
    // removes, dim has to mark, or a faded message keeps a bright bar and
    // frame drawn around it.
    const t = flow();
    const dimmed = sequenceTimelineView(t, "2026-03-01", "dim");
    const hidden = sequenceTimelineView(t, "2026-03-01", "hide");

    expect([...dimmed.future.activations]).toEqual(["a1"]);
    expect([...dimmed.future.fragments]).toEqual(["f1"]);
    expect([...dimmed.future.notes]).toEqual(["n1"]);
    expect(hidden.template.activations ?? []).toHaveLength(0);
    expect(hidden.template.fragments ?? []).toHaveLength(0);
    expect(hidden.template.notes ?? []).toHaveLength(0);
  });

  it("leaves a construct unmarked once its anchors have landed", () => {
    const dimmed = sequenceTimelineView(flow(), "2026-06-15", "dim");
    expect(dimmed.future.activations.size).toBe(0);
    expect(dimmed.future.notes.size).toBe(0);
    // f1 still spans m3, which is dated September.
    expect([...dimmed.future.fragments]).toEqual(["f1"]);
  });

  it("shows everything at the last stop", () => {
    const t = flow();
    const view = sequenceTimelineView(t, "2026-09-30", "hide");
    expect(view.template.messages).toHaveLength(3);
    expect(view.futureCount).toBe(0);
  });

  it("produces a document that still validates", () => {
    const view = sequenceTimelineView(flow(), "2026-03-01", "hide");
    expect(validateSequence(view.template).messages).toHaveLength(1);
  });
});

describe("the date field round-trips through validation", () => {
  it("normalises on the way in and is stripped when unusable", () => {
    const t = validateTemplate({
      version: 1,
      nodes: [node({ id: "a", date: "2026-3-4" }), node({ id: "b", date: "whenever" })],
      edges: [],
    });
    expect(t.nodes[0].date).toBe("2026-03-04");
    expect("date" in t.nodes[1]).toBe(false);
  });

  it("leaves an undated document byte-identical", () => {
    const before = validateTemplate({ version: 1, nodes: [node()], edges: [] });
    expect(JSON.stringify(validateTemplate(before))).toBe(JSON.stringify(before));
  });
});


describe("the continuous cursor", () => {
  it("maps dates to days and back, in UTC", () => {
    expect(dayToDate(dateToDay("2026-03-14"))).toBe("2026-03-14");
    expect(dayToDate(dateToDay("2024-02-29"))).toBe("2024-02-29");
    expect(daysBetween("2026-03-01", "2026-03-14")).toBe(13);
    expect(daysBetween("2026-03-14", "2026-03-01")).toBe(-13);
    // Ordering by day must agree with ordering by string.
    expect(dateToDay("2026-12-31")).toBeLessThan(dateToDay("2027-01-01"));
  });

  it("snaps to the nearest stop only within reach", () => {
    const t = templateTimeline(roadmap());
    expect(nearestStop(t, "2026-03-04", 5)).toBe("2026-03-02");
    expect(nearestStop(t, "2026-06-12", 5)).toBe("2026-06-15");
    // Halfway between March and June, nothing is within five days.
    expect(nearestStop(t, "2026-04-20", 5)).toBeNull();
    // A wide enough reach always finds something.
    expect(nearestStop(t, "2026-04-20", 400)).toBe("2026-03-02");
    expect(nearestStop(buildTimeline([]), "2026-04-20", 999)).toBeNull();
  });

  it("answers for a date no element is on", () => {
    // The whole point of a continuous cursor: April shows March's work and the
    // undated backdrop, even though nothing is dated in April.
    const view = timelineView(roadmap(), "2026-04-20", "hide");
    expect(view.template.nodes.map((n) => n.id).sort()).toEqual(["a", "plain"]);
  });
});

describe("isOverdue", () => {
  it("is true only for a past date on a pre-active element", () => {
    for (const status of ["proposed", "planned", "stubbed", "dark"]) {
      expect(isOverdue("2020-01-01", status, "2026-08-04")).toBe(true);
      // Not yet due.
      expect(isOverdue("2030-01-01", status, "2026-08-04")).toBe(false);
    }
  });

  it("an active or sunset element is never overdue — its date is history", () => {
    expect(isOverdue("2020-01-01", undefined, "2026-08-04")).toBe(false);
    expect(isOverdue("2020-01-01", "deprecated", "2026-08-04")).toBe(false);
    expect(isOverdue("2020-01-01", "retired", "2026-08-04")).toBe(false);
    expect(isOverdue(undefined, "planned", "2026-08-04")).toBe(false);
  });

  it("the due day itself is not overdue", () => {
    expect(isOverdue("2026-08-04", "planned", "2026-08-04")).toBe(false);
  });
});

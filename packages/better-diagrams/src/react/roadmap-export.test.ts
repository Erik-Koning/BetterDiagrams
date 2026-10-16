/**
 * A roadmap in a picture: the ruler over the drawing, a line where each unit
 * begins, and today's — and nothing of it on a document not laid out by date.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRegistry } from "./create-registry";
import { emitTemplate, type DrawCmd } from "./draw";
import { roadmapLayout } from "../contract/roadmap";
import { validateTemplate, type DiagramTemplate } from "../contract/schema";

const registry = createRegistry();
type TextCmd = Extract<DrawCmd, { op: "text" }>;
const texts = (cmds: DrawCmd[]) => cmds.filter((c): c is TextCmd => c.op === "text").map((c) => c.text);

/** A small plan laid out by date, 3px a day from March. */
const roadmap = () =>
  roadmapLayout(
    validateTemplate({
      version: 1,
      nodes: [
        { id: "a", label: "Design", kind: "task", date: "2026-03-20" },
        { id: "b", label: "Build", kind: "task", date: "2026-05-08" },
        { id: "u", label: "Someday", kind: "task" },
      ],
      edges: [],
      settings: { arrange: "roadmap", roadmap: { from: "2026-03-01", dayWidth: 3 } },
    } as unknown as DiagramTemplate),
  );

afterEach(() => vi.useRealTimers());

describe("roadmap export", () => {
  it("names the months over the drawing, the first with its year, and the Unscheduled column", () => {
    const labels = texts(emitTemplate(roadmap(), registry).cmds);
    // Design is a standard card ending Mar 20: at 3px a day it reaches back
    // into January, which is where the calendar starts — not over the
    // Unscheduled column left of it.
    expect(labels.slice(0, 6)).toEqual(["Jan ’26", "Feb", "Mar", "Apr", "May", "Unscheduled"]);
  });

  it("makes room for the ruler above the drawing", () => {
    const laid = roadmap();
    const plain = { ...laid, settings: {} } as DiagramTemplate;
    expect(emitTemplate(laid, registry).height - emitTemplate(plain, registry).height).toBe(26 + 10);
  });

  it("draws today's line when today is on the plan, and not when it isn't", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 3, 1));
    expect(texts(emitTemplate(roadmap(), registry).cmds)).toContain("Today");
    vi.setSystemTime(new Date(2031, 0, 1));
    expect(texts(emitTemplate(roadmap(), registry).cmds)).not.toContain("Today");
  });

  it("reads a task with a start as its range, start to due", () => {
    const doc = validateTemplate({
      version: 1,
      nodes: [{ id: "t", label: "Build", kind: "task", startDate: "2026-03-02", date: "2026-03-06", x: 0, y: 0 }],
      edges: [],
    } as unknown as DiagramTemplate);
    expect(texts(emitTemplate(doc, registry).cmds)).toContain("Mar 2 ’26 – Mar 6 ’26");
  });

  it("draws nothing of it when the document isn't laid out by date", () => {
    const laid = roadmap();
    const flow: DiagramTemplate = { ...laid, settings: { arrange: "flow", roadmap: { from: "2026-03-01", dayWidth: 3 } } };
    const plain = { ...laid, settings: {} } as DiagramTemplate;
    expect(emitTemplate(flow, registry)).toEqual(emitTemplate(plain, registry));
  });
});

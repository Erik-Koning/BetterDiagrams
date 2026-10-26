/**
 * Where an edge's words go: wrapped to the room its line gives, above an
 * across line and beside an up-and-down one — one layout for the canvas and
 * every exporter.
 */
import { describe, expect, it } from "vitest";
import { edgeGeometryFor, type Box } from "../contract/geometry";
import { approxTextWidth } from "../contract/text";
import { emitTemplate } from "./draw";
import { createRegistry } from "./create-registry";
import { edgeLabelLayout } from "./shapes";
import { validateTemplate } from "../contract/schema";

const left: Box = { x: 0, y: 0, width: 170, height: 76 };

describe("edgeLabelLayout", () => {
  it("leaves a one-line label above a long across line where it always was", () => {
    const geo = edgeGeometryFor("straight", left, { x: 500, y: 0, width: 170, height: 76 }, 0.5);
    const words = edgeLabelLayout(geo, 0.5, { label: "reads" }, 11, "mono");
    expect(words).toMatchObject({ lines: ["reads"], x: geo.label.x, anchor: "middle", beside: false, rise: 0 });
    expect(words.baselines).toEqual([geo.label.y - 5]);
  });

  it("wraps a label to the gap of a short arrow, stacking upward from the line", () => {
    const geo = edgeGeometryFor("straight", left, { x: 260, y: 0, width: 170, height: 76 }, 0.5);
    const label = "reads and writes orders";
    const words = edgeLabelLayout(geo, 0.5, { label }, 11, "mono");
    expect(words.lines.length).toBeGreaterThan(1);
    expect(words.lines.join(" ")).toBe(label);
    // No line wider than the room between the boxes (or the floor).
    for (const line of words.lines) expect(approxTextWidth(line, 11, "mono")).toBeLessThanOrEqual(78);
    // The bottom line keeps the one-line spot; the rest climb above it.
    expect(words.baselines[words.baselines.length - 1]).toBe(geo.label.y - 5);
    expect(words.rise).toBeGreaterThan(0);
  });

  it("moves the words beside an up-and-down line, the step badge on the line", () => {
    const geo = edgeGeometryFor("straight", left, { x: 0, y: 200, width: 170, height: 76 }, 0.5);
    const words = edgeLabelLayout(geo, 0.5, { label: "publishes events", tech: true, seq: true }, 11, "mono");
    expect(words.beside).toBe(true);
    expect(words.anchor).toBe("start");
    expect(words.x).toBeGreaterThan(geo.label.x);
    expect(words.seq).toEqual({ cx: geo.label.x, cy: geo.label.y });
    // The stack straddles the label point: label above it, [tech] below.
    expect(words.baselines[0]).toBeLessThan(geo.label.y + 5);
    expect(words.techY).toBeGreaterThan(words.baselines[0]);
  });
});

describe("exported edge labels", () => {
  it("draws a wrapped label line by line, as the canvas does", () => {
    const template = validateTemplate({
      version: 1,
      nodes: [
        { id: "a", label: "A", kind: "service", icon: "none", description: "", x: 0, y: 0, w: 170, h: 76 },
        { id: "b", label: "B", kind: "service", icon: "none", description: "", x: 260, y: 0, w: 170, h: 76 },
      ],
      edges: [{ id: "e", source: "a", target: "b", label: "reads and writes orders", style: "solid", color: "slate" }],
    });
    const { cmds } = emitTemplate(template, createRegistry());
    const texts = cmds.filter((c) => c.op === "text").map((c) => (c as { text: string }).text);
    const geo = edgeGeometryFor("curved", left, { x: 260, y: 0, width: 170, height: 76 }, 0.5);
    const words = edgeLabelLayout(geo, 0.5, { label: "reads and writes orders" }, 11, "mono");
    expect(texts).not.toContain("reads and writes orders");
    for (const line of words.lines) expect(texts).toContain(line);
  });
});

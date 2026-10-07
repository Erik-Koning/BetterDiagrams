/**
 * People colours on a task graph: a fixed, validated palette, assigned
 * across the whole plan so no two people share a colour while it lasts.
 */
import { describe, expect, it } from "vitest";
import { ASSIGNEE_PALETTE, assigneeSwatch, assigneeSwatches, swatchColor } from "./shapes";
import { createRegistry } from "./create-registry";
import { emitTemplate, LIGHT_EXPORT_PALETTE, type DrawCmd } from "./draw";
import { validateTemplate, type DiagramTemplate } from "../contract/schema";

const TEAM = ["Ana", "Lena", "Mo", "Priya", "Ravi", "Sam", "Zoe"];

describe("assigneeSwatches", () => {
  it("gives every person a different colour while the palette lasts", () => {
    const swatches = assigneeSwatches(TEAM);
    expect(new Set([...swatches.values()]).size).toBe(TEAM.length);
  });

  it("no longer puts Ana and Sam in the same green", () => {
    const swatches = assigneeSwatches(["Ana", "Sam"]);
    expect(swatches.get("Ana")).not.toEqual(swatches.get("Sam"));
  });

  it("depends on who is on the plan, not the order they appear in", () => {
    expect(assigneeSwatches([...TEAM].reverse())).toEqual(assigneeSwatches(TEAM));
  });

  it("keeps a person's colour when someone they never collided with leaves", () => {
    const all = assigneeSwatches(TEAM);
    for (const name of TEAM) {
      if (all.get(name) !== assigneeSwatch(name)) continue; // took a fallback slot
      const rest = TEAM.filter((n) => n !== name);
      const without = assigneeSwatches(rest);
      for (const other of rest) {
        if (all.get(other) === assigneeSwatch(other)) expect(without.get(other)).toBe(all.get(other));
      }
    }
  });

  it("shares colours only past seven people — the names still tell them apart", () => {
    const crowd = [...TEAM, "Ava", "Ben"];
    const swatches = assigneeSwatches(crowd);
    expect(swatches.size).toBe(crowd.length);
    expect(new Set([...swatches.values()]).size).toBe(ASSIGNEE_PALETTE.length);
  });

  it("hands the browser both steps, so the theme picks", () => {
    expect(swatchColor(ASSIGNEE_PALETTE[0]!)).toBe("light-dark(#2a78d6, #3987e5)");
  });
});

describe("people colours in exports", () => {
  const doc = validateTemplate({
    version: 1,
    nodes: [{ id: "t", label: "T", kind: "task", x: 0, y: 0, assignees: ["Ana"] }],
    edges: [],
  } as unknown as DiagramTemplate);
  const tabInk = (cmds: DrawCmd[]) =>
    cmds.find((c): c is Extract<DrawCmd, { op: "text" }> => c.op === "text" && c.text === "Ana")!.color;

  it("draws the dark step on a dark page and the light step on a light one", () => {
    const swatch = assigneeSwatches(["Ana"]).get("Ana")!;
    expect(tabInk(emitTemplate(doc, createRegistry()).cmds)).toBe(swatch.dark);
    expect(tabInk(emitTemplate(doc, createRegistry(), LIGHT_EXPORT_PALETTE).cmds)).toBe(swatch.light);
  });
});

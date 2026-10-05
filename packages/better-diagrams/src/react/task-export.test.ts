/**
 * Task graphs in a picture: the export draws what the canvas shows — the
 * corner check (struck through when blocked), the estimate, the assignee tabs, a done
 * task struck through — and a People section in the legend.
 */
import { describe, expect, it } from "vitest";
import { createRegistry } from "./create-registry";
import { emitTemplate, type DrawCmd } from "./draw";
import { validateTemplate, type DiagramTemplate } from "../contract/schema";

const registry = createRegistry();
const doc = (partial: Record<string, unknown>) =>
  validateTemplate({ version: 1, edges: [], ...partial } as unknown as DiagramTemplate) as DiagramTemplate;

type TextCmd = Extract<DrawCmd, { op: "text" }>;
type CircleCmd = Extract<DrawCmd, { op: "circle" }>;
const texts = (cmds: DrawCmd[]) => cmds.filter((c): c is TextCmd => c.op === "text").map((c) => c.text);
const circles = (cmds: DrawCmd[]) => cmds.filter((c): c is CircleCmd => c.op === "circle");

const PLAN = doc({
  nodes: [
    { id: "a", label: "Design", kind: "task", x: 0, y: 0, assignees: ["Ana"], storyPoints: 2, done: true },
    { id: "b", label: "Build", kind: "task", x: 300, y: 0, assignees: ["Ravi", "Ana"], storyPoints: 5 },
    { id: "c", label: "Ship", kind: "task", x: 600, y: 0 },
  ],
  edges: [
    { id: "ab", source: "a", target: "b" },
    { id: "bc", source: "b", target: "c", relation: "dependency" },
  ],
});

describe("task export", () => {
  const { cmds } = emitTemplate(PLAN, registry);

  it("draws a check per task — green on the done one — and the estimates", () => {
    const checks = circles(cmds).filter((c) => c.r === 11);
    expect(checks).toHaveLength(3);
    expect(checks.filter((c) => c.fill === "#16a34a")).toHaveLength(1);
    expect(texts(cmds)).toEqual(expect.arrayContaining(["TASK · 2 PTS", "TASK · 5 PTS"]));
  });

  it("strikes the check of the task waiting on open work, and only that one", () => {
    // Build's prerequisite is done; Ship waits on Build through a dependency.
    const slashes = cmds.filter((c) => c.op === "path" && c.strokeWidth === 1.75 && /^M [\d.-]+ [\d.-]+ L [\d.-]+ [\d.-]+$/.test(c.d));
    expect(slashes).toHaveLength(1);
    const ship = circles(cmds).filter((c) => c.r === 11)[2]!;
    expect(slashes[0]!.op === "path" && slashes[0]!.d.startsWith(`M ${ship.cx - 7} `)).toBe(true);
    // No Ready or Blocked label on any card.
    expect(texts(cmds).filter((t) => t === "BLOCKED" || t === "READY")).toHaveLength(0);
  });

  it("hangs the assignee tabs and lists everyone under People", () => {
    const all = texts(cmds);
    expect(all.filter((t) => t === "Ana")).toHaveLength(3); // two tabs + the legend row
    expect(all.filter((t) => t === "Ravi")).toHaveLength(2);
    expect(all).toContain("PEOPLE");
  });

  it("strikes a done task's summary through", () => {
    const title = cmds.find((c): c is TextCmd => c.op === "text" && c.text === "Design")!;
    const strike = cmds.find(
      (c) => c.op === "path" && !c.fill && c.stroke && /^M [\d.-]+ [\d.-]+ L [\d.-]+ [\d.-]+$/.test(c.d) && Math.abs(Number(c.d.split(" ")[2]) - (title.y - 4.5)) < 0.01,
    );
    expect(strike).toBeTruthy();
  });
});

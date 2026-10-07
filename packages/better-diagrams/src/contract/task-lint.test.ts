/**
 * The plan checks: deadlocks, overdue work, dates that contradict their
 * prerequisites, unassigned and unestimated work, and capacity.
 */
import { describe, expect, it } from "vitest";
import { lintTemplate } from "./lint";
import { taskLintRules } from "./task-lint";
import { validateTemplate } from "./schema";

const rules = taskLintRules({ today: "2026-06-01" });
const run = (raw: Record<string, unknown>) => lintTemplate(validateTemplate({ version: 1, edges: [], ...raw }), rules);
const byRule = (findings: ReturnType<typeof run>, rule: string) => findings.filter((f) => f.rule === rule);
const task = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id.toUpperCase(), kind: "task", x: 0, y: 0, ...extra });

describe("plan checks", () => {
  it("say nothing about a document without tasks", () => {
    expect(run({ nodes: [{ id: "s", label: "S", kind: "service", x: 0, y: 0 }] })).toEqual([]);
  });

  it("flag a deadlock as an error", () => {
    const f = run({ nodes: [task("a"), task("b")], edges: [{ id: "1", source: "a", target: "b" }, { id: "2", source: "b", target: "a" }] });
    expect(byRule(f, "task-deadlock")).toMatchObject([{ severity: "error", nodeIds: ["a", "b"] }]);
  });

  it("flag overdue work and a due date earlier than a prerequisite's", () => {
    const f = run({
      nodes: [task("late", { date: "2026-05-01" }), task("api", { date: "2026-07-01" }), task("ui", { date: "2026-06-15" })],
      edges: [{ id: "1", source: "api", target: "ui" }],
    });
    expect(byRule(f, "task-overdue").map((x) => x.nodeIds)).toEqual([["late"]]);
    expect(byRule(f, "task-due-before-prereq")).toMatchObject([{ nodeIds: ["ui", "api"] }]);
  });

  it("check assignment and estimates only once the plan uses them", () => {
    expect(byRule(run({ nodes: [task("a"), task("b")] }), "task-unassigned")).toEqual([]);
    const f = run({ nodes: [task("a", { assignees: ["Ana"], storyPoints: 3 }), task("b"), task("c", { done: true })] });
    expect(byRule(f, "task-unassigned").map((x) => x.nodeIds)).toEqual([["b"]]);
    expect(byRule(f, "task-unestimated").map((x) => x.nodeIds)).toEqual([["b"]]);
  });

  it("flag a person and a sprint over capacity", () => {
    const f = run({
      settings: { capacity: { Ana: 5 } },
      nodes: [
        { id: "s1", label: "Sprint 1", kind: "group", x: 0, y: 0, w: 600, h: 300, capacity: 6 },
        task("a", { parentId: "s1", assignees: ["Ana"], storyPoints: 4 }),
        task("b", { parentId: "s1", assignees: ["Ana"], storyPoints: 3 }),
      ],
    });
    expect(byRule(f, "person-over-capacity")).toMatchObject([{ message: "Ana holds 7 open pts against a capacity of 5", nodeIds: ["a", "b"] }]);
    expect(byRule(f, "sprint-over-capacity")).toMatchObject([{ nodeIds: ["s1"] }]);
  });
});

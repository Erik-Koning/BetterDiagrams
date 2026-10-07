/** The plan as a status report and as a spreadsheet. */
import { describe, expect, it } from "vitest";
import { taskReportMarkdown, tasksCsv } from "./task-report";
import { validateTemplate } from "./schema";

const PLAN = validateTemplate({
  version: 1,
  meta: { title: "Launch" },
  settings: { capacity: { Ana: 4 } },
  nodes: [
    { id: "s1", label: "Sprint 1", kind: "group", x: 0, y: 0, w: 900, h: 400 },
    { id: "spec", label: "Spec", kind: "task", parentId: "s1", x: 0, y: 0, storyPoints: 2, assignees: ["Ana"], done: true },
    { id: "api", label: "API", kind: "task", parentId: "s1", x: 0, y: 0, storyPoints: 5, assignees: ["Ana"], stage: "in-progress", priority: "p1" },
    { id: "ui", label: "UI", kind: "task", x: 0, y: 0, storyPoints: 3, assignees: ["Ravi"], date: "2026-01-01" },
    { id: "qa", label: "QA", kind: "task", x: 0, y: 0, storyPoints: 1 },
    { id: "ship", label: "Ship", kind: "milestone", x: 0, y: 0, date: "2026-12-01" },
  ],
  edges: [
    { id: "a-q", source: "api", target: "qa" },
    { id: "q-s", source: "qa", target: "ship" },
  ],
});

describe("taskReportMarkdown", () => {
  const md = taskReportMarkdown(PLAN, { today: "2026-06-01" });

  it("leads with progress, then what needs attention", () => {
    expect(md).toContain("**Progress:** 2/11 pts (18%) · 1 of 4 tasks done");
    expect(md).toContain("**Overdue:** UI — was due 2026-01-01");
    expect(md).toContain("**Blocked:** QA — waiting on API");
    expect(md).toContain("**Over capacity:** Ana holds 5 open pts against 4");
  });

  it("lists what's in progress, what's ready, milestones and people", () => {
    expect(md).toMatch(/## In progress\n\n- \*\*API\*\* — P1 · 5 pts · Ana · in progress/);
    expect(md).toMatch(/## Ready to pick up\n\n- \*\*UI\*\*/);
    expect(md).toContain("- **Ship** — 2026-12-01 — not yet reached");
    expect(md).toContain("| Ana | 1 | 5 | 4 ⚠ |");
    expect(md).toContain("## Done (1)");
  });
});

describe("tasksCsv", () => {
  it("is every task, one row each, with its status and what blocks it", () => {
    const rows = tasksCsv(PLAN, { today: "2026-06-01" }).trim().split("\r\n");
    expect(rows[0]).toBe("id,title,status,priority,points,assignees,due,phase,blocked by,ready,overdue,description");
    expect(rows).toHaveLength(5);
    expect(rows.find((r) => r.startsWith("api,"))).toBe("api,API,In progress,P1,5,Ana,,Sprint 1,,,,");
    expect(rows.find((r) => r.startsWith("qa,"))).toBe("qa,QA,To do,,1,,,,API,,,");
    expect(rows.find((r) => r.startsWith("ui,"))).toBe("ui,UI,To do,,3,Ravi,2026-01-01,,,yes,yes,");
  });
});

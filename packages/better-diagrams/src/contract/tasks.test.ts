import { describe, expect, it } from "vitest";
import { blockedTasks, isTaskLink, taskAssignees, type TaskDocument } from "./tasks";

const task = (id: string, extra: Partial<TaskDocument["nodes"][number]> = {}) => ({ id, kind: "task", label: id.toUpperCase(), ...extra });
const link = (source: string, target: string, extra: Partial<TaskDocument["edges"][number]> = {}) => ({ source, target, ...extra });

describe("blockedTasks", () => {
  it("blocks a task on an open prerequisite and on an open dependency alike", () => {
    const doc: TaskDocument = {
      nodes: [task("a"), task("b"), task("c")],
      edges: [link("a", "c"), link("b", "c", { relation: "dependency" })],
    };
    expect(blockedTasks(doc)).toEqual(new Map([["c", ["a", "b"]]]));
  });

  it("unblocks once the task waited on is done, and never blocks a done task", () => {
    const doc: TaskDocument = {
      nodes: [task("a", { done: true }), task("b"), task("c", { done: true })],
      edges: [link("a", "b"), link("b", "c")],
    };
    expect(blockedTasks(doc).size).toBe(0);
  });

  it("reads only one-way, ordinary or dependency lines between two tasks", () => {
    const doc: TaskDocument = {
      nodes: [task("a"), task("b"), { id: "svc", kind: "service" }],
      edges: [
        link("a", "b", { direction: "both" }),
        link("a", "b", { direction: "none" }),
        link("a", "b", { relation: "composition" }),
        link("svc", "b"),
        link("b", "b"),
      ],
    };
    expect(blockedTasks(doc).size).toBe(0);
  });

  it("names each blocker once however many lines join them", () => {
    const doc: TaskDocument = {
      nodes: [task("a"), task("b")],
      edges: [link("a", "b"), link("a", "b", { relation: "dependency" })],
    };
    expect(blockedTasks(doc).get("b")).toEqual(["a"]);
  });

  it("marks both ends of a deadlock blocked", () => {
    const doc: TaskDocument = { nodes: [task("a"), task("b")], edges: [link("a", "b"), link("b", "a")] };
    expect(blockedTasks(doc)).toEqual(new Map([["b", ["a"]], ["a", ["b"]]]));
  });
});

describe("isTaskLink", () => {
  it("is an ordinary forward line or a dependency", () => {
    expect(isTaskLink(link("a", "b"))).toBe(true);
    expect(isTaskLink(link("a", "b", { direction: "forward", relation: "dependency" }))).toBe(true);
    expect(isTaskLink(link("a", "b", { relation: "reference" }))).toBe(false);
    expect(isTaskLink(link("a", "b", { direction: "both" }))).toBe(false);
  });
});

describe("taskAssignees", () => {
  it("counts each person's tasks and finished tasks, sorted by name, tasks only", () => {
    const doc = {
      nodes: [
        task("a", { assignees: ["Ravi", "Ana"] }),
        task("b", { assignees: ["Ana"], done: true }),
        { id: "svc", kind: "service", assignees: ["Zed"] },
      ],
    };
    expect(taskAssignees(doc)).toEqual([
      { name: "Ana", tasks: 2, done: 1 },
      { name: "Ravi", tasks: 1, done: 0 },
    ]);
  });
});

import {
  criticalPath,
  overdueWork,
  planProgress,
  readyTasks,
  rollupLabel,
  taskDeadlocks,
  taskRollups,
  taskWorkload,
  workDone,
} from "./tasks";

const ms = (id: string, extra: Partial<TaskDocument["nodes"][number]> = {}) => ({ id, kind: "milestone", label: id, ...extra });

describe("milestones", () => {
  it("are reached when everything feeding them is done, and block what waits on them until then", () => {
    const open: TaskDocument = {
      nodes: [task("a", { done: true }), task("b"), ms("m"), task("after")],
      edges: [link("a", "m"), link("b", "m"), link("m", "after")],
    };
    expect(workDone(open).get("m")).toBe(false);
    expect(blockedTasks(open).get("after")).toEqual(["m"]);
    const finished: TaskDocument = { ...open, nodes: [task("a", { done: true }), task("b", { done: true }), ms("m"), task("after")] };
    expect(workDone(finished).get("m")).toBe(true);
    expect(blockedTasks(finished).has("after")).toBe(false);
  });

  it("with nothing feeding them are not reached", () => {
    expect(workDone({ nodes: [ms("m")], edges: [] }).get("m")).toBe(false);
  });
});

describe("readyTasks", () => {
  it("are open, not started and waiting on nothing", () => {
    const doc: TaskDocument = {
      nodes: [task("a"), task("b"), task("c", { stage: "in-progress" }), task("d", { done: true })],
      edges: [link("a", "b")],
    };
    expect([...readyTasks(doc)]).toEqual(["a"]);
  });
});

describe("overdueWork", () => {
  it("is open work past its date, and a milestone not reached by its date", () => {
    const doc: TaskDocument = {
      nodes: [
        task("late", { date: "2026-01-01" }),
        task("closed", { date: "2026-01-01", done: true }),
        task("soon", { date: "2027-01-01" }),
        ms("m", { date: "2026-01-01" }),
      ],
      edges: [link("late", "m")],
    };
    expect([...overdueWork(doc, "2026-06-01")].sort()).toEqual(["late", "m"]);
  });
});

describe("taskWorkload", () => {
  it("weighs each person's open points against their capacity", () => {
    const doc: TaskDocument = {
      nodes: [
        task("a", { assignees: ["Ana"], storyPoints: 5 }),
        task("b", { assignees: ["Ana", "Ravi"], storyPoints: 8 }),
        task("c", { assignees: ["Ana"], storyPoints: 3, done: true }),
      ],
      edges: [],
      settings: { capacity: { Ana: 10 } },
    };
    expect(taskWorkload(doc)).toEqual([
      { name: "Ana", openTasks: 2, openPoints: 13, points: 16, capacity: 10, over: true },
      { name: "Ravi", openTasks: 1, openPoints: 8, points: 8, over: false },
    ]);
  });
});

describe("roll-ups", () => {
  const doc: TaskDocument = {
    nodes: [
      { id: "sprint", kind: "group", capacity: 10 },
      { id: "inner", kind: "group", parentId: "sprint" },
      task("a", { parentId: "sprint", storyPoints: 5, done: true }),
      task("b", { parentId: "inner", storyPoints: 8 }),
      task("loose", { storyPoints: 2 }),
    ],
    edges: [],
  };

  it("count the tasks under each container at any depth, against its capacity", () => {
    const rollups = taskRollups(doc);
    expect(rollups.get("sprint")).toMatchObject({ tasks: 2, done: 1, points: 13, donePoints: 5, capacity: 10, over: true });
    expect(rollups.get("inner")).toMatchObject({ tasks: 1, points: 8, over: false });
    expect(rollupLabel(rollups.get("sprint")!)).toBe("5/13 pts");
  });

  it("add up to the plan, by tasks when nothing is estimated", () => {
    expect(planProgress(doc)).toMatchObject({ tasks: 3, done: 1, points: 15, donePoints: 5 });
    expect(rollupLabel(planProgress({ nodes: [task("x"), task("y", { done: true })], edges: [] }))).toBe("1/2 tasks");
  });
});

describe("criticalPath", () => {
  it("is the chain with the most work left, skipping done work at its head", () => {
    const doc: TaskDocument = {
      nodes: [
        task("spec", { done: true, storyPoints: 3 }),
        task("api", { storyPoints: 8 }),
        task("ui", { storyPoints: 3 }),
        task("qa", { storyPoints: 2 }),
        ms("launch"),
      ],
      edges: [
        { id: "s-api", source: "spec", target: "api" },
        { id: "s-ui", source: "spec", target: "ui" },
        { id: "api-qa", source: "api", target: "qa" },
        { id: "ui-qa", source: "ui", target: "qa" },
        { id: "qa-l", source: "qa", target: "launch" },
      ],
    };
    expect(criticalPath(doc)).toEqual({ nodes: ["api", "qa", "launch"], edges: ["api-qa", "qa-l"], weight: 10 });
  });

  it("is null when nothing is left to do", () => {
    expect(criticalPath({ nodes: [task("a", { done: true })], edges: [] })).toBeNull();
  });
});

describe("taskDeadlocks", () => {
  it("finds work waiting on itself in a loop", () => {
    const doc: TaskDocument = {
      nodes: [task("a"), task("b"), task("c"), task("free")],
      edges: [link("a", "b"), link("b", "c"), link("c", "a"), link("free", "a")],
    };
    expect(taskDeadlocks(doc)).toEqual([["a", "b", "c"]]);
  });
});

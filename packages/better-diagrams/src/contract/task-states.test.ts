/**
 * The states a task can be in: the default pair, a document's own list, one
 * task's own, and how each is stored in `done` and `stage`.
 */
import { describe, expect, it } from "vitest";
import { validateTemplate, type DiagramTemplate } from "./schema";
import { validateTemplateReport } from "./validation-report";
import { blockedTasks, planProgress, readyTasks, workDone } from "./tasks";
import { diagramJsonSchema } from "./json-schema";
import {
  DEFAULT_TASK_STATES,
  MAX_TASK_STATES,
  isDoneState,
  normalizeTaskStates,
  setTaskState,
  setTaskStates,
  taskState,
  taskStateChanges,
  taskStateLabel,
  taskStatesOf,
} from "./task-states";

const doc = (partial: Record<string, unknown>): DiagramTemplate =>
  validateTemplate({ version: 1, nodes: [], edges: [], ...partial });
const nodeOf = (d: DiagramTemplate, id: string) => d.nodes.find((n) => n.id === id)!;

const FLOW = ["todo", "doing", "review", "shipped"];

/** a → b → m, where m is a milestone; c names states of its own. */
const plan = (settings?: Record<string, unknown>) =>
  doc({
    nodes: [
      { id: "a", label: "A", kind: "task" },
      { id: "b", label: "B", kind: "task" },
      { id: "c", label: "C", kind: "task", states: ["open", "closed"] },
      { id: "m", label: "M", kind: "milestone" },
      { id: "svc", label: "Service", kind: "service" },
    ],
    edges: [
      { id: "ab", source: "a", target: "b" },
      { id: "bm", source: "b", target: "m" },
    ],
    ...(settings ? { settings } : {}),
  });

describe("the default states", () => {
  it("are notDone and done, as strings", () => {
    expect(DEFAULT_TASK_STATES).toEqual(["notDone", "done"]);
    const d = plan();
    expect(taskStatesOf(d, "a")).toEqual(["notDone", "done"]);
    expect(taskState(d, "a")).toBe("notDone");
    expect(taskState(setTaskState(d, "a", "done"), "a")).toBe("done");
  });

  it("store done as the check a task always had, and notDone as nothing", () => {
    const d = setTaskState(plan(), "a", "done");
    expect(nodeOf(d, "a")).toMatchObject({ done: true });
    const back = setTaskState(d, "a", "notDone");
    expect(nodeOf(back, "a")).not.toHaveProperty("done");
    expect(nodeOf(back, "a")).not.toHaveProperty("stage");
  });

  it("leave a document that names none byte-identical through validation", () => {
    const d = plan();
    expect(d.settings).toBeUndefined();
    expect(nodeOf(d, "a")).not.toHaveProperty("states");
    expect(JSON.stringify(validateTemplate(d))).toBe(JSON.stringify(d));
  });

  it("drop a list that only restates the default", () => {
    const d = doc({
      nodes: [{ id: "a", label: "A", kind: "task", states: ["notDone", "done"] }],
      settings: { taskStates: ["notDone", "done"] },
    });
    expect(d.settings).toBeUndefined();
    expect(nodeOf(d, "a")).not.toHaveProperty("states");
  });

  it("keep the built-in stages as detail on an open task, which reads as notDone", () => {
    const d = doc({ nodes: [{ id: "a", label: "A", kind: "task", stage: "in-review" }] });
    expect(nodeOf(d, "a").stage).toBe("in-review");
    expect(taskState(d, "a")).toBe("notDone");
  });

  it("have no state for anything that isn't a task", () => {
    const d = plan();
    expect(taskState(d, "m")).toBeUndefined();
    expect(taskState(d, "svc")).toBeUndefined();
    expect(taskState(d, "nope")).toBeUndefined();
  });
});

describe("a document's own states", () => {
  it("are kept in settings.taskStates and read by every task without its own", () => {
    const d = plan({ taskStates: FLOW });
    expect(d.settings?.taskStates).toEqual(FLOW);
    expect(taskStatesOf(d, "a")).toEqual(FLOW);
    expect(taskStatesOf(d, "c")).toEqual(["open", "closed"]);
    expect(taskState(d, "a")).toBe("todo");
    expect(taskState(d, "c")).toBe("open");
  });

  it("store a state between the first and last as the stage, and the last as done", () => {
    let d = setTaskState(plan({ taskStates: FLOW }), "a", "review");
    expect(nodeOf(d, "a")).toMatchObject({ stage: "review" });
    expect(nodeOf(d, "a")).not.toHaveProperty("done");
    expect(taskState(d, "a")).toBe("review");
    expect(taskState(validateTemplate(d), "a")).toBe("review");

    d = setTaskState(d, "a", "shipped");
    expect(nodeOf(d, "a")).toMatchObject({ done: true });
    expect(nodeOf(d, "a")).not.toHaveProperty("stage");
    expect(isDoneState(d, "a", "shipped")).toBe(true);
    expect(isDoneState(d, "a", "review")).toBe(false);

    d = setTaskState(d, "a", "todo");
    expect(nodeOf(d, "a")).not.toHaveProperty("done");
    expect(nodeOf(d, "a")).not.toHaveProperty("stage");
  });

  it("count only the last state as done, so blocking and milestones read as before", () => {
    let d = setTaskState(plan({ taskStates: FLOW }), "a", "review");
    expect(blockedTasks(d).get("b")).toEqual(["a"]);
    expect(readyTasks(d).has("a")).toBe(false); // started
    expect(planProgress(d).done).toBe(0);

    d = setTaskState(setTaskState(d, "a", "shipped"), "b", "shipped");
    expect(blockedTasks(d).size).toBe(0);
    expect(workDone(d).get("m")).toBe(true);
    expect(planProgress(d).done).toBe(2);
  });

  it("read a stage that names the last state as done, and drop one the list doesn't name", () => {
    const d = doc({
      nodes: [
        { id: "a", label: "A", kind: "task", stage: "shipped" },
        { id: "b", label: "B", kind: "task", stage: "in-progress" },
        { id: "c", label: "C", kind: "task", stage: "todo" },
      ],
      settings: { taskStates: FLOW },
    });
    expect(nodeOf(d, "a")).toMatchObject({ done: true });
    expect(nodeOf(d, "a")).not.toHaveProperty("stage");
    expect(nodeOf(d, "b")).not.toHaveProperty("stage");
    expect(nodeOf(d, "c")).not.toHaveProperty("stage");
  });

  it("say so in the validation report when a stage isn't one of the task's states", () => {
    const report = validateTemplateReport({
      version: 1,
      nodes: [{ id: "a", label: "A", kind: "task", stage: "reviw" }],
      edges: [],
      settings: { taskStates: FLOW },
    });
    expect(report.issues).toEqual([
      expect.objectContaining({ code: "unknown-value", path: "/nodes/0/stage", message: expect.stringContaining("doing, review") }),
    ]);
    const fine = validateTemplateReport({
      version: 1,
      nodes: [{ id: "a", label: "A", kind: "task", stage: "review" }],
      edges: [],
      settings: { taskStates: FLOW },
    });
    expect(fine.issues).toEqual([]);
  });

  it("are trimmed, deduplicated and capped, and need two to be a list", () => {
    expect(normalizeTaskStates([" todo ", "todo", "", 3, "done"])).toEqual(["todo", "done"]);
    expect(normalizeTaskStates(["only"])).toBeUndefined();
    expect(normalizeTaskStates("todo,done")).toBeUndefined();
    expect(normalizeTaskStates(Array.from({ length: 30 }, (_, i) => `s${i}`))).toHaveLength(MAX_TASK_STATES);
    expect(doc({ settings: { taskStates: ["only"] } }).settings).toBeUndefined();
  });
});

describe("one task's own states", () => {
  it("win over the document's, and are stored only where they differ", () => {
    const d = doc({
      nodes: [
        { id: "a", label: "A", kind: "task", states: FLOW },
        { id: "b", label: "B", kind: "task", states: ["open", "closed"], done: true },
      ],
      settings: { taskStates: FLOW },
    });
    expect(nodeOf(d, "a")).not.toHaveProperty("states");
    expect(nodeOf(d, "b").states).toEqual(["open", "closed"]);
    expect(taskState(d, "b")).toBe("closed");
  });

  it("can be set and taken away, keeping each task's place where the new list names it", () => {
    let d = setTaskState(plan({ taskStates: FLOW }), "a", "review");
    d = setTaskStates(d, ["todo", "review", "live"], "a");
    expect(nodeOf(d, "a").states).toEqual(["todo", "review", "live"]);
    expect(taskState(d, "a")).toBe("review");

    d = setTaskStates(d, ["new", "live"], "a");
    expect(taskState(d, "a")).toBe("new"); // "review" is gone: it starts over

    d = setTaskStates(setTaskState(d, "a", "live"), null, "a");
    expect(nodeOf(d, "a")).not.toHaveProperty("states");
    expect(taskState(d, "a")).toBe("shipped"); // finished stays finished
  });

  it("change for the whole document, leaving a task with its own list alone", () => {
    let d = setTaskState(plan(), "a", "done");
    d = setTaskStates(d, FLOW);
    expect(d.settings?.taskStates).toEqual(FLOW);
    expect(taskState(d, "a")).toBe("shipped");
    expect(taskState(d, "b")).toBe("todo");
    expect(taskState(d, "c")).toBe("open");

    d = setTaskStates(setTaskState(d, "b", "doing"), null);
    expect(d.settings).toBeUndefined();
    expect(taskState(d, "b")).toBe("notDone");
    expect(nodeOf(d, "b")).not.toHaveProperty("stage");
    expect(validateTemplate(d)).toEqual(d);
  });
});

describe("setTaskState", () => {
  it("throws on a typo instead of reading it as not done", () => {
    const d = plan({ taskStates: FLOW });
    expect(() => setTaskState(d, "a", "reviw")).toThrow(/isn't a state of task "a" \(todo, doing, review, shipped\)/);
    expect(() => setTaskState(d, "nope", "todo")).toThrow(/No node "nope"/);
    expect(() => setTaskState(d, "m", "todo")).toThrow(/not a task/);
    expect(() => setTaskStates(d, ["one"])).toThrow(/at least two states/);
  });

  it("returns the same document when the task is already there", () => {
    const d = plan();
    expect(setTaskState(d, "a", "notDone")).toBe(d);
  });
});

describe("taskStateChanges", () => {
  it("lists each task in another state, and not one added or removed", () => {
    const before = plan({ taskStates: FLOW });
    let after = setTaskState(setTaskState(before, "a", "doing"), "c", "closed");
    after = { ...after, nodes: [...after.nodes.filter((n) => n.id !== "b"), { ...nodeOf(after, "b"), id: "fresh", done: true }] };
    expect(taskStateChanges(before, after)).toEqual([
      { nodeId: "a", state: "doing", previous: "todo", done: false },
      { nodeId: "c", state: "closed", previous: "open", done: true },
    ]);
    expect(taskStateChanges(before, before)).toEqual([]);
  });
});

describe("taskStateLabel", () => {
  it("reads a state's name as words", () => {
    expect(taskStateLabel("notDone")).toBe("Not done");
    expect(taskStateLabel("in-review")).toBe("In review");
    expect(taskStateLabel("ready_for_QA")).toBe("Ready for QA");
    expect(taskStateLabel("QA")).toBe("QA");
    expect(taskStateLabel("shipped")).toBe("Shipped");
  });
});

describe("the JSON Schema", () => {
  it("describes states on a node and taskStates in settings", () => {
    const text = JSON.stringify(diagramJsonSchema());
    expect(text).toContain('"taskStates"');
    expect(text).toContain('"states"');
  });
});

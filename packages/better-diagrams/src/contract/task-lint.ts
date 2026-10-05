/**
 * task-lint.ts — the plan checks: what a lead would catch in review.
 *
 * Rules over the task graph (tasks.ts), joining the architecture and
 * data-model rules in the Checks menu. They say nothing about a document
 * without tasks. Two are deliberately conditional — a sketch of a plan with
 * no estimates anywhere is not missing an estimate on every card, so
 * "unestimated" only speaks once the plan estimates something, and
 * "unassigned" once it assigns someone.
 */
import type { DiagramTemplate } from "./schema";
import type { LintIssue, LintRuleDef } from "./lint";
import { lintIgnored } from "./lint-ignore";
import { TASK_KIND, isWorkItem, overdueWork, prerequisites, taskDeadlocks, taskRollups, taskWorkload, workDone } from "./tasks";

export interface TaskLintOptions {
  /** Today as `YYYY-MM-DD` — for tests; absent, the local date. */
  today?: string;
}

export function taskLintRules(opts: TaskLintOptions = {}): Record<string, LintRuleDef> {
  const labelOf = (t: DiagramTemplate) => {
    const byId = new Map(t.nodes.map((n) => [n.id, n]));
    return (id: string) => byId.get(id)?.label ?? id;
  };
  const openTasks = (t: DiagramTemplate) => t.nodes.filter((n) => n.kind === TASK_KIND && !n.done);

  return {
    "task-deadlock": {
      label: "Deadlocked tasks",
      description: "Tasks that wait on each other in a loop: none of them can ever start.",
      severity: "error",
      check(t) {
        const name = labelOf(t);
        const byId = new Map(t.nodes.map((n) => [n.id, n]));
        return taskDeadlocks(t)
          .filter((loop) => !loop.some((id) => byId.get(id) && lintIgnored(byId.get(id)!, "task-deadlock")))
          .map((loop) => ({
            message: `${[...loop, loop[0]!].map(name).join(" → ")} wait on each other — none can start`,
            nodeIds: loop,
          }));
      },
    },

    "task-overdue": {
      label: "Overdue",
      description: "Open work past its due date, or a milestone not reached by its date.",
      severity: "warning",
      check(t) {
        const late = overdueWork(t, opts.today);
        return t.nodes
          .filter((n) => late.has(n.id) && !lintIgnored(n, "task-overdue"))
          .map((n) => ({
            message: n.kind === TASK_KIND ? `"${n.label}" was due ${n.date}` : `Milestone "${n.label}" was due ${n.date} and isn't reached`,
            nodeIds: [n.id],
          }));
      },
    },

    "task-due-before-prereq": {
      label: "Due before what it waits on",
      description: "A task due earlier than work it can't start without — one of the two dates is wrong.",
      severity: "warning",
      check(t) {
        const byId = new Map(t.nodes.map((n) => [n.id, n]));
        const done = workDone(t);
        const issues: LintIssue[] = [];
        for (const [id, feeding] of prerequisites(t)) {
          const n = byId.get(id);
          if (!n?.date || done.get(id) || lintIgnored(n, "task-due-before-prereq")) continue;
          for (const p of feeding) {
            const pre = byId.get(p);
            if (pre?.date && pre.date > n.date && !done.get(p)) {
              issues.push({
                message: `"${n.label}" is due ${n.date} but waits on "${pre.label}", due ${pre.date}`,
                nodeIds: [id, p],
              });
            }
          }
        }
        return issues;
      },
    },

    "task-unassigned": {
      label: "Unassigned task",
      description: "Open work nobody holds. Checked once the plan assigns anyone.",
      severity: "info",
      check(t) {
        if (!t.nodes.some((n) => n.kind === TASK_KIND && n.assignees?.length)) return [];
        return openTasks(t)
          .filter((n) => !n.assignees?.length && !lintIgnored(n, "task-unassigned"))
          .map((n) => ({ message: `"${n.label}" has no one assigned`, nodeIds: [n.id] }));
      },
    },

    "task-unestimated": {
      label: "Unestimated task",
      description: "Open work with no story points. Checked once the plan estimates anything.",
      severity: "info",
      check(t) {
        if (!t.nodes.some((n) => n.kind === TASK_KIND && n.storyPoints !== undefined)) return [];
        return openTasks(t)
          .filter((n) => n.storyPoints === undefined && !lintIgnored(n, "task-unestimated"))
          .map((n) => ({ message: `"${n.label}" has no estimate`, nodeIds: [n.id] }));
      },
    },

    "person-over-capacity": {
      label: "Over capacity",
      description: "Someone holding more open points than their capacity (View → Team capacity).",
      severity: "warning",
      check(t) {
        // Ignore tags the person's first open task, so any of their tasks
        // carrying it silences the finding.
        return taskWorkload(t)
          .filter((w) => w.over)
          .map((w) => ({ w, theirs: openTasks(t).filter((n) => n.assignees?.includes(w.name)) }))
          .filter(({ theirs }) => !theirs.some((n) => lintIgnored(n, "person-over-capacity")))
          .map(({ w, theirs }) => ({
            message: `${w.name} holds ${w.openPoints} open pts against a capacity of ${w.capacity}`,
            nodeIds: theirs.map((n) => n.id),
          }));
      },
    },

    "sprint-over-capacity": {
      label: "Phase over capacity",
      description: "A sprint or phase holding more points than the capacity set on it.",
      severity: "warning",
      check(t) {
        const name = labelOf(t);
        const byId = new Map(t.nodes.map((n) => [n.id, n]));
        return [...taskRollups(t)]
          .filter(([id, r]) => r.over && !(byId.get(id) && lintIgnored(byId.get(id)!, "sprint-over-capacity")))
          .map(([id, r]) => ({ message: `"${name(id)}" holds ${r.points} pts against a capacity of ${r.capacity}`, nodeIds: [id] }));
      },
    },
  };
}

/** Whether a document has a plan for these rules to read. */
export function hasWork(t: Pick<DiagramTemplate, "nodes">): boolean {
  return t.nodes.some(isWorkItem);
}

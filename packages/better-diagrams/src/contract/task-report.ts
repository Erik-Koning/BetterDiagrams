/**
 * task-report.ts — a plan as a status report and as a spreadsheet.
 *
 * The Markdown report answers what a lead is asked every week: how far
 * along is it, what's late, what's stuck, what can someone pick up, who is
 * holding what. The CSV is every task, one row each, for a spreadsheet or
 * another tracker. Both read the same queries the editor draws from
 * (tasks.ts), so the report and the canvas never disagree.
 */
import type { DiagramTemplate } from "./schema";
import { csvText } from "./csv";
import {
  MILESTONE_KIND,
  TASK_KIND,
  blockedTasks,
  overdueWork,
  planProgress,
  readyTasks,
  rollupFraction,
  rollupLabel,
  taskRollups,
  taskWorkload,
  todayIso,
  workDone,
} from "./tasks";

const STAGE_TEXT: Record<string, string> = { "in-progress": "In progress", "in-review": "In review" };

/** A task's status in words: Done, In progress, In review, or To do. */
function statusOf(n: { done?: boolean; stage?: string }): string {
  return n.done ? "Done" : (STAGE_TEXT[n.stage ?? ""] ?? "To do");
}

/** The nearest container above a node, by label — its phase or sprint. */
function phaseOf(t: DiagramTemplate, id: string): string {
  const byId = new Map(t.nodes.map((n) => [n.id, n]));
  const parent = byId.get(byId.get(id)?.parentId ?? "");
  return parent?.label ?? "";
}

export interface TaskReportOptions {
  /** The report's heading; the document title by default. */
  title?: string;
  /** Today as `YYYY-MM-DD` — what "overdue" is measured against. */
  today?: string;
}

/** The plan as a Markdown status report. */
export function taskReportMarkdown(t: DiagramTemplate, opts: TaskReportOptions = {}): string {
  const today = opts.today ?? todayIso();
  const tasks = t.nodes.filter((n) => n.kind === TASK_KIND);
  const label = new Map(t.nodes.map((n) => [n.id, n.label]));
  const blocked = blockedTasks(t);
  const ready = readyTasks(t);
  const late = overdueWork(t, today);
  const plan = planProgress(t);
  const md = (s: string) => s.replace(/([\\`*_[\]|])/g, "\\$1");
  const item = (n: (typeof tasks)[number]) => {
    const bits = [
      n.priority ? n.priority.toUpperCase() : "",
      n.storyPoints !== undefined ? `${n.storyPoints} pts` : "",
      n.assignees?.length ? n.assignees.map(md).join(", ") : "unassigned",
      n.date ? `due ${n.date}` : "",
    ].filter(Boolean);
    return `- **${md(n.label)}** — ${bits.join(" · ")}`;
  };

  const out: string[] = [];
  out.push(`# ${md(opts.title ?? String(t.meta?.title ?? "Plan"))} — status report`, "");
  out.push(`_As of ${today}._`, "");
  out.push(
    `**Progress:** ${rollupLabel(plan)} (${Math.round(rollupFraction(plan) * 100)}%) · ${plan.done} of ${plan.tasks} tasks done`,
    "",
  );

  const lateTasks = tasks.filter((n) => late.has(n.id));
  const blockedList = tasks.filter((n) => blocked.has(n.id));
  const overloaded = taskWorkload(t).filter((w) => w.over);
  const overPhases = [...taskRollups(t)].filter(([, r]) => r.over);
  if (lateTasks.length || blockedList.length || overloaded.length || overPhases.length) {
    out.push("## Needs attention", "");
    for (const n of lateTasks) out.push(`- **Overdue:** ${md(n.label)} — was due ${n.date}`);
    for (const n of blockedList) {
      out.push(`- **Blocked:** ${md(n.label)} — waiting on ${blocked.get(n.id)!.map((id) => md(label.get(id) ?? id)).join(", ")}`);
    }
    for (const w of overloaded) out.push(`- **Over capacity:** ${md(w.name)} holds ${w.openPoints} open pts against ${w.capacity}`);
    for (const [id, r] of overPhases) out.push(`- **Over capacity:** ${md(label.get(id) ?? id)} holds ${r.points} pts against ${r.capacity}`);
    out.push("");
  }

  const started = tasks.filter((n) => !n.done && n.stage);
  if (started.length) {
    out.push("## In progress", "");
    for (const n of started) out.push(`${item(n)} · ${statusOf(n).toLowerCase()}`);
    out.push("");
  }
  const readyList = tasks.filter((n) => ready.has(n.id));
  if (readyList.length) {
    out.push("## Ready to pick up", "");
    for (const n of readyList) out.push(item(n));
    out.push("");
  }

  const milestones = t.nodes.filter((n) => n.kind === MILESTONE_KIND);
  if (milestones.length) {
    const reached = workDone(t);
    out.push("## Milestones", "");
    for (const m of milestones) {
      const state = reached.get(m.id) ? "reached" : late.has(m.id) ? "overdue" : "not yet reached";
      out.push(`- **${md(m.label)}**${m.date ? ` — ${m.date}` : ""} — ${state}`);
    }
    out.push("");
  }

  const people = taskWorkload(t);
  if (people.length) {
    out.push("## By person", "");
    out.push("| Person | Open tasks | Open pts | Capacity |", "| --- | ---: | ---: | ---: |");
    for (const w of people) {
      out.push(`| ${md(w.name)} | ${w.openTasks} | ${w.openPoints} | ${w.capacity ?? "—"}${w.over ? " ⚠" : ""} |`);
    }
    out.push("");
  }

  const done = tasks.filter((n) => n.done);
  if (done.length) {
    out.push(`## Done (${done.length})`, "");
    for (const n of done) out.push(`- ${md(n.label)}`);
    out.push("");
  }
  return out.join("\n");
}

/** Every task as a spreadsheet row. */
export function tasksCsv(t: DiagramTemplate, opts: { today?: string } = {}): string {
  const today = opts.today ?? todayIso();
  const label = new Map(t.nodes.map((n) => [n.id, n.label]));
  const blocked = blockedTasks(t);
  const ready = readyTasks(t);
  const late = overdueWork(t, today);
  const header = ["id", "title", "status", "priority", "points", "assignees", "due", "phase", "blocked by", "ready", "overdue", "description"];
  const rows = t.nodes
    .filter((n) => n.kind === TASK_KIND)
    .map((n) => [
      n.id,
      n.label,
      statusOf(n),
      n.priority ? n.priority.toUpperCase() : "",
      n.storyPoints !== undefined ? String(n.storyPoints) : "",
      (n.assignees ?? []).join("; "),
      n.date ?? "",
      phaseOf(t, n.id),
      (blocked.get(n.id) ?? []).map((id) => label.get(id) ?? id).join("; "),
      ready.has(n.id) ? "yes" : "",
      late.has(n.id) ? "yes" : "",
      n.description ?? "",
    ]);
  return csvText(header, rows);
}

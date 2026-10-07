/**
 * tasks.ts — reading a diagram as a work plan.
 *
 * A task graph is an ordinary architecture document: `task` nodes carrying
 * `assignees`, `storyPoints` and `done`, joined by two kinds of line. An
 * ordinary edge A → B says A is a PREREQUISITE of B — the arrow points at
 * the next task, and the line is always drawn. An edge whose relation is
 * `dependency` says the same about work elsewhere in the plan, and the
 * editor keeps it hidden until either end is hovered or selected, so a
 * plan's long-range links don't cross the whole picture.
 *
 * Both kinds block: a task that is not done is blocked while any task it
 * waits on is not done either. Only direct links count — an open task three
 * steps back has already blocked the one in between, which says so itself.
 *
 * Zero dependencies, like every contract module.
 */

/** The node kind a work item is. */
export const TASK_KIND = "task";

/**
 * A checkpoint in a plan. It holds no work of its own: it is REACHED when
 * every task (or milestone) feeding it is done, and a task waiting on it is
 * blocked until then.
 */
export const MILESTONE_KIND = "milestone";

/** A node that takes part in a plan's links: a task or a milestone. */
export function isWorkItem(n: { kind?: string }): boolean {
  return n.kind === TASK_KIND || n.kind === MILESTONE_KIND;
}

/** The relation that marks a long-range, hover-only link between tasks. */
export const DEPENDENCY_RELATION = "dependency";

/**
 * How far a task's assignee tabs hang below its card, in px. The canvas,
 * the image exporter and Tidy's spacing all read this one number, so a row
 * of tasks is never stacked closer than its tabs need.
 */
export const ASSIGNEE_STRIP_HEIGHT = 18;

/** Whether a node draws assignee tabs under its card. */
export function hasAssigneeStrip(n: { kind?: string; assignees?: readonly string[] }): boolean {
  return n.kind === TASK_KIND && !!n.assignees?.length;
}

/** The slice of a document the task queries read — structural, so a view doc serves too. */
export interface TaskDocument {
  nodes: ReadonlyArray<{
    id: string;
    kind?: string;
    label?: string;
    parentId?: string | null;
    assignees?: readonly string[];
    storyPoints?: number;
    done?: boolean;
    stage?: string;
    priority?: string;
    /** A task's due date / a milestone's date, `YYYY-MM-DD`. */
    date?: string;
    /** A container's capacity in story points. */
    capacity?: number;
  }>;
  edges: ReadonlyArray<{
    id?: string;
    source: string;
    target: string;
    relation?: string;
    direction?: string;
  }>;
  settings?: { capacity?: Readonly<Record<string, number>> };
}

/** One person on the plan, as the legend lists them. */
export interface TaskAssignee {
  name: string;
  /** Tasks assigned to them, finished or not. */
  tasks: number;
  /** How many of those are done. */
  done: number;
}

/**
 * Whether an edge says "the target waits on the source": an ordinary
 * (relation-less) line or a dependency, pointing one way. A two-way or
 * plain-association line states no order, so it blocks nothing — the same
 * reading graph search and the cycle check give those directions.
 */
export function isTaskLink(edge: TaskDocument["edges"][number]): boolean {
  if (edge.direction === "both" || edge.direction === "none") return false;
  return !edge.relation || edge.relation === DEPENDENCY_RELATION;
}

/** Each work item's prerequisites — the sources of its task links, each once, in edge order. */
export function prerequisites(doc: TaskDocument): Map<string, string[]> {
  const work = new Set(doc.nodes.filter(isWorkItem).map((n) => n.id));
  const out = new Map<string, string[]>();
  for (const e of doc.edges) {
    if (e.source === e.target || !isTaskLink(e) || !work.has(e.source) || !work.has(e.target)) continue;
    const list = out.get(e.target);
    if (!list) out.set(e.target, [e.source]);
    else if (!list.includes(e.source)) list.push(e.source);
  }
  return out;
}

/**
 * Whether each work item is done: a task by its check, a milestone by
 * whether it is REACHED — it has something feeding it, and all of that is
 * done. A milestone caught in a loop is never reached.
 */
export function workDone(doc: TaskDocument): Map<string, boolean> {
  const byId = new Map(doc.nodes.filter(isWorkItem).map((n) => [n.id, n]));
  const prereqs = prerequisites(doc);
  const out = new Map<string, boolean>();
  const visiting = new Set<string>();
  const doneOf = (id: string): boolean => {
    const known = out.get(id);
    if (known !== undefined) return known;
    const n = byId.get(id);
    if (!n) return false;
    if (n.kind === TASK_KIND) {
      out.set(id, !!n.done);
      return !!n.done;
    }
    if (visiting.has(id)) return false;
    visiting.add(id);
    const feeding = prereqs.get(id) ?? [];
    const reached = feeding.length > 0 && feeding.every(doneOf);
    visiting.delete(id);
    out.set(id, reached);
    return reached;
  };
  for (const id of byId.keys()) doneOf(id);
  return out;
}

/**
 * Every open task that waits on unfinished work, mapped to the ids of what
 * it waits on (each once, in edge order): an open task, or a milestone not
 * yet reached. A done task is never blocked, and done work blocks nothing; a
 * self-loop is ignored. Two open tasks waiting on each other are both
 * blocked — a deadlock, said plainly.
 */
export function blockedTasks(doc: TaskDocument): Map<string, string[]> {
  const done = workDone(doc);
  const blocked = new Map<string, string[]>();
  for (const [id, feeding] of prerequisites(doc)) {
    const n = doc.nodes.find((m) => m.id === id);
    if (n?.kind !== TASK_KIND || done.get(id)) continue;
    const waits = feeding.filter((p) => !done.get(p));
    if (waits.length) blocked.set(id, waits);
  }
  return blocked;
}

/**
 * The tasks someone could pick up now: open, not started (no stage), and
 * waiting on nothing.
 */
export function readyTasks(doc: TaskDocument): Set<string> {
  const blocked = blockedTasks(doc);
  return new Set(
    doc.nodes.filter((n) => n.kind === TASK_KIND && !n.done && !n.stage && !blocked.has(n.id)).map((n) => n.id),
  );
}

/** Today as `YYYY-MM-DD`, in local time — the same "today" the timeline uses. */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Work past its date and not finished: a task due before `today` and not
 * done, a milestone dated before `today` and not reached.
 */
export function overdueWork(doc: TaskDocument, today: string = todayIso()): Set<string> {
  const done = workDone(doc);
  return new Set(doc.nodes.filter((n) => isWorkItem(n) && n.date && n.date < today && !done.get(n.id)).map((n) => n.id));
}

/** What one person holds: open work and its points, against their capacity. */
export interface TaskWorkload {
  name: string;
  openTasks: number;
  openPoints: number;
  /** Story points across all their tasks, done or not. */
  points: number;
  /** From `settings.capacity`; absent means no limit. */
  capacity?: number;
  /** Open points past capacity. */
  over: boolean;
}

/**
 * Everyone's workload, sorted by name. A task's points count in full for
 * every person on it — a pair splits the work, but each of them is still
 * holding it.
 */
export function taskWorkload(doc: TaskDocument): TaskWorkload[] {
  const byName = new Map<string, TaskWorkload>();
  for (const n of doc.nodes) {
    if (n.kind !== TASK_KIND) continue;
    for (const name of n.assignees ?? []) {
      let row = byName.get(name);
      if (!row) {
        const capacity = doc.settings?.capacity?.[name];
        byName.set(name, (row = { name, openTasks: 0, openPoints: 0, points: 0, ...(capacity ? { capacity } : {}), over: false }));
      }
      const points = n.storyPoints ?? 0;
      row.points += points;
      if (!n.done) {
        row.openTasks += 1;
        row.openPoints += points;
      }
    }
  }
  for (const row of byName.values()) row.over = row.capacity !== undefined && row.openPoints > row.capacity;
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** How far a set of tasks has come. */
export interface TaskRollup {
  tasks: number;
  done: number;
  points: number;
  donePoints: number;
  /** A container's capacity, when it has one. */
  capacity?: number;
  /** Points past capacity. */
  over: boolean;
}

const rollupOf = (tasks: TaskDocument["nodes"], capacity?: number): TaskRollup => {
  const r: TaskRollup = { tasks: 0, done: 0, points: 0, donePoints: 0, ...(capacity ? { capacity } : {}), over: false };
  for (const n of tasks) {
    const points = n.storyPoints ?? 0;
    r.tasks += 1;
    r.points += points;
    if (n.done) {
      r.done += 1;
      r.donePoints += points;
    }
  }
  r.over = capacity !== undefined && r.points > capacity;
  return r;
};

/** The whole plan's progress — every task in the document. */
export function planProgress(doc: TaskDocument): TaskRollup {
  return rollupOf(doc.nodes.filter((n) => n.kind === TASK_KIND));
}

/**
 * Every container holding tasks — at any depth — with their progress, and
 * its capacity (a sprint's, a phase's) when it has one.
 */
export function taskRollups(doc: TaskDocument): Map<string, TaskRollup> {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const within = new Map<string, Array<TaskDocument["nodes"][number]>>();
  for (const n of doc.nodes) {
    if (n.kind !== TASK_KIND) continue;
    let cursor = n.parentId ?? null;
    const guard = new Set<string>();
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      if (!within.has(cursor)) within.set(cursor, []);
      within.get(cursor)!.push(n);
      cursor = byId.get(cursor)?.parentId ?? null;
    }
  }
  const out = new Map<string, TaskRollup>();
  for (const [id, tasks] of within) out.set(id, rollupOf(tasks, byId.get(id)?.capacity));
  return out;
}

/** "8/21 pts" when the tasks carry points, else "3/7 tasks" — a roll-up in one line. */
export function rollupLabel(r: TaskRollup): string {
  return r.points > 0 ? `${r.donePoints}/${r.points} pts` : `${r.done}/${r.tasks} tasks`;
}

/** Done as a fraction 0–1, by points when there are any, else by tasks. */
export function rollupFraction(r: TaskRollup): number {
  if (r.points > 0) return r.donePoints / r.points;
  return r.tasks ? r.done / r.tasks : 0;
}

/**
 * The critical path: the chain of prerequisites carrying the most work
 * still to do — what decides when the plan can finish. Each open task
 * weighs its story points (1 without an estimate); done work and milestones
 * weigh nothing, and done work at the head of the chain is left off. Work
 * caught in a loop is skipped (a deadlock is its own problem). Null when
 * nothing is left to do.
 */
export function criticalPath(doc: TaskDocument): { nodes: string[]; edges: string[]; weight: number } | null {
  const work = doc.nodes.filter(isWorkItem);
  const ids = new Set(work.map((n) => n.id));
  const order = new Map(work.map((n, i) => [n.id, i]));
  const done = workDone(doc);
  const weightOf = new Map(
    work.map((n) => [n.id, n.kind === TASK_KIND && !done.get(n.id) ? (n.storyPoints ?? 1) : 0]),
  );
  // Kahn's order over task links; whatever a loop holds never comes out.
  const incoming = new Map<string, Array<{ from: string; edge?: string }>>();
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>([...ids].map((id) => [id, 0]));
  const seen = new Set<string>();
  for (const e of doc.edges) {
    if (e.source === e.target || !isTaskLink(e) || !ids.has(e.source) || !ids.has(e.target)) continue;
    const pair = `${e.source}\u0000${e.target}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target)!.push({ from: e.source, ...(e.id ? { edge: e.id } : {}) });
    if (!outgoing.has(e.source)) outgoing.set(e.source, []);
    outgoing.get(e.source)!.push(e.target);
    indegree.set(e.target, indegree.get(e.target)! + 1);
  }
  const queue = [...ids].filter((id) => indegree.get(id) === 0).sort((a, b) => order.get(a)! - order.get(b)!);
  const best = new Map<string, { weight: number; via?: { from: string; edge?: string } }>();
  /** Processing order — a node always comes after everything it waits on. */
  const step = new Map<string, number>();
  while (queue.length) {
    const id = queue.shift()!;
    step.set(id, step.size);
    let top: { weight: number; via?: { from: string; edge?: string } } = { weight: 0 };
    for (const link of incoming.get(id) ?? []) {
      const prior = best.get(link.from);
      if (prior && prior.weight > top.weight) top = { weight: prior.weight, via: link };
    }
    best.set(id, { weight: top.weight + weightOf.get(id)!, ...(top.via ? { via: top.via } : {}) });
    for (const next of outgoing.get(id) ?? []) {
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  // The heaviest chain's end — on a tie, the later one, so a chain runs on
  // through the milestones (weightless) it leads to.
  let end: string | null = null;
  for (const [id, b] of best) {
    const current = end ? best.get(end)!.weight : 0;
    if (b.weight > current || (end && b.weight === current && step.get(id)! > step.get(end)!)) end = id;
  }
  if (!end || best.get(end)!.weight <= 0) return null;
  const nodes: string[] = [];
  const edges: string[] = [];
  let cursor: string | undefined = end;
  while (cursor) {
    nodes.unshift(cursor);
    const via: { from: string; edge?: string } | undefined = best.get(cursor)!.via;
    if (via?.edge) edges.unshift(via.edge);
    cursor = via?.from;
  }
  // Done work at the head of the chain is history, not path.
  while (nodes.length > 1 && weightOf.get(nodes[0]!) === 0 && done.get(nodes[0]!)) {
    nodes.shift();
    edges.shift();
  }
  return { nodes, edges, weight: best.get(end)!.weight };
}

/**
 * Work that can never start: groups of tasks and milestones that wait on
 * each other in a loop, each group in document order.
 */
export function taskDeadlocks(doc: TaskDocument): string[][] {
  const work = doc.nodes.filter(isWorkItem);
  const ids = new Set(work.map((n) => n.id));
  const order = new Map(work.map((n, i) => [n.id, i]));
  const next = new Map<string, string[]>();
  for (const e of doc.edges) {
    if (e.source === e.target || !isTaskLink(e) || !ids.has(e.source) || !ids.has(e.target)) continue;
    if (!next.has(e.source)) next.set(e.source, []);
    next.get(e.source)!.push(e.target);
  }
  // Tarjan's strongly connected components; a component of two or more is a loop.
  let index = 0;
  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  const visit = (id: string) => {
    indexOf.set(id, index);
    low.set(id, index);
    index += 1;
    stack.push(id);
    onStack.add(id);
    for (const to of next.get(id) ?? []) {
      if (!indexOf.has(to)) {
        visit(to);
        low.set(id, Math.min(low.get(id)!, low.get(to)!));
      } else if (onStack.has(to)) {
        low.set(id, Math.min(low.get(id)!, indexOf.get(to)!));
      }
    }
    if (low.get(id) === indexOf.get(id)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== id);
      if (component.length > 1) out.push(component.sort((a, b) => order.get(a)! - order.get(b)!));
    }
  };
  for (const n of work) if (!indexOf.has(n.id)) visit(n.id);
  return out.sort((a, b) => order.get(a[0]!)! - order.get(b[0]!)!);
}

/**
 * Everyone assigned to a task, with how many tasks each holds and how many
 * of those are done, sorted by name. Assignees on other kinds are ignored:
 * only a task draws them, so only a task's count in the legend.
 */
export function taskAssignees(doc: Pick<TaskDocument, "nodes">): TaskAssignee[] {
  const byName = new Map<string, TaskAssignee>();
  for (const n of doc.nodes) {
    if (n.kind !== TASK_KIND) continue;
    for (const name of n.assignees ?? []) {
      let row = byName.get(name);
      if (!row) byName.set(name, (row = { name, tasks: 0, done: 0 }));
      row.tasks += 1;
      if (n.done) row.done += 1;
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** What moved in a plan between two versions — Compare's task line. */
export interface TaskChanges {
  /** Tasks in the newer version only. */
  added: string[];
  /** Tasks in the older version only. */
  removed: string[];
  /** Tasks done now that weren't then. */
  closed: string[];
  /** Tasks done then that are open again. */
  reopened: string[];
  /** The change in total story points — scope added (positive) or cut. */
  scope: number;
}

/** Compare a plan's older version (`base`) with its newer one (`current`). */
export function taskChanges(base: TaskDocument, current: TaskDocument): TaskChanges {
  const tasksOf = (doc: TaskDocument) => new Map(doc.nodes.filter((n) => n.kind === TASK_KIND).map((n) => [n.id, n]));
  const before = tasksOf(base);
  const after = tasksOf(current);
  const out: TaskChanges = { added: [], removed: [], closed: [], reopened: [], scope: 0 };
  for (const [id, n] of after) {
    const was = before.get(id);
    if (!was) out.added.push(id);
    else if (n.done && !was.done) out.closed.push(id);
    else if (!n.done && was.done) out.reopened.push(id);
  }
  for (const id of before.keys()) if (!after.has(id)) out.removed.push(id);
  out.scope = planProgress(current).points - planProgress(base).points;
  return out;
}

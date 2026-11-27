/**
 * task-states.ts — the states a task can be in.
 *
 * A task moves through an ordered list of states. With nothing said that
 * list is `DEFAULT_TASK_STATES`: "notDone", then "done". A document names its
 * own in `settings.taskStates`, and one task names its own in `states`,
 * which wins over the document's.
 *
 * The FIRST state is where a task starts and the LAST is where it is
 * finished: only a task in its last state counts as done, so blocking,
 * milestones, roll-ups and the critical path read a custom list exactly as
 * they read the default one. That is also how a state is stored, in the two
 * fields a task always had:
 *
 *   first state      nothing stored
 *   a state between  `stage: "<state>"`
 *   last state       `done: true`
 *
 * so a document written before states existed means what it always meant.
 * (With no list of its own, a task's `stage` keeps its built-in
 * "in-progress" / "in-review" vocabulary: detail on an open task, not a
 * state.)
 *
 * Zero dependencies, like every contract module.
 */
import { TASK_KIND } from "./tasks";

/** The states of a task that names none: open, then finished. */
export const DEFAULT_TASK_STATES: readonly string[] = ["notDone", "done"];

/** The most states a list may hold, and the longest a state's name may be. */
export const MAX_TASK_STATES = 12;
export const MAX_TASK_STATE_LENGTH = 40;

/** The slice of a node the state queries read. */
export interface TaskStateNode {
  id: string;
  kind?: string;
  done?: boolean;
  stage?: string;
  states?: readonly string[];
}

/** The slice of a document the state queries read — structural, so any document with tasks serves. */
export interface TaskStateDocument {
  nodes: ReadonlyArray<TaskStateNode>;
  settings?: { taskStates?: readonly string[] };
}

/** One task's move from a state to another, as `taskStateChanges` lists it. */
export interface TaskStateChange {
  nodeId: string;
  /** The state the task is in now. */
  state: string;
  /** The state it was in before. */
  previous: string;
  /** Whether `state` is the task's last: it counts as done. */
  done: boolean;
}

/**
 * A list of states as the document keeps it: names trimmed, blanks and
 * repeats dropped, capped at `MAX_TASK_STATES`. Undefined when fewer than
 * two are left, since a task needs somewhere to start and somewhere to end.
 */
export function normalizeTaskStates(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const name = value.trim().slice(0, MAX_TASK_STATE_LENGTH).trim();
    if (name && !out.includes(name)) out.push(name);
    if (out.length === MAX_TASK_STATES) break;
  }
  return out.length >= 2 ? out : undefined;
}

/** Whether two lists name the same states in the same order. */
export function sameTaskStates(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = a ?? DEFAULT_TASK_STATES;
  const y = b ?? DEFAULT_TASK_STATES;
  return x.length === y.length && x.every((state, i) => state === y[i]);
}

const nodeOf = (doc: TaskStateDocument, node: string | TaskStateNode): TaskStateNode | undefined =>
  typeof node === "string" ? doc.nodes.find((n) => n.id === node) : node;

/**
 * The states a node can be in, in order: its own `states`, else the
 * document's `settings.taskStates`, else `DEFAULT_TASK_STATES`. Pass the
 * node or its id; an id the document doesn't hold reads as the document's.
 */
export function taskStatesOf(doc: TaskStateDocument, node: string | TaskStateNode): string[] {
  const own = nodeOf(doc, node)?.states;
  if (own && own.length >= 2) return [...own];
  const shared = doc.settings?.taskStates;
  return shared && shared.length >= 2 ? [...shared] : [...DEFAULT_TASK_STATES];
}

/** The state a node's stored fields say, within a list of states. */
function stateIn(node: TaskStateNode, states: readonly string[]): string {
  if (node.done) return states[states.length - 1]!;
  const at = node.stage ? states.indexOf(node.stage) : -1;
  return at > 0 && at < states.length - 1 ? states[at]! : states[0]!;
}

/**
 * The state a task is in. Undefined when the document holds no task by that
 * id: a milestone has no state of its own (see `workDone`), nor has any
 * other kind.
 */
export function taskState(doc: TaskStateDocument, nodeId: string): string | undefined {
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node || node.kind !== TASK_KIND) return undefined;
  return stateIn(node, taskStatesOf(doc, node));
}

/** Whether a state is the last a node can be in — the one that counts as done. */
export function isDoneState(doc: TaskStateDocument, node: string | TaskStateNode, state: string): boolean {
  const states = taskStatesOf(doc, node);
  return states[states.length - 1] === state;
}

/** A node with a state written the way the document stores it. */
function withState<N extends TaskStateNode>(node: N, state: string, states: readonly string[]): N {
  const { done: _done, stage: _stage, ...rest } = node;
  const at = states.indexOf(state);
  if (at === states.length - 1) return { ...rest, done: true } as N;
  if (at <= 0) return rest as N;
  return { ...rest, stage: state } as N;
}

/**
 * Move a task to a state. Throws when the document holds no task by that
 * id, or the state isn't one it can be in (`taskStatesOf` lists them) — a
 * typo should fail where it is made, not read as "not done". Returns the
 * same document when the task is already there.
 */
export function setTaskState<T extends TaskStateDocument>(doc: T, nodeId: string, state: string): T {
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`No node "${nodeId}"`);
  if (node.kind !== TASK_KIND) throw new Error(`Node "${nodeId}" is a ${node.kind ?? "node"}, not a task`);
  const states = taskStatesOf(doc, node);
  if (!states.includes(state)) {
    throw new Error(`"${state}" isn't a state of task "${nodeId}" (${states.join(", ")})`);
  }
  if (stateIn(node, states) === state) return doc;
  return { ...doc, nodes: doc.nodes.map((n) => (n === node ? withState(n, state, states) : n)) };
}

/**
 * Name the states tasks can be in: the whole document's
 * (`settings.taskStates`), or one node's own when `nodeId` is given. `null`
 * takes the list away again, back to what is inherited. Every task the
 * change reaches keeps its state when the new list still names it; a
 * finished task stays finished, and any other starts over at the first
 * state. Throws on a list that doesn't leave two states, or an unknown node.
 */
export function setTaskStates<T extends TaskStateDocument>(
  doc: T,
  states: readonly string[] | null,
  nodeId?: string,
): T {
  const list = states === null ? undefined : normalizeTaskStates(states);
  if (states !== null && !list) throw new Error("A task needs at least two states: where it starts and where it is done");
  if (nodeId !== undefined && !doc.nodes.some((n) => n.id === nodeId)) throw new Error(`No node "${nodeId}"`);

  const settle = (n: TaskStateNode, before: TaskStateDocument, after: TaskStateDocument, next: TaskStateNode) => {
    if (n.kind !== TASK_KIND) return next;
    const was = taskStatesOf(before, n);
    const now = taskStatesOf(after, next);
    if (sameTaskStates(was, now)) return next;
    const state = stateIn(n, was);
    const done = was[was.length - 1] === state;
    return withState(next, now.includes(state) && !done ? state : done ? now[now.length - 1]! : now[0]!, now);
  };

  if (nodeId !== undefined) {
    const inherited = doc.settings?.taskStates ?? DEFAULT_TASK_STATES;
    const own = list && !sameTaskStates(list, inherited) ? list : undefined;
    return {
      ...doc,
      nodes: doc.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const { states: _states, ...rest } = n;
        const next = own ? { ...rest, states: own } : rest;
        return settle(n, doc, doc, next);
      }),
    };
  }

  const { taskStates: _taskStates, ...settings } = doc.settings ?? {};
  const shared = list && !sameTaskStates(list, undefined) ? list : undefined;
  const nextSettings = shared ? { ...settings, taskStates: shared } : settings;
  const after: T = { ...doc, settings: nextSettings };
  if (!Object.keys(nextSettings).length) delete (after as { settings?: unknown }).settings;
  return { ...after, nodes: doc.nodes.map((n) => settle(n, doc, after, n)) };
}

/**
 * Every task that is in another state in `after` than it was in `before`,
 * in `after`'s order — what `onTaskDoneChange` reports, for a host comparing
 * two versions of a document itself (a file watcher, a webhook). A task in
 * only one of the two is not a change of state, so it is not listed.
 */
export function taskStateChanges(before: TaskStateDocument, after: TaskStateDocument): TaskStateChange[] {
  const was = new Map<string, string>();
  for (const n of before.nodes) if (n.kind === TASK_KIND) was.set(n.id, stateIn(n, taskStatesOf(before, n)));
  const out: TaskStateChange[] = [];
  for (const n of after.nodes) {
    if (n.kind !== TASK_KIND) continue;
    const previous = was.get(n.id);
    if (previous === undefined) continue;
    const states = taskStatesOf(after, n);
    const state = stateIn(n, states);
    if (state !== previous) out.push({ nodeId: n.id, state, previous, done: states[states.length - 1] === state });
  }
  return out;
}

/** Where a state sits in its list: where a task starts, where it is done, or between. */
export type TaskStatePosition = "first" | "between" | "last";

/** The pill a task with states of its own wears on its card and in a picture. */
export interface TaskStatePill {
  state: string;
  /** The state's name in words — see `taskStateLabel`. */
  label: string;
  position: TaskStatePosition;
  /** The state's place in the list, from 0. */
  index: number;
}

/**
 * The inks a state between the first and the last takes, by its place in
 * the list, so "doing" and "review" read apart at a glance. The first state
 * is muted (nothing has happened yet) and the last is done's green.
 */
export const TASK_STATE_INKS: readonly string[] = ["#0ea5e9", "#8b5cf6", "#d97706", "#0d9488", "#db2777"];
/** Done's green — the corner check's, and a milestone's Reached. */
export const TASK_DONE_INK = "#16a34a";

/** The ink of a state between the first and the last, by its place in the list. */
export function taskStateInk(index: number): string {
  return TASK_STATE_INKS[(Math.max(1, index) - 1) % TASK_STATE_INKS.length]!;
}

/**
 * The pill a task wears when it has states of its own — its node's, else
 * `shared` (the document's `settings.taskStates`). Null on the default pair:
 * there the corner check says everything, as it always has.
 */
export function taskStatePill(node: TaskStateNode, shared?: readonly string[]): TaskStatePill | null {
  const states = node.states && node.states.length >= 2 ? node.states : shared && shared.length >= 2 ? shared : null;
  if (!states || sameTaskStates(states, undefined)) return null;
  const state = stateIn(node, states);
  const index = states.indexOf(state);
  return {
    state,
    label: taskStateLabel(state),
    position: index === 0 ? "first" : index === states.length - 1 ? "last" : "between",
    index,
  };
}

/**
 * A state's name as a person reads it: "notDone" → "Not done",
 * "in-review" → "In review", "QA" → "QA".
 */
export function taskStateLabel(state: string): string {
  const words = state
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.length > 1 && word === word.toUpperCase() ? word : word.toLowerCase()));
  if (!words.length) return state;
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

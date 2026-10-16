/**
 * roadmap.ts — a plan laid out by date.
 *
 * With `settings.arrange: "roadmap"` the canvas reads left to right as time:
 * a task is a bar from its `startDate` to its due `date`, a milestone sits on
 * its day, and each group fits round its work like a time box. Positions are
 * DERIVED — the dates are the only record of when — so the editor re-lays the
 * plan on every edit (`settleRoadmap`), and dragging a card sideways is a way
 * of editing its dates (`roadmapDragPatch`), not its x.
 *
 *   settings.roadmap { from, dayWidth }  ── x of any date: (day − from) × dayWidth
 *   dates + groups + document order ──(roadmapLayout)──▶ x, y, w, h
 *
 * The axis is stored, not recomputed per edit: a task dragged before the
 * first date would otherwise move the origin, and every other card on the
 * canvas with it. It is fitted afresh only when the plan is first laid out
 * by date, or tidied.
 *
 * What the layout owns is the PLAN: work items, and the frames that hold
 * them. Zones, root-level boxes outside the plan, and what sits inside a card
 * (its own drill-in canvas) keep their places.
 *
 * Zero dependencies, like every contract module.
 */
import {
  CONTAINER_KINDS,
  KIND_DEFAULT_SIZE,
  MAX_DAY_WIDTH,
  MIN_DAY_WIDTH,
  absolutePosition,
  assignZonesByGeometry,
  hiddenInline,
  type DiagramNode,
  type DiagramTemplate,
  type RoadmapAxis,
} from "./schema";
import { dateToDay, dayToDate, normalizeDate, type DiagramDate } from "./timeline";
import { ASSIGNEE_STRIP_HEIGHT, TASK_KIND, hasAssigneeStrip, isWorkItem, todayIso } from "./tasks";

// ─── The axis ────────────────────────────────────────────────────────────────

export type { RoadmapAxis };
/** How wide a fitted plan aims to be, edge to edge — a few screens, not a few dozen. */
const FIT_WIDTH = 2400;
/** A fitted axis spans at least this many days, so a plan due in one week isn't 2,400px of it. */
const FIT_MIN_DAYS = 28;

/** Tidy's gaps, so a roadmap is spaced like the rest of the editor's layouts. */
const ROW_GAP = 28;
const COL_GAP = 16;
const FRAME_PAD = 28;
const FRAME_HEADER = 52;
const FRAME_MIN_W = 160;
/** A bar narrower than this can't hold a task's name, whatever its dates say. */
export const MIN_BAR_W = 120;
/** Clear space between the Unscheduled column and the first date. */
export const UNSCHEDULED_GAP = 48;

/** Whether the document is laid out by date. */
export function isRoadmap(doc: Pick<DiagramTemplate, "settings">): boolean {
  return doc.settings?.arrange === "roadmap";
}

/**
 * The stored axis, or null when there is none or it isn't usable. Checked
 * again here, not only on validation, since a host may hand the layout a
 * document it built itself.
 */
export function roadmapAxisOf(doc: Pick<DiagramTemplate, "settings">): RoadmapAxis | null {
  const stored = doc.settings?.roadmap as Partial<RoadmapAxis> | undefined;
  const from = normalizeDate(stored?.from);
  const dayWidth = stored?.dayWidth;
  if (!from || typeof dayWidth !== "number" || !Number.isFinite(dayWidth)) return null;
  return { from, dayWidth: clampDayWidth(dayWidth) };
}

/** A day width the axis accepts: whole, and in range. */
export function clampDayWidth(dayWidth: number): number {
  return Math.min(MAX_DAY_WIDTH, Math.max(MIN_DAY_WIDTH, Math.round(dayWidth)));
}

/** The x where `date` begins. Day d spans [dayX(d), dayX(d + 1)). */
export function dayX(axis: RoadmapAxis, date: DiagramDate): number {
  return (dateToDay(date) - dateToDay(axis.from)) * axis.dayWidth;
}

/** The day `x` falls in. */
export function dateAtX(axis: RoadmapAxis, x: number): DiagramDate {
  return dayToDate(dateToDay(axis.from) + Math.floor(x / axis.dayWidth));
}

/** `date` moved by whole days. */
export function shiftDate(date: DiagramDate, days: number): DiagramDate {
  return dayToDate(dateToDay(date) + days);
}

const firstOfMonth = (date: DiagramDate) => `${date.slice(0, 7)}-01`;

/** A task's start, when it has one that isn't after its due date. */
function startOf(n: Pick<DiagramNode, "kind" | "date" | "startDate">): DiagramDate | undefined {
  if (n.kind !== TASK_KIND || !n.startDate) return undefined;
  return n.date && n.startDate > n.date ? undefined : n.startDate;
}

/**
 * The axis that fits a plan: starting on the first of the month its earliest
 * date falls in, with a day as wide as spreads the whole plan over a few
 * screens. An undated plan starts this month.
 */
export function fitRoadmapAxis(
  doc: DiagramTemplate,
  opts: { containerKinds?: readonly string[]; today?: DiagramDate } = {},
): RoadmapAxis {
  const dates: DiagramDate[] = [];
  for (const n of planOf(doc, opts.containerKinds).leaves) {
    const start = startOf(n);
    if (start) dates.push(start);
    if (n.date) dates.push(n.date);
  }
  if (!dates.length) return { from: firstOfMonth(opts.today ?? todayIso()), dayWidth: 8 };
  dates.sort();
  const from = firstOfMonth(dates[0]!);
  const days = Math.max(FIT_MIN_DAYS, dateToDay(dates[dates.length - 1]!) - dateToDay(from) + 1);
  return { from, dayWidth: clampDayWidth(FIT_WIDTH / days) };
}

// ─── What the plan is ────────────────────────────────────────────────────────

interface Plan {
  /** Root-level nodes the layout places: work items and frames holding work. */
  roots: DiagramNode[];
  /** Each placed frame's children, in document order. */
  children: Map<string, DiagramNode[]>;
  /** Every leaf the layout places, dated or not. */
  leaves: DiagramNode[];
  /** Document order, the tiebreak wherever two things would otherwise tie. */
  order: Map<string, number>;
  containers: ReadonlySet<string>;
}

/**
 * The part of the document the roadmap places: work items, and the frames
 * whose subtree holds one — with everything else inside those frames, which
 * goes in the Unscheduled column. A card's own children live on its drill-in
 * canvas, so they are never part of it.
 */
function planOf(doc: DiagramTemplate, containerKinds: readonly string[] = CONTAINER_KINDS): Plan {
  const kinds = new Set(containerKinds);
  const inline = hiddenInline(doc, containerKinds);
  const ids = new Set(doc.nodes.map((n) => n.id));
  const kids = new Map<string | null, DiagramNode[]>();
  for (const n of doc.nodes) {
    if (inline.has(n.id)) continue;
    const parent = n.parentId && ids.has(n.parentId) ? n.parentId : null;
    const list = kids.get(parent);
    if (list) list.push(n);
    else kids.set(parent, [n]);
  }

  const holdsWork = new Map<string, boolean>();
  const planned = (n: DiagramNode, seen = new Set<string>()): boolean => {
    if (isWorkItem(n)) return true;
    if (!kinds.has(n.kind)) return false;
    const known = holdsWork.get(n.id);
    if (known !== undefined) return known;
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    const value = (kids.get(n.id) ?? []).some((c) => planned(c, seen));
    holdsWork.set(n.id, value);
    return value;
  };

  const roots = (kids.get(null) ?? []).filter((n) => planned(n));
  const children = new Map<string, DiagramNode[]>();
  const leaves: DiagramNode[] = [];
  const containers = new Set<string>();
  const visit = (n: DiagramNode) => {
    if (kinds.has(n.kind) && planned(n)) {
      containers.add(n.id);
      const list = kids.get(n.id) ?? [];
      children.set(n.id, list);
      list.forEach(visit);
    } else {
      leaves.push(n);
    }
  };
  roots.forEach(visit);
  return { roots, children, leaves, order: new Map(doc.nodes.map((n, i) => [n.id, i])), containers };
}

/** Whether a document has dated work to lay out by date — what offers the mode. */
export function hasRoadmapWork(doc: Pick<DiagramTemplate, "nodes">): boolean {
  return doc.nodes.some((n) => isWorkItem(n) && (!!n.date || !!startOf(n)));
}

// ─── The layout ──────────────────────────────────────────────────────────────

interface Block {
  id: string;
  left: number;
  w: number;
  /** The node's own height. */
  h: number;
  /** What it takes up in its row — a task's assignee tabs hang below its box. */
  footprint: number;
  order: number;
  /** Offset from the top of its parent's content, once packed. */
  top: number;
  kids?: Block[];
}

/**
 * Pack blocks into rows: the work first, earliest first, then the frames in
 * the order the document lists them — so workstreams keep their order as
 * rows however their dates move. Each goes in the first row where it
 * overlaps nothing already there: sprints that follow each other share a
 * row, and overlapping work stacks. A row is as tall as its tallest block.
 * Returns the height of the rows together.
 */
function pack(blocks: Block[]): number {
  const work = blocks.filter((b) => !b.kids).sort((a, b) => a.left - b.left || a.order - b.order);
  const frames = blocks.filter((b) => b.kids).sort((a, b) => a.order - b.order);
  const rows: Array<Array<{ left: number; right: number }>> = [];
  const heights: number[] = [];
  const rowOf = new Map<Block, number>();
  for (const b of [...work, ...frames]) {
    const right = b.left + b.w;
    let row = rows.findIndex((spans) => spans.every((s) => s.right + COL_GAP <= b.left || right + COL_GAP <= s.left));
    if (row < 0) {
      row = rows.length;
      rows.push([]);
      heights.push(0);
    }
    rows[row]!.push({ left: b.left, right });
    heights[row] = Math.max(heights[row]!, b.footprint);
    rowOf.set(b, row);
  }
  const tops: number[] = [];
  let y = 0;
  for (let i = 0; i < heights.length; i++) {
    tops.push(y);
    y += heights[i]! + ROW_GAP;
  }
  for (const b of blocks) b.top = tops[rowOf.get(b)!]!;
  return Math.max(0, y - ROW_GAP);
}

/** How `roadmapLayout` reads the document. */
export interface RoadmapLayoutOptions {
  /** The registry's container kinds, when it adds any — `CONTAINER_KINDS` by default. */
  containerKinds?: readonly string[];
  /** Fit a fresh axis rather than keep the stored one — what Tidy and switching to the mode do. */
  refit?: boolean;
  /** For an undated plan's axis; defaults to today. */
  today?: DiagramDate;
}

/**
 * The plan placed on its time axis. Returns the same document object when
 * nothing moves, so a caller can tell a no-op from an edit by identity.
 *
 * - A task with a start runs from its start to the end of its due day, no
 *   narrower than `MIN_BAR_W` — kept on the due edge, since when it must be
 *   done is what a roadmap is read for. Without a start it is a standard
 *   card ending on its due day.
 * - A milestone, or any other dated box in a plan's frame, is centred on its
 *   day and keeps its size.
 * - Anything in a plan's frame with no date goes in the Unscheduled column,
 *   left of the earliest date.
 * - Frames fit round their contents, and frames and cards side by side are
 *   packed into rows, earliest first — so a run of sprints reads as one row
 *   of time boxes, and overlapping workstreams stack.
 *
 * On a `refit`, boxes at the root that aren't part of the plan and would sit
 * on top of it move below it, together.
 */
export function roadmapLayout(doc: DiagramTemplate, opts: RoadmapLayoutOptions = {}): DiagramTemplate {
  const stored = roadmapAxisOf(doc);
  const axis = opts.refit || !stored ? fitRoadmapAxis(doc, opts) : stored;
  const plan = planOf(doc, opts.containerKinds);
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));

  // A leaf's x span depends only on its dates, so the Unscheduled column can
  // be set left of the earliest one before anything is packed.
  const spans = new Map<string, { left: number; w: number }>();
  let earliest = 0;
  for (const n of plan.leaves) {
    const span = datedSpan(n, axis);
    if (!span) continue;
    spans.set(n.id, span);
    earliest = Math.min(earliest, span.left);
  }
  const column = earliest - UNSCHEDULED_GAP;

  const leafBlock = (n: DiagramNode): Block => {
    const w = n.kind === TASK_KIND ? KIND_DEFAULT_SIZE.task!.w : n.w;
    const span = spans.get(n.id) ?? { left: column - w, w };
    const footprint = n.h + (hasAssigneeStrip(n) ? ASSIGNEE_STRIP_HEIGHT : 0);
    return { id: n.id, left: span.left, w: span.w, h: n.h, footprint, order: plan.order.get(n.id)!, top: 0 };
  };
  const block = (n: DiagramNode, seen = new Set<string>()): Block => {
    if (!plan.containers.has(n.id) || seen.has(n.id)) return leafBlock(n);
    seen.add(n.id);
    const kids = (plan.children.get(n.id) ?? []).map((c) => block(c, seen));
    const height = pack(kids);
    const left = Math.min(...kids.map((k) => k.left)) - FRAME_PAD;
    const right = Math.max(...kids.map((k) => k.left + k.w)) + FRAME_PAD;
    const w = Math.max(FRAME_MIN_W, right - left);
    const h = FRAME_HEADER + height + FRAME_PAD;
    return { id: n.id, left, w, h, footprint: h, order: plan.order.get(n.id)!, top: 0, kids };
  };

  const roots = plan.roots.map((n) => block(n));
  pack(roots);
  const placed = new Map<string, { x: number; y: number; w: number; h: number }>();
  const place = (b: Block, top: number) => {
    placed.set(b.id, { x: b.left, y: top, w: b.w, h: b.h });
    for (const k of b.kids ?? []) place(k, top + FRAME_HEADER + k.top);
  };
  for (const b of roots) place(b, b.top);

  // Below the plan, together, whatever at the root it would cover.
  let lift = 0;
  if (opts.refit && placed.size) {
    const boxes = [...placed.values()];
    const bounds = {
      minX: Math.min(...boxes.map((b) => b.x)),
      maxX: Math.max(...boxes.map((b) => b.x + b.w)),
      minY: Math.min(...boxes.map((b) => b.y)),
      maxY: Math.max(...boxes.map((b) => b.y + b.h)),
    };
    const loose = doc.nodes.filter((n) => !placed.has(n.id) && (!n.parentId || !byId.has(n.parentId)));
    const covered = loose.some(
      (n) => n.x < bounds.maxX && bounds.minX < n.x + n.w && n.y < bounds.maxY && bounds.minY < n.y + n.h,
    );
    if (covered) lift = bounds.maxY + ROW_GAP * 2 - Math.min(...loose.map((n) => n.y));
  }

  let moved = false;
  const nodes = doc.nodes.map((n) => {
    const at = placed.get(n.id);
    if (!at) {
      if (!lift || (n.parentId && byId.has(n.parentId))) return n;
      moved = true;
      return { ...n, y: n.y + lift };
    }
    const parent = n.parentId ? placed.get(n.parentId) : undefined;
    const x = Math.round(at.x - (parent?.x ?? 0));
    const y = Math.round(at.y - (parent?.y ?? 0));
    const w = Math.round(at.w);
    const h = Math.round(at.h);
    if (x === n.x && y === n.y && w === n.w && h === n.h) return n;
    moved = true;
    return { ...n, x, y, w, h };
  });

  const axisChanged = !stored || stored.from !== axis.from || stored.dayWidth !== axis.dayWidth;
  if (!moved && !axisChanged) return doc;

  // A line routed by hand round boxes that have since moved routes round
  // nothing — Tidy drops those waypoints, and so does this.
  let edges = doc.edges;
  if (moved && doc.edges.some((e) => e.points)) {
    const after = new Map(nodes.map((n) => [n.id, n]));
    const shifted = (id: string) => {
      const a = byId.get(id);
      const b = after.get(id);
      if (!a || !b) return false;
      const p = absolutePosition(a, byId);
      const q = absolutePosition(b, after);
      return p.x !== q.x || p.y !== q.y || a.w !== b.w || a.h !== b.h;
    };
    edges = doc.edges.map((e) => {
      if (!e.points || (!shifted(e.source) && !shifted(e.target))) return e;
      const { points: _stale, ...rest } = e;
      return rest;
    });
  }

  return {
    ...doc,
    nodes,
    edges,
    ...(axisChanged
      ? { settings: { ...doc.settings, roadmap: axis } }
      : {}),
  };
}

/** Where a dated leaf sits on the axis, or null when it has no date. */
function datedSpan(n: DiagramNode, axis: RoadmapAxis): { left: number; w: number } | null {
  if (n.kind === TASK_KIND) {
    const start = startOf(n);
    if (!n.date && !start) return null;
    const standard = KIND_DEFAULT_SIZE.task!.w;
    if (!n.date) return { left: dayX(axis, start!), w: standard };
    const right = dayX(axis, n.date) + axis.dayWidth;
    const w = start ? Math.max(MIN_BAR_W, right - dayX(axis, start)) : standard;
    return { left: right - w, w };
  }
  if (!n.date) return null;
  return { left: Math.round(dayX(axis, n.date) + axis.dayWidth / 2 - n.w / 2), w: n.w };
}

/**
 * A document as the roadmap would have it: laid out by date when it is in
 * that mode, untouched (the same object) when it isn't or nothing moves.
 * Zone membership is re-read from where things now sit, the way every derive
 * of the canvas reads it.
 */
export function settleRoadmap(
  doc: DiagramTemplate,
  opts: Omit<RoadmapLayoutOptions, "refit"> = {},
): DiagramTemplate {
  if (!isRoadmap(doc)) return doc;
  const laid = roadmapLayout(doc, opts);
  return laid === doc ? doc : assignZonesByGeometry(laid, { containerKinds: opts.containerKinds });
}

/**
 * The right edge of the Unscheduled column, when the plan has anything
 * undated in it — where the ruler labels the column. Null when it has none.
 */
export function unscheduledEdge(doc: DiagramTemplate, axis: RoadmapAxis, containerKinds?: readonly string[]): number | null {
  let earliest = 0;
  let undated = false;
  for (const n of planOf(doc, containerKinds).leaves) {
    const span = datedSpan(n, axis);
    if (span) earliest = Math.min(earliest, span.left);
    else undated = true;
  }
  return undated ? earliest - UNSCHEDULED_GAP : null;
}

// ─── Dragging is rescheduling ────────────────────────────────────────────────

/** One dragged node: its absolute x when the drag began and where it was let go. */
export interface RoadmapMove {
  id: string;
  from: number;
  to: number;
}

/** New dates for one node, only the fields that change. */
export type RoadmapDatePatch = { date?: DiagramDate; startDate?: DiagramDate };

/**
 * What a drag means on a roadmap: new dates, moved by whole days.
 *
 * A dated card moves its start and due date together. An undated one dropped
 * on the axis takes the date it was dropped on — a task its due day (where
 * its right edge lands), anything else the day under its centre — and stays
 * undated if let go still in the Unscheduled column. Dragging a frame moves
 * every dated card inside it; a node dragged along with a frame it is inside
 * moves with the frame, once. Only what the layout places is rescheduled: a
 * box outside the plan, or a card's own drill-in detail, keeps its dates.
 */
export function roadmapDragPatch(
  doc: DiagramTemplate,
  axis: RoadmapAxis,
  moves: readonly RoadmapMove[],
  containerKinds: readonly string[] = CONTAINER_KINDS,
): Map<string, RoadmapDatePatch> {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const kinds = new Set(containerKinds);
  const plan = planOf(doc, containerKinds);
  const owned = new Set([...plan.leaves.map((n) => n.id), ...plan.containers]);
  const dragged = new Set(moves.map((m) => m.id));
  const insideDragged = (n: DiagramNode) => {
    const seen = new Set([n.id]);
    for (let p = n.parentId; p && !seen.has(p); p = byId.get(p)?.parentId ?? null) {
      if (dragged.has(p)) return true;
      seen.add(p);
    }
    return false;
  };
  const kids = new Map<string, DiagramNode[]>();
  for (const n of byId.values()) {
    if (!n.parentId) continue;
    const list = kids.get(n.parentId);
    if (list) list.push(n);
    else kids.set(n.parentId, [n]);
  }

  const out = new Map<string, RoadmapDatePatch>();
  const shift = (n: DiagramNode, days: number) => {
    const start = startOf(n);
    if (!n.date && !start) return;
    out.set(n.id, {
      ...(n.date ? { date: shiftDate(n.date, days) } : {}),
      ...(start ? { startDate: shiftDate(start, days) } : {}),
    });
  };

  for (const m of moves) {
    const n = byId.get(m.id);
    if (!n || !owned.has(n.id) || insideDragged(n)) continue;
    const days = Math.round((m.to - m.from) / axis.dayWidth);
    if (kinds.has(n.kind)) {
      if (!days) continue;
      const seen = new Set<string>();
      const walk = (id: string) => {
        for (const c of kids.get(id) ?? []) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          if (!owned.has(c.id)) continue;
          shift(c, days);
          walk(c.id);
        }
      };
      walk(n.id);
      continue;
    }
    if (n.date || startOf(n)) {
      if (days) shift(n, days);
      continue;
    }
    // Undated: dated by where it lands, once it lands on the axis.
    if (n.kind === TASK_KIND) {
      const right = m.to + n.w;
      if (right > 0) out.set(n.id, { date: dateAtX(axis, right - 1) });
    } else {
      const centre = m.to + n.w / 2;
      if (centre >= 0) out.set(n.id, { date: dateAtX(axis, centre) });
    }
  }
  return out;
}

/** How far a neighbour of a card that says nothing of how long it runs is put. */
const NEIGHBOUR_DAYS = 7;

/**
 * The dates for a card added beside `source` on a roadmap (the quick-add
 * arrows). To its right is the work that follows it — starting the day
 * after it is due, and running as long — to its left the work before it,
 * and above or below, work alongside it on the same dates. A source without
 * a start moves its neighbour a week. Empty when there is no date to go by.
 */
export function besideDates(
  source: Pick<DiagramNode, "kind" | "date" | "startDate">,
  side: "top" | "right" | "bottom" | "left",
): RoadmapDatePatch {
  const due = source.date;
  const start = startOf(source);
  if (side === "top" || side === "bottom") return { ...(due ? { date: due } : {}), ...(start ? { startDate: start } : {}) };
  if (!due) return {};
  const ahead = side === "right";
  if (!start) return { date: shiftDate(due, ahead ? NEIGHBOUR_DAYS : -NEIGHBOUR_DAYS) };
  const span = dateToDay(due) - dateToDay(start);
  return ahead
    ? { startDate: shiftDate(due, 1), date: shiftDate(due, 1 + span) }
    : { startDate: shiftDate(start, -1 - span), date: shiftDate(start, -1) };
}

// ─── The ruler ───────────────────────────────────────────────────────────────

/** How much of the calendar one ruler unit is — the finest whose names fit at the zoom. */
export type RoadmapTickUnit = "week" | "month" | "quarter" | "year";

/** One unit on a roadmap's ruler, as `roadmapTicks` lists them. */
export interface RoadmapTick {
  /** Canvas x where the unit begins. */
  x: number;
  /** The day it begins, `YYYY-MM-DD`. */
  date: DiagramDate;
  /** Its name: "Mar 2" for a week and "Mar" for a month (with the year on the first tick and on January), "Q2 ’26" for a quarter, "2026" for a year. */
  label: string;
  /** The label with its year, whether or not `label` names it — for whichever label is shown first. */
  full: string;
  /** A stronger line: a month's first week, a quarter's first month, a year's first quarter. */
  major: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const yearTag = (year: number) => `’${String(year % 100).padStart(2, "0")}`;

/**
 * The finest unit whose labels fit side by side at `pxPerDay` screen pixels
 * a day: weeks when a week is wide enough for "Mar 30", then months,
 * quarters, years.
 */
export function roadmapTickUnit(pxPerDay: number): RoadmapTickUnit {
  if (pxPerDay * 7 >= 56) return "week";
  if (pxPerDay * 30 >= 48) return "month";
  if (pxPerDay * 91 >= 48) return "quarter";
  return "year";
}

/**
 * The ruler's ticks between canvas x `x0` and `x1`, in the unit that fits
 * `pxPerDay` (the axis's own day width in an export; that times the zoom on
 * the canvas). The first tick is the unit `x0` falls in, so its label can
 * show though its start is off to the left. The year is named on the first
 * tick and wherever a new one begins.
 */
export function roadmapTicks(
  axis: RoadmapAxis,
  x0: number,
  x1: number,
  pxPerDay: number = axis.dayWidth,
): { unit: RoadmapTickUnit; ticks: RoadmapTick[] } {
  const unit = roadmapTickUnit(pxPerDay);
  const ticks: RoadmapTick[] = [];
  const first = dateAtX(axis, x0);
  let year = Number(first.slice(0, 4));
  let month = Number(first.slice(5, 7)) - 1;

  if (unit === "week") {
    const day = dateToDay(first);
    // Day 0 (1970-01-01) was a Thursday; step back to the Monday on or before.
    let d = day - ((((day + 3) % 7) + 7) % 7);
    let lastMonth = -1;
    for (let guard = 0; guard < 2000; guard++) {
      const date = dayToDate(d);
      const x = dayX(axis, date);
      if (x > x1) break;
      const y = Number(date.slice(0, 4));
      const m = Number(date.slice(5, 7)) - 1;
      const showYear = !ticks.length || (m === 0 && Number(date.slice(8)) <= 7);
      const label = `${MONTHS[m]} ${Number(date.slice(8))}`;
      ticks.push({
        x,
        date,
        label: showYear ? `${label} ${yearTag(y)}` : label,
        full: `${label} ${yearTag(y)}`,
        major: m !== lastMonth && ticks.length > 0,
      });
      lastMonth = m;
      d += 7;
    }
    return { unit, ticks };
  }

  const step = unit === "month" ? 1 : unit === "quarter" ? 3 : 12;
  month -= month % step;
  for (let guard = 0; guard < 2000; guard++) {
    const date = `${year}-${String(month + 1).padStart(2, "0")}-01`;
    const x = dayX(axis, date);
    if (x > x1) break;
    const full =
      unit === "month" ? `${MONTHS[month]} ${yearTag(year)}` : unit === "quarter" ? `Q${month / 3 + 1} ${yearTag(year)}` : String(year);
    const label = unit === "month" && ticks.length && month !== 0 ? MONTHS[month]! : full;
    ticks.push({ x, date, label, full, major: unit === "year" || (unit === "month" ? month % 3 === 0 : month === 0) });
    month += step;
    if (month >= 12) {
      month -= 12;
      year += 1;
    }
  }
  return { unit, ticks };
}

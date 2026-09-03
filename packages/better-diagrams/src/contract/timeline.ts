/**
 * timeline.ts — dates on elements, and the scrubbed view they drive.
 *
 * Every element in both documents (architecture nodes, edges and zones;
 * sequence participants and messages) may carry a `date`. The dates are the
 * only input: the set of distinct dates IS the timeline, so there is no
 * separate "phases" or "milestones" structure to keep in sync with the diagram.
 *
 *   dates on elements ──(buildTimeline)──▶ stops[]  ── the scrubber's positions
 *   stops[i] ──(timelineView)──▶ the document as it stood on that date
 *
 * Two rules define what a stop shows, and they fall out of one another:
 *
 *   - an element dated ON OR BEFORE the cursor is PRESENT
 *   - an element with NO date is present at every stop — undated means
 *     "always been there", not "due at the epoch"
 *
 * So the first stop shows only what was due by then plus the undated backdrop,
 * and the last stop — being the latest date in the document — shows everything.
 *
 * Dates CASCADE down containment: a node's effective date is the latest in its
 * ancestor chain, because a box cannot exist before the boundary drawn around
 * it. That is also what keeps the view sound — hiding a group can never strand
 * its children on the canvas, since they are hidden by the same rule.
 *
 * Like the rest of contract/, this file has zero dependencies: it imports only
 * TYPES from the two schemas, so it can run in a backend or a report job.
 */
import type { DiagramNode, DiagramTemplate } from "./schema";
import type { SeqActivation, SeqFragment, SeqNote, SequenceTemplate } from "./sequence";

// ─── The stored value ────────────────────────────────────────────────────────

/**
 * A date as stored: `YYYY-MM-DD`, zero-padded.
 *
 * A plain string rather than a `Date` so the document stays JSON, and so
 * ordering is a string comparison — `"2026-03-09" < "2026-03-14"` is true
 * lexicographically exactly when it is true chronologically. Every comparison
 * in this file relies on that, which is why the padding is not optional.
 */
export type DiagramDate = string;

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const pad = (n: number) => String(n).padStart(2, "0");

/** Days in a month, Gregorian, so a clamped day lands on a real calendar date. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Coerce anything into a canonical `YYYY-MM-DD`, or `undefined`.
 *
 * Repairs rather than rejects, like the rest of validation: separators may be
 * `-`, `/`, or `.`; components need not be padded; a month-only value takes
 * the first of that month; an impossible day is clamped into the month
 * ("2026-02-31" → "2026-02-28") rather than rolling into March, which would
 * silently move an element to a date nobody wrote.
 *
 * Anything that isn't a date at all returns undefined, so validation stores
 * nothing instead of storing garbage that would corrupt the ordering.
 */
export function normalizeDate(raw: unknown): DiagramDate | undefined {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return undefined;
    return `${raw.getFullYear()}-${pad(raw.getMonth() + 1)}-${pad(raw.getDate())}`;
  }
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (!text) return undefined;

  // Anchored at BOTH ends: an unanchored pattern accepts "2026-06-15garbage"
  // as a date, which is exactly the input that most deserves to be refused.
  // A trailing time-of-day is the one exception worth keeping — an ISO
  // timestamp is a date somebody wrote, and dropping it would silently
  // un-date the element.
  const match = /^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?(?:[T ][\d:.]+(?:Z|[+-][\d:]+)?)?$/.exec(
    text,
  );
  if (!match) {
    // Day-first and month-first slips ("15/06/2026", "06/15/2026") are common
    // enough to name rather than swallow: both readings are plausible, so
    // guessing one would move the element to a date nobody wrote.
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || month < 1 || month > 12) return undefined;
  // A month with no day means "that month" — the first is the earliest moment
  // it could be true, which is the reading that keeps the element from
  // appearing later than the author intended.
  const day = match[3] === undefined ? 1 : Number(match[3]);
  if (!Number.isFinite(day) || day < 1) return undefined;

  return `${match[1]}-${pad(month)}-${pad(Math.min(day, daysInMonth(year, month)))}`;
}

export interface FormatDateOptions {
  /**
   * `auto` (default) prints the year only when it differs from
   * `referenceYear` — a roadmap that runs inside one year doesn't repeat it on
   * every box. `always` and `never` override that.
   */
  year?: "auto" | "always" | "never";
  /** What `auto` compares against. Defaults to the current calendar year. */
  referenceYear?: number;
}

/**
 * Render a stored date for display: `Mar 14`, or `Mar 14 ’27` once the year
 * matters. Month as text so `03/04` can never be read as the fourth of March
 * by one reader and the third of April by another.
 */
export function formatDiagramDate(
  date: DiagramDate | undefined | null,
  opts: FormatDateOptions = {},
): string {
  if (!date) return "";
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!parts) return String(date);
  const year = Number(parts[1]);
  const month = MONTH_LABELS[Number(parts[2]) - 1] ?? parts[2];
  const day = Number(parts[3]);

  const mode = opts.year ?? "auto";
  const reference = opts.referenceYear ?? new Date().getFullYear();
  const showYear = mode === "always" || (mode === "auto" && year !== reference);
  return showYear ? `${month} ${day} ’${pad(year % 100)}` : `${month} ${day}`;
}

/** The later of two dates, treating `undefined` as "no constraint". */
export function laterDate(
  a: DiagramDate | undefined,
  b: DiagramDate | undefined,
): DiagramDate | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

// ─── The timeline ────────────────────────────────────────────────────────────

/** How elements dated after the cursor are treated while scrubbing. */
export const TIMELINE_FUTURE_MODES = ["dim", "hide"] as const;
export type TimelineFutureMode = (typeof TIMELINE_FUTURE_MODES)[number];

export interface Timeline {
  /** Every distinct date in the document, ascending. Empty = nothing dated. */
  stops: DiagramDate[];
  /** How many elements carry a date. */
  dated: number;
  /** How many carry none — the backdrop, present at every stop. */
  undated: number;
}

export const EMPTY_TIMELINE: Timeline = { stops: [], dated: 0, undated: 0 };

/** Collect dates into the ascending, de-duplicated stop list. */
export function buildTimeline(dates: Iterable<DiagramDate | undefined | null>): Timeline {
  const stops = new Set<DiagramDate>();
  let dated = 0;
  let undated = 0;
  for (const date of dates) {
    if (date) {
      stops.add(date);
      dated += 1;
    } else {
      undated += 1;
    }
  }
  return { stops: [...stops].sort(), dated, undated };
}

/** The stop at `index`, clamped. `null` when the document has no dates. */
export function timelineStop(timeline: Timeline, index: number): DiagramDate | null {
  if (!timeline.stops.length) return null;
  const i = Math.max(0, Math.min(timeline.stops.length - 1, Math.floor(index)));
  return timeline.stops[i];
}

// ─── Continuous cursor ───────────────────────────────────────────────────────
//
// The stops are where something HAPPENS, not the only places the cursor may
// stand. Scrubbing is continuous over days, so "what did this look like on the
// 20th of April" is answerable even though nothing is dated then — the two
// visibility rules already cover it, since they compare against a date rather
// than an index.
//
// Days are counted in UTC from the epoch so the mapping is exact and
// timezone-independent: a viewer in Auckland and one in Los Angeles must put
// the handle in the same place.

const MS_PER_DAY = 86_400_000;

/** Whole days from the epoch. Order-preserving, so arithmetic on it is safe. */
export function dateToDay(date: DiagramDate): number {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!parts) return 0;
  return Math.round(
    Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])) / MS_PER_DAY,
  );
}

/** The inverse of `dateToDay`. */
export function dayToDate(day: number): DiagramDate {
  const d = new Date(Math.round(day) * MS_PER_DAY);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Whole days between two dates, signed. */
export function daysBetween(from: DiagramDate, to: DiagramDate): number {
  return dateToDay(to) - dateToDay(from);
}

/**
 * The stop nearest `date`, or null when the closest one is further away than
 * `withinDays`. This is the whole of snapping: the caller decides what
 * "within reach" means in its own units (the scrubber converts a pixel
 * threshold, so the feel is the same whether the plan spans a month or a
 * decade) and this answers where to land.
 */
export function nearestStop(
  timeline: Timeline,
  date: DiagramDate,
  withinDays: number,
): DiagramDate | null {
  let best: DiagramDate | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const stop of timeline.stops) {
    const gap = Math.abs(daysBetween(stop, date));
    if (gap < bestGap) {
      bestGap = gap;
      best = stop;
    }
  }
  return best !== null && bestGap <= withinDays ? best : null;
}

/**
 * Where the scrubber opens: today, held inside the timeline's own span.
 *
 * Today is the interesting question — "what changes from here" — but a cursor
 * past the last stop would open on a view identical to not scrubbing at all,
 * and one before the first would open on an empty diagram.
 */
export function openingCursor(timeline: Timeline, today?: DiagramDate): DiagramDate | null {
  if (!timeline.stops.length) return null;
  const now = today ?? normalizeDate(new Date())!;
  const first = timeline.stops[0];
  const last = timeline.stops[timeline.stops.length - 1];
  if (now < first) return first;
  if (now > last) return last;
  return now;
}

// ─── Overdue ─────────────────────────────────────────────────────────────────

/**
 * The stages that come BEFORE active — an element in one of these has not
 * landed yet, whatever its date says.
 */
export const PRE_ACTIVE_STATUSES: readonly string[] = ["proposed", "planned", "stubbed", "dark"];

/**
 * A date in the past on an element that has not become active: the plan says
 * it should have landed, the status says it hasn't. This is the one moment a
 * date chip needs to be louder than grey. An element with no status is
 * active, and an active element's past date just means "landed" — not overdue.
 */
export function isOverdue(
  date: DiagramDate | undefined | null,
  status: string | undefined,
  today?: DiagramDate,
): boolean {
  if (!date || !status || !PRE_ACTIVE_STATUSES.includes(status)) return false;
  return date < (today ?? normalizeDate(new Date())!);
}

// ─── Architecture: effective dates and the scrubbed view ─────────────────────

/**
 * Each node's date after cascading containment: the latest date in its
 * ancestor chain. A node inside a group planned for June cannot be on the
 * canvas in March, whatever its own date says.
 *
 * Guarded against parent cycles so it is safe on hand-built input, the same
 * way `absolutePosition` is — validation breaks cycles, this file does not
 * assume validation ran.
 */
export function effectiveNodeDates(
  template: DiagramTemplate,
): Map<string, DiagramDate | undefined> {
  const byId = new Map(template.nodes.map((n) => [n.id, n]));
  const resolved = new Map<string, DiagramDate | undefined>();

  const resolve = (node: DiagramNode, seen: Set<string>): DiagramDate | undefined => {
    if (resolved.has(node.id)) return resolved.get(node.id);
    if (seen.has(node.id)) return node.date; // cycle — stop at own date
    seen.add(node.id);
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const value = laterDate(node.date, parent ? resolve(parent, seen) : undefined);
    resolved.set(node.id, value);
    return value;
  };

  for (const node of template.nodes) resolve(node, new Set());
  return resolved;
}

/** Ids of everything dated after the cursor, per family. */
export interface TimelineFuture {
  nodes: Set<string>;
  edges: Set<string>;
  zones: Set<string>;
}

export interface TimelineView {
  /** The document to render. Future elements are gone when mode is "hide". */
  template: DiagramTemplate;
  /**
   * What to render in the disabled style. Populated only in "dim" mode —
   * in "hide" mode those elements aren't in `template` to mark.
   */
  future: TimelineFuture;
  /** How many elements are still ahead of the cursor, in either mode. */
  futureCount: number;
}

const noFuture = (): TimelineFuture => ({
  nodes: new Set(),
  edges: new Set(),
  zones: new Set(),
});

/**
 * The architecture document as it stood on `at`.
 *
 * `at === null` (the timeline is off) returns the document untouched, so
 * callers never need a branch for "not scrubbing".
 *
 * In `hide` mode the returned template genuinely lacks the future elements —
 * it is a VIEW document, never something to save. In `dim` mode it is the
 * original and the ids come back in `future` for the renderer to style.
 */
export function timelineView(
  template: DiagramTemplate,
  at: DiagramDate | null,
  mode: TimelineFutureMode = "dim",
): TimelineView {
  if (!at) return { template, future: noFuture(), futureCount: 0 };

  const nodeDates = effectiveNodeDates(template);
  const futureNodes = new Set(
    template.nodes.filter((n) => isAfter(nodeDates.get(n.id), at)).map((n) => n.id),
  );

  // An edge is as late as the latest of itself and its two endpoints — it
  // cannot connect a box that isn't there yet.
  const futureEdges = new Set(
    template.edges
      .filter((e) =>
        isAfter(
          laterDate(e.date, laterDate(nodeDates.get(e.source), nodeDates.get(e.target))),
          at,
        ),
      )
      .map((e) => e.id),
  );

  // Zones do NOT cascade to their members: `zoneId` is a membership axis, not
  // containment (see zones.ts), so a region arriving later doesn't retroject
  // its contents. A dated zone appears or dims on its own.
  const futureZones = new Set(
    (template.zones ?? []).filter((z) => isAfter(z.date, at)).map((z) => z.id),
  );

  const futureCount = futureNodes.size + futureEdges.size + futureZones.size;
  if (mode === "dim") {
    return {
      template,
      future: { nodes: futureNodes, edges: futureEdges, zones: futureZones },
      futureCount,
    };
  }

  // Cascade guarantees no child outlives its parent here, so dropping future
  // nodes can never leave a dangling `parentId`. A dropped zone can leave a
  // stale `zoneId`, which every consumer already treats as "no zone".
  const sliced: DiagramTemplate = {
    ...template,
    nodes: template.nodes.filter((n) => !futureNodes.has(n.id)),
    edges: template.edges.filter((e) => !futureEdges.has(e.id)),
    ...(template.zones
      ? { zones: template.zones.filter((z) => !futureZones.has(z.id)) }
      : {}),
  };
  return { template: sliced, future: noFuture(), futureCount };
}

/** Every date in an architecture document, elements without one included. */
export function templateTimeline(template: DiagramTemplate): Timeline {
  return buildTimeline([
    ...template.nodes.map((n) => n.date),
    ...template.edges.map((e) => e.date),
    ...(template.zones ?? []).map((z) => z.date),
  ]);
}

// ─── Sequence: the same two rules over the other document ────────────────────

export interface SequenceTimelineView {
  template: SequenceTemplate;
  /**
   * Ids to render disabled, per family. Activations, fragments, and notes have
   * no dates of their own — they inherit from the messages and participants
   * they anchor to, which is the same inheritance `hide` mode expresses by
   * dropping them. Without them here, a scrubbed diagram would fade a message
   * and leave the bar and frame around it at full strength.
   */
  future: {
    participants: Set<string>;
    messages: Set<string>;
    activations: Set<string>;
    fragments: Set<string>;
    notes: Set<string>;
  };
  futureCount: number;
}

const noSequenceFuture = (): SequenceTimelineView["future"] => ({
  participants: new Set(),
  messages: new Set(),
  activations: new Set(),
  fragments: new Set(),
  notes: new Set(),
});

/**
 * The sequence document as it stood on `at`.
 *
 * A message is as late as the latest of itself and the two participants it
 * runs between — a call to a service that doesn't exist yet hasn't happened.
 * In `hide` mode the anchored constructs follow the same reference rules
 * `validateSequence` applies: a dropped DEFINING reference drops the
 * construct, a dropped AUXILIARY one degrades the field.
 */
export function sequenceTimelineView(
  template: SequenceTemplate,
  at: DiagramDate | null,
  mode: TimelineFutureMode = "dim",
): SequenceTimelineView {
  if (!at) return { template, future: noSequenceFuture(), futureCount: 0 };

  const dateOf = new Map(template.participants.map((p) => [p.id, p.date]));
  const futureParticipants = new Set(
    template.participants.filter((p) => isAfter(p.date, at)).map((p) => p.id),
  );
  const futureMessages = new Set(
    template.messages
      .filter((m) =>
        isAfter(
          laterDate(
            m.date,
            laterDate(
              m.from ? dateOf.get(m.from) : undefined,
              m.to ? dateOf.get(m.to) : undefined,
            ),
          ),
          at,
        ),
      )
      .map((m) => m.id),
  );

  const futureCount = futureParticipants.size + futureMessages.size;

  // The anchored constructs survive exactly when their DEFINING references do
  // — one predicate, used to drop them in `hide` mode and to mark them in
  // `dim` mode, so the two modes cannot disagree about what is not there yet.
  const present = (id: string) => !futureMessages.has(id);
  const participantPresent = (id: string) => !futureParticipants.has(id);
  const activationHere = (a: SeqActivation) =>
    participantPresent(a.participant) && present(a.from);
  const fragmentHere = (f: SeqFragment) => present(f.from) && present(f.to);
  const noteHere = (n: SeqNote) => participantPresent(n.participant);

  if (mode === "dim") {
    return {
      template,
      future: {
        participants: futureParticipants,
        messages: futureMessages,
        activations: new Set(
          (template.activations ?? []).filter((a) => !activationHere(a)).map((a) => a.id),
        ),
        fragments: new Set(
          (template.fragments ?? []).filter((f) => !fragmentHere(f)).map((f) => f.id),
        ),
        notes: new Set((template.notes ?? []).filter((n) => !noteHere(n)).map((n) => n.id)),
      },
      futureCount,
    };
  }

  const participants = template.participants.filter((p) => participantPresent(p.id));
  const messages = template.messages.filter((m) => present(m.id));

  const activations = (template.activations ?? []).flatMap((a): SeqActivation[] => {
    if (!activationHere(a)) return [];
    // AUXILIARY reference: a `to` that has not landed degrades to an open bar
    // rather than dropping the bar.
    const { to, ...rest } = a;
    return [to && present(to) ? { ...rest, to } : rest];
  });
  const fragments = (template.fragments ?? []).flatMap((f): SeqFragment[] => {
    if (!fragmentHere(f)) return [];
    const elses = (f.elses ?? []).filter((e) => present(e.at));
    const { elses: _dropped, ...rest } = f;
    return [elses.length ? { ...rest, elses } : rest];
  });
  const notes = (template.notes ?? []).flatMap((n): SeqNote[] => {
    if (!noteHere(n)) return [];
    const { across, at: rowAt, ...rest } = n;
    return [
      {
        ...rest,
        ...(across && participantPresent(across) ? { across } : {}),
        ...(rowAt && present(rowAt) ? { at: rowAt } : {}),
      },
    ];
  });

  // Rebuilt field by field rather than spread-and-override: spreading
  // `template` would carry an emptied `activations: []` through, and the
  // optional keys are absent-or-populated everywhere else in this schema.
  const sliced: SequenceTemplate = {
    version: template.version,
    ...(template.meta ? { meta: template.meta } : {}),
    participants,
    messages,
    ...(activations.length ? { activations } : {}),
    ...(fragments.length ? { fragments } : {}),
    ...(notes.length ? { notes } : {}),
  };

  return { template: sliced, future: noSequenceFuture(), futureCount };
}

/** Every date in a sequence document, elements without one included. */
export function sequenceTimeline(template: SequenceTemplate): Timeline {
  return buildTimeline([
    ...template.participants.map((p) => p.date),
    ...template.messages.map((m) => m.date),
  ]);
}

// ─── Internals ───────────────────────────────────────────────────────────────

/** Undated is never in the future — it has always been there. */
function isAfter(date: DiagramDate | undefined, at: DiagramDate): boolean {
  return !!date && date > at;
}

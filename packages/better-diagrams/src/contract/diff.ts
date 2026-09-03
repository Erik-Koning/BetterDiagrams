/**
 * diff.ts — semantic comparison of two templates.
 *
 * Stateless: feed it any two documents (two git revisions, two DB rows, the
 * saved baseline vs the working copy) and it reports what was added, removed,
 * and changed, matched by id. Positional fields are ignored by default —
 * dragging a box somewhere else is not an architecture change — so a review
 * diff stays about structure, not tidying.
 *
 * The editor's Compare mode renders this as an overlay; `summary` feeds the
 * +a −r ~c banner.
 */
import type { DiagramTemplate } from "./schema";
import type { SequenceTemplate } from "./sequence";

export type DiffState = "added" | "removed" | "changed";

export interface ChangedEntry {
  id: string;
  /** Which semantic fields differ, sorted — "label", "kind", "team", … */
  fields: string[];
}

export interface CollectionDiff {
  added: string[];
  removed: string[];
  changed: ChangedEntry[];
}

export interface TemplateDiff {
  nodes: CollectionDiff;
  edges: CollectionDiff;
  zones: CollectionDiff;
  /** Document-level fields that differ (title, versionTag, routing, …). */
  meta: string[];
  summary: { added: number; removed: number; changed: number };
}

/** The same shape for a sequence document, one entry per collection. */
export interface SequenceDiff {
  participants: CollectionDiff;
  messages: CollectionDiff;
  activations: CollectionDiff;
  fragments: CollectionDiff;
  notes: CollectionDiff;
  meta: string[];
  summary: { added: number; removed: number; changed: number };
}

/**
 * Fields that describe placement rather than architecture. `points` is a
 * zone's outline or an edge's waypoints; `labelT` is where an edge label sits
 * along its curve; `start`/`end` pin an edge to a side of its node boxes.
 */
export const POSITIONAL_FIELDS = ["x", "y", "w", "h", "labelT", "points", "start", "end"] as const;

/**
 * Fields that are VIEW STATE rather than either architecture or placement.
 *
 * `collapsed` is the clearest case: the README calls it "view state that rides
 * the undo stack", it hides nothing from the document, and reporting a folded
 * group as a change makes "what did we alter since the last review" answer
 * "you looked at it".
 */
export const VIEW_FIELDS = ["collapsed"] as const;

/** What a diff ignores unless the caller replaces the list. */
export const DEFAULT_DIFF_IGNORE: readonly string[] = [...POSITIONAL_FIELDS, ...VIEW_FIELDS];

function diffCollection<T extends { id: string }>(
  base: T[],
  current: T[],
  ignore: Set<string>,
): CollectionDiff {
  const baseBy = new Map(base.map((item) => [item.id, item]));
  const currentBy = new Map(current.map((item) => [item.id, item]));

  const added = current.filter((item) => !baseBy.has(item.id)).map((item) => item.id);
  const removed = base.filter((item) => !currentBy.has(item.id)).map((item) => item.id);

  const changed: ChangedEntry[] = [];
  for (const [id, before] of baseBy) {
    const after = currentBy.get(id);
    if (!after) continue;
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const fields = [...keys]
      .filter((key) => !ignore.has(key))
      .filter(
        (key) =>
          JSON.stringify((before as Record<string, unknown>)[key]) !==
          JSON.stringify((after as Record<string, unknown>)[key]),
      )
      .sort();
    if (fields.length) changed.push({ id, fields });
  }
  return { added, removed, changed };
}

/** Compare two templates by id. `opts.ignore` replaces the positional default. */
export function diffTemplates(
  base: DiagramTemplate,
  current: DiagramTemplate,
  opts: { ignore?: readonly string[] } = {},
): TemplateDiff {
  const ignore = new Set(opts.ignore ?? DEFAULT_DIFF_IGNORE);
  const nodes = diffCollection(base.nodes, current.nodes, ignore);
  const edges = diffCollection(base.edges, current.edges, ignore);
  const zones = diffCollection(base.zones ?? [], current.zones ?? [], ignore);
  const meta = diffMeta(base.meta, current.meta, ignore);
  return {
    nodes,
    edges,
    zones,
    meta,
    summary: {
      added: nodes.added.length + edges.added.length + zones.added.length,
      removed: nodes.removed.length + edges.removed.length + zones.removed.length,
      changed: nodes.changed.length + edges.changed.length + zones.changed.length + (meta.length ? 1 : 0),
    },
  };
}

/**
 * Which document-level fields differ.
 *
 * Retitling a diagram, changing its version tag, or switching its default
 * connector are real edits a reviewer needs to see; before this they were the
 * one part of the document a Compare could not report at all. `views` is
 * excluded — it holds per-view ghost placements, which is placement.
 */
function diffMeta(
  base: DiagramTemplate["meta"],
  current: DiagramTemplate["meta"],
  ignore: ReadonlySet<string>,
): string[] {
  const before = (base ?? {}) as Record<string, unknown>;
  const after = (current ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => key !== "views" && !ignore.has(key))
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort();
}

/**
 * Compare two sequence documents by id.
 *
 * The sequence schema stores no coordinates at all — order IS the layout — so
 * every difference here is structural by construction and there is nothing
 * positional to ignore. Row and column MOVES do show up, as a change to the
 * neighbouring anchors, because in this document moving a step is the edit.
 */
export function diffSequences(
  base: SequenceTemplate,
  current: SequenceTemplate,
  opts: { ignore?: readonly string[] } = {},
): SequenceDiff {
  const ignore = new Set(opts.ignore ?? []);
  const participants = diffCollection(base.participants, current.participants, ignore);
  const messages = diffCollection(base.messages, current.messages, ignore);
  const activations = diffCollection(base.activations ?? [], current.activations ?? [], ignore);
  const fragments = diffCollection(base.fragments ?? [], current.fragments ?? [], ignore);
  const notes = diffCollection(base.notes ?? [], current.notes ?? [], ignore);
  const meta = diffMeta(base.meta, current.meta, ignore);
  const all = [participants, messages, activations, fragments, notes];
  return {
    participants,
    messages,
    activations,
    fragments,
    notes,
    meta,
    summary: {
      added: all.reduce((n, d) => n + d.added.length, 0),
      removed: all.reduce((n, d) => n + d.removed.length, 0),
      changed: all.reduce((n, d) => n + d.changed.length, 0) + (meta.length ? 1 : 0),
    },
  };
}

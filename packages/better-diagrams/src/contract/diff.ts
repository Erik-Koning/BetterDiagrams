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
  summary: { added: number; removed: number; changed: number };
}

/**
 * Fields that describe placement rather than architecture. `points` is a
 * zone's outline or an edge's waypoints; `labelT` is where an edge label sits
 * along its curve; `start`/`end` pin an edge to a side of its node boxes.
 */
export const POSITIONAL_FIELDS = ["x", "y", "w", "h", "labelT", "points", "start", "end"] as const;

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
  const ignore = new Set(opts.ignore ?? POSITIONAL_FIELDS);
  const nodes = diffCollection(base.nodes, current.nodes, ignore);
  const edges = diffCollection(base.edges, current.edges, ignore);
  const zones = diffCollection(base.zones ?? [], current.zones ?? [], ignore);
  return {
    nodes,
    edges,
    zones,
    summary: {
      added: nodes.added.length + edges.added.length + zones.added.length,
      removed: nodes.removed.length + edges.removed.length + zones.removed.length,
      changed: nodes.changed.length + edges.changed.length + zones.changed.length,
    },
  };
}

/**
 * lineage.ts — column lineage: which columns a column is computed from, and
 * which it feeds.
 *
 * "Where does revenue_usd come from?" is not a relationship question. A
 * foreign key says two rows belong together; lineage says one column's
 * values were made from another's, by a job, through a transform. So it is
 * kept apart from the edges: the document's validated `lineage` list, one
 * link per column-to-column derivation, never a line on the canvas — route
 * search, coverage and impact over keys never see it.
 *
 *   validateLineage     repair a document's list (dangling tables pruned)
 *   traceLineage        upstream / downstream from a column, breadth first
 *   lineageChain        the links from the subject to one traced column
 *   sensitiveLineage    columns fed by a sensitive column that do not say so
 *   importOpenLineage   OpenLineage run events with the `columnLineage`
 *                       facet → links, matched to the document's tables
 *
 * Zero dependencies, like every contract module.
 */
import { documentFieldRecords, fieldKey, type FieldDocument, type FieldRef } from "./fields";
import type { LineageLink } from "./lineage-links";
import { DEFAULT_SENSITIVE_TAG_PATTERN } from "./sensitivity";

export { validateLineage, MAX_LINEAGE } from "./lineage-links";
export type { LineageLink } from "./lineage-links";

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

export interface LineageColumn {
  ref: FieldRef;
  /** Links away from the subject (1 for a direct source or target). */
  depth: number;
  direction: "upstream" | "downstream";
  /** The link that reached it. */
  via: string;
}

export interface LineageTrace {
  subject: FieldRef;
  /** Every column reached, nearest first, upstream before downstream at each depth. */
  columns: LineageColumn[];
  /** Ids of the links walked. */
  links: string[];
  /** The walk stopped at `maxDepth` with more to go. */
  truncated: boolean;
}

/**
 * Walk the lineage from a column: upstream to what it is computed from,
 * downstream to what it feeds, or both — breadth first, each column once,
 * so a column reached both ways is listed on the side it was reached first.
 */
export function traceLineage(
  lineage: readonly LineageLink[],
  subject: FieldRef,
  opts: { direction?: "upstream" | "downstream" | "both"; maxDepth?: number } = {},
): LineageTrace {
  const direction = opts.direction ?? "both";
  const maxDepth = opts.maxDepth ?? Infinity;
  const into = new Map<string, LineageLink[]>();
  const out = new Map<string, LineageLink[]>();
  for (const l of lineage) {
    const k = fieldKey(l.to);
    (into.get(k) ?? into.set(k, []).get(k)!).push(l);
    const f = fieldKey(l.from);
    (out.get(f) ?? out.set(f, []).get(f)!).push(l);
  }
  const columns: LineageColumn[] = [];
  const links = new Set<string>();
  let truncated = false;
  const walk = (dir: "upstream" | "downstream") => {
    const seen = new Set([fieldKey(subject)]);
    let frontier = [subject];
    for (let depth = 1; frontier.length; depth++) {
      const next: FieldRef[] = [];
      for (const at of frontier) {
        for (const l of (dir === "upstream" ? into : out).get(fieldKey(at)) ?? []) {
          const ref = dir === "upstream" ? l.from : l.to;
          if (depth > maxDepth) {
            truncated = true;
            continue;
          }
          links.add(l.id);
          const k = fieldKey(ref);
          if (seen.has(k)) continue;
          seen.add(k);
          columns.push({ ref, depth, direction: dir, via: l.id });
          next.push(ref);
        }
      }
      frontier = next;
    }
  };
  if (direction !== "downstream") walk("upstream");
  if (direction !== "upstream") walk("downstream");
  // The subject may feed itself by a cycle; it is never its own column.
  const subjectKey = fieldKey(subject);
  return {
    subject,
    columns: columns.filter((c) => fieldKey(c.ref) !== subjectKey).sort((a, b) => a.depth - b.depth || (a.direction === b.direction ? 0 : a.direction === "upstream" ? -1 : 1)),
    links: [...links],
    truncated,
  };
}

/** The links from the subject to one traced column, in walking order — the "why is this here" chain. */
export function lineageChain(lineage: readonly LineageLink[], trace: LineageTrace, target: FieldRef): LineageLink[] | null {
  const byId = new Map(lineage.map((l) => [l.id, l]));
  const reached = new Map(trace.columns.map((c) => [fieldKey(c.ref), c]));
  const chain: LineageLink[] = [];
  let at = reached.get(fieldKey(target));
  const subjectKey = fieldKey(trace.subject);
  while (at) {
    const link = byId.get(at.via);
    if (!link) return null;
    chain.unshift(link);
    const back = at.direction === "upstream" ? link.to : link.from;
    if (fieldKey(back) === subjectKey) return chain;
    at = reached.get(fieldKey(back));
  }
  return null;
}

/**
 * Columns a sensitive column's values flow into (any number of links
 * downstream) that carry no sensitive tag themselves — where tagging has
 * not kept up with the data. Each with the nearest sensitive source.
 */
export function sensitiveLineage(
  doc: FieldDocument & { lineage?: readonly LineageLink[] },
  opts: { sensitiveTag?: RegExp } = {},
): Array<{ ref: FieldRef; source: FieldRef; hops: number }> {
  const lineage = doc.lineage ?? [];
  if (!lineage.length) return [];
  const tag = opts.sensitiveTag ?? DEFAULT_SENSITIVE_TAG_PATTERN;
  const records = documentFieldRecords(doc);
  const sensitive = (ref: FieldRef) => !!records.get(ref.nodeId)?.find((r) => r.id === ref.fieldId)?.tags?.some((t) => tag.test(t));
  const out = new Map<string, { ref: FieldRef; source: FieldRef; hops: number }>();
  const sources = new Map<string, FieldRef>();
  for (const l of lineage) if (sensitive(l.from)) sources.set(fieldKey(l.from), l.from);
  for (const source of sources.values()) {
    for (const c of traceLineage(lineage, source, { direction: "downstream" }).columns) {
      if (sensitive(c.ref)) continue;
      const k = fieldKey(c.ref);
      const had = out.get(k);
      if (!had || c.depth < had.hops) out.set(k, { ref: c.ref, source, hops: c.depth });
    }
  }
  return [...out.values()].sort((a, b) => a.hops - b.hops);
}

// ── OpenLineage ──────────────────────────────────────────────────────────────

export interface OpenLineageImport {
  lineage: LineageLink[];
  /** Datasets no table matched, with how many column links named them. */
  unmatched: Array<{ namespace: string; name: string; links: number }>;
  /** Links whose column the matched table does not list — kept, under the name the event gave. */
  unknownColumns: FieldRef[];
  events: number;
}

export interface OpenLineageOptions {
  /**
   * Which table a dataset is. Default: a table whose entity name, label or id
   * equals the dataset name, or its last dotted segment ("public.orders" →
   * "orders"), ignoring case.
   */
  resolveDataset?: (dataset: { namespace: string; name: string }) => string | undefined;
}

/** Events from a JSON array, one event object, `{ events: [...] }`, or newline-delimited JSON. */
export function parseOpenLineageEvents(input: string | unknown): unknown[] {
  let value: unknown = input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    try {
      value = JSON.parse(trimmed);
    } catch {
      value = trimmed
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return null;
          }
        })
        .filter((v) => v !== null);
    }
  }
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.events)) return value.events;
  return isRecord(value) ? [value] : [];
}

/**
 * Read OpenLineage run events (https://openlineage.io) — the `columnLineage`
 * dataset facet on each output — into lineage links on this document.
 * Datasets are matched to tables (see `resolveDataset`), columns to the
 * table's fields by name; the same derivation seen in several runs is one
 * link. Transform text is the facet's description, or its type.
 */
export function importOpenLineage(doc: FieldDocument, input: string | unknown, opts: OpenLineageOptions = {}): OpenLineageImport {
  const events = parseOpenLineageEvents(input);
  const records = documentFieldRecords(doc);
  const byName = new Map<string, string>();
  const norm = (s: string) => s.trim().toLowerCase();
  for (const n of doc.nodes) {
    const model = isRecord(n.data?.model) ? (n.data!.model as Record<string, unknown>) : {};
    for (const name of [n.id, n.label, typeof model.name === "string" ? model.name : undefined]) {
      if (name && !byName.has(norm(name))) byName.set(norm(name), n.id);
    }
  }
  const resolve =
    opts.resolveDataset ??
    ((d: { namespace: string; name: string }) => byName.get(norm(d.name)) ?? byName.get(norm(d.name.split(".").at(-1) ?? d.name)));
  const columnOf = (nodeId: string, name: string, unknown: FieldRef[]): FieldRef => {
    const rec = records.get(nodeId)?.find((r) => norm(r.name) === norm(name) || norm(r.id) === norm(name));
    const ref = { nodeId, fieldId: rec?.id ?? name };
    if (!rec) unknown.push(ref);
    return ref;
  };

  const links = new Map<string, LineageLink>();
  const unmatched = new Map<string, { namespace: string; name: string; links: number }>();
  const unknownColumns: FieldRef[] = [];
  const miss = (namespace: string, name: string) => {
    const k = `${namespace}\u0000${name}`;
    const had = unmatched.get(k);
    if (had) had.links++;
    else unmatched.set(k, { namespace, name, links: 1 });
  };
  for (const event of events) {
    if (!isRecord(event)) continue;
    const job = isRecord(event.job) && typeof event.job.name === "string" ? event.job.name : undefined;
    for (const output of Array.isArray(event.outputs) ? event.outputs : []) {
      if (!isRecord(output)) continue;
      const outNs = String(output.namespace ?? "");
      const outName = String(output.name ?? "");
      const facet = isRecord(output.facets) && isRecord(output.facets.columnLineage) ? output.facets.columnLineage : null;
      const fields = facet && isRecord(facet.fields) ? facet.fields : null;
      if (!fields) continue;
      const toNode = resolve({ namespace: outNs, name: outName });
      for (const [column, spec] of Object.entries(fields)) {
        if (!isRecord(spec) || !Array.isArray(spec.inputFields)) continue;
        for (const input of spec.inputFields) {
          if (!isRecord(input) || typeof input.field !== "string") continue;
          const inNs = String(input.namespace ?? "");
          const inName = String(input.name ?? "");
          const fromNode = resolve({ namespace: inNs, name: inName });
          if (!toNode) miss(outNs, outName);
          if (!fromNode) miss(inNs, inName);
          if (!toNode || !fromNode) continue;
          const from = columnOf(fromNode, input.field, unknownColumns);
          const to = columnOf(toNode, column, unknownColumns);
          if (fieldKey(from) === fieldKey(to)) continue;
          const id = `${from.nodeId}.${from.fieldId}->${to.nodeId}.${to.fieldId}`;
          if (links.has(id)) continue;
          // The current spec describes each input's transformations; older
          // producers describe the output column once.
          const t = Array.isArray(input.transformations) && isRecord(input.transformations[0]) ? input.transformations[0] : null;
          const transform =
            (t && (text(t.description, 1000) ?? [t.type, t.subtype].filter((x) => typeof x === "string").join(" ").trim())) ||
            text(spec.transformationDescription, 1000) ||
            text(spec.transformationType, 100);
          links.set(id, { id, from, to, ...(transform ? { transform } : {}), ...(job ? { job } : {}) });
        }
      }
    }
  }
  const seenUnknown = new Set<string>();
  return {
    lineage: [...links.values()],
    unmatched: [...unmatched.values()],
    unknownColumns: unknownColumns.filter((r) => !seenUnknown.has(fieldKey(r)) && !!seenUnknown.add(fieldKey(r))),
    events: events.length,
  };
}

/** Merge imported links into a document's list: an id already there is replaced. */
export function mergeLineage(existing: readonly LineageLink[] | undefined, incoming: readonly LineageLink[]): LineageLink[] {
  const ids = new Set(incoming.map((l) => l.id));
  return [...(existing ?? []).filter((l) => !ids.has(l.id)), ...incoming];
}

/** "3 upstream columns · 5 downstream". */
export function lineageHeadline(trace: LineageTrace): string {
  const up = trace.columns.filter((c) => c.direction === "upstream").length;
  const down = trace.columns.length - up;
  return `${up} upstream column${up === 1 ? "" : "s"} · ${down} downstream`;
}

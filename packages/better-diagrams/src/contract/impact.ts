/**
 * impact.ts — what depends on a table or a key, and what a change to it
 * would reach.
 *
 * A foreign key `source → target` means the source DEPENDS on the target.
 * So the dependents of T are the tables with a key path leading to T (the
 * edges walked backwards), its dependencies the ones it leads to (walked
 * forwards). The references panel answers one hop; this answers all of
 * them, with the first hop that reached each table — the "why" — and a way
 * to rebuild the chain from the subject to it.
 *
 * Two things a reviewer asks about a delete come with it: what CASCADES
 * (edges whose import says `cascadeDelete`, or whose kind is composition —
 * the child goes with its parent), and what BLOCKS it (a `restrict` or
 * `no action` delete rule on a key pointing at the subject).
 *
 * A field subject (`Account.Id`) holds only the first hop to that field —
 * the edges landing on it, by the same rule `referencesTo` uses; after that
 * the walk is table-level. Linear: one breadth-first search.
 *
 * Zero dependencies, like every contract module.
 */
import type { GraphWalk } from "./graph";
import { edgeFieldIds, referencedKey, type FieldDocument, type Pin } from "./fields";

export interface ImpactOptions {
  /** `dependents` (the default): what depends on the subject; `dependencies`: what it depends on. */
  direction?: "dependents" | "dependencies";
  /** Stop after this many hops. Default: no limit (the walk is linear anyway). */
  maxDepth?: number;
  /** `keys` (the default): walk only lines carrying a key; `all`: any line. */
  via?: "keys" | "all";
}

export interface ImpactNode {
  id: string;
  depth: number;
  /** The first hop that reached it: the edge, the table it came from, and the key it carries. */
  via: { edgeId: string; from: string; field?: string };
  /** Reached over cascading edges only: a delete of the subject deletes it. */
  cascade: boolean;
  /** The key on its `via` hop must hold a value. */
  required: boolean;
}

export interface ImpactResult {
  subject: Pin;
  direction: "dependents" | "dependencies";
  /** Breadth-first order, nearest first; the subject itself is not listed. */
  nodes: ImpactNode[];
  /** Node ids per depth, index 0 = one hop away. */
  byDepth: string[][];
  /** Every edge walked. */
  edges: string[];
  /** The tables a delete of the subject would cascade to (dependents only). */
  cascade: string[];
  /** Keys whose delete rule would block a delete of the subject (dependents only). */
  blockers: Array<{ edgeId: string; from: string; field?: string }>;
  /** Tables reached whose import marks them outside the model (external stubs). */
  outsideModel: string[];
}

const modelOf = (bag: Record<string, unknown> | undefined): Record<string, unknown> =>
  bag?.model && typeof bag.model === "object" && !Array.isArray(bag.model) ? (bag.model as Record<string, unknown>) : {};

const cascades = (e: FieldDocument["edges"][number]) => {
  const m = modelOf(e.data);
  return m.cascadeDelete === true || e.relation === "composition" || m.kind === "composition";
};
const blocks = (e: FieldDocument["edges"][number]) => {
  const rule = modelOf(e.data).deleteConstraint;
  return typeof rule === "string" && /^(restrict|no[ _]?action)$/i.test(rule.trim());
};

export function impactOf(doc: FieldDocument, subject: Pin, opts: ImpactOptions = {}): ImpactResult {
  const direction = opts.direction ?? "dependents";
  const keysOnly = (opts.via ?? "keys") === "keys";
  const maxDepth = opts.maxDepth ?? Infinity;
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]));
  const implicit = subject.fieldId !== undefined ? referencedKey(doc, { label: "", nodeId: subject.nodeId })?.fieldId : undefined;

  // Arcs in the walking direction: dependents walk an edge from its target
  // to its source, dependencies from source to target.
  type Arc = { edge: FieldDocument["edges"][number]; to: string };
  const arcs = new Map<string, Arc[]>();
  for (const e of doc.edges) {
    if (!nodeById.has(e.source) || !nodeById.has(e.target) || e.source === e.target) continue;
    if (keysOnly && edgeFieldIds(e).start === undefined) continue;
    const [from, to] = direction === "dependents" ? [e.target, e.source] : [e.source, e.target];
    const list = arcs.get(from);
    if (list) list.push({ edge: e, to });
    else arcs.set(from, [{ edge: e, to }]);
  }
  /** Whether a first-hop edge touches the subject's field. */
  const holdsField = (e: FieldDocument["edges"][number]) => {
    if (subject.fieldId === undefined) return true;
    const ends = edgeFieldIds(e);
    return direction === "dependents" ? (ends.end ?? implicit) === subject.fieldId : ends.start === subject.fieldId;
  };

  const seen = new Map<string, ImpactNode>();
  const edges: string[] = [];
  const blockers: ImpactResult["blockers"] = [];
  const queue: Array<{ id: string; depth: number; cascade: boolean }> = [{ id: subject.nodeId, depth: 0, cascade: true }];
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head]!;
    if (at.depth >= maxDepth) continue;
    for (const { edge, to } of arcs.get(at.id) ?? []) {
      if (at.depth === 0 && !holdsField(edge)) continue;
      if (to === subject.nodeId) continue;
      edges.push(edge.id);
      if (direction === "dependents" && at.depth === 0 && blocks(edge)) {
        const field = edgeFieldIds(edge).start;
        blockers.push({ edgeId: edge.id, from: edge.source, ...(field !== undefined ? { field } : {}) });
      }
      if (seen.has(to)) continue;
      const field = edgeFieldIds(edge).start;
      const m = modelOf(edge.data);
      const node: ImpactNode = {
        id: to,
        depth: at.depth + 1,
        via: { edgeId: edge.id, from: at.id, ...(field !== undefined ? { field } : {}) },
        cascade: direction === "dependents" && at.cascade && cascades(edge),
        required: m.required === true,
      };
      seen.set(to, node);
      queue.push({ id: to, depth: at.depth + 1, cascade: node.cascade });
    }
  }
  const nodes = [...seen.values()];
  const byDepth: string[][] = [];
  for (const n of nodes) (byDepth[n.depth - 1] ??= []).push(n.id);
  const outsideModel = nodes
    .filter((n) => modelOf(nodeById.get(n.id)?.data).shape === "external")
    .map((n) => n.id);
  return {
    subject,
    direction,
    nodes,
    byDepth,
    edges: [...new Set(edges)],
    cascade: nodes.filter((n) => n.cascade).map((n) => n.id),
    blockers,
    outsideModel,
  };
}

/** The chain from the subject to one impacted table, subject first — for lighting as a route. */
export function impactChain(result: ImpactResult, nodeId: string): GraphWalk | null {
  const byId = new Map(result.nodes.map((n) => [n.id, n]));
  const nodes = [nodeId];
  const edges: string[] = [];
  let cursor = byId.get(nodeId);
  if (!cursor) return null;
  while (cursor) {
    edges.unshift(cursor.via.edgeId);
    nodes.unshift(cursor.via.from);
    cursor = byId.get(cursor.via.from);
  }
  return nodes[0] === result.subject.nodeId ? { nodes, edges } : null;
}

/** "23 tables depend on Account.Id — 4 by cascade, 2 blockers". */
export function impactHeadline(result: ImpactResult, subjectLabel: string): string {
  const n = result.nodes.length;
  const tables = `${n} table${n === 1 ? "" : "s"}`;
  const head = result.direction === "dependents"
    ? `${tables} depend${n === 1 ? "s" : ""} on ${subjectLabel}`
    : `${subjectLabel} depends on ${tables}`;
  const extra = [
    result.cascade.length ? `${result.cascade.length} by cascade` : "",
    result.blockers.length ? `${result.blockers.length} blocker${result.blockers.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return extra.length ? `${head} — ${extra.join(", ")}` : head;
}

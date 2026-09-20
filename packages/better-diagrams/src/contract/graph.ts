/**
 * graph.ts — searching the diagram as a graph.
 *
 * `paths.ts` resolves a walk someone has already written down. This module
 * FINDS walks: the shortest route between two nodes, the k best alternatives,
 * every simple route up to a length, and the neighbourhood around a node —
 * the questions a reader asks of any diagram with more than a dozen boxes
 * ("how does the CDN reach the database?", "what is two hops from Orders?").
 *
 * Every search reads the same structural slice a `DiagramTemplate` already
 * satisfies, so a scoped view document or a host's own graph serves as well.
 * Results come back as {@link GraphWalk}s — the node ids visited and the edge
 * ids travelled, interleaved — and `walkToPath` turns one into a `DiagramPath`
 * the canvas can light up.
 *
 * Direction is honoured by default: an edge is walked source → target, except
 * one whose `direction` is `both` or `none`, which reads as a two-way link.
 * `undirected` ignores arrows entirely. Ids and orderings are deterministic:
 * ties break by document order, so a result is stable across runs.
 *
 * Zero dependencies, like every contract module.
 */
import type { DiagramPath } from "./paths";
import { edgeFieldIds, fieldKey, type FieldRef } from "./fields";

/** The slice of a document the searches read — structural, so a view doc serves too. */
export interface GraphDocument {
  nodes: ReadonlyArray<{ id: string }>;
  edges: ReadonlyArray<{
    id: string;
    source: string;
    target: string;
    direction?: string;
    /** Row anchors — what makes a route field-to-field rather than table-to-table. */
    startField?: string;
    endField?: string;
    data?: Record<string, unknown>;
  }>;
}

export interface GraphOptions {
  /** Walk every edge both ways, whatever its arrow. Default false. */
  undirected?: boolean;
  /** Which edges may be walked. Absent = all of them. */
  edgeFilter?: (edge: GraphDocument["edges"][number]) => boolean;
  /** Which nodes may be visited (the endpoints are always allowed). Absent = all. */
  nodeFilter?: (node: GraphDocument["nodes"][number]) => boolean;
}

/**
 * One route: `nodes[i]` is joined to `nodes[i + 1]` by `edges[i]`, so a walk
 * of n nodes has n − 1 edges and a walk from a node to itself has none.
 */
export interface GraphWalk {
  nodes: string[];
  edges: string[];
}

/** The number of hops a walk takes. */
export const walkLength = (walk: GraphWalk): number => walk.edges.length;

/** Whether two walks travel exactly the same edges in the same order. */
export function sameWalk(a: GraphWalk, b: GraphWalk): boolean {
  return (
    a.nodes.length === b.nodes.length &&
    a.nodes[0] === b.nodes[0] &&
    a.edges.length === b.edges.length &&
    a.edges.every((id, i) => id === b.edges[i])
  );
}

interface Arc {
  edge: string;
  to: string;
}

/** Adjacency lists in document order, respecting direction and the filters. */
function buildAdjacency(doc: GraphDocument, opts: GraphOptions): Map<string, Arc[]> {
  const known = new Set(doc.nodes.map((n) => n.id));
  const allowed = opts.nodeFilter
    ? new Set(doc.nodes.filter(opts.nodeFilter).map((n) => n.id))
    : known;
  const out = new Map<string, Arc[]>();
  for (const id of known) out.set(id, []);
  for (const e of doc.edges) {
    if (!known.has(e.source) || !known.has(e.target)) continue;
    if (opts.edgeFilter && !opts.edgeFilter(e)) continue;
    // A self-loop never advances a simple walk; leaving it out keeps every
    // search from considering a hop that goes nowhere.
    if (e.source === e.target) continue;
    const twoWay = opts.undirected || e.direction === "both" || e.direction === "none";
    out.get(e.source)!.push({ edge: e.id, to: e.target });
    if (twoWay) out.get(e.target)!.push({ edge: e.id, to: e.source });
  }
  // The node filter bars entry: an excluded node is never stepped onto. The
  // searches exempt their own endpoints before the filter gets here.
  if (allowed !== known) {
    for (const [id, arcs] of out) out.set(id, arcs.filter((a) => allowed.has(a.to)));
  }
  return out;
}

/**
 * Breadth-first search over prepared adjacency, with the sets Yen's
 * algorithm needs to carve a spur: nodes and edges that may not be used.
 */
function bfs(
  adj: Map<string, Arc[]>,
  from: string,
  to: string,
  banned: { nodes?: ReadonlySet<string>; edges?: ReadonlySet<string> } = {},
): GraphWalk | null {
  if (!adj.has(from) || !adj.has(to)) return null;
  if (from === to) return { nodes: [from], edges: [] };
  const parent = new Map<string, Arc & { from: string }>();
  const seen = new Set<string>([from]);
  const queue: string[] = [from];
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head];
    for (const arc of adj.get(at) ?? []) {
      if (seen.has(arc.to)) continue;
      if (banned.edges?.has(arc.edge)) continue;
      if (banned.nodes?.has(arc.to)) continue;
      seen.add(arc.to);
      parent.set(arc.to, { ...arc, from: at });
      if (arc.to === to) {
        const nodes: string[] = [to];
        const edges: string[] = [];
        let cursor = to;
        while (cursor !== from) {
          const p = parent.get(cursor)!;
          edges.unshift(p.edge);
          nodes.unshift(p.from);
          cursor = p.from;
        }
        return { nodes, edges };
      }
      queue.push(arc.to);
    }
  }
  return null;
}

/** The endpoints are always allowed, even when the node filter says otherwise. */
const endpoints = (from: string, to: string) => new Set([from, to]);

function adjacencyFor(doc: GraphDocument, from: string, to: string, opts: GraphOptions) {
  const nodeFilter = opts.nodeFilter;
  const ends = endpoints(from, to);
  return buildAdjacency(doc, {
    ...opts,
    ...(nodeFilter ? { nodeFilter: (n) => ends.has(n.id) || nodeFilter(n) } : {}),
  });
}

/**
 * The fewest-hop route from one node to another, or null when none exists.
 * Among equally short routes the first in document order wins. A node to
 * itself is a walk of one node and no edges.
 */
export function shortestPath(
  doc: GraphDocument,
  from: string,
  to: string,
  opts: GraphOptions = {},
): GraphWalk | null {
  return bfs(adjacencyFor(doc, from, to, opts), from, to);
}

/**
 * The k shortest SIMPLE routes (no node visited twice), shortest first —
 * Yen's algorithm over hop counts. Fewer than k come back when the graph has
 * fewer distinct routes. Routes of equal length keep the order they were
 * found in, which follows document order, so the result is stable.
 *
 * Parallel edges count as distinct routes: two references from Contact to
 * Account are two ways to get there, and a reader wants to see both.
 */
export function shortestPaths(
  doc: GraphDocument,
  from: string,
  to: string,
  k: number,
  opts: GraphOptions & { maxDepth?: number } = {},
): GraphWalk[] {
  return yen(adjacencyFor(doc, from, to, opts), from, to, k, opts.maxDepth ?? Infinity).walks;
}

/**
 * Yen's algorithm over prepared adjacency. `banned` nodes are never entered
 * (the field searches use it to keep a route from passing back through its
 * own endpoints); routes longer than `maxDepth` are dropped. `truncated`
 * says a route was left out: k reached with candidates waiting, or a route
 * pruned by depth.
 */
function yen(
  adj: Map<string, Arc[]>,
  from: string,
  to: string,
  k: number,
  maxDepth: number,
  banned: ReadonlySet<string> = new Set(),
): { walks: GraphWalk[]; truncated: boolean } {
  const first = bfs(adj, from, to, { nodes: banned });
  if (!first || k < 1) return { walks: [], truncated: false };
  if (first.edges.length > maxDepth) return { walks: [], truncated: true };
  const found: GraphWalk[] = [first];
  const candidates: GraphWalk[] = [];
  let truncated = false;

  while (found.length < k) {
    const prev = found[found.length - 1];
    for (let i = 0; i < prev.nodes.length - 1; i++) {
      const spur = prev.nodes[i];
      const rootNodes = prev.nodes.slice(0, i + 1);
      const rootEdges = prev.edges.slice(0, i);
      // Every found route sharing this root must leave the spur node some
      // other way, or the search would rediscover it.
      const bannedEdges = new Set<string>();
      for (const p of found) {
        if (p.edges.length > i && rootEdges.every((id, j) => id === p.edges[j])) {
          bannedEdges.add(p.edges[i]);
        }
      }
      // And the spur must not loop back through the root.
      const bannedNodes = new Set([...banned, ...rootNodes.slice(0, -1)]);
      const spurWalk = bfs(adj, spur, to, { nodes: bannedNodes, edges: bannedEdges });
      if (!spurWalk) continue;
      const total: GraphWalk = {
        nodes: [...rootNodes.slice(0, -1), ...spurWalk.nodes],
        edges: [...rootEdges, ...spurWalk.edges],
      };
      if (total.edges.length > maxDepth) {
        truncated = true;
        continue;
      }
      if (found.some((p) => sameWalk(p, total)) || candidates.some((p) => sameWalk(p, total))) {
        continue;
      }
      candidates.push(total);
    }
    if (!candidates.length) break;
    // Stable sort: equal lengths keep discovery order.
    candidates.sort((a, b) => a.edges.length - b.edges.length);
    found.push(candidates.shift()!);
  }
  if (found.length === k && candidates.length) truncated = true;
  return { walks: found, truncated };
}

/**
 * Every simple route from one node to another up to `maxDepth` hops, in
 * depth-first document order. Bounded twice — by depth and by `limit` on
 * the number returned — because the count can explode on a dense graph and
 * a reader never wants more than a screenful anyway. Sorted shortest first.
 */
export function allSimplePaths(
  doc: GraphDocument,
  from: string,
  to: string,
  opts: GraphOptions & { maxDepth?: number; limit?: number } = {},
): GraphWalk[] {
  const maxDepth = opts.maxDepth ?? 6;
  const limit = opts.limit ?? 100;
  const adj = adjacencyFor(doc, from, to, opts);
  if (!adj.has(from) || !adj.has(to)) return [];
  if (from === to) return [{ nodes: [from], edges: [] }];
  const out: GraphWalk[] = [];
  const nodes: string[] = [from];
  const edges: string[] = [];
  const onPath = new Set<string>([from]);

  const visit = (at: string) => {
    if (out.length >= limit || edges.length >= maxDepth) return;
    for (const arc of adj.get(at) ?? []) {
      if (onPath.has(arc.to)) continue;
      nodes.push(arc.to);
      edges.push(arc.edge);
      if (arc.to === to) {
        out.push({ nodes: [...nodes], edges: [...edges] });
      } else {
        onPath.add(arc.to);
        visit(arc.to);
        onPath.delete(arc.to);
      }
      nodes.pop();
      edges.pop();
      if (out.length >= limit) return;
    }
  };
  visit(from);
  return out.sort((a, b) => a.edges.length - b.edges.length);
}

/**
 * The subgraph within `depth` hops of one or more nodes: every node reached
 * (with how far away it is, 0 for the starts) and every edge whose two ends
 * are both in that set — not only the edges the search walked, so a
 * neighbourhood drawn on its own shows its internal wiring complete.
 *
 * Direction is honoured as everywhere else, so on a directed graph this is
 * "what the starts reach"; pass `undirected` for "what they touch".
 */
export function neighbourhood(
  doc: GraphDocument,
  from: string | readonly string[],
  depth: number,
  opts: GraphOptions = {},
): { nodes: Map<string, number>; edges: string[] } {
  const starts = typeof from === "string" ? [from] : [...from];
  const adj = buildAdjacency(doc, opts);
  // The same multi-source walk `reachableFrom` makes, with no field to hold
  // a first step to. (Key coverage runs a third in `coverage.ts`, over a
  // graph of its own: adjacency filtered to the chosen keys, built once and
  // reused across thousands of candidate evaluations — routing it through
  // here would rebuild that adjacency on every call.)
  const nodes = distances(
    adj,
    starts.map((id) => ({ id, arcs: null })),
    depth,
  );
  return { nodes, edges: edgesWithin(doc, nodes, opts) };
}

/**
 * A `DiagramPath` that `resolvePath` expands back to exactly this walk.
 *
 * Node ids are the currency of `steps`; an edge id goes between two nodes
 * only where the document joins them by more than one edge, since that is
 * the one case the resolver cannot infer. The result is as short as a path
 * written by hand.
 */
export function walkToPath(
  doc: GraphDocument,
  walk: GraphWalk,
  path: { id: string; title?: string } & Partial<Omit<DiagramPath, "id" | "title" | "steps">>,
): DiagramPath {
  const between = new Map<string, number>();
  const pairKey = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);
  for (const e of doc.edges) {
    const key = pairKey(e.source, e.target);
    between.set(key, (between.get(key) ?? 0) + 1);
  }
  const steps: string[] = [];
  walk.nodes.forEach((id, i) => {
    if (i > 0) {
      const prev = walk.nodes[i - 1];
      if ((between.get(pairKey(prev, id)) ?? 0) > 1) steps.push(walk.edges[i - 1]);
    }
    steps.push(id);
  });
  const { id, title, ...rest } = path;
  return {
    id,
    title: title ?? `${walk.nodes[0]} → ${walk.nodes[walk.nodes.length - 1]}`,
    steps,
    ...rest,
  };
}

// ─── Field-level search ──────────────────────────────────────────────────────
//
// A route between FIELDS is a route between their tables whose first hop
// leaves through an edge anchored at the one field and whose last hop
// arrives on an edge anchored at the other. "Anchored" is `edgeFieldIds`
// (contract/fields.ts): the row anchors, else the dialect's own record of
// the field. An endpoint with no field, or a field that anchors no edge on
// this document, falls back to the table with the `constrained` flag false.

/** A table, optionally narrowed to one of its fields. */
export interface FieldEndpoint {
  nodeId: string;
  fieldId?: string;
}

export interface FieldPathOptions extends GraphOptions {
  /** How many routes to return. Default 10. */
  k?: number;
  /** Longest route, in hops. Default 10. */
  maxDepth?: number;
}

export interface FieldPathResult {
  /** Shortest first; every one leaves and arrives through the pinned fields when it could. */
  walks: GraphWalk[];
  /** Whether each end was held to its field, or fell back to the table. */
  constrained: { from: boolean; to: boolean };
  /** A route was left out: k reached with more waiting, or a route pruned by depth. */
  truncated: boolean;
}

/** How many first × last hop combinations a field search tries before giving up on completeness. */
const ANCHOR_PAIR_CAP = 36;

/** Adjacency with every arc reversed — what "arrives at" reads as "leaves from". */
function reverseAdjacency(adj: Map<string, Arc[]>, doc: GraphDocument): Map<string, Arc[]> {
  const out = new Map<string, Arc[]>();
  for (const id of adj.keys()) out.set(id, []);
  const order = new Map(doc.edges.map((e, i) => [e.id, i]));
  for (const [from, arcs] of adj) for (const arc of arcs) out.get(arc.to)!.push({ edge: arc.edge, to: from });
  // Document order, like the forward lists, so ties break the same way.
  for (const arcs of out.values()) arcs.sort((a, b) => (order.get(a.edge) ?? 0) - (order.get(b.edge) ?? 0));
  return out;
}

/**
 * The arcs out of an endpoint's node that travel an edge anchored at its
 * field — on whichever side of the edge touches the node, so the same
 * predicate serves forward and reversed adjacency. Null = unconstrained.
 */
function anchoredArcs(
  adj: Map<string, Arc[]>,
  edgeById: Map<string, GraphDocument["edges"][number]>,
  endpoint: FieldEndpoint,
): Arc[] | null {
  if (!endpoint.fieldId) return null;
  const { nodeId, fieldId } = endpoint;
  const out = (adj.get(nodeId) ?? []).filter((arc) => {
    const e = edgeById.get(arc.edge);
    if (!e) return false;
    const { start, end } = edgeFieldIds(e);
    return (e.source === nodeId && start === fieldId && arc.to === e.target) ||
      (e.target === nodeId && end === fieldId && arc.to === e.source);
  });
  return out.length ? out : null;
}

const edgeIndex = (doc: GraphDocument) => new Map(doc.edges.map((e) => [e.id, e]));

/**
 * The k shortest simple routes from one field to another. The middle of the
 * route never passes back through either table. Two fields of the same
 * table have no route: a simple walk cannot leave and return.
 */
export function fieldPaths(
  doc: GraphDocument,
  from: FieldEndpoint,
  to: FieldEndpoint,
  opts: FieldPathOptions = {},
): FieldPathResult {
  const k = opts.k ?? 10;
  const maxDepth = opts.maxDepth ?? 10;
  const adj = adjacencyFor(doc, from.nodeId, to.nodeId, opts);
  const edgeById = edgeIndex(doc);
  const firstArcs = anchoredArcs(adj, edgeById, from);
  const lastArcs = anchoredArcs(reverseAdjacency(adj, doc), edgeById, to);
  const constrained = { from: firstArcs !== null, to: lastArcs !== null };
  if (!adj.has(from.nodeId) || !adj.has(to.nodeId) || from.nodeId === to.nodeId) {
    return { walks: [], constrained, truncated: false };
  }

  const banned = new Set<string>();
  if (firstArcs) banned.add(from.nodeId);
  if (lastArcs) banned.add(to.nodeId);
  const walks: GraphWalk[] = [];
  let truncated = false;
  const consider = (walk: GraphWalk) => {
    if (walk.edges.length > maxDepth) {
      truncated = true;
      return;
    }
    if (!walks.some((w) => sameWalk(w, walk))) walks.push(walk);
  };

  // The one-hop route: an edge anchored at both fields.
  if (firstArcs && lastArcs) {
    for (const f of firstArcs) {
      if (f.to === to.nodeId && lastArcs.some((l) => l.edge === f.edge)) {
        consider({ nodes: [from.nodeId, to.nodeId], edges: [f.edge] });
      }
    }
  }

  const starts = firstArcs
    ? firstArcs.map((f) => ({ nodes: [from.nodeId], edges: [f.edge], at: f.to }))
    : [{ nodes: [] as string[], edges: [] as string[], at: from.nodeId }];
  const ends = lastArcs
    ? lastArcs.map((l) => ({ nodes: [to.nodeId], edges: [l.edge], at: l.to }))
    : [{ nodes: [] as string[], edges: [] as string[], at: to.nodeId }];
  let pairs = 0;
  for (const s of starts) {
    for (const e of ends) {
      if (banned.has(s.at) || banned.has(e.at)) continue;
      if (++pairs > ANCHOR_PAIR_CAP) {
        truncated = true;
        break;
      }
      const inner = yen(adj, s.at, e.at, k, maxDepth - s.edges.length - e.edges.length, banned);
      if (inner.truncated) truncated = true;
      for (const w of inner.walks) {
        consider({ nodes: [...s.nodes, ...w.nodes, ...e.nodes], edges: [...s.edges, ...w.edges, ...e.edges] });
      }
    }
  }
  walks.sort((a, b) => a.edges.length - b.edges.length);
  if (walks.length > k) truncated = true;
  return { walks: walks.slice(0, k), constrained, truncated };
}

export interface BetweenOptions extends GraphOptions {
  /** Longest route counted, in hops. Default 8 — a definition, not a truncation. */
  maxDepth?: number;
  /** Enumeration stops after this many expansions. Default 20 000. */
  limit?: number;
  /** …or after this many milliseconds. Default 300. */
  budgetMs?: number;
  /** The clock, injectable for tests. Default `performance.now`. */
  now?: () => number;
}

export interface BetweenResult {
  /** Exact, under the bounds: on at least one enumerated simple route. */
  onRoutes: { nodes: Set<string>; edges: Set<string> };
  /**
   * The cheap superset: within `maxDepth` of both ends by shortest distance
   * (two breadth-first searches). Every node on a route is here; a node here
   * may only sit on walks that revisit something.
   */
  corridor: { nodes: Set<string>; edges: Set<string> };
  /** Simple routes completed by the enumeration. */
  routes: number;
  /** The enumeration was stopped by `limit` or `budgetMs` — `onRoutes` may be incomplete. */
  truncated: boolean;
  constrained: { from: boolean; to: boolean };
}

/** Every edge whose two ends were both reached — what a neighbourhood is wired by. */
function edgesWithin(
  doc: GraphDocument,
  reached: ReadonlyMap<string, number>,
  opts: GraphOptions,
): string[] {
  return doc.edges
    .filter((e) => reached.has(e.source) && reached.has(e.target))
    .filter((e) => !opts.edgeFilter || opts.edgeFilter(e))
    .map((e) => e.id);
}

/**
 * Multi-source BFS distances, with each seed's first step optionally held to
 * given arcs, stopping `maxDepth` hops out. Both reachability answers —
 * `neighbourhood` and `reachableFrom` — are this one walk.
 */
function distances(
  adj: Map<string, Arc[]>,
  seeds: Array<{ id: string; arcs: Arc[] | null }>,
  maxDepth = Infinity,
): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  const sealed = new Set<string>();
  for (const seed of seeds) {
    if (!adj.has(seed.id) || dist.has(seed.id)) continue;
    dist.set(seed.id, 0);
    if (seed.arcs) {
      sealed.add(seed.id);
      for (const arc of seed.arcs) {
        if (dist.has(arc.to)) continue;
        dist.set(arc.to, 1);
        queue.push(arc.to);
      }
    } else {
      queue.push(seed.id);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head];
    if (sealed.has(at)) continue;
    const d = dist.get(at)!;
    if (d >= maxDepth) continue;
    for (const arc of adj.get(at) ?? []) {
      if (dist.has(arc.to)) continue;
      dist.set(arc.to, d + 1);
      queue.push(arc.to);
    }
  }
  return dist;
}

const clock = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();

/**
 * The bounded enumeration behind `between` and `keyFrequency`: every simple
 * route from `a` to `b` inside the corridor, handed to `onRoute` as it is
 * completed, until the expansion limit or the time budget stops it.
 */
export function enumerateRoutes(
  doc: GraphDocument,
  a: FieldEndpoint,
  b: FieldEndpoint,
  opts: BetweenOptions,
  onRoute: (walk: GraphWalk) => void,
): Omit<BetweenResult, "onRoutes"> {
  const maxDepth = opts.maxDepth ?? 8;
  const limit = opts.limit ?? 20_000;
  const budgetMs = opts.budgetMs ?? 300;
  const now = opts.now ?? clock;
  const adj = adjacencyFor(doc, a.nodeId, b.nodeId, opts);
  const edgeById = edgeIndex(doc);
  const rev = reverseAdjacency(adj, doc);
  const firstArcs = anchoredArcs(adj, edgeById, a);
  const lastArcs = anchoredArcs(rev, edgeById, b);
  const constrained = { from: firstArcs !== null, to: lastArcs !== null };
  const empty = (): Omit<BetweenResult, "onRoutes"> => ({
    corridor: { nodes: new Set(), edges: new Set() },
    routes: 0,
    truncated: false,
    constrained,
  });
  if (!adj.has(a.nodeId) || !adj.has(b.nodeId) || a.nodeId === b.nodeId) return empty();

  // Tier 2: within reach of both ends.
  const distA = distances(adj, [{ id: a.nodeId, arcs: firstArcs }]);
  const distB = distances(rev, [{ id: b.nodeId, arcs: lastArcs }]);
  const corridorNodes = new Set<string>();
  for (const [id, da] of distA) {
    const db = distB.get(id);
    if (db !== undefined && da + db <= maxDepth) corridorNodes.add(id);
  }
  if (!corridorNodes.has(b.nodeId)) return { ...empty(), corridor: { nodes: new Set([a.nodeId]), edges: new Set() } };
  const corridorEdges = new Set<string>();
  for (const [from, arcs] of adj) {
    if (!corridorNodes.has(from)) continue;
    for (const arc of arcs) {
      if (!corridorNodes.has(arc.to)) continue;
      if ((distA.get(from) ?? Infinity) + 1 + (distB.get(arc.to) ?? Infinity) <= maxDepth) corridorEdges.add(arc.edge);
    }
  }

  // Tier 1: enumerate simple routes inside the corridor, pruned by the
  // distance still needed to reach b, stopped by the expansion and time
  // bounds.
  const lastEdges = lastArcs ? new Set(lastArcs.map((l) => l.edge)) : null;
  let routes = 0;
  let expansions = 0;
  let truncated = false;
  const started = now();
  const onPath = new Set<string>([a.nodeId]);
  const nodes: string[] = [a.nodeId];
  const edges: string[] = [];

  const visit = (arcs: Arc[]): void => {
    for (const arc of arcs) {
      if (truncated) return;
      if (++expansions > limit || (expansions % 256 === 0 && now() - started > budgetMs)) {
        truncated = true;
        return;
      }
      const next = arc.to;
      if (onPath.has(next) || !corridorNodes.has(next)) continue;
      const depth = edges.length + 1;
      if (depth + (distB.get(next) ?? Infinity) > maxDepth) continue;
      if (next === b.nodeId) {
        if (lastEdges && !lastEdges.has(arc.edge)) continue;
        routes++;
        onRoute({ nodes: [...nodes, next], edges: [...edges, arc.edge] });
        continue;
      }
      if (depth >= maxDepth) continue;
      onPath.add(next);
      nodes.push(next);
      edges.push(arc.edge);
      visit(adj.get(next) ?? []);
      edges.pop();
      nodes.pop();
      onPath.delete(next);
    }
  };
  visit(firstArcs ?? adj.get(a.nodeId) ?? []);

  return {
    corridor: { nodes: corridorNodes, edges: corridorEdges },
    routes,
    truncated,
    constrained,
  };
}

/**
 * Everything between two fields: the tables on some simple route from one
 * to the other. Two tiers, because enumerating simple routes is exponential
 * and the exact answer can only be promised under bounds — the corridor is
 * the bound-free superset the panel can always show.
 */
export function between(
  doc: GraphDocument,
  a: FieldEndpoint,
  b: FieldEndpoint,
  opts: BetweenOptions = {},
): BetweenResult {
  const onNodes = new Set<string>();
  const onEdges = new Set<string>();
  const rest = enumerateRoutes(doc, a, b, opts, (walk) => {
    for (const n of walk.nodes) onNodes.add(n);
    for (const e of walk.edges) onEdges.add(e);
  });
  return { onRoutes: { nodes: onNodes, edges: onEdges }, ...rest };
}

export interface KeyUse {
  /** The key (a referencing field) and the edges of it the routes travelled. */
  ref: FieldRef;
  edges: string[];
  /** How many of the enumerated routes travel at least one of those edges. */
  routes: number;
  /** `routes / total`, 0..1. */
  share: number;
}

export interface KeyFrequencyResult {
  /** Most-used first; ties by document order of the key's first edge. */
  keys: KeyUse[];
  /** Routes enumerated. */
  routes: number;
  truncated: boolean;
  constrained: { from: boolean; to: boolean };
}

/**
 * Which keys the routes between two ends have in common: for every key, how
 * many of the enumerated simple routes travel it. Same bounds and
 * `truncated` as `between`, and one enumeration serves both when a caller
 * wants both (see `field-routes.ts`).
 */
export function keyFrequency(
  doc: GraphDocument,
  a: FieldEndpoint,
  b: FieldEndpoint,
  opts: BetweenOptions = {},
): KeyFrequencyResult {
  const edgeById = edgeIndex(doc);
  const order = new Map(doc.edges.map((e, i) => [e.id, i]));
  const uses = new Map<string, KeyUse & { first: number }>();
  const rest = enumerateRoutes(doc, a, b, opts, (walk) => {
    const seen = new Set<string>();
    for (const edgeId of walk.edges) {
      const e = edgeById.get(edgeId);
      const start = e ? edgeFieldIds(e).start : undefined;
      if (!e || !start) continue;
      const ref = { nodeId: e.source, fieldId: start };
      const key = fieldKey(ref);
      let use = uses.get(key);
      if (!use) {
        use = { ref, edges: [], routes: 0, share: 0, first: order.get(edgeId) ?? 0 };
        uses.set(key, use);
      }
      if (!use.edges.includes(edgeId)) use.edges.push(edgeId);
      if (!seen.has(key)) {
        seen.add(key);
        use.routes++;
      }
    }
  });
  const keys = [...uses.values()]
    .sort((x, y) => y.routes - x.routes || x.first - y.first)
    .map(({ first: _first, ...use }) => ({ ...use, share: rest.routes ? use.routes / rest.routes : 0 }));
  return { keys, routes: rest.routes, truncated: rest.truncated, constrained: rest.constrained };
}

export interface ReachableResult {
  /** Every node reached, with its distance from the nearest start (0 for a start). */
  nodes: Map<string, number>;
  /** Every edge whose two ends were both reached. */
  edges: string[];
  /** Per start: whether its first step was held to its field. */
  constrained: boolean[];
}

/**
 * Everything the pinned fields reach: a breadth-first search from all of
 * them at once, each start's first step held to the edges its field
 * anchors. Linear, so it needs no budget; `maxDepth` (default unbounded)
 * narrows the view rather than protecting it.
 */
export function reachableFrom(
  doc: GraphDocument,
  starts: readonly FieldEndpoint[],
  opts: GraphOptions & { maxDepth?: number } = {},
): ReachableResult {
  const ids = new Set(starts.map((s) => s.nodeId));
  const nodeFilter = opts.nodeFilter;
  const adj = buildAdjacency(doc, {
    ...opts,
    ...(nodeFilter ? { nodeFilter: (n) => ids.has(n.id) || nodeFilter(n) } : {}),
  });
  const edgeById = edgeIndex(doc);
  const seeds = starts.map((s) => ({ id: s.nodeId, arcs: anchoredArcs(adj, edgeById, s) }));
  const nodes = distances(adj, seeds, opts.maxDepth ?? Infinity);
  return { nodes, edges: edgesWithin(doc, nodes, opts), constrained: seeds.map((s) => s.arcs !== null) };
}

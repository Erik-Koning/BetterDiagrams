/**
 * coverage.ts — how much of a data model a set of KEYS reaches.
 *
 * A key is a referencing field (`keyFields`); choosing keys means choosing
 * which edges may be walked. Coverage is the fraction of tables those edges
 * reach — either any table one of them touches ("all"), or what a breadth-
 * first search from one root table can get to over them ("from").
 *
 * `minimalKeyCover` asks the classic question — the fewest keys that reach
 * everything reachable — with a greedy answer first (fast, within ln(n) of
 * the optimum) and a bounded exact pass after, so a small model gets a
 * proven answer and a large one an honest "smallest found".
 *
 * Zero dependencies, like every contract module.
 */
import { dataFields, fieldKey, keyFields, type FieldDocument, type FieldRef } from "./fields";

type CoverageNode = FieldDocument["nodes"][number];

/**
 * What counts as a TABLE by default: a node that stores field data — rows it
 * draws, or fields in its `data` bag. That is the whole of the question a
 * coverage score asks, and it excludes by construction everything a key can
 * never stand for: bands and groups (structure), views and record types
 * (facets of a table), external stubs and polymorphic collapse points
 * (stand-ins). An object with no foreign key at all still counts — an island
 * table is exactly what the score should report as unreached.
 */
export const storesFields = (node: CoverageNode): boolean =>
  !!node.fields?.length || dataFields(node).length > 0;

export type CoverageScope = { kind: "all" } | { kind: "from"; nodeId: string };

export interface CoverageOptions {
  /** Default `{ kind: "all" }`. */
  scope?: CoverageScope;
  /** Walk key edges both ways. Default true — a key joins two tables either way round. */
  undirected?: boolean;
  /**
   * Which nodes the score is ABOUT. Defaults to {@link storesFields}. Routes
   * may still travel through anything — a stand-in node is a real hop — but
   * only tables are counted, reported, and aimed at.
   */
  isTable?: (node: CoverageNode) => boolean;
}

export interface CoverageResult {
  /** Tables reached with the chosen keys (the root counts as reached in "from" scope). */
  reached: Set<string>;
  /** Every table in the document. */
  total: number;
  /** `reached.size / total`, 0..1. */
  fraction: number;
  /** Per chosen key (by `fieldKey`), the tables it added, in the order the keys were given. */
  byKey: Map<string, string[]>;
  /** Tables no key at all could reach in this scope — the ceiling. */
  unreachable: number;
}

export interface KeyGain {
  ref: FieldRef;
  /** The tables this key would add to the chosen set. */
  adds: string[];
  /** `adds.length / total`. */
  fraction: number;
}

export interface MinimalCoverOptions extends CoverageOptions {
  /** Wall-clock stop for the exact pass. Default 300 ms. */
  budgetMs?: number;
  /** The exact pass runs only when this many candidate keys or fewer remain. Default 12. */
  exactUpTo?: number;
  /** Injectable clock. */
  now?: () => number;
}

export interface MinimalCoverResult {
  keys: FieldRef[];
  reached: Set<string>;
  fraction: number;
  /** The exact pass finished: no smaller set reaches as much. */
  optimal: boolean;
  /** A pass was cut short by the budget — the greedy one, or the exact one. */
  truncated: boolean;
}

interface Arc {
  to: string;
  edge: string;
}

/**
 * Adjacency over key edges only, tagged with the key each arc belongs to,
 * plus the tables each key TOUCHES — which is the whole of "all" scope, and
 * is what lets the greedy search score a candidate without a fresh search.
 */
function keyGraph(doc: FieldDocument, undirected: boolean, isTable: (n: CoverageNode) => boolean) {
  const keys = keyFields(doc);
  const tables = new Set(doc.nodes.filter(isTable).map((n) => n.id));
  const keyOfEdge = new Map<string, string>();
  for (const k of keys) for (const e of k.edges) keyOfEdge.set(e, fieldKey(k.ref));
  const adj = new Map<string, Arc[]>();
  for (const n of doc.nodes) adj.set(n.id, []);
  const touched = new Map<string, Set<string>>();
  for (const e of doc.edges) {
    const key = keyOfEdge.get(e.id);
    if (!key || !adj.has(e.source) || !adj.has(e.target)) continue;
    // A self-loop is unwalkable — it advances nothing — but its key still
    // touches the table it loops on, which is what "all" scope counts.
    let set = touched.get(key);
    if (!set) touched.set(key, (set = new Set()));
    set.add(e.source);
    set.add(e.target);
    if (e.source === e.target) continue;
    adj.get(e.source)!.push({ to: e.target, edge: e.id });
    if (undirected || e.direction === "both" || e.direction === "none") adj.get(e.target)!.push({ to: e.source, edge: e.id });
  }
  return { keys, keyOfEdge, adj, touched, tables };
}

/** The tables in a reached set — the only thing a coverage number counts. */
const tablesIn = (graph: Graph, ids: Iterable<string>): string[] => [...ids].filter((id) => graph.tables.has(id));

type Graph = ReturnType<typeof keyGraph>;

/** The tables reached with a set of chosen keys (by `fieldKey`). */
function reach(graph: Graph, chosen: ReadonlySet<string>, scope: CoverageScope): Set<string> {
  const walkable = (arc: Arc) => chosen.has(graph.keyOfEdge.get(arc.edge) ?? "");
  const out = new Set<string>();
  if (scope.kind === "all") {
    for (const key of chosen) for (const id of graph.touched.get(key) ?? []) out.add(id);
    return out;
  }
  if (!graph.adj.has(scope.nodeId)) return out;
  out.add(scope.nodeId);
  const queue = [scope.nodeId];
  for (let head = 0; head < queue.length; head++) {
    for (const arc of graph.adj.get(queue[head]) ?? []) {
      if (!walkable(arc) || out.has(arc.to)) continue;
      out.add(arc.to);
      queue.push(arc.to);
    }
  }
  return out;
}

const scopeOf = (opts: CoverageOptions): CoverageScope => opts.scope ?? { kind: "all" };
const tableOf = (opts: CoverageOptions) => opts.isTable ?? storesFields;

/**
 * The tables adding one key brings in, given what the chosen keys already
 * reach. "All" scope is a set union, so it costs the key's own edges; "from"
 * scope has to search again, because one key can open a whole chain.
 */
function grow(
  graph: Graph,
  scope: CoverageScope,
  chosen: ReadonlySet<string>,
  reached: ReadonlySet<string>,
  key: string,
): Set<string> {
  if (scope.kind === "all") {
    const out = new Set(reached);
    for (const id of graph.touched.get(key) ?? []) out.add(id);
    return out;
  }
  return reach(graph, new Set([...chosen, key]), scope);
}

export function keyCoverage(doc: FieldDocument, chosen: readonly FieldRef[], opts: CoverageOptions = {}): CoverageResult {
  const graph = keyGraph(doc, opts.undirected !== false, tableOf(opts));
  const scope = scopeOf(opts);
  const total = graph.tables.size;
  const everything = reach(graph, new Set(graph.keys.map((k) => fieldKey(k.ref))), scope);
  const byKey = new Map<string, string[]>();
  const running = new Set<string>();
  let reached = reach(graph, running, scope);
  for (const ref of chosen) {
    const key = fieldKey(ref);
    if (running.has(key)) continue;
    const next = grow(graph, scope, running, reached, key);
    running.add(key);
    byKey.set(key, tablesIn(graph, next).filter((id) => !reached.has(id)));
    reached = next;
  }
  const reachedTables = new Set(tablesIn(graph, reached));
  return {
    reached: reachedTables,
    total,
    fraction: total ? reachedTables.size / total : 0,
    byKey,
    unreachable: total - tablesIn(graph, everything).length,
  };
}

/**
 * For every key NOT chosen, what adding it would reach — the candidate bars.
 * Most gain first; ties by document order of the key's first edge.
 */
export function marginalGains(doc: FieldDocument, chosen: readonly FieldRef[], opts: CoverageOptions = {}): KeyGain[] {
  const graph = keyGraph(doc, opts.undirected !== false, tableOf(opts));
  const scope = scopeOf(opts);
  const total = graph.tables.size;
  const running = new Set(chosen.map(fieldKey));
  const base = reach(graph, running, scope);
  const out: KeyGain[] = [];
  for (const k of graph.keys) {
    const key = fieldKey(k.ref);
    if (running.has(key)) continue;
    const next = grow(graph, scope, running, base, key);
    const adds = tablesIn(graph, next).filter((id) => !base.has(id));
    out.push({ ref: k.ref, adds, fraction: total ? adds.length / total : 0 });
  }
  return out.sort((a, b) => b.adds.length - a.adds.length);
}

const clock = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();

/**
 * The fewest keys that reach everything any key can reach in this scope.
 * Greedy by marginal gain, then — when few enough candidates remain and the
 * budget allows — an exact search over subsets smaller than the greedy
 * answer, by increasing size, which proves the first hit optimal.
 */
export function minimalKeyCover(doc: FieldDocument, opts: MinimalCoverOptions = {}): MinimalCoverResult {
  const graph = keyGraph(doc, opts.undirected !== false, tableOf(opts));
  const scope = scopeOf(opts);
  const total = graph.tables.size;
  const budgetMs = opts.budgetMs ?? 300;
  const exactUpTo = opts.exactUpTo ?? 12;
  const now = opts.now ?? clock;
  const started = now();
  const allKeys = graph.keys.map((k) => fieldKey(k.ref));
  const refOf = new Map(graph.keys.map((k) => [fieldKey(k.ref), k.ref]));
  // The goal is TABLES, not nodes: a key that only reaches a stand-in adds
  // nothing anyone asked for, and greedy must never spend a round on one.
  const target = new Set(tablesIn(graph, reach(graph, new Set(allKeys), scope)));
  const score = (ids: Iterable<string>) => tablesIn(graph, ids).length;
  const done = (keys: string[], reached: Set<string>, optimal: boolean, truncated: boolean): MinimalCoverResult => {
    const tables = new Set(tablesIn(graph, reached));
    return {
      keys: keys.map((k) => refOf.get(k)!),
      reached: tables,
      fraction: total ? tables.size / total : 0,
      optimal,
      truncated,
    };
  };
  if (!target.size) return done([], new Set(), true, false);

  // Greedy. Budgeted like the exact pass below: a model with hundreds of
  // keys must never hold the thread for seconds, and an honest "smallest
  // found so far" beats a frozen editor. The FIRST round always completes —
  // a budget so tight it returns nothing would be worse than useless.
  const chosen: string[] = [];
  const chosenSet = new Set<string>();
  let reached = reach(graph, chosenSet, scope);
  let reachedScore = score(reached);
  let greedyStopped = false;
  while (reachedScore < target.size) {
    if (chosen.length && now() - started > budgetMs) {
      greedyStopped = true;
      break;
    }
    let best: { key: string; next: Set<string>; score: number } | null = null;
    let looked = 0;
    for (const key of allKeys) {
      if (chosenSet.has(key)) continue;
      // Rounds are cheap in "all" scope but a "from" scope round is a search
      // per candidate; check inside the round too, after the first one.
      if (chosen.length && ++looked % 64 === 0 && now() - started > budgetMs) {
        greedyStopped = true;
        break;
      }
      const next = grow(graph, scope, chosenSet, reached, key);
      const gained = score(next);
      if (gained > reachedScore && (!best || gained > best.score)) best = { key, next, score: gained };
    }
    if (greedyStopped) break;
    if (!best) break;
    chosen.push(best.key);
    chosenSet.add(best.key);
    reached = best.next;
    reachedScore = best.score;
  }
  if (greedyStopped) return done(chosen, reached, false, true);
  if (chosen.length <= 1) return done(chosen, reached, true, false);

  // Exact: candidates are the keys that reach anything on their own. Too many
  // of them is a CAP (not a timeout); no time left is a timeout.
  const candidates = allKeys.filter((key) => score(reach(graph, new Set([key]), scope)) > 0);
  if (candidates.length > exactUpTo) return done(chosen, reached, false, false);
  if (now() - started > budgetMs) return done(chosen, reached, false, true);
  const wanted = reachedScore;
  let checked = 0;
  for (let size = 1; size < chosen.length; size++) {
    const pick: number[] = [];
    const search = (start: number): string[] | null | "stop" => {
      if (pick.length === size) {
        if (++checked % 8 === 0 && now() - started > budgetMs) return "stop";
        const keys = pick.map((i) => candidates[i]);
        return score(reach(graph, new Set(keys), scope)) >= wanted ? keys : null;
      }
      for (let i = start; i <= candidates.length - (size - pick.length); i++) {
        pick.push(i);
        const hit = search(i + 1);
        pick.pop();
        if (hit) return hit;
      }
      return null;
    };
    const hit = search(0);
    if (hit === "stop") return done(chosen, reached, false, true);
    if (hit) return done(hit, reach(graph, new Set(hit), scope), true, false);
  }
  return done(chosen, reached, true, false);
}

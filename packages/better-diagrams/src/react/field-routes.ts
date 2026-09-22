/**
 * field-routes.ts — what the path panel shows for a set of pins, computed
 * once per structural change of the document.
 *
 * Two pins: the k best routes between them (lit on the canvas as transient
 * paths), the tables on any route, and the wider corridor. Three or more:
 * the union of what lies between every pair, and everything reachable from
 * the pins — with a keep-set the canvas dims everything else against.
 * Pure: the studio memoises it on the document's STRUCTURE (ids, endpoints,
 * anchors, direction), never on positions.
 */
import type { DiagramTemplate, EdgeColor } from "../contract/schema";
import { between, fieldPaths, keyFrequency, reachableFrom, type GraphWalk, type KeyFrequencyResult } from "../contract/graph";
import { edgeKeyOf, keysBetween, type KeyLink, type Pin } from "../contract/fields";

export interface RouteQuery {
  pins: readonly Pin[];
  /** Ignore arrow direction (the default the panel opens with). */
  undirected: boolean;
  /** With three or more pins: what the canvas is dimmed to. */
  mode: "between" | "reachable";
}

export interface RouteEntry {
  walk: GraphWalk;
  /** "Contact.AccountId → Account → Case" */
  title: string;
  color: EdgeColor;
  hops: number;
  /** The key each hop is carried by, in hop order; "?" when an edge has no key. */
  keys: string[];
}

export interface RouteView {
  kind: "pair" | "many";
  /** Two pins only: the routes, shortest first. */
  routes: RouteEntry[];
  /** Tables on an enumerated route between the pins — the pinned tables themselves excluded. */
  betweenNodes: string[];
  /** Tables within reach of both ends that no enumerated route used. */
  corridorExtra: string[];
  /** Everything reachable from the pins, with the nearest distance. */
  reachable: Map<string, number>;
  /** Nodes to keep bright, or null for no dimming (pair mode). */
  keep: Set<string> | null;
  keepEdges: Set<string> | null;
  /** A search was cut short — by k, depth, the expansion limit or the budget. */
  truncated: boolean;
  /** Pins whose field anchors no edge on this document; searched from the table instead. */
  constrainedFallback: Pin[];
  /** More pins than pairwise mode looks at. */
  pinsIgnored: number;
  /** Two pins only: which keys the routes have in common. */
  keyUse: KeyFrequencyResult | null;
  /**
   * Two pins only: the keys joining the pinned tables directly, either way
   * round — including references the document draws no line for, which no
   * route can travel but a reader asking "how do these join" still wants.
   */
  directKeys: KeyLink[];
}

/** Pairwise mode looks at the first this-many pins (28 pairs). */
export const PAIRWISE_PIN_CAP = 8;

export function computeRouteView(doc: DiagramTemplate, query: RouteQuery, colors: readonly EdgeColor[]): RouteView {
  const { undirected, mode } = query;
  const pins = query.pins.slice(0, PAIRWISE_PIN_CAP);
  const pinsIgnored = Math.max(0, query.pins.length - pins.length);
  const labelOf = new Map(doc.nodes.map((n) => [n.id, n.label]));
  const label = (id: string) => labelOf.get(id) ?? id;
  const pinNodes = new Set(pins.map((p) => p.nodeId));
  const opts = { undirected };
  const empty: RouteView = {
    kind: pins.length === 2 ? "pair" : "many",
    routes: [],
    betweenNodes: [],
    corridorExtra: [],
    reachable: new Map(),
    keep: null,
    keepEdges: null,
    truncated: false,
    constrainedFallback: [],
    pinsIgnored,
    keyUse: null,
    directKeys: [],
  };
  if (pins.length < 2) return empty;

  if (pins.length === 2) {
    const [a, b] = pins;
    const paths = fieldPaths(doc, a, b, { ...opts, k: 10, maxDepth: 10 });
    const span = between(doc, a, b, opts);
    const edgeById = new Map(doc.edges.map((e) => [e.id, e]));
    const endLabel = (id: string, pin: Pin) => (pin.fieldId ? `${label(id)}.${pin.fieldId}` : label(id));
    const routes: RouteEntry[] = paths.walks.map((walk, i) => ({
      walk,
      title: walk.nodes
        .map((id, j) => (j === 0 ? endLabel(id, a) : j === walk.nodes.length - 1 ? endLabel(id, b) : label(id)))
        .join(" → "),
      color: colors[i % colors.length] ?? "sky",
      hops: walk.edges.length,
      keys: walk.edges.map((id) => {
        const e = edgeById.get(id);
        return (e && edgeKeyOf(e)) ?? "?";
      }),
    }));
    const onRoute = new Set([...span.onRoutes.nodes].filter((id) => !pinNodes.has(id)));
    for (const w of paths.walks) for (const id of w.nodes) if (!pinNodes.has(id)) onRoute.add(id);
    // A table pin has no field to hold to; only a FIELD that anchored nothing is a fallback.
    const fallback: Pin[] = [];
    if (a.fieldId && !paths.constrained.from) fallback.push(a);
    if (b.fieldId && !paths.constrained.to) fallback.push(b);
    return {
      ...empty,
      kind: "pair",
      routes,
      betweenNodes: [...onRoute],
      corridorExtra: [...span.corridor.nodes].filter((id) => !onRoute.has(id) && !pinNodes.has(id)),
      reachable: reachableFrom(doc, pins, opts).nodes,
      truncated: paths.truncated || span.truncated,
      constrainedFallback: fallback,
      keyUse: keyFrequency(doc, a, b, opts),
      directKeys: keysBetween(doc, a, b),
    };
  }

  // Many: every pair's between, unioned; plus what the pins reach.
  const onRoute = new Set<string>();
  const onEdges = new Set<string>();
  const corridor = new Set<string>();
  let truncated = false;
  for (let i = 0; i < pins.length; i++) {
    for (let j = i + 1; j < pins.length; j++) {
      const span = between(doc, pins[i], pins[j], opts);
      for (const id of span.onRoutes.nodes) onRoute.add(id);
      for (const id of span.onRoutes.edges) onEdges.add(id);
      for (const id of span.corridor.nodes) corridor.add(id);
      if (span.truncated) truncated = true;
    }
  }
  const reach = reachableFrom(doc, pins, opts);
  const fallback = pins.filter((p, i) => p.fieldId && !reach.constrained[i]);
  const keep = new Set<string>(pinNodes);
  const keepEdges = new Set<string>();
  if (mode === "reachable") {
    for (const id of reach.nodes.keys()) keep.add(id);
    for (const id of reach.edges) keepEdges.add(id);
  } else {
    for (const id of onRoute) keep.add(id);
    for (const id of onEdges) keepEdges.add(id);
  }
  return {
    kind: "many",
    routes: [],
    betweenNodes: [...onRoute].filter((id) => !pinNodes.has(id)),
    corridorExtra: [...corridor].filter((id) => !onRoute.has(id) && !pinNodes.has(id)),
    reachable: reach.nodes,
    keep,
    keepEdges,
    truncated,
    constrainedFallback: fallback,
    pinsIgnored,
    keyUse: null,
    directKeys: [],
  };
}

/**
 * The document's shape as far as routes care: ids, endpoints, anchors,
 * direction. A drag changes none of it, so the panel's memo survives one.
 */
export function structureSignature(doc: DiagramTemplate): string {
  const nodes = doc.nodes.map((n) => n.id).join(",");
  const edges = doc.edges
    .map((e) => `${e.id}|${e.source}|${e.target}|${e.startField ?? ""}|${e.endField ?? ""}|${e.direction ?? ""}`)
    .join(",");
  return `${nodes}\n${edges}`;
}

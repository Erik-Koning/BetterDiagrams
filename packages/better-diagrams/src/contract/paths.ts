/**
 * paths.ts — named flows through the diagram.
 *
 * A path is an ordered walk a reader can light up: the nodes it visits and
 * the edges it travels, start to end, under a title. It is a VIEW aid, not a
 * container — a node can sit on any number of paths — and which paths are lit
 * is editor state, never stored in the document.
 *
 * `steps` is one ordered list of ids because that is how a flow is spoken:
 * "the CDN, then the API, then the queue". Node ids are the normal currency;
 * an edge id belongs in the list only where two nodes are joined by several
 * edges and the walk has to say which one it takes. Everything else is
 * inferred by `resolvePath` — the edge between two consecutive nodes when
 * exactly one exists, the endpoints of an edge named on its own — so a path
 * written by hand or by a model stays short and still resolves to a complete
 * chain with a direction on every hop.
 *
 * Zero dependencies, like every contract module. The colour vocabulary is a
 * parameter rather than an import so this file never reaches into schema.ts.
 */
import type { EdgeColor } from "./schema";

export interface DiagramPath {
  id: string;
  /** What the flow is called — the menu row, the legend row. */
  title: string;
  /**
   * The walk, start to end: node ids, with an edge id between two nodes only
   * when several edges join them. Never empty after validation; every id
   * names a node or edge that exists.
   */
  steps: string[];
  /**
   * The glow colour, from the edge palette. Absent means "the next colour
   * in the cycle" — assigned by the path's position among ALL paths, so a
   * path keeps its colour whether or not its neighbours are lit.
   */
  color?: EdgeColor;
  /** One line about the flow; shown as the menu row's tooltip. */
  description?: string;
}

// Known keys, for editors that warn about keys the schema doesn't define.
// See TEMPLATE_KEYS in schema.ts for how the Record enforces the list.
const PATH_KEY_MAP: Record<keyof DiagramPath, true> = {
  id: true,
  title: true,
  steps: true,
  color: true,
  description: true,
};
export const PATH_KEYS: readonly string[] = Object.keys(PATH_KEY_MAP);

/**
 * The order unset paths take their colours in. Slate last: it is the edge
 * palette's neutral and reads as "no highlight" next to the others.
 */
export const PATH_COLOR_CYCLE: readonly EdgeColor[] = [
  "sky",
  "emerald",
  "amber",
  "rose",
  "violet",
  "slate",
];

/** A path's own colour, else the cycle by its index among all paths. */
export function pathColor(path: Pick<DiagramPath, "color">, index: number): EdgeColor {
  if (path.color) return path.color;
  const n = PATH_COLOR_CYCLE.length;
  return PATH_COLOR_CYCLE[((index % n) + n) % n];
}

/** One hop of a resolved walk. `index` is its position, 0 = the start. */
export interface ResolvedPathStep {
  kind: "node" | "edge";
  id: string;
  index: number;
  /** An edge walked against its arrow — from its target to its source. */
  reversed?: boolean;
}

export interface ResolvedPath {
  id: string;
  /** Alternating node/edge steps wherever the document allows it. */
  steps: ResolvedPathStep[];
}

/**
 * What the canvas hangs on an element that is on a lit path: enough to colour
 * it, to place it in the pulse that travels the path, and to run an edge's
 * dash flow the way the walk goes. One entry per lit path the element is on.
 */
export interface PathGlow {
  pathId: string;
  color: EdgeColor;
  /** This element's position in the walk, 0 = the start. */
  step: number;
  /** How many hops the walk has, so the pulse cycle spans the whole path. */
  steps: number;
  reversed?: boolean;
  /**
   * Drawn in the dedicated route colour (`--as-route`) rather than the
   * palette: a single transient route the reader has singled out.
   */
  bright?: boolean;
  /**
   * The pulse and the dash flow run along this path. One lit path at a time
   * moves — the route singled out, else the shortest one lit — so the eye is
   * led along one walk; every other lit path keeps a still halo.
   */
  animate?: boolean;
}

/** The slice of a document `resolvePath` reads — structural, so a view doc serves too. */
export interface PathDocument {
  nodes: ReadonlyArray<{ id: string }>;
  edges: ReadonlyArray<{ id: string; source: string; target: string }>;
}

type Hop = Omit<ResolvedPathStep, "index">;

/**
 * Expand a path's `steps` into the complete chain the canvas lights up.
 *
 *  - two consecutive NODES joined by exactly one edge get that edge between
 *    them (walked backwards when it points the other way); joined by several
 *    or none, they stay adjacent and the reader sees two lit boxes;
 *  - an EDGE named on its own brings its endpoints with it — the near end is
 *    the node the walk is standing on when it can be, else the source;
 *  - an id that is both a node and an edge (separate namespaces) reads as the
 *    edge only when the walk is standing on a node that edge touches.
 *
 * Consecutive repeats collapse. Ids the document doesn't know are skipped —
 * `validatePaths` already drops them, but a view document may hide some.
 */
export function resolvePath(doc: PathDocument, path: Pick<DiagramPath, "id" | "steps">): ResolvedPath {
  const nodeIds = new Set(doc.nodes.map((n) => n.id));
  // An edge whose end the document doesn't know cannot be walked: a view
  // document may have hidden one of its nodes.
  const walkable = doc.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  const edgeById = new Map(walkable.map((e) => [e.id, e]));
  /** Edges by the unordered pair they join, for the one-edge inference. */
  const between = new Map<string, Array<{ id: string; source: string; target: string }>>();
  const pairKey = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);
  for (const e of walkable) {
    const key = pairKey(e.source, e.target);
    const list = between.get(key);
    if (list) list.push(e);
    else between.set(key, [e]);
  }

  const hops: Hop[] = [];
  const last = () => hops[hops.length - 1];
  const standingOn = (): string | null => {
    const l = last();
    return l?.kind === "node" ? l.id : null;
  };
  const pushNode = (id: string) => {
    const l = last();
    if (l?.kind === "node" && l.id === id) return;
    hops.push({ kind: "node", id });
  };
  const pushEdge = (id: string, reversed: boolean) => {
    const l = last();
    if (l?.kind === "edge" && l.id === id) return;
    hops.push(reversed ? { kind: "edge", id, reversed: true } : { kind: "edge", id });
  };

  /** The far end of the last explicitly named edge, owed to the chain. */
  let owed: string | null = null;

  for (const raw of path.steps) {
    const edge = edgeById.get(raw);
    const isNode = nodeIds.has(raw);
    const on = standingOn();
    const asEdge = !!edge && (!isNode || (on !== null && (edge.source === on || edge.target === on)));

    if (asEdge && edge) {
      if (owed !== null) {
        pushNode(owed);
        owed = null;
      }
      const from = standingOn();
      const near = from !== null && (edge.source === from || edge.target === from) ? from : edge.source;
      pushNode(near);
      const reversed = near === edge.target && edge.source !== edge.target;
      pushEdge(edge.id, reversed);
      owed = reversed ? edge.source : edge.target;
      continue;
    }

    if (!isNode) continue; // unknown id — nothing to light

    if (owed !== null) {
      if (owed !== raw) pushNode(owed);
      owed = null;
    }
    const from = standingOn();
    if (from !== null && from !== raw) {
      const joining = between.get(pairKey(from, raw)) ?? [];
      if (joining.length === 1) {
        const e = joining[0];
        pushEdge(e.id, e.target === from && e.source !== e.target);
      }
    }
    pushNode(raw);
  }
  if (owed !== null) pushNode(owed);

  return { id: path.id, steps: hops.map((hop, index) => ({ ...hop, index })) };
}

/** The same id coercion the schema applies to nodes and edges. */
function idOf(raw: unknown): string | null {
  if (typeof raw === "string") return raw.trim() || null;
  if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : null;
  if (typeof raw === "bigint") return String(raw);
  return null;
}

/**
 * Repair rather than reject, like the rest of the validator: a step naming
 * nothing in the document is dropped, a path left with no steps is dropped
 * with it, duplicate ids get the `_2` suffix nodes and zones get, a title
 * falls back to the id, and an unknown colour is forgotten so the cycle
 * supplies one.
 */
export function validatePaths(
  raw: unknown,
  ctx: {
    nodeIds: ReadonlySet<string>;
    edgeIds: ReadonlySet<string>;
    /** The edge palette — `EDGE_COLORS`, passed in to keep this module import-free. */
    colors: readonly string[];
  },
): DiagramPath[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: DiagramPath[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const p = entry as Record<string, unknown>;
    const rawId = idOf(p.id);
    if (rawId === null) continue;

    const steps: string[] = [];
    for (const s of Array.isArray(p.steps) ? p.steps : []) {
      const id = idOf(s);
      if (id === null || (!ctx.nodeIds.has(id) && !ctx.edgeIds.has(id))) continue;
      if (steps[steps.length - 1] === id) continue;
      steps.push(id);
    }
    if (!steps.length) continue;

    let id = rawId;
    let bump = 2;
    while (seen.has(id)) id = `${rawId}_${bump++}`;
    seen.add(id);

    const title = typeof p.title === "string" && p.title.trim() ? p.title.trim() : id;
    const color =
      typeof p.color === "string" && ctx.colors.includes(p.color) ? (p.color as EdgeColor) : undefined;
    const description = typeof p.description === "string" ? p.description.trim() : "";

    out.push({
      id,
      title,
      steps,
      ...(color ? { color } : {}),
      ...(description ? { description } : {}),
    });
  }
  return out;
}

/**
 * path-view.ts — the view pass that lights up paths.
 *
 * Which paths are lit is editor state, like the tag filter and the timeline
 * cursor: it never enters the document. So, as with the timeline, the canvas
 * is flagged on the way INTO React Flow — a pure map over what the editor
 * already holds, never written back — and the renderers read the flags.
 *
 * A node carries its glow as CSS custom properties on the React Flow wrapper
 * (a class plus the colour, the layered shadow, and its position in the walk)
 * so the stylesheet can draw and animate the halo without the node component
 * knowing about paths. An edge carries the same facts in its `data`, because
 * the halo has to be a second stroke of the line's own geometry and only the
 * edge component has that.
 *
 * A path is lit by DOCUMENT id, and the canvas rarely draws every document
 * element under its own id: a level shows ghosts for what lies outside it, a
 * collapsed group is a chip, a card's children are its next level. So the
 * pass also lights whatever STANDS for a lit element the canvas hides (see
 * `representatives`) — the chip a route runs into wears the route's halo and
 * says how many of its hops it hides, and a line re-routed to that chip
 * lights when any edge it bundles is lit. Without that, a route through a
 * folded group read as broken from the level above.
 */
import type { Edge, Node } from "@xyflow/react";
import {
  BOUNDARY_NODE_PREFIX,
  COLLAPSED_EDGE_PREFIX,
  GHOST_EDGE_PREFIX,
  ghostSourceId,
  isBoundaryNodeId,
  isCollapsedEdgeId,
  isGhostEdgeId,
  isGhostNodeId,
  isZoneNodeId,
  type DiagramEdge,
  type DiagramTemplate,
} from "../contract/schema";
import { PATH_COLOR_CYCLE, pathColor, resolvePath, type DiagramPath, type PathGlow } from "../contract/paths";
import type { EdgeColor } from "../contract/schema";
import { edgeKeyOf } from "../contract/fields";

/** Every lit path each element is on, keyed by DOCUMENT id. */
export interface PathGlowIndex {
  nodes: Map<string, PathGlow[]>;
  edges: Map<string, PathGlow[]>;
}

/**
 * Resolve the lit paths of a document into per-element glow entries, or null
 * when nothing is lit — the cheap case the view pass short-circuits on.
 *
 * Colours are assigned by a path's position among ALL the document's paths,
 * not among the lit ones, so lighting a second path never recolours the first.
 *
 * `extra` are TRANSIENT paths — routes a search found, never part of the
 * document — lit alongside, each in the colour its caller gave it (see
 * `transientPathColors`). They resolve against the same document, so a
 * route names ordinary node and edge ids.
 */
export function buildPathGlowIndex(
  template: DiagramTemplate,
  activeIds: readonly string[],
  extra: readonly DiagramPath[] = [],
  opts: {
    /** Draw the extras in the dedicated route colour — a route singled out, not a set of them. */
    bright?: boolean;
  } = {},
): PathGlowIndex | null {
  const paths = template.paths ?? [];
  if ((!paths.length || !activeIds.length) && !extra.length) return null;
  const active = new Set(activeIds);
  const index: PathGlowIndex = { nodes: new Map(), edges: new Map() };
  let any = false;
  /** Each lit path's hop count, in lighting order — what picks the one that moves. */
  const lit: Array<{ id: string; steps: number; bright: boolean }> = [];
  const light = (path: DiagramPath, color: EdgeColor, bright: boolean) => {
    const resolved = resolvePath(template, path);
    const steps = resolved.steps.length;
    if (steps) lit.push({ id: path.id, steps, bright });
    for (const step of resolved.steps) {
      const glow: PathGlow = {
        pathId: path.id,
        color,
        step: step.index,
        steps,
        ...(step.reversed ? { reversed: true } : {}),
        ...(bright ? { bright: true } : {}),
      };
      const bucket = step.kind === "node" ? index.nodes : index.edges;
      const list = bucket.get(step.id);
      if (list) list.push(glow);
      else bucket.set(step.id, [glow]);
      any = true;
    }
  };
  paths.forEach((path, i) => {
    if (active.has(path.id)) light(path, pathColor(path, i), false);
  });
  for (const path of extra) light(path, path.color ?? PATH_COLOR_CYCLE[0], opts.bright === true);
  if (!any) return null;
  // One path moves: the route singled out, else the shortest lit one (the
  // first of equals). Several pulses at once were a canvas full of blinking
  // and said nothing about which walk to follow.
  const moving =
    lit.find((p) => p.bright) ??
    lit.reduce<{ id: string; steps: number } | null>((best, p) => (best && best.steps <= p.steps ? best : p), null);
  if (moving) {
    for (const bucket of [index.nodes, index.edges]) {
      for (const glows of bucket.values()) {
        for (const glow of glows) if (glow.pathId === moving.id) glow.animate = true;
      }
    }
  }
  return index;
}

/** The ink a glow paints with: the route colour when bright, else its palette colour. */
export const glowInk = (glow: Pick<PathGlow, "color" | "bright">): string =>
  glow.bright ? "var(--as-route)" : `var(--as-edge-${glow.color})`;

/**
 * Colours for `count` transient paths: the cycle from `offset` — the slot
 * the document's NEXT path would take, so a route never wears the colour
 * of a path that exists — skipping any colour a lit document path wears.
 * Past six distinct routes the cycle wraps; a collision is then unavoidable.
 */
export function transientPathColors(
  count: number,
  taken: readonly EdgeColor[],
  offset: number,
): EdgeColor[] {
  const n = PATH_COLOR_CYCLE.length;
  const start = ((offset % n) + n) % n;
  const rotated = Array.from({ length: n }, (_, i) => PATH_COLOR_CYCLE[(start + i) % n]);
  const avoid = new Set(taken);
  const pool = rotated.filter((c) => !avoid.has(c));
  const cycle = pool.length ? pool : rotated;
  return Array.from({ length: Math.max(0, count) }, (_, i) => cycle[i % cycle.length]);
}

/**
 * The layered box-shadow for a node on one or more lit paths: a thin solid
 * ring plus a soft halo per path, each further path one ring wider so every
 * colour stays visible. Alpha and blur are the theme's glow tokens, resolved
 * where the shadow is painted.
 */
export function glowShadow(glows: readonly PathGlow[]): string {
  const layers: string[] = [];
  glows.forEach((glow, k) => {
    const ink = glowInk(glow);
    const halo = `color-mix(in srgb, ${ink} calc(var(--as-glow-alpha) * 100%), transparent)`;
    if (k === 0) layers.push(`0 0 0 1.5px ${ink}`);
    layers.push(`0 0 var(--as-glow-blur) ${2 + 4 * k}px ${halo}`);
  });
  return layers.join(", ");
}

/** The document node a canvas node stands for, or null for zones. */
export function documentNodeId(id: string): string | null {
  if (isZoneNodeId(id)) return null;
  if (isBoundaryNodeId(id)) return id.slice(BOUNDARY_NODE_PREFIX.length);
  if (isGhostNodeId(id)) return ghostSourceId(id);
  return id;
}

/** The document edge a canvas edge stands for (collapse re-routes, ghosts). */
export function documentEdgeId(id: string): string {
  if (isCollapsedEdgeId(id)) return id.slice(COLLAPSED_EDGE_PREFIX.length);
  if (isGhostEdgeId(id)) return id.slice(GHOST_EDGE_PREFIX.length);
  return id;
}

/**
 * Which canvas node shows, or stands in for, each document node.
 *
 * A node the canvas draws maps to the element drawing it — itself, its ghost,
 * the boundary frame. A node the canvas does NOT draw maps to the nearest
 * ancestor it does draw, provided that ancestor renders none of its own
 * children: a collapsed or folded chip, a card whose contents are its next
 * level, the ghost of a group. An expanded frame and the boundary frame are
 * refused as stand-ins — a child of theirs missing from the canvas is missing
 * for some other reason (a provider switch), and a route lit on the frame
 * would claim to run through something the reader can see it does not.
 *
 * It is the "nearest visible ancestor" rule `toReactFlow` re-routes edges by,
 * stated for nodes, so a lit route and its re-routed lines agree on which
 * chip a hidden hop lands on. Nodes nothing on the canvas stands for are
 * absent from the map.
 */
export function representatives(
  template: Pick<DiagramTemplate, "nodes">,
  canvasNodeIds: Iterable<string>,
): Map<string, string> {
  const shown = new Map<string, string>();
  for (const id of canvasNodeIds) {
    const docId = documentNodeId(id);
    if (docId !== null && !shown.has(docId)) shown.set(docId, id);
  }
  const parentOf = new Map<string, string>();
  const rendersChildren = new Set<string>();
  for (const n of template.nodes) {
    if (!n.parentId) continue;
    parentOf.set(n.id, n.parentId);
    if (shown.has(n.id)) rendersChildren.add(n.parentId);
  }
  const standsIn = (docId: string) => {
    const canvasId = shown.get(docId);
    return canvasId !== undefined && !rendersChildren.has(docId) && !isBoundaryNodeId(canvasId);
  };
  const out = new Map(shown);
  for (const n of template.nodes) {
    if (shown.has(n.id)) continue;
    let cursor = parentOf.get(n.id);
    const guard = new Set<string>();
    while (cursor !== undefined && !shown.has(cursor) && !guard.has(cursor)) {
      guard.add(cursor);
      cursor = parentOf.get(cursor);
    }
    if (cursor !== undefined && standsIn(cursor)) out.set(n.id, shown.get(cursor)!);
  }
  return out;
}

/**
 * A keep-set widened to the canvas: every kept element the canvas hides adds
 * the document node of its stand-in, so a chip stays bright when something
 * it hides is kept and recedes when nothing is. A set nothing needs adding
 * to comes back as itself, so the renderers' memo holds.
 */
export function keptOnCanvas(keep: ReadonlySet<string>, reps: ReadonlyMap<string, string>): ReadonlySet<string> {
  let out: Set<string> | null = null;
  for (const id of keep) {
    const canvasId = reps.get(id);
    const docId = canvasId === undefined ? null : documentNodeId(canvasId);
    if (docId === null || docId === id || keep.has(docId)) continue;
    (out ??= new Set(keep)).add(docId);
  }
  return out ?? keep;
}

/** One glow per path: the first seen wins, which is the earliest hop on a stand-in. */
function onePerPath(glows: readonly PathGlow[]): PathGlow[] {
  const seen = new Set<string>();
  return glows.filter((g) => !seen.has(g.pathId) && (seen.add(g.pathId), true));
}

/**
 * What stands for what on one canvas — computed once per view pass and read
 * by both passes below, so the glow and the fade agree.
 */
export interface CanvasStandIns {
  /** Which canvas node shows, or stands in for, each document node (`representatives`). */
  nodes: ReadonlyMap<string, string>;
  /**
   * For each re-routed or ghost line, the document edges it bundles: every
   * edge whose two ends land on its two ends, the one that lent it its id
   * included. `toReactFlow` and `scopedView` draw a converging bundle once
   * and name the line after whichever edge came first, so a line's own id
   * says nothing about the OTHER edges it stands for.
   */
  lines: ReadonlyMap<string, readonly DiagramEdge[]>;
}

export function canvasStandIns(
  template: Pick<DiagramTemplate, "nodes" | "edges">,
  nodes: readonly Node[],
  edges: readonly Edge[],
): CanvasStandIns {
  const reps = representatives(template, nodes.map((n) => n.id));
  const byPair = new Map<string, DiagramEdge[]>();
  for (const e of template.edges) {
    const s = reps.get(e.source);
    const t = reps.get(e.target);
    if (s === undefined || t === undefined || s === t) continue; // no line: wiring inside one stand-in
    const key = `${s}\u0000${t}`;
    const list = byPair.get(key);
    if (list) list.push(e);
    else byPair.set(key, [e]);
  }
  const lines = new Map<string, DiagramEdge[]>();
  for (const e of edges) {
    if (!isCollapsedEdgeId(e.id) && !isGhostEdgeId(e.id)) continue;
    const bundle = byPair.get(`${e.source}\u0000${e.target}`);
    if (bundle) lines.set(e.id, bundle);
  }
  return { nodes: reps, lines };
}

/** The document edges a canvas edge stands for: its bundle, or just itself. */
const documentEdgesOf = (e: Edge, standIns: CanvasStandIns | null | undefined): readonly string[] =>
  standIns?.lines.get(e.id)?.map((d) => d.id) ?? [documentEdgeId(e.id)];

/** The wrapper attribute the "N inside" badge reads: React's attribute types name no `data-*` key, so the record is built loosely. */
const insideAttribute = (n: Node, inside: number): Node["domAttributes"] =>
  ({ ...n.domAttributes, "data-path-inside": String(inside) }) as Node["domAttributes"];

const withClass = (className: string | undefined, add: string) =>
  className ? `${className} ${add}` : add;

/**
 * Flag the canvas for the lit paths. Elements on no lit path are returned by
 * identity, so the memoised renderers of everything else do not re-render.
 * Runs after the timeline pass (a hidden node stays hidden) and before the
 * selection lift, which concatenates classes rather than replacing them.
 *
 * With the canvas's stand-ins, an element the canvas hides — folded into a
 * chip, below a card's drill level — lights the element standing in for it,
 * which also says how many it hides (`data-path-inside`), and a re-routed
 * line lights when any edge it bundles is lit. Without them, only elements
 * drawn under their own id do.
 */
export function applyPathView(
  nodes: Node[],
  edges: Edge[],
  index: PathGlowIndex | null,
  standIns?: CanvasStandIns | null,
): { nodes: Node[]; edges: Edge[] } {
  if (!index) return { nodes, edges };
  // Every lit document node the canvas hides, on the element standing for it.
  const hidden = new Map<string, { glows: PathGlow[]; inside: number }>();
  if (standIns) {
    for (const [docId, glows] of index.nodes) {
      const canvasId = standIns.nodes.get(docId);
      if (canvasId === undefined || documentNodeId(canvasId) === docId) continue; // drawn under its own id
      const entry = hidden.get(canvasId) ?? { glows: [], inside: 0 };
      entry.inside += 1;
      // Earliest hop first, so the stand-in takes its place in the walk from
      // the first thing the path reaches inside it.
      entry.glows = [...entry.glows, ...glows].sort((a, b) => a.step - b.step);
      hidden.set(canvasId, entry);
    }
  }
  return {
    nodes: nodes.map((n) => {
      const docId = documentNodeId(n.id);
      const own = docId === null ? undefined : index.nodes.get(docId);
      const via = hidden.get(n.id);
      // Its own glows first: an element on the path in its own right keeps
      // its own step; what it hides adds only paths it is not already on.
      const glows = via ? onePerPath([...(own ?? []), ...via.glows]) : own;
      if (!glows?.length) return n;
      const first = glows[0];
      return {
        ...n,
        className: withClass(n.className, "as-path-node"),
        style: {
          ...n.style,
          "--as-path-ink": glowInk(first),
          "--as-path-shadow": glowShadow(glows),
          "--as-path-step": first.step,
          "--as-path-steps": first.steps,
        } as Node["style"],
        ...(via ? { domAttributes: insideAttribute(n, via.inside) } : {}),
      };
    }),
    edges: edges.map((e) => {
      const bundle = standIns?.lines.get(e.id);
      const litIds = documentEdgesOf(e, standIns).filter((id) => index.edges.get(id)?.length);
      if (!litIds.length) return e;
      const glows = onePerPath(litIds.flatMap((id) => index.edges.get(id)!));
      // A bright route names the key carrying each hop on the line itself —
      // for a stand-in line, the key of the lit edge it bundles, not of
      // whichever edge happened to lend the line its id.
      const bright = glows.some((g) => g.bright);
      const data = e.data as { startField?: string; data?: Record<string, unknown> } | undefined;
      const routeKey = !bright
        ? undefined
        : bundle
          ? edgeKeyOf(bundle.find((d) => d.id === litIds[0])!)
          : edgeKeyOf({ startField: data?.startField, data: data?.data });
      return {
        ...e,
        className: withClass(e.className, bright ? "as-path-edge as-path-edge--bright" : "as-path-edge"),
        data: { ...e.data, pathGlow: glows, ...(routeKey ? { routeKey } : {}) },
      };
    }),
  };
}

/**
 * Fade every edge outside a kept set — the path panel's "everything not
 * reachable from the pins" view. Nodes take the same treatment through the
 * studio context (`dimmedIds`, widened to stand-ins by `keptOnCanvas`), where
 * the node renderer already dims for the tag filter; edges have no such hook,
 * so the class goes on the React Flow wrapper here. A re-routed line is kept
 * when any edge it bundles is. Null keeps everything, by identity.
 */
export function applyOutsideView(
  edges: Edge[],
  keepEdges: ReadonlySet<string> | null,
  standIns?: CanvasStandIns | null,
): Edge[] {
  if (!keepEdges) return edges;
  return edges.map((e) =>
    documentEdgesOf(e, standIns).some((id) => keepEdges.has(id))
      ? e
      : { ...e, className: withClass(e.className, "as-edge--outside") },
  );
}

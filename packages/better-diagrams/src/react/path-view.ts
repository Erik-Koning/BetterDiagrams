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
  const light = (path: DiagramPath, color: EdgeColor, bright: boolean) => {
    const resolved = resolvePath(template, path);
    const steps = resolved.steps.length;
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
  return any ? index : null;
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

const withClass = (className: string | undefined, add: string) =>
  className ? `${className} ${add}` : add;

/**
 * Flag the canvas for the lit paths. Elements on no lit path are returned by
 * identity, so the memoised renderers of everything else do not re-render.
 * Runs after the timeline pass (a hidden node stays hidden) and before the
 * selection lift, which concatenates classes rather than replacing them.
 */
export function applyPathView(
  nodes: Node[],
  edges: Edge[],
  index: PathGlowIndex | null,
): { nodes: Node[]; edges: Edge[] } {
  if (!index) return { nodes, edges };
  return {
    nodes: nodes.map((n) => {
      const docId = documentNodeId(n.id);
      const glows = docId === null ? undefined : index.nodes.get(docId);
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
      };
    }),
    edges: edges.map((e) => {
      const glows = index.edges.get(documentEdgeId(e.id));
      if (!glows?.length) return e;
      // A bright route names the key carrying each hop on the line itself.
      const bright = glows.some((g) => g.bright);
      const data = e.data as { startField?: string; data?: Record<string, unknown> } | undefined;
      const routeKey = bright ? edgeKeyOf({ startField: data?.startField, data: data?.data }) : undefined;
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
 * studio context (`dimmedIds`), where the node renderer already dims for the
 * tag filter; edges have no such hook, so the class goes on the React Flow
 * wrapper here. Null keeps everything, by identity.
 */
export function applyOutsideView(edges: Edge[], keepEdges: ReadonlySet<string> | null): Edge[] {
  if (!keepEdges) return edges;
  return edges.map((e) =>
    keepEdges.has(documentEdgeId(e.id)) ? e : { ...e, className: withClass(e.className, "as-edge--outside") },
  );
}

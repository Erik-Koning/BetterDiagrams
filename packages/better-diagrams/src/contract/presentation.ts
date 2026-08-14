/**
 * presentation.ts — the content/presentation split.
 *
 * One document, two homes. The CONTENT form is a template with the placement
 * stripped: nodes without `x/y/w/h`, edges without `labelT/start/end/points`
 * — everything an AI needs to reason about the architecture and nothing it
 * can mangle about the layout. The PRESENTATION form is the placement alone,
 * keyed by element id. Merging the two rebuilds the original template
 * byte-for-byte; either half also stands on its own (a content doc lays
 * itself out; a template never split still validates unchanged), so both the
 * inline and the split shape are first-class.
 *
 * Two deliberate boundaries:
 *  - ZONE boxes stay in content. In this editor zone geometry IS meaning —
 *    membership (`zoneId`) is derived from who sits inside the box — so a
 *    layout file that moved zones could silently rewrite the architecture.
 *  - Node records remember the `parent`/`zone` they were captured under.
 *    Coordinates are parent-relative and zone-anchored; if a content edit
 *    moved the node somewhere else, the stale position is discarded (its size
 *    survives) and the node is re-placed instead of materialising at a spot
 *    that meant something only in its old home.
 */
import {
  EDGE_ANCHOR_SIDES,
  validateTemplate,
  validateViewRecords,
  type DiagramEdge,
  type DiagramNode,
  type DiagramTemplate,
  type EdgeAnchor,
  type EdgeAnchorSide,
  type ValidateOptions,
  type ViewRecord,
} from "./schema";
import { autoLayout, placeUnpositioned } from "./layout";

export type { ViewRecord } from "./schema";

/** Top-level marker that lets an importer recognise a layout file on sight. */
export const PRESENTATION_FORMAT = "better-diagrams/presentation";

/** Where one node sits — plus the containment it was captured under. */
export interface NodePlacement {
  x: number;
  y: number;
  w: number;
  h: number;
  /** `parentId` at capture time. A mismatch at merge means the coords lie. */
  parent?: string;
  /** `zoneId` at capture time — same guard for zone-anchored coordinates. */
  zone?: string;
}

/** How one edge travels — only ever the parts that differ from the default. */
export interface EdgeRoute {
  /** Endpoints at capture time, so a renamed edge can still find its route. */
  source?: string;
  target?: string;
  labelT?: number;
  start?: EdgeAnchor;
  end?: EdgeAnchor;
  points?: Array<[number, number]>;
}

export interface DiagramPresentation {
  version: 1;
  format: typeof PRESENTATION_FORMAT;
  nodes?: Record<string, NodePlacement>;
  edges?: Record<string, EdgeRoute>;
  /**
   * Per-drill-view overrides (ghost placements, ghost edge routes), keyed by
   * focused node id — the split home of `template.meta.views`.
   */
  views?: Record<string, ViewRecord>;
}

/**
 * A template whose placement may be absent — what `splitTemplate` emits and
 * `mergeTemplate` accepts. A full `DiagramTemplate` satisfies it, which is
 * what makes "inline or split" a caller's choice rather than a mode.
 */
export interface DiagramContent extends Omit<DiagramTemplate, "nodes"> {
  nodes: Array<Omit<DiagramNode, "x" | "y" | "w" | "h"> & Partial<Pick<DiagramNode, "x" | "y" | "w" | "h">>>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function cleanAnchor(raw: unknown): EdgeAnchor | undefined {
  if (!isRecord(raw)) return undefined;
  if (!(EDGE_ANCHOR_SIDES as readonly string[]).includes(raw.side as string)) return undefined;
  const side = raw.side as EdgeAnchorSide;
  const t = finite(raw.t) ? Math.min(1, Math.max(0, raw.t)) : 0.5;
  return t === 0.5 ? { side } : { side, t };
}

function cleanPoints(raw: unknown): Array<[number, number]> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const points = raw
    .filter((p): p is [unknown, unknown] => Array.isArray(p) && p.length >= 2 && finite(Number(p[0])) && finite(Number(p[1])))
    .slice(0, 16)
    .map(([x, y]): [number, number] => [Math.round(Number(x)), Math.round(Number(y))]);
  return points.length ? points : undefined;
}

/**
 * Repair a presentation document rather than reject it. Records with broken
 * geometry are dropped; ids that don't exist in any particular content doc
 * are KEPT — whether they dangle is for `mergeTemplate` to decide, against
 * the content it is actually merging into.
 */
export function validatePresentation(raw: unknown): DiagramPresentation {
  const out: DiagramPresentation = { version: 1, format: PRESENTATION_FORMAT };
  if (!isRecord(raw)) return out;

  if (isRecord(raw.nodes)) {
    const nodes: Record<string, NodePlacement> = {};
    for (const [id, rec] of Object.entries(raw.nodes)) {
      if (!isRecord(rec)) continue;
      if (!finite(rec.x) || !finite(rec.y) || !finite(rec.w) || !finite(rec.h)) continue;
      if (rec.w <= 0 || rec.h <= 0) continue;
      nodes[id] = {
        x: rec.x,
        y: rec.y,
        w: rec.w,
        h: rec.h,
        ...(typeof rec.parent === "string" && rec.parent ? { parent: rec.parent } : {}),
        ...(typeof rec.zone === "string" && rec.zone ? { zone: rec.zone } : {}),
      };
    }
    if (Object.keys(nodes).length) out.nodes = nodes;
  }

  if (isRecord(raw.edges)) {
    const edges: Record<string, EdgeRoute> = {};
    for (const [id, rec] of Object.entries(raw.edges)) {
      if (!isRecord(rec)) continue;
      const labelT = finite(rec.labelT) ? Math.min(0.85, Math.max(0.15, rec.labelT)) : undefined;
      const start = cleanAnchor(rec.start);
      const end = cleanAnchor(rec.end);
      const points = cleanPoints(rec.points);
      const route: EdgeRoute = {
        ...(typeof rec.source === "string" && rec.source ? { source: rec.source } : {}),
        ...(typeof rec.target === "string" && rec.target ? { target: rec.target } : {}),
        ...(labelT !== undefined && labelT !== 0.5 ? { labelT } : {}),
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
        ...(points ? { points } : {}),
      };
      // A record that says nothing beyond its endpoints says nothing at all.
      if (route.labelT !== undefined || route.start || route.end || route.points) edges[id] = route;
    }
    if (Object.keys(edges).length) out.edges = edges;
  }

  const views = validateViewRecords(raw.views);
  if (views) out.views = views;

  return out;
}

/**
 * Split a template into its two homes. The input is validated first, so the
 * split of any loadable document is canonical — and `mergeTemplate` of the
 * result reproduces the validated input byte-for-byte.
 */
export function splitTemplate(
  template: DiagramTemplate,
  opts?: ValidateOptions,
): { content: DiagramContent; presentation: DiagramPresentation } {
  const t = validateTemplate(template, opts);

  const nodeRecords: Record<string, NodePlacement> = {};
  const nodes = t.nodes.map((n) => {
    const { x, y, w, h, ...rest } = n;
    nodeRecords[n.id] = {
      x,
      y,
      w,
      h,
      ...(n.parentId ? { parent: n.parentId } : {}),
      ...(n.zoneId ? { zone: n.zoneId } : {}),
    };
    return rest;
  });

  const edgeRecords: Record<string, EdgeRoute> = {};
  const edges = t.edges.map((e) => {
    const { labelT, start, end, points, ...rest } = e;
    const route: EdgeRoute = {
      source: e.source,
      target: e.target,
      // 0.5 is the default the validator resynthesises — never stored.
      ...(labelT !== undefined && labelT !== 0.5 ? { labelT } : {}),
      ...(start ? { start } : {}),
      ...(end ? { end } : {}),
      ...(points ? { points } : {}),
    };
    if (route.labelT !== undefined || route.start || route.end || route.points) {
      edgeRecords[e.id] = route;
    }
    return rest as DiagramEdge;
  });

  // Per-view overrides are presentation through and through — they follow
  // the placements out of the content doc.
  const metaViews = t.meta?.views;
  let contentMeta = t.meta;
  if (metaViews) {
    const { views: _views, ...rest } = t.meta!;
    contentMeta = Object.keys(rest).length ? rest : undefined;
  }

  const content: DiagramContent = { ...t, nodes, edges };
  if (contentMeta) content.meta = contentMeta;
  else delete content.meta;

  const presentation: DiagramPresentation = {
    version: 1,
    format: PRESENTATION_FORMAT,
    ...(Object.keys(nodeRecords).length ? { nodes: nodeRecords } : {}),
    ...(Object.keys(edgeRecords).length ? { edges: edgeRecords } : {}),
    ...(metaViews ? { views: metaViews } : {}),
  };
  return { content, presentation };
}

/**
 * Recombine content with placement into a full template.
 *
 * Per node: the record wins when its captured `parent`/`zone` still match;
 * on a mismatch the position is discarded (the size survives — a reparented
 * service is still the same size) and the node re-places. A node with neither
 * a record nor its own coordinates is new: `placeUnpositioned` stacks it
 * below the occupied area of its container without moving anything else.
 *
 * Per edge: matched by id first; records whose id no longer exists fall back
 * to their captured `(source, target)` pair, first unclaimed match — models
 * renumber edge ids routinely, and losing the whole route over a rename
 * would make content editing hostile.
 *
 * Ends in `validateTemplate`: canonical key order comes from its rebuild, and
 * out-of-range record values get the same clamps as any other input.
 */
export function mergeTemplate(
  content: DiagramContent | DiagramTemplate,
  presentation?: DiagramPresentation,
  opts?: ValidateOptions,
): DiagramTemplate {
  const pres = presentation ? validatePresentation(presentation) : undefined;
  const contentNodes = Array.isArray(content?.nodes) ? content.nodes : [];
  const contentEdges = Array.isArray(content?.edges) ? content.edges : [];

  const unpositioned: string[] = [];
  const nodes = contentNodes.map((n) => {
    const rec = pres?.nodes?.[n.id];
    const parentOk = rec && (rec.parent ?? null) === (n.parentId ?? null);
    const zoneOk = rec && (rec.zone ?? null) === (n.zoneId ?? null);
    if (rec && parentOk && zoneOk) {
      return { ...n, x: rec.x, y: rec.y, w: rec.w, h: rec.h };
    }
    if (rec) {
      // Containment moved out from under the coords; keep only the size.
      unpositioned.push(String(n.id));
      return { ...n, x: 0, y: 0, w: rec.w, h: rec.h };
    }
    if (finite((n as DiagramNode).x) && finite((n as DiagramNode).y)) return n;
    unpositioned.push(String(n.id));
    return n;
  });

  // Route records: by id, then by captured endpoints for renamed edges.
  const contentEdgeIds = new Set(contentEdges.map((e) => String(e.id)));
  const byEndpoints = new Map<string, EdgeRoute[]>();
  for (const [id, route] of Object.entries(pres?.edges ?? {})) {
    if (contentEdgeIds.has(id) || !route.source || !route.target) continue;
    const key = `${route.source}→${route.target}`;
    if (!byEndpoints.has(key)) byEndpoints.set(key, []);
    byEndpoints.get(key)!.push(route);
  }

  const edges = contentEdges.map((e) => {
    let route = pres?.edges?.[String(e.id)];
    if (!route) route = byEndpoints.get(`${e.source}→${e.target}`)?.shift();
    if (!route) return e;
    const { source: _s, target: _t, ...applied } = route;
    return { ...e, ...applied };
  });

  // Per-view overrides ride home on meta; validateTemplate canonicalises
  // their position (views last), which is what keeps the round trip byte-true.
  const mergedMeta = pres?.views ? { ...(content.meta ?? {}), views: pres.views } : content.meta;
  const merged = validateTemplate(
    { ...content, ...(mergedMeta ? { meta: mergedMeta } : {}), nodes, edges } as DiagramTemplate,
    opts,
  );
  if (!unpositioned.length) return merged;
  // NOTHING has a position — a bare content doc. Incremental stacking would
  // pile the whole document into one column; the full layout is what "no
  // layout yet" actually calls for. Placement stays incremental the moment
  // even one element has a home to respect.
  const layoutOpts = { containerKinds: opts?.containerKinds };
  if (unpositioned.length === merged.nodes.length && merged.nodes.length > 1) {
    // Nothing is placed anywhere, so every drilled canvas needs arranging
    // too — otherwise each level's contents would sit piled at its origin.
    return autoLayout(merged, { ...layoutOpts, frames: "all" });
  }
  return placeUnpositioned(merged, unpositioned, layoutOpts);
}

/**
 * edit.ts — pure edits to a diagram document.
 *
 *   let doc = addNode(template, { label: "Cache", kind: "database" });
 *   doc = addEdge(doc, { source: "api", target: "cache", label: "reads" });
 *   doc = updateNode(doc, "cache", { label: "Redis" });
 *   doc = removeNodes(doc, ["legacy"]);
 *
 * Each function takes a document and returns a new one; the input is never
 * touched. What they guarantee is REFERENTIAL integrity — the rules the
 * editor's own gestures follow:
 *
 *  - removing a node removes everything nested under it, every edge touching
 *    one of them, and an arrow-end dot left with no line;
 *  - removing a zone leaves its members in place and clears their `zoneId`;
 *  - renaming a node or edge rewrites every reference to it — edges, children,
 *    paths, saved analyses, lineage and per-view layout;
 *  - a reference to an id the document doesn't have, an id already in use, or
 *    a parent that would contain itself is refused with an Error, rather than
 *    repaired after the fact.
 *
 * They do NOT coerce values: a kind or a colour stays whatever you wrote.
 * `validateTemplateReport` canonicalises a result and lists what it had to
 * change; the editor's `update()` handle method runs it for you.
 */
import {
  BOUNDARY_NODE_PREFIX,
  GHOST_NODE_PREFIX,
  KIND_DEFAULT_SIZE,
  EDGE_COLORS,
  POINT_KINDS,
  type DiagramEdge,
  type DiagramNode,
  type DiagramTemplate,
  type ViewRecord,
} from "./schema";
import type { DiagramZone } from "./zones";
import { validatePaths } from "./paths";
import { validateAnalyses, type SavedAnalysis } from "./analyses";
import { validateLineage } from "./lineage-links";
import { placeUnpositioned } from "./layout";

/** A node to add — anything a `DiagramNode` carries, all of it optional. */
export type NodeInput = Partial<DiagramNode>;
/** An edge to add: its two ends, plus anything else a `DiagramEdge` carries. */
export type EdgeInput = Partial<DiagramEdge> & { source: string; target: string };
/** A zone to add — anything a `DiagramZone` carries, all of it optional. */
export type ZoneInput = Partial<DiagramZone>;

/**
 * A change to one element: the keys to set (an explicit `undefined` clears
 * one), or a function from the element to its replacement.
 */
export type ElementUpdate<T> = Partial<T> | ((current: T) => T);

/** Ids to remove, by the document collection they live in. */
export interface ElementIds {
  nodes?: readonly string[];
  edges?: readonly string[];
  zones?: readonly string[];
}

export interface RemoveOptions {
  /**
   * Kinds that are bare arrow ends (the built-in `point`): one left with no
   * line once its edges are gone is removed too, as the editor's Delete does.
   * Pass a registry's own point kinds when it defines more.
   */
  pointKinds?: readonly string[];
}

/** The default size of a zone, the one validation fills in. */
const ZONE_SIZE = { w: 400, h: 300 } as const;

/**
 * An id no node, edge or zone in the document uses yet, made from `base`: a
 * label slugs to lower-case words joined by dashes ("Redis Cache" →
 * `redis-cache`), then `-2`, `-3`… until it is free.
 */
export function uniqueId(template: DiagramTemplate, base: string): string {
  const slug =
    base
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 48)
      .replace(/^-+|-+$/g, "") || "node";
  const taken = new Set<string>([
    ...template.nodes.map((n) => n.id),
    ...template.edges.map((e) => e.id),
    ...(template.zones ?? []).map((z) => z.id),
  ]);
  if (!taken.has(slug)) return slug;
  let n = 2;
  while (taken.has(`${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}

// ── Nodes ────────────────────────────────────────────────────────────────────

/**
 * Add a node. Without an `id` one is made from the label (or kind) with
 * `uniqueId`; without both `x` and `y` it is placed below whatever already
 * occupies its container, moving nothing else. Throws when the id is taken
 * or the `parentId` / `zoneId` names nothing.
 */
export function addNode(template: DiagramTemplate, input: NodeInput = {}): DiagramTemplate {
  const kind = input.kind ?? "service";
  const id = input.id ?? uniqueId(template, input.label || kind);
  if (template.nodes.some((n) => n.id === id)) throw new Error(`A node with id "${id}" already exists`);
  if (input.parentId) requireNode(template, input.parentId, "parent");
  if (input.zoneId) requireZone(template, input.zoneId);
  const size = KIND_DEFAULT_SIZE[kind] ?? KIND_DEFAULT_SIZE.default;
  const positioned = typeof input.x === "number" && typeof input.y === "number";
  const node: DiagramNode = withoutUndefined({
    label: input.label ?? id,
    icon: "none",
    description: "",
    w: size.w,
    h: size.h,
    ...withoutUndefined(input),
    id,
    kind,
    parentId: input.parentId ?? null,
    x: input.x ?? 0,
    y: input.y ?? 0,
  });
  const next = { ...template, nodes: [...template.nodes, node] };
  return positioned ? next : placeUnpositioned(next, [id]);
}

/**
 * Change one node. A new `id` renames it (see `renameNode`); a new
 * `parentId` must name a node that isn't this one or nested inside it.
 * Throws when the node doesn't exist.
 */
export function updateNode(
  template: DiagramTemplate,
  id: string,
  update: ElementUpdate<DiagramNode>,
): DiagramTemplate {
  const current = requireNode(template, id, "node");
  const next = withoutUndefined(typeof update === "function" ? update(current) : { ...current, ...update });
  let doc = template;
  if (next.id !== id) doc = renameNode(doc, id, next.id);
  if (next.parentId && next.parentId !== current.parentId) {
    requireNode(doc, next.parentId, "parent");
    if (next.parentId === next.id || descendantsOf(doc, [next.id]).has(next.parentId)) {
      throw new Error(`Node "${next.id}" cannot be placed inside itself`);
    }
  }
  if (next.zoneId && next.zoneId !== current.zoneId) requireZone(doc, next.zoneId);
  return { ...doc, nodes: doc.nodes.map((n) => (n.id === next.id ? { ...next, parentId: next.parentId ?? null } : n)) };
}

/**
 * Give a node a new id, rewriting every reference to the old one: edges,
 * children, path steps, saved analyses, lineage, and the per-view layout in
 * `meta.views`. Throws when `from` doesn't exist or `to` is taken.
 */
export function renameNode(template: DiagramTemplate, from: string, to: string): DiagramTemplate {
  requireNode(template, from, "node");
  if (from === to) return template;
  if (!to.trim()) throw new Error("A node id cannot be empty");
  if (template.nodes.some((n) => n.id === to)) throw new Error(`A node with id "${to}" already exists`);
  const swap = (id: string) => (id === from ? to : id);
  const out: DiagramTemplate = {
    ...template,
    nodes: template.nodes.map((n) => ({
      ...n,
      id: swap(n.id),
      parentId: n.parentId ? swap(n.parentId) : n.parentId,
    })),
    edges: template.edges.map((e) =>
      e.source === from || e.target === from ? { ...e, source: swap(e.source), target: swap(e.target) } : e,
    ),
  };
  if (template.paths) out.paths = template.paths.map((p) => ({ ...p, steps: p.steps.map(swap) }));
  if (template.analyses) out.analyses = template.analyses.map((a) => renameInAnalysis(a, swap));
  if (template.lineage) {
    out.lineage = template.lineage.map((l) => ({
      ...l,
      from: { ...l.from, nodeId: swap(l.from.nodeId) },
      to: { ...l.to, nodeId: swap(l.to.nodeId) },
    }));
  }
  const views = template.meta?.views;
  if (views) {
    out.meta = {
      ...template.meta,
      views: Object.fromEntries(
        Object.entries(views).map(([focus, view]) => [swap(focus), renameKeys(view, "nodes", swap)]),
      ),
    };
  }
  return out;
}

/** Remove nodes, with everything nested under them — see `removeElements`. */
export function removeNodes(
  template: DiagramTemplate,
  ids: readonly string[],
  options?: RemoveOptions,
): DiagramTemplate {
  return removeElements(template, { nodes: ids }, options);
}

// ── Edges ────────────────────────────────────────────────────────────────────

/**
 * Connect two nodes. Without an `id` one is made from the two ends. Throws
 * when either end names no node or the id is taken. A self-loop
 * (`source === target`) is allowed — it draws a retry loop.
 */
export function addEdge(template: DiagramTemplate, input: EdgeInput): DiagramTemplate {
  requireNode(template, input.source, "source");
  requireNode(template, input.target, "target");
  const id = input.id ?? uniqueId(template, `e-${input.source}-${input.target}`);
  if (template.edges.some((e) => e.id === id)) throw new Error(`An edge with id "${id}" already exists`);
  const edge: DiagramEdge = withoutUndefined({ label: "", style: "solid", color: "slate", ...withoutUndefined(input), id });
  return { ...template, edges: [...template.edges, edge] };
}

/**
 * Change one edge. New ends must name existing nodes; a new `id` is
 * rewritten in path steps and per-view routes. Throws when the edge doesn't
 * exist.
 */
export function updateEdge(
  template: DiagramTemplate,
  id: string,
  update: ElementUpdate<DiagramEdge>,
): DiagramTemplate {
  const current = template.edges.find((e) => e.id === id);
  if (!current) throw new Error(`No edge with id "${id}"`);
  const next = withoutUndefined(typeof update === "function" ? update(current) : { ...current, ...update });
  if (next.source !== current.source) requireNode(template, next.source, "source");
  if (next.target !== current.target) requireNode(template, next.target, "target");
  // A field anchor names a row of the end it sits on; moving the end loses it.
  if (next.source !== current.source && next.startField === current.startField) delete next.startField;
  if (next.target !== current.target && next.endField === current.endField) delete next.endField;
  const out: DiagramTemplate = { ...template, edges: template.edges.map((e) => (e.id === id ? next : e)) };
  if (next.id === id) return out;
  if (!next.id.trim()) throw new Error("An edge id cannot be empty");
  if (template.edges.some((e) => e.id === next.id)) throw new Error(`An edge with id "${next.id}" already exists`);
  const swap = (step: string) => (step === id ? next.id : step);
  if (template.paths) out.paths = template.paths.map((p) => ({ ...p, steps: p.steps.map(swap) }));
  const views = template.meta?.views;
  if (views) {
    out.meta = {
      ...template.meta,
      views: Object.fromEntries(Object.entries(views).map(([focus, view]) => [focus, renameKeys(view, "edges", swap)])),
    };
  }
  return out;
}

/** Remove edges — see `removeElements`. */
export function removeEdges(
  template: DiagramTemplate,
  ids: readonly string[],
  options?: RemoveOptions,
): DiagramTemplate {
  return removeElements(template, { edges: ids }, options);
}

// ── Zones ────────────────────────────────────────────────────────────────────

/** Add an infrastructure zone. Without an `id` one is made from the label. Throws when the id is taken. */
export function addZone(template: DiagramTemplate, input: ZoneInput = {}): DiagramTemplate {
  const id = input.id ?? uniqueId(template, input.label || "zone");
  if ((template.zones ?? []).some((z) => z.id === id)) throw new Error(`A zone with id "${id}" already exists`);
  const providers = input.providers?.length ? input.providers : [input.provider ?? "onprem"];
  const zone: DiagramZone = withoutUndefined({
    label: input.label ?? id,
    shape: "rounded",
    x: 0,
    y: 0,
    ...ZONE_SIZE,
    ...withoutUndefined(input),
    id,
    providers,
    provider: input.provider && providers.includes(input.provider) ? input.provider : providers[0],
  });
  return { ...template, zones: [...(template.zones ?? []), zone] };
}

/** Change one zone. A new `id` is rewritten in every member's `zoneId`. Throws when the zone doesn't exist. */
export function updateZone(
  template: DiagramTemplate,
  id: string,
  update: ElementUpdate<DiagramZone>,
): DiagramTemplate {
  const current = requireZone(template, id);
  const next = withoutUndefined(typeof update === "function" ? update(current) : { ...current, ...update });
  const zones = (template.zones ?? []).map((z) => (z.id === id ? next : z));
  if (next.id === id) return { ...template, zones };
  if (!next.id.trim()) throw new Error("A zone id cannot be empty");
  if ((template.zones ?? []).some((z) => z.id === next.id)) throw new Error(`A zone with id "${next.id}" already exists`);
  return {
    ...template,
    zones,
    nodes: template.nodes.map((n) => (n.zoneId === id ? { ...n, zoneId: next.id } : n)),
  };
}

/** Remove zones; their members stay — see `removeElements`. */
export function removeZones(template: DiagramTemplate, ids: readonly string[]): DiagramTemplate {
  return removeElements(template, { zones: ids });
}

// ── Removal ──────────────────────────────────────────────────────────────────

/**
 * Remove nodes, edges and zones in one pass, with the cascade the editor's
 * Delete applies:
 *
 *  - a node takes everything nested under it (its `parentId` descendants)
 *    and every edge touching any of them;
 *  - an arrow-end dot (`pointKinds`) left with no line goes too;
 *  - a zone takes only its backdrop: its members stay, with `zoneId` cleared;
 *  - path steps, saved analyses, lineage links and per-view layout that
 *    pointed at something removed are dropped with it.
 *
 * Ids the document doesn't have are ignored, so removing twice is harmless.
 */
export function removeElements(
  template: DiagramTemplate,
  ids: ElementIds,
  options: RemoveOptions = {},
): DiagramTemplate {
  const doomed = descendantsOf(template, ids.nodes ?? []);
  const cutEdges = new Set(ids.edges ?? []);
  const goneZones = new Set(ids.zones ?? []);
  const removedEdge = (e: { id: string; source: string; target: string }) =>
    cutEdges.has(e.id) || doomed.has(e.source) || doomed.has(e.target);
  const pointKinds = new Set(options.pointKinds ?? POINT_KINDS);
  const points = new Set(template.nodes.filter((n) => pointKinds.has(n.kind)).map((n) => n.id));
  for (const id of strandedPoints(points, template.edges, removedEdge)) doomed.add(id);

  const edges = template.edges.filter((e) => !removedEdge(e) && !doomed.has(e.source) && !doomed.has(e.target));
  if (!doomed.size && edges.length === template.edges.length && !(template.zones ?? []).some((z) => goneZones.has(z.id))) {
    return template;
  }
  const nodes = template.nodes
    .filter((n) => !doomed.has(n.id))
    .map((n) => (n.zoneId && goneZones.has(n.zoneId) ? { ...n, zoneId: null } : n));
  const out: DiagramTemplate = { ...template, nodes, edges };
  if (template.zones) {
    const zones = template.zones.filter((z) => !goneZones.has(z.id));
    if (zones.length) out.zones = zones;
    else delete out.zones;
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  const edgeIds = new Set(edges.map((e) => e.id));
  if (template.paths) {
    const paths = validatePaths(template.paths, { nodeIds, edgeIds, colors: EDGE_COLORS });
    if (paths.length) out.paths = paths;
    else delete out.paths;
  }
  if (template.analyses) {
    const analyses = validateAnalyses(template.analyses, { nodeIds });
    if (analyses.length) out.analyses = analyses;
    else delete out.analyses;
  }
  if (template.lineage) {
    const lineage = validateLineage(template.lineage, { nodeIds });
    if (lineage.length) out.lineage = lineage;
    else delete out.lineage;
  }
  const views = template.meta?.views;
  if (views) {
    const kept = Object.entries(views)
      .filter(([focus]) => nodeIds.has(focus))
      .map(([focus, view]) => [focus, pruneView(view, nodeIds, edgeIds)] as const)
      .filter(([, view]) => view.nodes || view.edges);
    const meta = { ...template.meta };
    if (kept.length) meta.views = Object.fromEntries(kept);
    else delete meta.views;
    out.meta = meta;
  }
  return out;
}

/**
 * The arrow-end dots a removal leaves with no line: each is an end of a
 * removed edge and of no edge that stays. Exactly those — a dot that was
 * already alone was put there on purpose.
 */
export function strandedPoints(
  pointIds: ReadonlySet<string>,
  edges: ReadonlyArray<{ id: string; source: string; target: string }>,
  removed: (edge: { id: string; source: string; target: string }) => boolean,
): Set<string> {
  const out = new Set<string>();
  const kept = edges.filter((e) => !removed(e));
  for (const e of edges) {
    if (!removed(e)) continue;
    for (const end of [e.source, e.target]) {
      if (pointIds.has(end) && !kept.some((k) => k.source === end || k.target === end)) {
        out.add(end);
      }
    }
  }
  return out;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The given ids that exist, plus every node nested under them at any depth. */
function descendantsOf(template: DiagramTemplate, ids: readonly string[]): Set<string> {
  const known = new Set(template.nodes.map((n) => n.id));
  const out = new Set(ids.filter((id) => known.has(id)));
  let grew = out.size > 0;
  while (grew) {
    grew = false;
    for (const n of template.nodes) {
      if (n.parentId && out.has(n.parentId) && !out.has(n.id)) {
        out.add(n.id);
        grew = true;
      }
    }
  }
  return out;
}

function requireNode(template: DiagramTemplate, id: string, role: string): DiagramNode {
  const node = template.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`No node with id "${id}"${role === "node" ? "" : ` for the ${role}`}`);
  return node;
}

function requireZone(template: DiagramTemplate, id: string): DiagramZone {
  const zone = template.zones?.find((z) => z.id === id);
  if (!zone) throw new Error(`No zone with id "${id}"`);
  return zone;
}

/** A copy without keys set to `undefined` — how a patch clears a field. */
function withoutUndefined<T extends object>(value: T): T {
  const out = { ...value };
  for (const key of Object.keys(out) as Array<keyof T>) {
    if (out[key] === undefined) delete out[key];
  }
  return out;
}

/**
 * The document id a per-view record is about, and the prefix it wears. A
 * drill-in view records a ghost — a stand-in for an element on another level —
 * under its canvas id (`ghost:<id>`, see scope.ts), so a key is resolved to
 * the element it names before it is kept or renamed.
 */
function viewKey(key: string): { prefix: string; id: string } {
  for (const prefix of [GHOST_NODE_PREFIX, BOUNDARY_NODE_PREFIX]) {
    if (key.startsWith(prefix)) return { prefix, id: key.slice(prefix.length) };
  }
  return { prefix: "", id: key };
}

function renameKeys(view: ViewRecord, part: "nodes" | "edges", swap: (id: string) => string): ViewRecord {
  const records = view[part];
  if (!records) return view;
  const renamed = Object.entries(records).map(([key, rec]) => {
    const { prefix, id } = viewKey(key);
    return [prefix + swap(id), rec] as const;
  });
  return { ...view, [part]: Object.fromEntries(renamed) };
}

function pruneView(view: ViewRecord, nodeIds: ReadonlySet<string>, edgeIds: ReadonlySet<string>): ViewRecord {
  const out: ViewRecord = {};
  const nodes = view.nodes && Object.entries(view.nodes).filter(([key]) => nodeIds.has(viewKey(key).id));
  if (nodes?.length) out.nodes = Object.fromEntries(nodes);
  const edges = view.edges && Object.entries(view.edges).filter(([key]) => edgeIds.has(viewKey(key).id));
  if (edges?.length) out.edges = Object.fromEntries(edges);
  return out;
}

/** Every node reference a saved analysis holds, run through `swap`. */
function renameInAnalysis(analysis: SavedAnalysis, swap: (id: string) => string): SavedAnalysis {
  const ref = <T extends { nodeId: string }>(r: T): T => ({ ...r, nodeId: swap(r.nodeId) });
  switch (analysis.kind) {
    case "paths":
      return { ...analysis, pins: analysis.pins.map(ref) };
    case "coverage":
      return {
        ...analysis,
        keys: analysis.keys.map(ref),
        scope: analysis.scope.kind === "from" ? ref(analysis.scope) : analysis.scope,
      };
    case "impact":
      return { ...analysis, subject: ref(analysis.subject) };
    case "neighbourhood":
      return { ...analysis, from: analysis.from.map(swap) };
    case "usage":
      return analysis;
  }
}

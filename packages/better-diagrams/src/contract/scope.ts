/**
 * scope.ts — drill-in views: one template, one derived diagram per level.
 *
 * A node's children (`parentId`) are its next C4 level. `scopedView` derives
 * the diagram for one focused node: the focus becomes an open BOUNDARY frame,
 * its direct children render as ordinary boxes at their stored coordinates,
 * and every edge crossing the boundary lands on a derived GHOST standing in
 * for the outside element. Like `materializeCombo` (states.ts), the result is
 * a view document, never something to save — every derived element carries a
 * reserved id prefix (schema.ts) so a canvas round-trip strips it.
 *
 * The coordinate rule that makes editing-in-focus trivial: a child's stored
 * parent-relative x/y ARE its coordinates in the focused view. Dragging a
 * child in focus writes plain document coordinates — no transform, no second
 * home. `liftScopedReactFlow` is the exact inverse of `scopedView ∘
 * toReactFlow`, and the pinned law is byte-identity:
 *
 *     lift(toReactFlow(scopedView(t, f)), f, { base: t }) ≡ t
 *
 * Whatever `scopedView` strips or forces (zone membership, forced chips,
 * group-focus waypoints), `lift` restores from base — the same carry-through
 * discipline collapse established.
 */
import {
  BOUNDARY_NODE_PREFIX,
  COLLAPSED_SIZE,
  CONTAINER_KINDS,
  GHOST_EDGE_PREFIX,
  GHOST_NODE_PREFIX,
  NODE_MIN_SIZE,
  fromReactFlow,
  hiddenInline,
  isBoundaryNodeId,
  isGhostEdgeId,
  isGhostNodeId,
  visibleAnchor,
  type DiagramEdge,
  type DiagramNode,
  type DiagramTemplate,
  type RFEdgeLike,
  type RFNodeLike,
  type ValidateOptions,
  type ViewRecord,
} from "./schema";
import { effectiveNodeDates } from "./timeline";

/** Inset between the boundary frame and the children it wraps. */
const BOUNDARY_PAD = 28;
/** Extra top inset clearing the boundary's header chip. */
const BOUNDARY_HEADER = 52;
/** Gap between the boundary frame and a ghost column. */
const GHOST_GAP = 90;
/** Vertical gap between stacked ghosts. */
const GHOST_STACK_GAP = 28;

export interface ScopedViewOptions {
  /** Kinds that render as open containers — `registry.containerKinds`. */
  containerKinds?: readonly string[];
  /** Per-view overrides. Defaults to `template.meta.views[focusId]`. */
  view?: ViewRecord;
}

/** Every node with internal detail — the drillable set, in document order. */
export function drillableIds(t: DiagramTemplate): string[] {
  const parents = new Set(t.nodes.map((n) => n.parentId).filter((p): p is string => !!p));
  return t.nodes.filter((n) => parents.has(n.id)).map((n) => n.id);
}

/**
 * The ancestor chain of a node, root first, EXCLUDING the node itself — the
 * focus stack that shows it. Breadcrumbs for a focus f are
 * `[...focusPath(t, f), f]`; navigating to a node drills to `focusPath(t, n)`.
 */
export function focusPath(t: DiagramTemplate, nodeId: string): string[] {
  const byId = new Map(t.nodes.map((n) => [n.id, n]));
  const path: string[] = [];
  const guard = new Set<string>([nodeId]);
  let cursor = byId.get(nodeId)?.parentId ?? null;
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    path.unshift(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return path;
}

/**
 * The shared partition both directions are built on — using it from both
 * `scopedView` and `liftScopedReactFlow` is what makes them agree by
 * construction on which edges are interior (verbatim, real id) and which are
 * derived stand-ins.
 */
interface ScopePartition {
  focus: DiagramNode;
  /** The focus and every descendant. */
  subtree: Set<string>;
  /** Direct children, document order. */
  children: DiagramNode[];
  childIds: Set<string>;
  /** View representative of any node id (child id, `boundary:` or `ghost:`). */
  rep: (id: string) => string;
  /** Edge ids emitted verbatim — both endpoints are direct children. */
  interiorEdges: Set<string>;
}

function scopePartition(
  t: DiagramTemplate,
  focusId: string,
  containerKinds?: readonly string[],
): ScopePartition | null {
  const byId = new Map(t.nodes.map((n) => [n.id, n]));
  const focus = byId.get(focusId);
  if (!focus) return null;

  const subtree = new Set<string>([focusId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of t.nodes) {
      if (!subtree.has(n.id) && n.parentId && subtree.has(n.parentId)) {
        subtree.add(n.id);
        grew = true;
      }
    }
  }

  const children = t.nodes.filter((n) => n.parentId === focusId);
  const childIds = new Set(children.map((n) => n.id));

  // Outside representatives ignore transient collapse flags: which level an
  // element belongs to must not change when the user collapses a group.
  const drillHidden = hiddenInline(t, containerKinds);

  const repCache = new Map<string, string>();
  const rep = (id: string): string => {
    const hit = repCache.get(id);
    if (hit !== undefined) return hit;
    let out: string;
    if (id === focusId) {
      out = `${BOUNDARY_NODE_PREFIX}${focusId}`;
    } else if (subtree.has(id)) {
      // The direct-child ancestor on the path up to the focus.
      let cursor = id;
      const guard = new Set<string>();
      while (!childIds.has(cursor) && !guard.has(cursor)) {
        guard.add(cursor);
        cursor = byId.get(cursor)?.parentId ?? cursor;
        if (guard.has(cursor)) break;
      }
      out = cursor;
    } else {
      out = `${GHOST_NODE_PREFIX}${visibleAnchor(id, byId, drillHidden)}`;
    }
    repCache.set(id, out);
    return out;
  };

  // A self-loop on a direct child IS of this level: the retry arrow the schema
  // prompt asks for belongs to the box it loops on, wherever that box is being
  // shown. (A self-loop deeper down still collapses onto its card below — both
  // ends map to the same representative and it is dropped as internal wiring.)
  const interiorEdges = new Set(
    t.edges
      .filter((e) => childIds.has(e.source) && childIds.has(e.target))
      .map((e) => e.id),
  );

  return { focus, subtree, children, childIds, rep, interiorEdges };
}

/** Rendered size of a node standing on a level: closed groups show as chips. */
function renderSize(
  n: DiagramNode,
  hasChildren: boolean,
  containerSet: ReadonlySet<string>,
): { w: number; h: number } {
  if (hasChildren && containerSet.has(n.kind as string)) return { ...COLLAPSED_SIZE };
  return { w: n.w, h: n.h };
}

/**
 * Derive the diagram for one level: the focused node's boundary frame, its
 * direct children, and ghost stand-ins for everything they talk to outside.
 * Pure and deterministic; the input is never touched. Throws on an unknown
 * focus id — that is a caller bug, not repairable input.
 */
export function scopedView(
  t: DiagramTemplate,
  focusId: string,
  opts: ScopedViewOptions = {},
): DiagramTemplate {
  const part = scopePartition(t, focusId, opts.containerKinds);
  if (!part) throw new Error(`scopedView: unknown focus id "${focusId}"`);
  const { focus, children, rep, interiorEdges } = part;

  const containerSet = new Set(opts.containerKinds ?? CONTAINER_KINDS);
  const byId = new Map(t.nodes.map((n) => [n.id, n]));
  const parents = new Set(t.nodes.map((n) => n.parentId).filter((p): p is string => !!p));
  const view = opts.view ?? t.meta?.views?.[focusId];
  const focusIsContainer = containerSet.has(focus.kind as string);

  // ── Children: stored parent-relative coords ARE the view coords. ──
  const emittedChildren: DiagramNode[] = children.map((child) => {
    const hasChildren = parents.has(child.id);
    const forceChip = hasChildren && containerSet.has(child.kind as string);
    return {
      ...child,
      parentId: null,
      zoneId: null,
      ...(forceChip ? { collapsed: true } : {}),
    };
  });

  // ── Boundary box wraps the children (at their RENDER size — chips are
  // small), or falls back to the focus card's own footprint when empty. ──
  let bounds: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const child of children) {
    const size = renderSize(child, parents.has(child.id), containerSet);
    const minX = child.x;
    const minY = child.y;
    bounds = bounds
      ? {
          minX: Math.min(bounds.minX, minX),
          minY: Math.min(bounds.minY, minY),
          maxX: Math.max(bounds.maxX, minX + size.w),
          maxY: Math.max(bounds.maxY, minY + size.h),
        }
      : { minX, minY, maxX: minX + size.w, maxY: minY + size.h };
  }
  const boundaryBox = bounds
    ? {
        x: bounds.minX - BOUNDARY_PAD,
        y: bounds.minY - BOUNDARY_HEADER,
        w: bounds.maxX - bounds.minX + BOUNDARY_PAD * 2,
        h: bounds.maxY - bounds.minY + BOUNDARY_HEADER + BOUNDARY_PAD,
      }
    : {
        x: 0,
        y: 0,
        w: Math.max(focus.w, NODE_MIN_SIZE.group.w),
        h: Math.max(focus.h, NODE_MIN_SIZE.group.h),
      };

  const boundary: DiagramNode = {
    id: `${BOUNDARY_NODE_PREFIX}${focusId}`,
    label: focus.label,
    kind: "group",
    icon: focus.icon,
    description: focus.description,
    parentId: null,
    zoneId: null,
    x: boundaryBox.x,
    y: boundaryBox.y,
    w: boundaryBox.w,
    h: boundaryBox.h,
    locked: true,
  };

  // ── Edges: verbatim interiors, derived stand-ins for everything remapped. ──
  const isInside = (r: string) => !r.startsWith(GHOST_NODE_PREFIX);
  const nodeDates = effectiveNodeDates(t);

  interface RemapGroup {
    key: string;
    srcRep: string;
    tgtRep: string;
    edges: DiagramEdge[];
    crossing: boolean;
  }
  const groups = new Map<string, RemapGroup>();
  const order: Array<{ verbatim?: DiagramEdge; group?: RemapGroup }> = [];

  for (const e of t.edges) {
    const srcRep = rep(e.source);
    const tgtRep = rep(e.target);
    const srcIn = isInside(srcRep);
    const tgtIn = isInside(tgtRep);
    if (!srcIn && !tgtIn) continue; // other levels' wiring
    if (interiorEdges.has(e.id)) {
      // Both endpoints are direct children — the edge is genuinely OF this
      // level. Group-focus interiors drop `points`: group children are inline
      // at root, so stored waypoints are root-space (lift restores them).
      const emit = focusIsContainer && e.points ? stripPoints(e) : e;
      order.push({ verbatim: emit });
      continue;
    }
    if (srcRep === tgtRep) continue; // internal wiring of one child card
    const key = `${srcRep}→${tgtRep}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, srcRep, tgtRep, edges: [], crossing: !srcIn || !tgtIn };
      groups.set(key, group);
      order.push({ group });
    }
    group.edges.push(e);
  }

  const edges: DiagramEdge[] = [];
  for (const entry of order) {
    if (entry.verbatim) {
      edges.push(entry.verbatim);
      continue;
    }
    const g = entry.group!;
    const first = g.edges[0];
    const single = g.edges.length === 1;
    // A single CROSSING edge keeps its payload — labels to externals are the
    // point of a container diagram. Converging bundles and interior remaps
    // follow the collapse precedent: a stand-in shows no one original's text.
    const keepPayload = single && g.crossing;
    const { start, end, points: _points, tech, seq, date, ...rest } = first;
    const derived: DiagramEdge = {
      ...rest,
      id: `${GHOST_EDGE_PREFIX}${first.id}`,
      source: g.srcRep,
      target: g.tgtRep,
      label: keepPayload ? first.label : "",
      ...(keepPayload && tech !== undefined ? { tech } : {}),
      ...(keepPayload && seq !== undefined ? { seq } : {}),
      ...(keepPayload && date !== undefined ? { date } : {}),
      // An anchor names a side of a specific box: it survives only on an
      // endpoint that is still that box.
      ...(keepPayload && start && g.srcRep === first.source ? { start } : {}),
      ...(keepPayload && end && g.tgtRep === first.target ? { end } : {}),
    };
    const override = view?.edges?.[derived.id];
    if (override) {
      if (override.labelT !== undefined) derived.labelT = override.labelT;
      if (override.start) derived.start = override.start;
      if (override.end) derived.end = override.end;
      if (override.points) derived.points = override.points;
    }
    edges.push(derived);
  }

  // ── Ghosts: one per outside representative, columned by direction. ──
  const ghostIds: string[] = [];
  const ghostInbound = new Map<string, boolean>();
  for (const g of [...groups.values()].filter((g) => g.crossing)) {
    const ghostId = isInside(g.srcRep) ? g.tgtRep : g.srcRep;
    if (!ghostInbound.has(ghostId)) {
      ghostIds.push(ghostId);
      ghostInbound.set(ghostId, false);
    }
    // Inbound = the ghost SENDS into this level.
    if (!isInside(g.srcRep)) ghostInbound.set(ghostId, true);
  }

  const ghostNodes: DiagramNode[] = [];
  const columns: Record<"left" | "right", DiagramNode[]> = { left: [], right: [] };
  for (const ghostId of ghostIds) {
    const repNode = byId.get(ghostId.slice(GHOST_NODE_PREFIX.length));
    if (!repNode) continue;
    const size = renderSize(repNode, parents.has(repNode.id), containerSet);
    const date = nodeDates.get(repNode.id);
    const ghost: DiagramNode = {
      id: ghostId,
      label: repNode.label,
      kind: repNode.kind,
      icon: repNode.icon,
      description: repNode.description,
      parentId: null,
      zoneId: null,
      x: 0,
      y: 0,
      w: size.w,
      h: size.h,
      ...(repNode.team !== undefined ? { team: repNode.team } : {}),
      ...(repNode.status !== undefined ? { status: repNode.status } : {}),
      ...(date !== undefined ? { date } : {}),
    };
    ghostNodes.push(ghost);
    columns[ghostInbound.get(ghostId) ? "left" : "right"].push(ghost);
  }

  // Stack each column vertically centred on the boundary; overrides win.
  for (const side of ["left", "right"] as const) {
    const col = columns[side];
    if (!col.length) continue;
    const totalH =
      col.reduce((sum, n) => sum + n.h, 0) + GHOST_STACK_GAP * (col.length - 1);
    let y = boundaryBox.y + Math.max(0, (boundaryBox.h - totalH) / 2);
    for (const ghost of col) {
      ghost.x =
        side === "left"
          ? boundaryBox.x - GHOST_GAP - ghost.w
          : boundaryBox.x + boundaryBox.w + GHOST_GAP;
      ghost.y = y;
      y += ghost.h + GHOST_STACK_GAP;
    }
  }
  for (const ghost of ghostNodes) {
    const override = view?.nodes?.[ghost.id];
    if (override) {
      ghost.x = override.x;
      ghost.y = override.y;
      ghost.w = override.w;
      ghost.h = override.h;
    }
  }

  const { views: _views, ...restMeta } = t.meta ?? {};
  return {
    version: 1,
    meta: { ...restMeta, scopedFocus: focusId },
    nodes: [boundary, ...emittedChildren, ...ghostNodes],
    edges,
  };
}

function stripPoints(e: DiagramEdge): DiagramEdge {
  const { points: _points, ...rest } = e;
  return rest as DiagramEdge;
}

/**
 * The inverse of `scopedView ∘ toReactFlow`: lift the focused canvas back
 * into the FULL document. Derived elements are dropped, endpoints drawn to
 * ghosts or the boundary resolve to their real nodes, view-stripped fields
 * come back from base, and everything outside the level carries through
 * untouched. Bails to a plain `fromReactFlow` when the boundary node is
 * absent — RF state that was never a scoped view must not be re-anchored.
 */
export function liftScopedReactFlow(
  nodes: readonly RFNodeLike[],
  edges: readonly RFEdgeLike[],
  focusId: string,
  opts: ValidateOptions & { meta?: DiagramTemplate["meta"]; base: DiagramTemplate },
): DiagramTemplate {
  const boundaryId = `${BOUNDARY_NODE_PREFIX}${focusId}`;
  const boundaryNode = nodes.find((n) => n.id === boundaryId);
  const part = scopePartition(opts.base, focusId, opts.containerKinds);
  if (!boundaryNode || !part) {
    return fromReactFlow(nodes, edges, opts);
  }

  const baseById = new Map(opts.base.nodes.map((n) => [n.id, n]));
  const baseEdgeById = new Map(opts.base.edges.map((e) => [e.id, e]));
  const containerSet = new Set(opts.containerKinds ?? CONTAINER_KINDS);
  const baseParents = new Set(
    opts.base.nodes.map((n) => n.parentId).filter((p): p is string => !!p),
  );
  const focusIsContainer = containerSet.has(part.focus.kind as string);
  const origin = boundaryNode.position;

  const liftedNodes: RFNodeLike[] = [];
  for (const n of nodes) {
    if (isBoundaryNodeId(n.id) || isGhostNodeId(n.id)) continue;

    const base = baseById.get(n.id);
    // Coordinate identity: a root-level canvas position IS the child's
    // parent-relative coordinate. Only boundary-parented nodes translate.
    const position =
      n.parentId === boundaryId
        ? { x: origin.x + n.position.x, y: origin.y + n.position.y }
        : n.position;
    const parentId = !n.parentId || n.parentId === boundaryId ? focusId : n.parentId;

    // Restore what the view stripped or forced (see the module doc):
    // zone membership always; a FORCED chip's collapse flag and size.
    const forcedChip =
      !!base &&
      part.childIds.has(n.id) &&
      containerSet.has(base.kind as string) &&
      baseParents.has(n.id) &&
      base.collapsed !== true;
    const data = {
      ...n.data,
      ...(base && part.childIds.has(n.id) ? { zoneId: base.zoneId ?? null } : {}),
      ...(forcedChip ? { collapsed: false } : {}),
    };

    liftedNodes.push({
      ...n,
      parentId,
      position,
      data,
      ...(forcedChip && base ? { width: base.w, height: base.h } : {}),
    });
  }

  const liftedEdges: RFEdgeLike[] = [];
  for (const e of edges) {
    if (isGhostEdgeId(e.id)) continue;
    const resolve = (id: string) =>
      id === boundaryId ? focusId : isGhostNodeId(id) ? id.slice(GHOST_NODE_PREFIX.length) : id;
    // Group-focus interiors dropped their root-space waypoints on the way
    // out; bring them back so an untouched edge stays byte-identical.
    const basePoints =
      focusIsContainer && part.interiorEdges.has(e.id)
        ? baseEdgeById.get(e.id)?.points
        : undefined;
    liftedEdges.push({
      ...e,
      source: resolve(e.source),
      target: resolve(e.target),
      ...(basePoints ? { data: { ...e.data, points: basePoints } } : {}),
    });
  }

  // Everything the level does not show is view-hidden and carries from base;
  // everything it DOES show is genuinely editable, so absence is deletion.
  //
  // With one correction: a child deleted HERE takes its own contents with it.
  // Those grandchildren are not on this canvas — they live one level deeper —
  // so the plain rule would carry them through, and validation would then null
  // their now-missing parent and strand them at root, at coordinates that only
  // meant something inside the box that no longer exists.
  const survivingChildren = new Set(
    liftedNodes.filter((n) => part.childIds.has(n.id)).map((n) => n.id),
  );
  const orphaned = new Set<string>();
  if (survivingChildren.size < part.childIds.size) {
    for (const id of part.childIds) if (!survivingChildren.has(id)) orphaned.add(id);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of opts.base.nodes) {
        if (n.parentId && orphaned.has(n.parentId) && !orphaned.has(n.id)) {
          orphaned.add(n.id);
          grew = true;
        }
      }
    }
  }

  const viewHidden = {
    nodes: new Set(
      opts.base.nodes
        .filter((n) => !part.childIds.has(n.id) && !orphaned.has(n.id))
        .map((n) => n.id),
    ),
    edges: new Set(
      opts.base.edges
        .filter(
          (e) =>
            !part.interiorEdges.has(e.id) &&
            !orphaned.has(e.source) &&
            !orphaned.has(e.target),
        )
        .map((e) => e.id),
    ),
  };

  const out = fromReactFlow(liftedNodes, liftedEdges, {
    ...opts,
    viewHidden,
    carryZones: true,
    allNodesPresent: false,
  });

  // The carry-through appends hidden elements after the canvas's, and the
  // canvas order is depth-sorted — restore the base document's order so an
  // edit-free lift is byte-identical. New elements keep their arrival order,
  // after everything they didn't displace.
  return {
    ...out,
    nodes: reorderLikeBase(out.nodes, opts.base.nodes),
    edges: reorderLikeBase(out.edges, opts.base.edges),
  };
}

function reorderLikeBase<T extends { id: string }>(current: T[], base: readonly T[]): T[] {
  const rank = new Map(base.map((el, i) => [el.id, i]));
  const known = current.filter((el) => rank.has(el.id));
  const fresh = current.filter((el) => !rank.has(el.id));
  known.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...known, ...fresh];
}

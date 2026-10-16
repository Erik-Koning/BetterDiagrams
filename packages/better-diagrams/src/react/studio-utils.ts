/**
 * studio-utils.ts — the architecture editor's small pure helpers: selection
 * in document terms, view signatures, pin and focus pruning, scoped-node
 * decoration, the timeline view. Split out of ArchitectureStudio.tsx.
 */
import {
  type Edge,
  type Node,
} from "@xyflow/react";

import {
  BOUNDARY_NODE_PREFIX,
  COLLAPSED_EDGE_PREFIX,
  closedContainers,
  fromZoneNodeId,
  ghostSourceId,
  isBoundaryNodeId,
  isCollapsedEdgeId,
  isGhostEdgeId,
  isGhostNodeId,
  isZoneNodeId,
  type DiagramTemplate,
  type GroupContents,
} from "../contract/schema";
import { documentNodeId } from "./path-view";
import {
  type TimelineFuture,
  type TimelineFutureMode,
} from "../contract/timeline";
import { hasField, type Pin } from "../contract/fields";
import type { ResolvedRegistry } from "./registry-types";
import type { StudioSelection } from "./ArchitectureStudio";

// ─── Small utilities ─────────────────────────────────────────────────────────

/**
 * A canvas selection in DOCUMENT terms: a zone loses its canvas prefix, a
 * collapse-rerouted edge resolves to the document edge it stands in for
 * (deduped — several hidden edges can share one stand-in), a ghost resolves
 * to the document element it projects, and the boundary frame is nothing.
 */
export function documentSelection(nodeIds: readonly string[], edgeIds: readonly string[]): StudioSelection {
  return {
    nodes: [
      ...new Set(
        nodeIds
          .filter((id) => !isZoneNodeId(id) && !isBoundaryNodeId(id))
          .map((id) => (isGhostNodeId(id) ? ghostSourceId(id) : id)),
      ),
    ],
    edges: [
      ...new Set(
        edgeIds.map((id) =>
          isCollapsedEdgeId(id)
            ? id.slice(COLLAPSED_EDGE_PREFIX.length)
            : isGhostEdgeId(id)
              ? ghostSourceId(id)
              : id,
        ),
      ),
    ],
    zones: nodeIds.filter(isZoneNodeId).map(fromZoneNodeId),
  };
}

/** The document with its title set — the write half of the title↔name sync. */
export function withMetaTitle<T extends { meta?: Record<string, unknown> }>(doc: T, title: string): T {
  return { ...doc, meta: { ...doc.meta, title } };
}


export function registryKinds(registry: ResolvedRegistry, showHidden = false) {
  return {
    containerKinds: registry.containerKinds,
    annotationKinds: registry.annotationKinds,
    pointKinds: registry.pointKinds,
    showHidden,
  };
}

/**
 * What the canvas is currently showing: each zone's provider, plus whether
 * ghosts are on. The canvas rebuilds when this changes.
 *
 * Both inputs must be in the signature. If the initial value were computed
 * differently from the one the effect compares against, the effect would fire
 * on mount and record a spurious undo entry before the user touched anything.
 */
export function viewSignatureOf(
  template: DiagramTemplate,
  showHidden: boolean,
  focusId: string | null = null,
  containerKinds?: readonly string[],
  /** A read-only viewer's fold override — view state, like `showHidden`. */
  viewFold: GroupContents | null = null,
): string {
  const zones = (template.zones ?? []).map((z) => `${z.id}:${z.provider}`).join("|");
  // Every container drawn closed — its own flag, or the document's fold. The
  // fold makes this depend on what a group CONTAINS: dropping a card into an
  // empty frame under `settings.groupContents: "hide"` gives the frame
  // something to fold, and the canvas must rebuild to fold it.
  const collapsed = [...closedContainers(template, { containerKinds })].sort().join(",");
  // The DOCUMENT part is everything before `|hidden:` — the rebuild effect
  // splits on it to separate edits (provider switch, collapse → commit) from
  // pure view changes (ghost toggle, drill focus → no undo entry). Anything
  // document-derived added later must go BEFORE that marker; view state after.
  return `${zones}|collapsed:${collapsed}|hidden:${showHidden}|focus:${focusId ?? ""}|fold:${viewFold ?? ""}`;
}

/** The longest prefix of the focus stack whose nodes still exist in `doc`. */
/** Pins whose field (or table) still exists. */
/**
 * The document node a canvas node stands for — a ghost's source, the
 * boundary frame's component — else itself. `documentNodeId` is the one
 * rule; this keeps the id when it names no document node (a zone), so a
 * caller that already excluded zones gets a string back.
 */
export const documentNodeOf = (id: string): string => documentNodeId(id) ?? id;

export function prunePins(doc: DiagramTemplate, pins: readonly Pin[]): Pin[] {
  return pins.filter((p) => hasField(doc, p));
}

/**
 * Where a context menu may open so it stays on screen: `.as-context` is
 * `position: fixed` with a 260×320 ceiling, and a row near the bottom edge
 * would otherwise hang its items below the viewport.
 */
export function clampMenu(x: number, y: number): { x: number; y: number } {
  if (typeof window === "undefined") return { x, y };
  return {
    x: Math.max(0, Math.min(x, window.innerWidth - 270)),
    y: Math.max(0, Math.min(y, window.innerHeight - 330)),
  };
}

export function pruneFocusStack(doc: DiagramTemplate, stack: readonly string[]): string[] {
  const ids = new Set(doc.nodes.map((n) => n.id));
  const out: string[] = [];
  for (const id of stack) {
    if (!ids.has(id)) break;
    out.push(id);
  }
  return out;
}

/**
 * View-only affordance pass over a scoped canvas: the boundary frame is
 * scenery (locked already stops drags; selection would put a dead-end in the
 * inspector), and ghosts move only to be tidied — their drags land in
 * `meta.views`, handled by drag-stop, not by the ordinary commit path.
 */
export function decorateScopedNodes(nodes: Node[]): Node[] {
  return nodes.map((n) =>
    isBoundaryNodeId(n.id)
      ? // Not selectable (its inspector would be a dead end) and not
        // draggable (the frame is derived from what it wraps) — but very
        // much CONNECTABLE: an edge drawn to the frame is an edge to the
        // component itself, which is how you wire this level to its parent.
        { ...n, selectable: false, draggable: false }
      : n,
  );
}

/**
 * Flag the canvas for the scrub cursor: later elements are either greyed out
 * or dropped from the render.
 *
 * A pure map over what the editor already holds, applied on the way INTO
 * React Flow and never written back into state, so the document the editor
 * derives from its canvas is unaffected by where the cursor stands.
 */
export function applyTimelineView(
  nodes: Node[],
  edges: Edge[],
  future: TimelineFuture | null,
  mode: TimelineFutureMode,
): { nodes: Node[]; edges: Edge[] } {
  if (!future) return { nodes, edges };

  // Zones share the node array under a prefixed id, and a scoped view's
  // derived elements stand in for real ones — the future sets are keyed by
  // DOCUMENT id, so every synthetic id is consulted through its real one.
  const nodeIsFuture = (id: string) =>
    isZoneNodeId(id)
      ? future.zones.has(fromZoneNodeId(id))
      : isBoundaryNodeId(id)
        ? future.nodes.has(id.slice(BOUNDARY_NODE_PREFIX.length))
        : isGhostNodeId(id)
          ? future.nodes.has(ghostSourceId(id))
          : future.nodes.has(id);

  function mark<T extends { className?: string; hidden?: boolean; selected?: boolean }>(
    item: T,
    isFuture: boolean,
  ): T {
    if (!isFuture) return item;
    // Hidden rather than removed: React Flow keeps it in the array, so the
    // editor's own state stays complete. Deselected with it, or the inspector
    // would be editing something invisible.
    if (mode === "hide") return { ...item, hidden: true, selected: false };
    return { ...item, className: `${item.className ? `${item.className} ` : ""}as-future` };
  }

  return {
    nodes: nodes.map((n) => mark(n, nodeIsFuture(n.id))),
    // An endpoint check as well as the edge's own id: a collapse-rerouted edge
    // carries a synthetic id that no future set can know about.
    edges: edges.map((e) => {
      const isFuture =
        future.edges.has(e.id) || nodeIsFuture(e.source) || nodeIsFuture(e.target);
      // The label renders through a portal, outside the edge's own group, so a
      // wrapper class alone would leave it bright — see DiagramEdgeData.future.
      const flagged = isFuture ? { ...e, data: { ...e.data, future: true } } : e;
      return mark(flagged, isFuture);
    }),
  };
}

/**
 * React Flow requires a parent to appear before its children in the array.
 * Zones sort ahead of everything so they paint behind the diagram.
 */
export function sortByDepth(nodes: Node[]): Node[] {
  const zoneNodes = nodes.filter((n) => isZoneNodeId(n.id));
  nodes = nodes.filter((n) => !isZoneNodeId(n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = (n: Node) => {
    let d = 0;
    let cursor = n.parentId ? byId.get(n.parentId) : undefined;
    const guard = new Set<string>([n.id]);
    while (cursor && !guard.has(cursor.id)) {
      guard.add(cursor.id);
      d++;
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return d;
  };
  return [...zoneNodes, ...[...nodes].sort((a, b) => depth(a) - depth(b))];
}

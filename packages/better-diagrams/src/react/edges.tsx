/**
 * edges.tsx — the labeled floating edge.
 *
 * The curve is computed from the two node boxes by `floatingEdgeGeometry`
 * rather than from handle coordinates, so:
 *   - edges re-route sensibly as nodes move, without the user picking handles
 *   - the Canvas2D/SVG exporters, which call the same function, produce output
 *     that matches the screen exactly
 *   - an edge loaded from JSON with no `sourceHandle` still renders
 *
 * The label slides along the curve by dragging it, persisted as `labelT` —
 * and dragging it AWAY from the curve bends the line instead, the text acting
 * as a handle on the line it names.
 *
 * Shaping the line, all direct manipulation:
 *   - drag anywhere on it to bend it there (a waypoint is born under the
 *     pointer); double-click does the same without the drag
 *   - drag its label perpendicular to it to shape the line without having to
 *     hit the 2px stroke under the words — it moves the dot that governs the
 *     label's stretch of line where there is one, and only mints a new dot on
 *     a line that has none, so nudging a line repeatedly cannot litter it
 *   - drag a waypoint to move it, double-click one to remove it
 *   - on a selected edge, drag an endpoint to pin where it attaches — or drop
 *     it on another node to re-attach the edge there
 */
import { memo, useCallback, useRef, useState, type CSSProperties } from "react";
import {
  EdgeLabelRenderer,
  ViewportPortal,
  useInternalNode,
  useReactFlow,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import {
  anchorFromPoint,
  cardinalityMarker,
  crowsFootPath,
  edgeGeometryFor,
  edgeHeadPath,
  endLabelInset,
  nearestTOnCurve,
  startAngle,
  tAtDistance,
  type Box,
  type EdgeGeometry,
  type EdgePathSpec,
} from "../contract/geometry";
import {
  EDGE_COLOR_HEX,
  EDGE_DASH,
  fieldAnchors,
  isCollapsedEdgeId,
  isGhostEdgeId,
  MAX_EDGE_POINTS,
  type DiagramEdgeData,
  type DiagramNodeData,
} from "../contract/schema";
import { topDropTarget } from "./dangling";
import { formatDiagramDate } from "../contract/timeline";
import { useStudio } from "./context";
import { seqBadgeOffset } from "./shapes";

export type LabeledEdgeType = Edge<DiagramEdgeData, "labeled">;

/**
 * Where a new waypoint slots into the stored route: ordered by position along
 * the curve, so the line keeps travelling in one direction through its points.
 */
function insertionIndex(
  geo: EdgeGeometry,
  points: ReadonlyArray<readonly [number, number]>,
  point: { x: number; y: number },
): number {
  const tNew = nearestTOnCurve(geo, point);
  for (let i = 0; i < points.length; i++) {
    if (tNew < nearestTOnCurve(geo, { x: points[i][0], y: points[i][1] })) return i;
  }
  return points.length;
}

/** How close (px) a dragged waypoint must come to a reference line to snap. */
const SNAP_TOL = 6;

/**
 * How far the pointer must leave the line, dragging a label, before the drag
 * MINTS a waypoint on a line that has none. Deliberately blunt: a new bend is
 * a new thing in the document, and a label nudged along its line must not keep
 * leaving dots behind. Measured as CHANGE in the offset from the curve, not
 * raw distance — the pointer grabs the text a few px off the line already, and
 * that head start must not count as a bend.
 */
const LABEL_BEND_TOL = 18;

/**
 * The same threshold when the drag will MOVE a waypoint the line already has.
 * Nothing is created, so nothing is lost by being responsive.
 */
const LABEL_MOVE_TOL = 6;

/**
 * How far the pointer must travel before a press on the label counts as a
 * drag at all. Small enough that a deliberate nudge still registers, large
 * enough that trackpad jitter during a click does not move anything.
 */
const LABEL_DRAG_TOL = 3;

/**
 * The label layer's geometry. Inline rather than in the stylesheet because it
 * is load-bearing, not decorative: an outermost svg sized 0×0 paints NOTHING
 * in Chrome — `overflow: visible` or not — which is exactly how every edge
 * label went invisible the first time they moved into this portal. A DOM test
 * can see an inline style; it cannot see a stylesheet, and jsdom cannot see
 * paint at all.
 *
 * `pointerEvents: none` is what stops a full-size layer (one per edge, all
 * stacked over the canvas) from swallowing clicks meant for nodes; the label
 * group inside re-enables them for itself, and hit-testing still reaches it
 * where it paints outside this box.
 */
const LABEL_LAYER_STYLE: CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  width: "100%",
  height: "100%",
  overflow: "visible",
  pointerEvents: "none",
};

/** The nearest reference within snapping distance, or nothing. */
function snapAxis(v: number, refs: readonly number[]): number | null {
  let best: number | null = null;
  for (const r of refs) {
    if (Math.abs(v - r) <= SNAP_TOL && (best === null || Math.abs(v - r) < Math.abs(v - best))) {
      best = r;
    }
  }
  return best;
}

export const LabeledEdge = memo(function LabeledEdge({
  id,
  source,
  target,
  data,
  selected,
}: EdgeProps<LabeledEdgeType>) {
  const { readOnly, requestCommit, registry, showToast } = useStudio();
  const { screenToFlowPosition, setEdges, setNodes, getEdges, getNodes, getInternalNode } =
    useReactFlow();
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const draggingRef = useRef(false);
  /**
   * An endpoint mid-drag: its end of the line follows the pointer instead of
   * its box, and `drop` names the node it would re-attach to if released now.
   */
  const [dragEnd, setDragEnd] = useState<{
    which: "start" | "end";
    x: number;
    y: number;
    drop: string | null;
  } | null>(null);
  /** Inline label editor open (double-click on the line or its label). */
  const [editingLabel, setEditingLabel] = useState(false);
  /**
   * Alignment guides while a waypoint drags: the reference lines the dragged
   * point is currently snapped to, drawn as dashed hints.
   */
  const [guides, setGuides] = useState<{ x?: number; y?: number } | null>(null);
  // A stand-in for other edges — collapse-rerouted, or a scoped view's
  // projection of a connection crossing the level. `fromReactFlow` strips
  // both, so any edit made through one would be silently discarded: offer
  // none. (A route the user genuinely arranges on a ghost edge is per-view
  // presentation and belongs in `meta.views`, not on the document edge.)
  const synthetic = isCollapsedEdgeId(id) || isGhostEdgeId(id);

  const box = (node: typeof sourceNode): Box | null => {
    if (!node) return null;
    const { x, y } = node.internals.positionAbsolute;
    return {
      x,
      y,
      width: node.measured?.width ?? 0,
      height: node.measured?.height ?? 0,
    };
  };

  const s = box(sourceNode);
  const t = box(targetNode);

  /**
   * The stored route with field references resolved: a foreign key lands on
   * the row it names rather than on the middle of the table. Recomputed from
   * the live boxes each time, because which face the line leaves through
   * follows the nodes as they are dragged.
   */
  const specOf = (sBox: Box, tBox: Box): EdgePathSpec => {
    const side = (node: typeof sourceNode, b: Box) => {
      const nodeData = node?.data as DiagramNodeData | undefined;
      return {
        fields: nodeData?.fields,
        description: nodeData?.description,
        h: b.height,
        centerX: b.x + b.width / 2,
      };
    };
    return {
      ...fieldAnchors(
        {
          start: data?.start,
          end: data?.end,
          startField: data?.startField,
          endField: data?.endField,
        },
        side(sourceNode, sBox),
        side(targetNode, tBox),
      ),
      points: data?.points,
    };
  };

  /**
   * Dragging the label is TWO gestures in one, split by direction:
   *
   *   along the line       → slide the label (labelT), as it always has
   *   away from the line   → shape the line, the label riding it as a handle:
   *                          it moves the dot governing the label's stretch of
   *                          line, or mints one if the line has none
   *
   * Both run at once, because both are just components of one drag: the
   * pointer's foot on the curve gives the slide, its offset from the curve
   * gives the bend. The line is bent through the pointer MINUS the offset the
   * label was grabbed at, so the line lands where the text was, not where the
   * text happens to hang above it.
   *
   * All of it is measured against the geometry AT GRAB TIME. Re-measuring a
   * curve that the bend is currently reshaping would let the label chase its
   * own waypoint down the line.
   */
  const onLabelPointerDown = useCallback(
    (event: React.PointerEvent<SVGElement>) => {
      if (readOnly || !s || !t) return;
      event.stopPropagation();
      const element = event.currentTarget;
      element.setPointerCapture(event.pointerId);
      draggingRef.current = true;

      const grabGeo = edgeGeometryFor(data?.routingResolved, s, t, data?.labelT ?? 0.5, specOf(s, t));
      const from = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const grabFoot = grabGeo.at(nearestTOnCurve(grabGeo, from));
      // Where the pointer sits relative to the line at grab: subtracted from
      // every later position, so a straight slide reads as zero bend.
      const offset = { x: from.x - grabFoot.x, y: from.y - grabFoot.y };
      const basePoints = data?.points ?? [];
      /**
       * Which dot this drag will move. A line is divided into sections by its
       * waypoints; the label sits on one of them, and the dots bounding that
       * section are the ones that shape it. Reuse the nearer of those rather
       * than minting another — a line the user keeps nudging by its label
       * should end up with ONE bend they move, not a trail of them.
       *
       * Only a line with no dots at all gets a new one.
       */
      const grabT = nearestTOnCurve(grabGeo, from);
      const along = basePoints
        .map((pt, index) => ({ index, pt, t: nearestTOnCurve(grabGeo, { x: pt[0], y: pt[1] }) }))
        .sort((a, b) => a.t - b.t);
      const before = [...along].reverse().find((dot) => dot.t <= grabT);
      const after = along.find((dot) => dot.t > grabT);
      const nearer =
        before && after
          ? Math.hypot(before.pt[0] - grabFoot.x, before.pt[1] - grabFoot.y) <=
            Math.hypot(after.pt[0] - grabFoot.x, after.pt[1] - grabFoot.y)
            ? before
            : after
          : (before ?? after);
      const reuseIndex = nearer?.index ?? -1;
      const reusePoint = nearer?.pt;
      // Moving an existing dot is always available — it adds nothing, so the
      // waypoint cap does not apply to it.
      const canBend =
        !synthetic && (reuseIndex >= 0 || basePoints.length < MAX_EDGE_POINTS);
      // Same soft snapping as dragging the line itself: level runs read as
      // deliberate rather than nearly-aligned.
      const refsX = [Math.round(grabGeo.at(0).x), Math.round(grabGeo.tip.x), ...basePoints.map((pt) => pt[0])];
      const refsY = [Math.round(grabGeo.at(0).y), Math.round(grabGeo.tip.y), ...basePoints.map((pt) => pt[1])];
      let bendIndex = -1;

      /**
       * A click is not a drag.
       *
       * Without a threshold, the pointer jitter of an ordinary click on a
       * trackpad rewrote `labelT` and pushed an undo entry — so selecting a
       * label nudged it, and ⌘Z afterwards moved it back. The line-drag path
       * has had this guard all along; the label needed the same one.
       */
      let travelled = false;

      const move = (e: PointerEvent) => {
        if (!draggingRef.current) return;
        const point = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        if (!travelled) {
          if (Math.hypot(point.x - from.x, point.y - from.y) < LABEL_DRAG_TOL) return;
          travelled = true;
        }
        const nextT = nearestTOnCurve(grabGeo, point);
        const foot = grabGeo.at(nextT);
        // How far the pointer has moved OFF the line since the grab.
        const drift = Math.hypot(point.x - foot.x - offset.x, point.y - foot.y - offset.y);
        if (canBend && bendIndex < 0 && drift >= (reusePoint ? LABEL_MOVE_TOL : LABEL_BEND_TOL)) {
          bendIndex =
            reuseIndex >= 0
              ? reuseIndex
              : insertionIndex(grabGeo, basePoints, { x: point.x - offset.x, y: point.y - offset.y });
        }
        let points: Array<[number, number]> | undefined;
        if (bendIndex >= 0) {
          // An existing dot travels BY the drag; a new one lands where the
          // text is. Sending a dot from further down the line to the pointer
          // would teleport it, yanking a stretch of line nobody grabbed.
          const wx = Math.round(reusePoint ? reusePoint[0] + (point.x - from.x) : point.x - offset.x);
          const wy = Math.round(reusePoint ? reusePoint[1] + (point.y - from.y) : point.y - offset.y);
          const sx = snapAxis(wx, refsX);
          const sy = snapAxis(wy, refsY);
          setGuides(
            sx !== null || sy !== null
              ? { ...(sx !== null ? { x: sx } : {}), ...(sy !== null ? { y: sy } : {}) }
              : null,
          );
          points = [...basePoints];
          const at: [number, number] = [sx ?? wx, sy ?? wy];
          if (reuseIndex >= 0) points[bendIndex] = at;
          else points.splice(bendIndex, 0, at);
        }
        setEdges((edges) =>
          edges.map((edge) =>
            edge.id === id
              ? {
                  ...edge,
                  data: { ...edge.data, labelT: nextT, ...(points ? { points } : {}) },
                }
              : edge,
          ),
        );
      };
      const finish = (cancelled: boolean) => {
        draggingRef.current = false;
        element.releasePointerCapture(event.pointerId);
        element.removeEventListener("pointermove", move as EventListener);
        element.removeEventListener("pointerup", up);
        element.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", onKey, true);
        setGuides(null);
        if (cancelled) {
          // Put the line back exactly as it was. Escape abandons a gesture
          // everywhere else; a route you can only undo AFTER releasing is a
          // gesture you cannot change your mind about.
          setEdges((edges) =>
            edges.map((edge) =>
              edge.id === id
                ? {
                    ...edge,
                    data: {
                      ...edge.data,
                      labelT: data?.labelT,
                      ...(basePoints.length ? { points: basePoints } : {}),
                    },
                  }
                : edge,
            ),
          );
          return;
        }
        if (!travelled) return; // a click, not a drag — nothing to record
        // Without this the new labelT lives only in React Flow state — undo
        // and a controlled host would never see it until an unrelated edit
        // happened to commit.
        requestCommit();
      };
      const up = () => finish(false);
      const cancel = () => finish(true);
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      };
      element.addEventListener("pointermove", move as EventListener);
      element.addEventListener("pointerup", up);
      element.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", onKey, true);
    },
    [readOnly, synthetic, s, t, data, screenToFlowPosition, setEdges, id, requestCommit],
  );

  /** Replace this edge's waypoints — always a NEW array; history clones shallowly. */
  const setPoints = useCallback(
    (points: Array<[number, number]> | undefined) => {
      setEdges((edges) =>
        edges.map((edge) => {
          if (edge.id !== id) return edge;
          const nextData = { ...edge.data, points } as DiagramEdgeData;
          if (!points?.length) delete nextData.points;
          return { ...edge, data: nextData };
        }),
      );
    },
    [setEdges, id],
  );

  const onWaypointPointerDown = useCallback(
    (index: number) => (event: React.PointerEvent<SVGCircleElement>) => {
      if (readOnly || synthetic || !s || !t) return;
      event.stopPropagation();
      const element = event.currentTarget;
      element.setPointerCapture(event.pointerId);
      // Alignment references, fixed at grab time: the two attachment points
      // and every OTHER waypoint. Level runs are what make a route look tidy.
      const grabGeo = edgeGeometryFor(data?.routingResolved, s, t, data?.labelT ?? 0.5, specOf(s, t));
      const o = grabGeo.at(0);
      const others = (data?.points ?? []).filter((_, i) => i !== index);
      const refsX = [Math.round(o.x), Math.round(grabGeo.tip.x), ...others.map((p) => p[0])];
      const refsY = [Math.round(o.y), Math.round(grabGeo.tip.y), ...others.map((p) => p[1])];
      let moved = false;
      const move = (e: PointerEvent) => {
        const point = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        const sx = snapAxis(Math.round(point.x), refsX);
        const sy = snapAxis(Math.round(point.y), refsY);
        setGuides(sx !== null || sy !== null ? { ...(sx !== null ? { x: sx } : {}), ...(sy !== null ? { y: sy } : {}) } : null);
        moved = true;
        setEdges((edges) =>
          edges.map((edge) => {
            if (edge.id !== id) return edge;
            const pts = [...((edge.data as DiagramEdgeData | undefined)?.points ?? [])];
            pts[index] = [sx ?? Math.round(point.x), sy ?? Math.round(point.y)];
            return { ...edge, data: { ...edge.data, points: pts } };
          }),
        );
      };
      const up = () => {
        element.releasePointerCapture(event.pointerId);
        element.removeEventListener("pointermove", move as EventListener);
        element.removeEventListener("pointerup", up);
        setGuides(null);
        if (moved) requestCommit();
      };
      element.addEventListener("pointermove", move as EventListener);
      element.addEventListener("pointerup", up);
    },
    [readOnly, synthetic, s, t, data, screenToFlowPosition, setEdges, id, requestCommit],
  );

  const removeWaypoint = useCallback(
    (index: number) => {
      if (readOnly || synthetic) return;
      const pts = (data?.points ?? []).filter((_, i) => i !== index);
      setPoints(pts.length ? pts : undefined);
      requestCommit();
    },
    [readOnly, synthetic, data?.points, setPoints, requestCommit],
  );

  // A node can be momentarily unmeasured on first paint.
  if (!s || !t || !s.width || !t.width) return null;

  // The drop-target judgement is shared with the studio's onConnectEnd, so
  // dragging an endpoint and dragging a NEW connection agree about what a
  // given release means.
  const nodeAt = (point: { x: number; y: number }, exclude?: ReadonlySet<string>) =>
    topDropTarget({ getNodes, getInternalNode }, point, exclude ? { exclude } : {});

  // Rubber band: a dragged endpoint follows the pointer as a free point — a
  // zero-size box, which every router attaches to at the point itself. The
  // stored anchor and field reference for that end describe the box it is
  // leaving, so they are excluded from the spec while it travels.
  const spec = specOf(s, t);
  if (dragEnd?.which === "start") delete spec.start;
  if (dragEnd?.which === "end") delete spec.end;
  const freeBox = { x: dragEnd?.x ?? 0, y: dragEnd?.y ?? 0, width: 0, height: 0 };
  const geo = edgeGeometryFor(
    data?.routingResolved,
    dragEnd?.which === "start" ? freeBox : s,
    dragEnd?.which === "end" ? freeBox : t,
    data?.labelT ?? 0.5,
    spec,
  );
  // Compare-mode recolour wins; otherwise the edge's own colour. Selection is
  // a CLASS, not an inline stroke — CSS can theme it (a presentation
  // attribute would beat a hex here but lose to the stylesheet rule).
  const diffStroke =
    data?.diffState === "added"
      ? "#34d399"
      : data?.diffState === "removed"
        ? "#fb7185"
        : data?.diffState === "changed"
          ? "#f59e0b"
          : undefined;
  const color = diffStroke ?? (EDGE_COLOR_HEX[data?.color ?? "slate"] ?? EDGE_COLOR_HEX.slate);
  // Colour arrives twice: the hex as an SVG attribute (jsdom, no-CSS
  // fallback), and a class the stylesheet resolves through --as-edge-* /
  // --as-diff-* variables — which is what lets a light theme darken every
  // edge without this component knowing about themes.
  const colorClass = data?.diffState ? `as-edge--${data.diffState}` : `as-edge--c-${data?.color ?? "slate"}`;
  const dash = EDGE_DASH[data?.style ?? "solid"]?.join(" ") || undefined;
  const direction = data?.direction ?? "forward";
  // Which glyph each end draws. `direction` sets the defaults; an explicit
  // head renders regardless of it — a diamond-at-source aggregation keeps its
  // plain forward arrow at the target.
  const endHead = data?.endHead ?? (direction !== "none" ? "arrow" : undefined);
  const startHead = data?.startHead ?? (direction === "both" ? "arrow" : undefined);
  const hasLabel = !!data?.label || !!data?.tech || !!data?.seq || !!data?.date;
  // Stacked under whatever else the label group is showing, so a connection
  // that lands later says so without displacing its own name.
  const dateY = (data?.label ? 8 : -5) + (data?.tech ? 11 : 0);
  const origin = geo.at(0);
  // A recognisable cardinality draws its crow's-foot symbol at the box; the
  // text still renders further in, for readers who don't speak the notation.
  const startMarker = cardinalityMarker(data?.startLabel);
  const endMarker = cardinalityMarker(data?.endLabel);
  // Cardinality sits a fixed distance in from each box — near the end it
  // describes, wherever the middle label happens to be.
  const startLabelAt = data?.startLabel
    ? geo.at(tAtDistance(geo, endLabelInset(startMarker)))
    : null;
  const endLabelAt = data?.endLabel
    ? geo.at(tAtDistance(geo, endLabelInset(endMarker), true))
    : null;

  // Double-click means WORDS: name the connection right where it is —
  // bending is the drag gesture, as in every mainstream diagrammer.
  // (Double-click on a waypoint dot still removes that dot.)
  const onPathDoubleClick = (event: React.MouseEvent<SVGElement>) => {
    if (readOnly || synthetic) return;
    event.stopPropagation();
    event.preventDefault();
    setEditingLabel(true);
  };

  // Drag anywhere on the line to bend it there: past a small threshold the
  // grab point becomes a waypoint that follows the pointer until release. The
  // threshold is what keeps a plain click a click — selection still works —
  // and a motionless double-click still reaches the handler above.
  const onPathPointerDown = (event: React.PointerEvent<SVGPathElement>) => {
    if (readOnly || synthetic || event.button !== 0) return;
    // Same cap as the double-click: a bend past MAX_EDGE_POINTS would be
    // dropped by validation, so the gesture must not start — and it says so,
    // because a line that stops responding to a drag reads as broken.
    if ((data?.points?.length ?? 0) >= MAX_EDGE_POINTS) {
      showToast(`A line holds at most ${MAX_EDGE_POINTS} bends — remove one first`);
      return;
    }
    event.stopPropagation();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    const from = { x: event.clientX, y: event.clientY };
    // Ordering is judged against the geometry at grab time — the curve
    // reshapes under the pointer once the new point starts moving.
    const grabGeo = geo;
    const basePoints = data?.points ?? [];
    // The new point snaps softly to the attachment points' and other
    // waypoints' reference lines — level runs read as deliberate.
    const refsX = [Math.round(origin.x), Math.round(grabGeo.tip.x), ...basePoints.map((p) => p[0])];
    const refsY = [Math.round(origin.y), Math.round(grabGeo.tip.y), ...basePoints.map((p) => p[1])];
    let bendIndex = -1;

    const move = (e: PointerEvent) => {
      if (bendIndex < 0 && Math.hypot(e.clientX - from.x, e.clientY - from.y) < 4) return;
      const point = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      if (bendIndex < 0) bendIndex = insertionIndex(grabGeo, basePoints, point);
      const sx = snapAxis(Math.round(point.x), refsX);
      const sy = snapAxis(Math.round(point.y), refsY);
      setGuides(
        sx !== null || sy !== null
          ? { ...(sx !== null ? { x: sx } : {}), ...(sy !== null ? { y: sy } : {}) }
          : null,
      );
      const pts: Array<[number, number]> = [...basePoints];
      pts.splice(bendIndex, 0, [sx ?? Math.round(point.x), sy ?? Math.round(point.y)]);
      setEdges((edges) =>
        edges.map((edge) => (edge.id === id ? { ...edge, data: { ...edge.data, points: pts } } : edge)),
      );
    };
    // pointercancel ends the gesture like a release: the bend is already on
    // screen, so committing it beats leaving state undo can't see.
    const up = () => {
      element.releasePointerCapture(event.pointerId);
      element.removeEventListener("pointermove", move as EventListener);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      setGuides(null);
      if (bendIndex >= 0) requestCommit();
    };
    element.addEventListener("pointermove", move as EventListener);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
  };

  // Drag an endpoint of a selected edge to move where the line attaches.
  // Released over its own node (or empty canvas) it pins the anchor to the
  // nearest point on the box's perimeter; released over another node it
  // re-attaches the edge there, dropping the anchor and field reference —
  // both described the box it left.
  const onEndpointPointerDown =
    (which: "start" | "end") => (event: React.PointerEvent<SVGCircleElement>) => {
      if (readOnly || synthetic || event.button !== 0) return;
      event.stopPropagation();
      const element = event.currentTarget;
      element.setPointerCapture(event.pointerId);
      const ownId = which === "start" ? source : target;
      const ownNode = which === "start" ? sourceNode : targetNode;
      const ownBox = which === "start" ? s : t;
      // A point-backed end IS its node: released in space the gesture moves
      // the dot, not an anchor on it — the dot is 12px, an anchor fraction on
      // it says nothing.
      const ownIsPoint = registry.pointKinds.includes(
        (ownNode?.data as DiagramNodeData | undefined)?.kind ?? "",
      );
      // Everything this endpoint is already INSIDE. Pinning to a side means
      // pulling the endpoint just outside its own box, and just outside a
      // nested box is its parent's frame — so a parent under the pointer is
      // the gesture working, not a re-target.
      const ancestors = new Set<string>();
      for (let cursor = ownNode?.parentId; cursor; ) {
        ancestors.add(cursor);
        cursor = getNodes().find((n) => n.id === cursor)?.parentId;
      }

      let last: { x: number; y: number } | null = null;
      let drop: string | null = null;

      const move = (e: PointerEvent) => {
        const point = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        last = point;
        const over = nodeAt(point, ancestors);
        // Dropping on the far node makes a SELF-LOOP — dragging an edge's end
        // onto its own source is how an ordinary arrow becomes a retry loop.
        // Only this end's own node stays a pin, never a re-attachment.
        drop = over && over !== ownId ? over : null;
        setDragEnd({ which, x: point.x, y: point.y, drop });
      };
      // Unlike the bend, nothing is written until release — so a cancelled
      // gesture aborts cleanly rather than half-applying.
      const cancel = () => {
        element.releasePointerCapture(event.pointerId);
        element.removeEventListener("pointermove", move as EventListener);
        element.removeEventListener("pointerup", up);
        element.removeEventListener("pointercancel", cancel);
        setDragEnd(null);
      };
      const up = () => {
        cancel();
        if (!last) return; // never moved — a plain click changes nothing
        const point = last;
        const dropId = drop;
        if (!dropId && ownIsPoint) {
          // Reposition the dot itself. Via the delta from its absolute centre,
          // so a point that somehow lives inside a parent moves correctly in
          // its parent-relative coordinates too.
          const abs = ownNode!.internals.positionAbsolute;
          const dx = point.x - (abs.x + ownBox.width / 2);
          const dy = point.y - (abs.y + ownBox.height / 2);
          setNodes((nodes) =>
            nodes.map((n) =>
              n.id === ownId
                ? {
                    ...n,
                    position: {
                      x: Math.round(n.position.x + dx),
                      y: Math.round(n.position.y + dy),
                    },
                  }
                : n,
            ),
          );
          requestCommit();
          return;
        }
        // Re-attaching a dangling end onto a real node strands its dot: with
        // no edge left pointing at it, the dot is invisible clutter — sweep
        // it. Judged against the OTHER edges; this one is leaving.
        const orphanedPoint =
          dropId &&
          ownIsPoint &&
          !getEdges().some((e) => e.id !== id && (e.source === ownId || e.target === ownId))
            ? ownId
            : null;
        setEdges((edges) =>
          edges.map((edge) => {
            if (edge.id !== id) return edge;
            const nextData = { ...edge.data } as DiagramEdgeData;
            if (dropId) {
              if (which === "start") {
                delete nextData.start;
                delete nextData.startField;
                return { ...edge, source: dropId, data: nextData };
              }
              delete nextData.end;
              delete nextData.endField;
              return { ...edge, target: dropId, data: nextData };
            }
            nextData[which] = anchorFromPoint(ownBox, point);
            // A field reference re-aims the pinned fraction back at its row
            // (fieldAnchors), which would visibly undo the drag — a hand-placed
            // pin replaces the semantic row attachment, exactly as a
            // re-attachment does. The inspector can re-link the row.
            delete nextData[which === "start" ? "startField" : "endField"];
            return { ...edge, data: nextData };
          }),
        );
        if (orphanedPoint) setNodes((nodes) => nodes.filter((n) => n.id !== orphanedPoint));
        requestCommit();
      };
      element.addEventListener("pointermove", move as EventListener);
      element.addEventListener("pointerup", up);
      element.addEventListener("pointercancel", cancel);
    };

  return (
    <g>
      {/* Wide invisible path so the edge is easy to click — and to grab. */}
      <path
        className="as-edge__hit"
        d={geo.path}
        style={{ pointerEvents: "stroke" }}
        onDoubleClick={onPathDoubleClick}
        onPointerDown={onPathPointerDown}
      />
      <path
        className={[
          "as-edge__stroke",
          colorClass,
          selected && !diffStroke ? "as-edge__stroke--selected" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        d={geo.path}
        fill="none"
        stroke={color}
        strokeWidth={selected ? 2.6 : 1.8}
        strokeDasharray={dash}
        style={{ pointerEvents: "none" }}
      />
      {/* An end that states its cardinality draws the symbol INSTEAD of an
          end glyph: a relationship reads by its crow's foot, and stacking both
          at one point says two different things about the same end. Otherwise
          `direction` decides which ends carry a glyph by default and
          startHead/endHead choose which one — filled glyphs theme like the
          classic arrow, hollow ones like the (also stroked) crow's feet. */}
      {endHead && !endMarker
        ? (() => {
            const glyph = edgeHeadPath(endHead, geo.tip, geo.angle);
            return (
              <path
                className={`${glyph.filled ? "as-edge__arrow" : "as-edge__crow"} ${colorClass}`}
                d={glyph.d}
                fill={glyph.filled ? color : "none"}
                stroke={glyph.filled ? undefined : color}
                strokeWidth={glyph.filled ? undefined : 1.8}
                style={{ pointerEvents: "none" }}
              />
            );
          })()
        : null}
      {startHead && !startMarker
        ? (() => {
            const glyph = edgeHeadPath(startHead, origin, startAngle(geo));
            return (
              <path
                className={`${glyph.filled ? "as-edge__arrow" : "as-edge__crow"} ${colorClass}`}
                d={glyph.d}
                fill={glyph.filled ? color : "none"}
                stroke={glyph.filled ? undefined : color}
                strokeWidth={glyph.filled ? undefined : 1.8}
                style={{ pointerEvents: "none" }}
              />
            );
          })()
        : null}
      {endMarker ? (
        <path
          className={`as-edge__crow ${colorClass}`}
          d={crowsFootPath(endMarker, geo.tip, geo.angle)}
          fill="none"
          stroke={color}
          strokeWidth={1.8}
          style={{ pointerEvents: "none" }}
        />
      ) : null}
      {startMarker ? (
        <path
          className={`as-edge__crow ${colorClass}`}
          d={crowsFootPath(startMarker, origin, startAngle(geo))}
          fill="none"
          stroke={color}
          strokeWidth={1.8}
          style={{ pointerEvents: "none" }}
        />
      ) : null}
      {selected && !readOnly && !synthetic
        ? (data?.points ?? []).map(([px, py], index) => (
            <circle
              // Index-keyed on purpose: a coordinate key would remount the
              // element every drag frame and drop its pointer capture.
              key={index}
              className="as-edge__waypoint"
              cx={px}
              cy={py}
              r={4.5}
              fill="var(--as-bg, #0b1020)"
              stroke={color}
              strokeWidth={1.6}
              onPointerDown={onWaypointPointerDown(index)}
              onDoubleClick={(event) => {
                event.stopPropagation();
                removeWaypoint(index);
              }}
            >
              <title>Drag to bend · double-click to remove</title>
            </circle>
          ))
        : null}
      {selected && !readOnly && !synthetic
        ? (["start", "end"] as const).map((which) => {
            const p = which === "start" ? origin : geo.tip;
            const active = dragEnd?.which === which;
            return (
              <circle
                key={which}
                className={[
                  "as-edge__endpoint",
                  active && dragEnd?.drop ? "as-edge__endpoint--drop" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                cx={p.x}
                cy={p.y}
                r={5}
                stroke={color}
                strokeWidth={1.6}
                onPointerDown={onEndpointPointerDown(which)}
              >
                <title>Drag to move this end · drop on a node to re-attach</title>
              </circle>
            );
          })
        : null}
      {/* Alignment guides while a waypoint drags: dashed reference lines the
          dragged point is snapped to. */}
      {guides
        ? (() => {
            const xs = [origin.x, geo.tip.x, ...(data?.points ?? []).map((p) => p[0])];
            const ys = [origin.y, geo.tip.y, ...(data?.points ?? []).map((p) => p[1])];
            const pad = 30;
            return (
              <>
                {guides.x !== undefined ? (
                  <line
                    className="as-edge__guide"
                    x1={guides.x}
                    y1={Math.min(...ys) - pad}
                    x2={guides.x}
                    y2={Math.max(...ys) + pad}
                  />
                ) : null}
                {guides.y !== undefined ? (
                  <line
                    className="as-edge__guide"
                    x1={Math.min(...xs) - pad}
                    y1={guides.y}
                    x2={Math.max(...xs) + pad}
                    y2={guides.y}
                  />
                ) : null}
              </>
            );
          })()
        : null}
      {editingLabel && !readOnly ? (
        <EdgeLabelRenderer>
          {/* HTML, not SVG text: a real caret, selection, and IME. Positioned
              on the label point in FLOW coordinates — the renderer's layer
              carries the viewport transform. */}
          <input
            className="as-edge__labeledit nodrag nopan"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${geo.label.x}px, ${geo.label.y - 5}px)`,
              pointerEvents: "all",
            }}
            value={data?.label ?? ""}
            autoFocus
            onFocus={(event) => event.target.select()}
            onChange={(event) => {
              const value = event.target.value;
              setEdges((edges) =>
                edges.map((edge) =>
                  edge.id === id ? { ...edge, data: { ...edge.data, label: value } } : edge,
                ),
              );
            }}
            onBlur={() => {
              setEditingLabel(false);
              // Live edits went through setEdges only — record them so the
              // label is undoable and reaches a controlled host.
              requestCommit();
            }}
            onKeyDown={(event) => {
              // The editor's global shortcuts must not fire from the caret;
              // Enter and Escape both finish (blur commits).
              event.stopPropagation();
              if (event.key === "Enter" || event.key === "Escape") {
                (event.target as HTMLInputElement).blur();
              }
            }}
            onPointerDown={(event) => event.stopPropagation()}
            aria-label="Edge label"
          />
        </EdgeLabelRenderer>
      ) : null}
      {startLabelAt || endLabelAt || (hasLabel && !editingLabel) ? (
        // Every word an edge carries goes through the viewport portal, which
        // React Flow renders AFTER the node layer: a connection's name is the
        // one thing that must never be covered, and an edge whose line
        // correctly passes under a card would otherwise take its text under
        // with it. The portal carries the same pan/zoom transform, so these
        // stay plain flow coordinates — the 0×0 `overflow: visible` svg is
        // just the SVG context they need to live in.
        <ViewportPortal>
          {/* `as-future` rides the layer itself: the timeline's dimming is a
              class on the edge WRAPPER, which this text no longer lives in. */}
          <svg
            className={`as-edge__labellayer${data?.future ? " as-future" : ""}`}
            style={LABEL_LAYER_STYLE}
          >
            {startLabelAt ? (
              <text
                className="as-edge__endlabel"
                x={startLabelAt.x}
                y={startLabelAt.y - 4}
                textAnchor="middle"
                style={{ pointerEvents: "none" }}
              >
                {data!.startLabel}
              </text>
            ) : null}
            {endLabelAt ? (
              <text
                className="as-edge__endlabel"
                x={endLabelAt.x}
                y={endLabelAt.y - 4}
                textAnchor="middle"
                style={{ pointerEvents: "none" }}
              >
                {data!.endLabel}
              </text>
            ) : null}
            {hasLabel && !editingLabel ? (
            <g
              className="as-edge__labelgroup"
              style={{ pointerEvents: readOnly ? "none" : "all" }}
              onPointerDown={onLabelPointerDown}
              onDoubleClick={onPathDoubleClick}
            >
              {data?.seq ? (
                <>
                  <circle
                    className={`as-edge__seq as-edge--c-${data?.color ?? "slate"}`}
                    cx={geo.label.x - seqBadgeOffset(data.label)}
                    cy={geo.label.y - 9}
                    r={8}
                    fill={EDGE_COLOR_HEX[data?.color ?? "slate"]}
                  />
                  <text
                    className="as-edge__seqnum"
                    x={geo.label.x - seqBadgeOffset(data.label)}
                    y={geo.label.y - 5.6}
                    textAnchor="middle"
                  >
                    {data.seq}
                  </text>
                </>
              ) : null}
              {data?.label ? (
                <text
                  className={`as-edge__label${selected ? " as-edge__label--selected" : ""}`}
                  x={geo.label.x + (data?.seq ? 6 : 0)}
                  y={geo.label.y - 5}
                  textAnchor="middle"
                >
                  {data.label}
                </text>
              ) : null}
              {data?.tech ? (
                <text
                  className="as-edge__tech"
                  x={geo.label.x + (data?.seq && !data?.label ? 6 : 0)}
                  y={geo.label.y + (data?.label ? 8 : -5)}
                  textAnchor="middle"
                >
                  [{data.tech}]
                </text>
              ) : null}
              {data?.date ? (
                <text className="as-edge__date" x={geo.label.x} y={geo.label.y + dateY} textAnchor="middle">
                  {formatDiagramDate(data.date)}
                </text>
              ) : null}
            </g>
            ) : null}
          </svg>
        </ViewportPortal>
      ) : null}
    </g>
  );
});


export const EDGE_TYPES = { labeled: LabeledEdge };

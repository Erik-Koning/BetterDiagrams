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
 * The label slides along the curve by dragging it, persisted as `labelT`.
 */
import { memo, useCallback, useRef } from "react";
import { useInternalNode, useReactFlow, type Edge, type EdgeProps } from "@xyflow/react";
import {
  cardinalityMarker,
  crowsFootPath,
  edgeGeometryFor,
  endLabelInset,
  nearestTOnCurve,
  startAngle,
  tAtDistance,
  type Box,
  type EdgePathSpec,
} from "../contract/geometry";
import {
  EDGE_COLOR_HEX,
  EDGE_DASH,
  fieldAnchors,
  isCollapsedEdgeId,
  isGhostEdgeId,
  type DiagramEdgeData,
  type DiagramNodeData,
} from "../contract/schema";
import { formatDiagramDate } from "../contract/timeline";
import { useStudio } from "./context";
import { seqBadgeOffset } from "./shapes";

export type LabeledEdgeType = Edge<DiagramEdgeData, "labeled">;

export const LabeledEdge = memo(function LabeledEdge({
  id,
  source,
  target,
  data,
  selected,
}: EdgeProps<LabeledEdgeType>) {
  const { readOnly, requestCommit } = useStudio();
  const { screenToFlowPosition, setEdges } = useReactFlow();
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const draggingRef = useRef(false);
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

  const onLabelPointerDown = useCallback(
    (event: React.PointerEvent<SVGElement>) => {
      if (readOnly || !s || !t) return;
      event.stopPropagation();
      const element = event.currentTarget;
      element.setPointerCapture(event.pointerId);
      draggingRef.current = true;

      const move = (e: PointerEvent) => {
        if (!draggingRef.current) return;
        const point = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        // Recompute geometry each frame — the nodes may be moving too.
        const geo = edgeGeometryFor(data?.routingResolved, s, t, data?.labelT ?? 0.5, specOf(s, t));
        const nextT = nearestTOnCurve(geo, point);
        setEdges((edges) =>
          edges.map((edge) =>
            edge.id === id ? { ...edge, data: { ...edge.data, labelT: nextT } } : edge,
          ),
        );
      };
      const up = () => {
        draggingRef.current = false;
        element.releasePointerCapture(event.pointerId);
        element.removeEventListener("pointermove", move as EventListener);
        element.removeEventListener("pointerup", up);
        // Without this the new labelT lives only in React Flow state — undo
        // and a controlled host would never see it until an unrelated edit
        // happened to commit.
        requestCommit();
      };
      element.addEventListener("pointermove", move as EventListener);
      element.addEventListener("pointerup", up);
    },
    [readOnly, s, t, data?.labelT, data?.routingResolved, screenToFlowPosition, setEdges, id, requestCommit],
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
      if (readOnly || synthetic) return;
      event.stopPropagation();
      const element = event.currentTarget;
      element.setPointerCapture(event.pointerId);
      let moved = false;
      const move = (e: PointerEvent) => {
        const point = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        moved = true;
        setEdges((edges) =>
          edges.map((edge) => {
            if (edge.id !== id) return edge;
            const pts = [...((edge.data as DiagramEdgeData | undefined)?.points ?? [])];
            pts[index] = [Math.round(point.x), Math.round(point.y)];
            return { ...edge, data: { ...edge.data, points: pts } };
          }),
        );
      };
      const up = () => {
        element.releasePointerCapture(event.pointerId);
        element.removeEventListener("pointermove", move as EventListener);
        element.removeEventListener("pointerup", up);
        if (moved) requestCommit();
      };
      element.addEventListener("pointermove", move as EventListener);
      element.addEventListener("pointerup", up);
    },
    [readOnly, synthetic, screenToFlowPosition, setEdges, id, requestCommit],
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

  const geo = edgeGeometryFor(data?.routingResolved, s, t, data?.labelT ?? 0.5, specOf(s, t));
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

  // Double-click on the line bends it there: a new waypoint, inserted between
  // its neighbours by position along the curve so the route stays ordered.
  const onPathDoubleClick = (event: React.MouseEvent<SVGPathElement>) => {
    if (readOnly || synthetic) return;
    event.stopPropagation();
    event.preventDefault();
    const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const existing = data?.points ?? [];
    const tNew = nearestTOnCurve(geo, point);
    let index = existing.length;
    for (let i = 0; i < existing.length; i++) {
      if (tNew < nearestTOnCurve(geo, { x: existing[i][0], y: existing[i][1] })) {
        index = i;
        break;
      }
    }
    setPoints([
      ...existing.slice(0, index),
      [Math.round(point.x), Math.round(point.y)],
      ...existing.slice(index),
    ]);
    requestCommit();
  };

  return (
    <g>
      {/* Wide invisible path so the edge is easy to click. */}
      <path
        className="as-edge__hit"
        d={geo.path}
        style={{ pointerEvents: "stroke" }}
        onDoubleClick={onPathDoubleClick}
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
          arrowhead: a relationship reads by its crow's foot, and stacking both
          at one point says two different things about the same end. */}
      {direction !== "none" && !endMarker ? (
        <polygon
          className={`as-edge__arrow ${colorClass}`}
          points="0,-4.5 9,0 0,4.5"
          fill={color}
          transform={`translate(${geo.tip.x} ${geo.tip.y}) rotate(${(geo.angle * 180) / Math.PI})`}
          style={{ pointerEvents: "none" }}
        />
      ) : null}
      {direction === "both" && !startMarker ? (
        <polygon
          className={`as-edge__arrow ${colorClass}`}
          points="0,-4.5 9,0 0,4.5"
          fill={color}
          transform={`translate(${origin.x} ${origin.y}) rotate(${(startAngle(geo) * 180) / Math.PI})`}
          style={{ pointerEvents: "none" }}
        />
      ) : null}
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
      {hasLabel ? (
        <g style={{ pointerEvents: readOnly ? "none" : "all" }} onPointerDown={onLabelPointerDown}>
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
    </g>
  );
});


export const EDGE_TYPES = { labeled: LabeledEdge };

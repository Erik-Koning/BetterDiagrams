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
import { edgeGeometryFor, nearestTOnCurve, startAngle, type Box } from "../contract/geometry";
import { EDGE_COLOR_HEX, EDGE_DASH, type DiagramEdgeData } from "../contract/schema";
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
  const { readOnly } = useStudio();
  const { screenToFlowPosition, setEdges } = useReactFlow();
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const draggingRef = useRef(false);

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
        const geo = edgeGeometryFor(data?.routingResolved, s, t, data?.labelT ?? 0.5);
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
      };
      element.addEventListener("pointermove", move as EventListener);
      element.addEventListener("pointerup", up);
    },
    [readOnly, s, t, data?.labelT, data?.routingResolved, screenToFlowPosition, setEdges, id],
  );

  // A node can be momentarily unmeasured on first paint.
  if (!s || !t || !s.width || !t.width) return null;

  const geo = edgeGeometryFor(data?.routingResolved, s, t, data?.labelT ?? 0.5);
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

  return (
    <g>
      {/* Wide invisible path so the edge is easy to click. */}
      <path className="as-edge__hit" d={geo.path} style={{ pointerEvents: "stroke" }} />
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
      {direction !== "none" ? (
        <polygon
          className={`as-edge__arrow ${colorClass}`}
          points="0,-4.5 9,0 0,4.5"
          fill={color}
          transform={`translate(${geo.tip.x} ${geo.tip.y}) rotate(${(geo.angle * 180) / Math.PI})`}
          style={{ pointerEvents: "none" }}
        />
      ) : null}
      {direction === "both" ? (
        <polygon
          className={`as-edge__arrow ${colorClass}`}
          points="0,-4.5 9,0 0,4.5"
          fill={color}
          transform={`translate(${origin.x} ${origin.y}) rotate(${(startAngle(geo) * 180) / Math.PI})`}
          style={{ pointerEvents: "none" }}
        />
      ) : null}
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

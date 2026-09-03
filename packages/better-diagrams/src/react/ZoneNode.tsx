/**
 * ZoneNode.tsx — the infra-zone renderer.
 *
 * A zone is a React Flow node so it inherits dragging, resizing, selection,
 * undo, and export for free — but it behaves unlike any other node:
 *
 *   - It paints at a negative zIndex, behind everything.
 *   - Its body is `pointer-events: none`, so a click on the zone lands on
 *     whatever node sits on top, or on the canvas. Only the header chip is
 *     interactive, and it doubles as the drag handle (`dragHandle` in the node
 *     mapping) — otherwise dragging a big zone would be impossible to avoid.
 *   - It carries a segmented provider toggle. Switching it re-evaluates which
 *     nodes in the zone are visible.
 *
 * Shapes: rect/rounded render as a plain div so borders stay crisp and corner
 * radii uniform. ellipse/hexagon/polygon render as SVG stretched to the box,
 * with `vector-effect="non-scaling-stroke"` so a wide, short zone doesn't get a
 * squashed outline.
 */
import { memo, useCallback, useRef } from "react";
import { NodeResizer, useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useStudio } from "./context";
import { DateChip } from "./chrome";
import { providerDef, zoneFill, zoneInk } from "./registry-types";
import {
  containZonePoints,
  outlineToSvgPoints,
  zoneChipRadius,
  zoneCornerRadius,
  zoneOutline,
  type DiagramZone,
  type ZonePoint,
} from "../contract/zones";
import { fromZoneNodeId, type ZoneBox, type ZoneNodeData } from "../contract/schema";

export type ZoneNodeType = Node<ZoneNodeData, "zone">;

/** Beyond this many providers a segmented control gets too wide; use a select. */
const MAX_SEGMENTS = 4;

export const ZoneNode = memo(function ZoneNode({ id, data, selected }: NodeProps<ZoneNodeType>) {
  const { registry, readOnly, requestCommit, beginZoneResize, endZoneResize } = useStudio();
  const { setNodes } = useReactFlow();
  // The box at resize start, so drag-end knows a gesture actually began.
  const resizeBoxRef = useRef<ZoneBox | null>(null);
  const zone = data.zone;
  const outline = zoneOutline(zone);
  // The ink (a per-zone override, else the provider colour) drives everything:
  // outline, header chip, swatch — and the fill is DERIVED from it as a dull
  // tint, so one picked colour styles the whole region in either theme.
  const ink = zoneInk(registry, zone);

  /** Write a change back into this zone node's `data.zone`. */
  const patchZone = useCallback(
    (patch: Partial<DiagramZone>) => {
      setNodes((nodes) =>
        nodes.map((n) =>
          n.id === id
            ? { ...n, data: { ...n.data, zone: { ...(n.data as ZoneNodeData).zone, ...patch } } }
            : n,
        ),
      );
    },
    [id, setNodes],
  );

  const setProvider = useCallback(
    (provider: string) => {
      if (readOnly || provider === zone.provider) return;
      patchZone({ provider });
    },
    [readOnly, zone.provider, patchZone],
  );

  /**
   * End of a vertex gesture. Points arrive UNCLAMPED — one dragged past the
   * box edge grows the box to hold it (position/size live on the React Flow
   * node, which owns geometry once dragged), and every point is remapped back
   * into 0..1 before the commit, matching what validation expects.
   */
  const commitPoints = useCallback(
    (pts: ZonePoint[]) => {
      setNodes((nodes) =>
        nodes.map((n) => {
          if (n.id !== id) return n;
          const stored = (n.data as ZoneNodeData).zone;
          const w = Number(n.width ?? (n.style as CSSProperties | undefined)?.width) || stored.w;
          const h = Number(n.height ?? (n.style as CSSProperties | undefined)?.height) || stored.h;
          const grown = containZonePoints({ x: n.position.x, y: n.position.y, w, h }, pts);
          if (!grown) {
            return { ...n, data: { ...n.data, zone: { ...stored, points: pts } } };
          }
          return {
            ...n,
            position: { x: grown.x, y: grown.y },
            width: grown.w,
            height: grown.h,
            style: { ...(n.style as object), width: grown.w, height: grown.h },
            data: {
              ...n.data,
              zone: { ...stored, x: grown.x, y: grown.y, w: grown.w, h: grown.h, points: grown.points },
            },
          };
        }),
      );
      // One undo point per finished gesture.
      requestCommit();
    },
    [id, setNodes, requestCommit],
  );

  const style = {
    "--as-zone-color": ink,
    // Precomputed rgba, byte-identical to what the exporters paint — deriving
    // it in CSS instead would be a second formula that could drift.
    "--as-zone-fill": zoneFill(registry, zone),
    // The header chip traces this same corner where it overlaps it, so the
    // two curves lie on top of each other instead of crossing.
    "--as-zone-radius": `${zoneChipRadius(zone)}px`,
  } as CSSProperties;

  return (
    <div
      className="as-zone"
      style={style}
      data-selected={selected ? "" : undefined}
      data-outline={zone.outline ?? "solid"}
    >
      <NodeResizer
        isVisible={!!selected && !readOnly && !zone.locked}
        minWidth={120}
        minHeight={100}
        onResizeStart={(_event, params) => {
          const box = { x: params.x, y: params.y, w: params.width, h: params.height };
          resizeBoxRef.current = box;
          beginZoneResize(fromZoneNodeId(id), box);
        }}
        onResizeEnd={(_event, params) => {
          const started = resizeBoxRef.current;
          resizeBoxRef.current = null;
          if (started) {
            endZoneResize(fromZoneNodeId(id), {
              x: params.x,
              y: params.y,
              w: params.width,
              h: params.height,
            });
          } else {
            // Defensive: an end without a start still records the edit.
            requestCommit();
          }
        }}
      />

      {/* The fill. Never interactive — clicks must reach the nodes above it. */}
      {outline || zone.shape === "ellipse" ? (
        <svg
          className="as-zone__shape"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {zone.shape === "ellipse" ? (
            <ellipse cx={50} cy={50} rx={50} ry={50} vectorEffect="non-scaling-stroke" />
          ) : (
            <polygon points={outlineToSvgPoints(outline!)} vectorEffect="non-scaling-stroke" />
          )}
        </svg>
      ) : (
        <div
          className="as-zone__shape as-zone__shape--box"
          style={{ borderRadius: zoneCornerRadius(zone.shape) }}
          aria-hidden="true"
        />
      )}

      {/* The only interactive part, and the drag handle. */}
      <div className="as-zone__header">
        <span className="as-zone__swatch" aria-hidden="true" />
        <span className="as-zone__label" title={zone.label}>
          {zone.label}
        </span>
        <DateChip date={zone.date} inline prefix="Region exists from" />

        {zone.providers.length > 1 ? (
          zone.providers.length <= MAX_SEGMENTS ? (
            // `nodrag` stops React Flow starting a zone drag from a mousedown
            // on the toggle — the header is the drag handle, so without it
            // picking a provider would also drag the zone across the canvas.
            <span
              className="as-zone__toggle nodrag"
              role="group"
              aria-label={`${zone.label} provider`}
            >
              {zone.providers.map((p) => {
                const pd = providerDef(registry, p);
                const active = p === zone.provider;
                return (
                  <button
                    key={p}
                    type="button"
                    className={`as-zone__seg${active ? " as-zone__seg--on" : ""}`}
                    style={active ? { background: pd.color } : undefined}
                    aria-pressed={active}
                    disabled={readOnly}
                    // The click belongs to the toggle, not to the zone under
                    // it: picking a provider also selected the region and
                    // opened its inspector over the canvas, every time.
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      setProvider(p);
                    }}
                    title={`Show the ${pd.label} deployment`}
                  >
                    {pd.label}
                  </button>
                );
              })}
            </span>
          ) : (
            <select
              className="as-zone__select nodrag"
              value={zone.provider}
              disabled={readOnly}
              aria-label={`${zone.label} provider`}
              onChange={(event) => setProvider(event.target.value)}
            >
              {zone.providers.map((p) => (
                <option key={p} value={p}>
                  {providerDef(registry, p).label}
                </option>
              ))}
            </select>
          )
        ) : (
          // The provider's NAME, not the zone's ink — a recoloured zone is
          // still hosted where it is hosted.
          <span className="as-zone__single">{providerDef(registry, zone.provider).label}</span>
        )}
      </div>

      {selected && !readOnly && !zone.locked && zone.shape === "polygon" ? (
        <PolygonEditor
          zone={zone}
          onChange={(points) => patchZone({ points })}
          onDragEnd={commitPoints}
        />
      ) : null}
    </div>
  );
});

// ─── Polygon vertex editing ──────────────────────────────────────────────────

/**
 * Draggable vertices, plus press-and-drag on an edge midpoint to add a point
 * and place it in one gesture, and double-click-to-remove. Points are
 * normalised 0..1, so a zone keeps its silhouette when resized. Coordinates
 * are deliberately NOT clamped during a drag — releasing a vertex outside the
 * box grows the zone to contain it (see `commitPoints` above).
 */
function PolygonEditor({
  zone,
  onChange,
  onDragEnd,
}: {
  zone: DiagramZone;
  onChange: (points: ZonePoint[]) => void;
  /** Fired once per finished gesture with the final (possibly out-of-box) points. */
  onDragEnd: (points: ZonePoint[]) => void;
}) {
  const points = zoneOutline(zone) ?? [];
  const width = zone.w;
  const height = zone.h;

  /**
   * Shared drag plumbing. `place(nx, ny)` builds the full point list for the
   * pointer at (nx, ny) — always from the pre-gesture `points`, so indices
   * can't go stale while re-renders stream in mid-drag.
   */
  const dragFrom = useCallback(
    (
      target: SVGGraphicsElement,
      pointerId: number,
      place: (nx: number, ny: number) => ZonePoint[],
      initial: ZonePoint[],
    ) => {
      const svg = target.ownerSVGElement;
      if (!svg) return;
      target.setPointerCapture(pointerId);
      let latest = initial;

      const move = (e: PointerEvent) => {
        const rect = svg.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        latest = place((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
        onChange(latest);
      };
      const up = () => {
        target.releasePointerCapture(pointerId);
        target.removeEventListener("pointermove", move as EventListener);
        target.removeEventListener("pointerup", up);
        onDragEnd(latest);
      };
      target.addEventListener("pointermove", move as EventListener);
      target.addEventListener("pointerup", up);
    },
    [onChange, onDragEnd],
  );

  const startDrag = useCallback(
    (index: number) => (event: ReactPointerEvent<SVGGraphicsElement>) => {
      event.stopPropagation();
      const place = (nx: number, ny: number) =>
        points.map((p, i): ZonePoint => (i === index ? [nx, ny] : p));
      dragFrom(event.currentTarget, event.pointerId, place, points);
    },
    [points, dragFrom],
  );

  /** The new point exists from the pointerdown; keep holding to place it. */
  const addAndDrag = useCallback(
    (afterIndex: number) => (event: ReactPointerEvent<SVGGraphicsElement>) => {
      event.stopPropagation();
      const a = points[afterIndex];
      const b = points[(afterIndex + 1) % points.length];
      const place = (nx: number, ny: number): ZonePoint[] => {
        const next = [...points];
        next.splice(afterIndex + 1, 0, [nx, ny]);
        return next;
      };
      const initial = place((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      onChange(initial);
      dragFrom(event.currentTarget, event.pointerId, place, initial);
    },
    [points, onChange, dragFrom],
  );

  const removePoint = useCallback(
    (index: number) => (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      // A polygon needs three points to still be a polygon.
      if (points.length <= 3) return;
      // Through onDragEnd so the removal commits like any finished gesture.
      onDragEnd(points.filter((_, i) => i !== index));
    },
    [points, onDragEnd],
  );

  // Handles are drawn in the ZONE's own 0..100 box, which `preserveAspectRatio:
  // none` then stretches to the region's real size — so one radius produced a
  // 6x5px dot on a small zone and a 30x17px blob on a large one. Convert a
  // fixed pixel radius into that box's units per axis, so every handle is the
  // same size on screen and round whatever shape the zone is.
  const rx = (px: number) => (width > 0 ? (px / width) * 100 : px);
  const ry = (px: number) => (height > 0 ? (px / height) * 100 : px);

  return (
    <svg
      className="as-zone__vertices"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      // Sits above the fill so the handles are grabbable, but the SVG itself
      // stays transparent to clicks except on the handles.
      style={{ pointerEvents: "none" }}
    >
      {points.map((p, i) => {
        const next = points[(i + 1) % points.length];
        const mid: ZonePoint = [(p[0] + next[0]) / 2, (p[1] + next[1]) / 2];
        return (
          <ellipse
            key={`add-${i}`}
            className="as-zone__vertex as-zone__vertex--add nodrag"
            cx={mid[0] * 100}
            cy={mid[1] * 100}
            rx={rx(VERTEX_ADD_R)}
            ry={ry(VERTEX_ADD_R)}
            onPointerDown={addAndDrag(i)}
          >
            <title>Press to add a point — keep holding to place it</title>
          </ellipse>
        );
      })}
      {points.map((p, i) => (
        <ellipse
          key={`v-${i}`}
          className="as-zone__vertex nodrag"
          cx={p[0] * 100}
          cy={p[1] * 100}
          rx={rx(VERTEX_R)}
          ry={ry(VERTEX_R)}
          onPointerDown={startDrag(i)}
          onDoubleClick={removePoint(i)}
        >
          <title>Drag to move · double-click to remove</title>
        </ellipse>
      ))}
    </svg>
  );
}

/** Vertex handle radius, in SCREEN px — a comfortable pointer target. */
const VERTEX_R = 7;
/** The "add a point" dot between two vertices, deliberately smaller. */
const VERTEX_ADD_R = 5;

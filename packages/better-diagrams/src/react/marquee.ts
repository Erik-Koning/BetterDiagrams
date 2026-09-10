/**
 * marquee.ts — the rubber band the Select tool draws.
 *
 * React Flow ships a marquee of its own and the Cursor tool uses it. This one
 * exists for the two things that one cannot do:
 *
 *   * **Band from anywhere.** React Flow only starts a band when the press
 *     lands on the bare pane (`event.target === container`), so a drag that
 *     begins over a box moves the box instead. A tool whose whole job is
 *     "drag to highlight" has to work over the boxes too.
 *   * **Merge.** Its band calls `resetSelectedElements()` the moment the drag
 *     passes the click threshold, so a modifier-held band replaces the
 *     selection rather than adding to it.
 *
 * A press that never moves past `DRAG_THRESHOLD` is left completely alone, so
 * click-to-select, double-click-to-drill and the right-click menu all still
 * behave as they do under the Cursor tool. Only a real drag is intercepted.
 *
 * The band rectangle is written straight to the DOM rather than held in state:
 * it moves every frame, and the editor it lives in is a large component that
 * has no reason to re-render sixty times a second for a rectangle.
 */
import { useCallback, useEffect, useRef } from "react";
import type { Edge, Node } from "@xyflow/react";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Pt {
  x: number;
  y: number;
}

/** A box the band can catch, in flow (absolute) coordinates. */
export interface BandBox extends Rect {
  id: string;
}

/** How far the pointer must travel before a press becomes a drag. */
export const DRAG_THRESHOLD = 4;

/** The border strip that pans the canvas while a band is dragged into it. */
const AUTO_PAN_EDGE = 28;
/** Pixels per frame at the very edge; less the further inside the pointer is. */
const AUTO_PAN_MAX = 16;

/**
 * Touch a box and it is in.
 *
 * The same rule as `SelectionMode.Partial`, which the canvas already uses for
 * React Flow's band — requiring full enclosure means a rubber band round
 * "these four services" has to clear every edge of every one of them.
 */
export function boxesOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  );
}

/** The rectangle two corners describe, in either order. */
export function rectBetween(a: Pt, b: Pt): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export function idsInBand(band: Rect, boxes: readonly BandBox[]): Set<string> {
  const hit = new Set<string>();
  for (const box of boxes) if (boxesOverlap(band, box)) hit.add(box.id);
  return hit;
}

export function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * How far to shove the viewport this frame, given where the pointer is.
 *
 * Proportional rather than a fixed step: nudging one pixel past the edge
 * should creep, and holding the pointer well outside should race.
 */
export function edgePan(point: Pt, bounds: { left: number; top: number; right: number; bottom: number }): Pt {
  const axis = (at: number, low: number, high: number) => {
    if (at < low + AUTO_PAN_EDGE) {
      return Math.min(1, (low + AUTO_PAN_EDGE - at) / AUTO_PAN_EDGE) * AUTO_PAN_MAX;
    }
    if (at > high - AUTO_PAN_EDGE) {
      return -Math.min(1, (at - (high - AUTO_PAN_EDGE)) / AUTO_PAN_EDGE) * AUTO_PAN_MAX;
    }
    return 0;
  };
  return { x: axis(point.x, bounds.left, bounds.right), y: axis(point.y, bounds.top, bounds.bottom) };
}

/**
 * The slice of the React Flow instance the band needs.
 *
 * Structural rather than `ReactFlowInstance` so the hook can be driven by a
 * fake in a test — jsdom lays nothing out, so a real instance measures every
 * node as 0x0 and no band ever catches anything.
 */
export interface MarqueeFlow {
  getNodes: () => Node[];
  getEdges: () => Edge[];
  getInternalNode: (id: string) => { internals: { positionAbsolute: Pt } } | undefined;
  screenToFlowPosition: (point: Pt) => Pt;
  flowToScreenPosition: (point: Pt) => Pt;
  getViewport: () => { x: number; y: number; zoom: number };
  setViewport: (viewport: { x: number; y: number; zoom: number }) => unknown;
}

interface Drag {
  pointerId: number;
  startClient: Pt;
  startFlow: Pt;
  client: Pt;
  bounds: DOMRect;
  additive: boolean;
  /** What was selected before the drag — kept only for an additive band. */
  base: { nodes: Set<string>; edges: Set<string> };
  boxes: BandBox[];
  applied: { nodes: Set<string>; edges: Set<string> };
  active: boolean;
  detach: () => void;
}

/** Elements over the canvas that own their own press. */
const PASSTHROUGH = [
  ".nodrag",
  // NOT `.react-flow__handle`. Handles cannot start a connection under this
  // tool (`nodesConnectable` is off, and the stylesheet takes their pointer
  // events with it), so listing them here would only reserve a dead ring
  // around every hovered card for a gesture that no longer exists.
  ".react-flow__panel",
  ".react-flow__controls",
  ".react-flow__minimap",
  ".react-flow__resize-control",
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
].join(", ");

export function useMarqueeSelect({
  enabled,
  surfaceRef,
  flow,
  setNodes,
  setEdges,
}: {
  enabled: boolean;
  /** The positioned box the band is drawn inside — the canvas. */
  surfaceRef: { current: HTMLElement | null };
  flow: MarqueeFlow;
  setNodes: (updater: (nodes: Node[]) => Node[]) => void;
  setEdges: (updater: (edges: Edge[]) => Edge[]) => void;
}): {
  bandRef: React.RefObject<HTMLDivElement>;
  onPointerDownCapture: (event: React.PointerEvent<HTMLElement>) => void;
} {
  const bandRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const frame = useRef(0);

  const draw = useCallback((rect: Rect | null) => {
    const el = bandRef.current;
    if (!el) return;
    if (!rect) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.style.left = `${rect.x}px`;
    el.style.top = `${rect.y}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
  }, []);

  /** Re-derive the selection and the band from where the pointer now is. */
  const commit = useCallback(
    (d: Drag) => {
      const bandFlow = rectBetween(d.startFlow, flow.screenToFlowPosition(d.client));
      const caught = idsInBand(bandFlow, d.boxes);

      const nodeIds = d.additive ? new Set([...d.base.nodes, ...caught]) : caught;
      // Edges follow their boxes, which is what React Flow's own band does:
      // catching a node catches what it is wired to, so a copied selection
      // arrives with its wiring rather than as loose boxes.
      const edgeIds = new Set(d.additive ? d.base.edges : []);
      for (const edge of flow.getEdges()) {
        // `hidden` as well as `selectable`: the timeline's "hide later" mode
        // hides future elements rather than removing them, and a band that
        // caught one put an invisible line in reach of the next Delete.
        if (edge.selectable === false || edge.hidden) continue;
        if (caught.has(edge.source) || caught.has(edge.target)) edgeIds.add(edge.id);
      }

      if (!sameSet(nodeIds, d.applied.nodes)) {
        d.applied.nodes = nodeIds;
        setNodes((current) =>
          current.map((n) => (!!n.selected === nodeIds.has(n.id) ? n : { ...n, selected: nodeIds.has(n.id) })),
        );
      }
      if (!sameSet(edgeIds, d.applied.edges)) {
        d.applied.edges = edgeIds;
        setEdges((current) =>
          current.map((e) => (!!e.selected === edgeIds.has(e.id) ? e : { ...e, selected: edgeIds.has(e.id) })),
        );
      }

      const topLeft = flow.flowToScreenPosition({ x: bandFlow.x, y: bandFlow.y });
      const bottomRight = flow.flowToScreenPosition({
        x: bandFlow.x + bandFlow.width,
        y: bandFlow.y + bandFlow.height,
      });
      draw({
        x: topLeft.x - d.bounds.left,
        y: topLeft.y - d.bounds.top,
        width: bottomRight.x - topLeft.x,
        height: bottomRight.y - topLeft.y,
      });
    },
    [draw, flow, setEdges, setNodes],
  );

  const stop = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    d?.detach();
    draw(null);
    return d;
  }, [draw]);

  const onPointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!enabled || event.button !== 0 || !event.isPrimary) return;
      const surface = surfaceRef.current;
      const target = event.target as HTMLElement | null;
      if (!surface || !target) return;
      // Only presses on the canvas surface itself. Everything floating over it
      // — the AI panel, the inspector, the minimap, a node's own buttons —
      // keeps its press, or the tool would swallow every control on screen.
      if (!target.closest(".react-flow__pane") || target.closest(PASSTHROUGH)) return;

      stop();
      const bounds = surface.getBoundingClientRect();
      const startClient = { x: event.clientX, y: event.clientY };
      const selected = <T extends { id: string; selected?: boolean }>(items: T[]) =>
        new Set(items.filter((item) => item.selected).map((item) => item.id));

      const d: Drag = {
        pointerId: event.pointerId,
        startClient,
        startFlow: flow.screenToFlowPosition(startClient),
        client: startClient,
        bounds,
        // ⌘/Ctrl as well as ⇧, matching the chord that extends a selection by
        // clicking (`multiSelectionKeyCode` on the canvas).
        additive: event.metaKey || event.ctrlKey || event.shiftKey,
        base: { nodes: selected(flow.getNodes()), edges: selected(flow.getEdges()) },
        // Measured once: nothing is draggable while this tool is active, so
        // the boxes cannot move under the band.
        boxes: flow
          .getNodes()
          .filter((n) => n.selectable !== false && !n.hidden)
          .map((n) => {
            const at = flow.getInternalNode(n.id)?.internals.positionAbsolute ?? n.position;
            return {
              id: n.id,
              x: at.x,
              y: at.y,
              width: n.measured?.width ?? n.width ?? 0,
              height: n.measured?.height ?? n.height ?? 0,
            };
          }),
        applied: { nodes: new Set(), edges: new Set() },
        active: false,
        detach: () => {},
      };

      const tick = () => {
        const live = drag.current;
        if (!live?.active) return;
        const pan = edgePan(live.client, live.bounds);
        if (pan.x || pan.y) {
          const viewport = flow.getViewport();
          flow.setViewport({ x: viewport.x + pan.x, y: viewport.y + pan.y, zoom: viewport.zoom });
          commit(live);
        }
        frame.current = requestAnimationFrame(tick);
      };

      const onMove = (moveEvent: PointerEvent) => {
        const live = drag.current;
        if (!live || moveEvent.pointerId !== live.pointerId) return;
        live.client = { x: moveEvent.clientX, y: moveEvent.clientY };
        if (!live.active) {
          const travelled = Math.hypot(
            live.client.x - live.startClient.x,
            live.client.y - live.startClient.y,
          );
          if (travelled <= DRAG_THRESHOLD) return;
          live.active = true;
          frame.current = requestAnimationFrame(tick);
        }
        commit(live);
      };

      const onUp = (upEvent: PointerEvent) => {
        const live = drag.current;
        if (live && upEvent.pointerId !== live.pointerId) return;
        const finished = stop();
        // A band ends on a `click`, and the pane answers that by clearing the
        // selection the band just made. Only a real drag is swallowed — a
        // press that never moved is an ordinary click and must stay one.
        if (finished?.active) swallowNextClick(surface);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      d.detach = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      drag.current = d;
    },
    [commit, enabled, flow, stop, surfaceRef],
  );

  // Switching tool or unmounting mid-drag leaves the band on screen and the
  // window listeners attached, so both are torn down here as well.
  useEffect(() => {
    if (!enabled) stop();
    return () => void stop();
  }, [enabled, stop]);

  return { bandRef, onPointerDownCapture };
}

function swallowNextClick(surface: HTMLElement) {
  const drop = () => {
    surface.removeEventListener("click", swallow, true);
    window.clearTimeout(timer);
  };
  const swallow = (event: MouseEvent) => {
    event.stopPropagation();
    drop();
  };
  surface.addEventListener("click", swallow, true);
  // A drag released outside the window never produces the click, so the
  // listener cannot wait for one that may not come.
  const timer = window.setTimeout(drop, 400);
}

/**
 * resize-handles.ts — when a node's resize handles are up.
 *
 * Selection puts them up, as it always has. So does hover: the pointer
 * resting on a box lights its corners, so it can be pulled wider without a
 * click first — and without touching a selection held elsewhere, since the
 * fan-out that makes a multi-selection follow a handle follows a SELECTED
 * node's handle only (see `fanOutResize`). An unselected box under the
 * pointer resizes alone.
 *
 * Hover is read from React Flow's wrapper, never from the card inside it.
 * The controls hang half outside the card's box, so a pointer travelling
 * from the card onto a handle leaves the card — and a resizer keyed on the
 * card's hover would unmount under the pointer that was about to grab it.
 * The wrapper contains the handles, so the same journey stays inside.
 *
 * A gesture in flight keeps them up whatever the pointer does. Dragging a
 * corner past the box's floor carries the pointer off the box (the handle
 * stops, the pointer does not); unmounting the resizer there would destroy
 * the drag without its end, and the size would never be committed.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface ResizeHandles {
  /** Whether to mount the `NodeResizer`. */
  visible: boolean;
  /** Put on the node's own element — any element inside React Flow's wrapper. */
  hostRef: RefObject<HTMLDivElement>;
  /** Call from the resizer's `onResizeStart`. */
  onResizeStart: () => void;
  /** Call from the resizer's `onResizeEnd`. */
  onResizeEnd: () => void;
}

/**
 * @param enabled whether this node may be resized at all — editable, unlocked,
 *   not a stand-in; the callers' own rules, unchanged.
 */
export function useResizeHandles(enabled: boolean, selected: boolean | undefined): ResizeHandles {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    const wrapper = hostRef.current?.closest(".react-flow__node");
    if (!wrapper) return;
    const enter = () => setHovered(true);
    const leave = () => setHovered(false);
    // `pointerenter`/`pointerleave` rather than over/out: they do not fire
    // for movement between the wrapper's own descendants, which is exactly
    // the card-to-handle journey that must not count as leaving.
    wrapper.addEventListener("pointerenter", enter);
    wrapper.addEventListener("pointerleave", leave);
    return () => {
      wrapper.removeEventListener("pointerenter", enter);
      wrapper.removeEventListener("pointerleave", leave);
    };
  }, []);

  const onResizeStart = useCallback(() => setResizing(true), []);
  const onResizeEnd = useCallback(() => setResizing(false), []);

  return {
    visible: enabled && (!!selected || hovered || resizing),
    hostRef,
    onResizeStart,
    onResizeEnd,
  };
}

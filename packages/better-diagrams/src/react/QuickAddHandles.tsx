/**
 * QuickAddHandles.tsx — the four arrows standing off a selected card.
 *
 * Click one and a node of the same kind appears on that side, already wired
 * to the card by an arrow (where it lands is quick-add.ts's business). Drawn
 * with React Flow's NodeToolbar, so they keep their size at any zoom and
 * stand a fixed screen distance off each side.
 *
 * Rendered ONCE, for the single selected card, rather than inside every node
 * renderer: a NodeToolbar subscribes to the viewport, and four per node on a
 * few hundred tables would be a thousand subscriptions re-run on every frame
 * of every pan.
 */
import { useCallback, type CSSProperties, type SyntheticEvent } from "react";
import { NodeToolbar, Position, useStore, type ReactFlowState } from "@xyflow/react";
import type { QuickAddSide } from "./quick-add";

const SIDES: ReadonlyArray<[QuickAddSide, Position, string]> = [
  ["top", Position.Top, "above"],
  ["right", Position.Right, "to the right"],
  ["bottom", Position.Bottom, "below"],
  ["left", Position.Left, "to the left"],
];

/**
 * Screen pixels between the card's edge and an arrow: clear of the 8px
 * connect dot on the same side, which still starts a drag of its own.
 */
const OFFSET = 18;

const stop = (event: SyntheticEvent) => event.stopPropagation();

export function QuickAddHandles({
  nodeId,
  kindLabel,
  hangBelow = 0,
  tint,
  onAdd,
}: {
  nodeId: string;
  /** What a click adds — "Service", "Table" — for the button's name. */
  kindLabel: string;
  /** Canvas pixels of the card that hang below its box (a task's assignee tabs). */
  hangBelow?: number;
  /** The colour of the frame or zone the card sits in (`containerInk`); absent, the arrows stay neutral. */
  tint?: string | null;
  onAdd: (side: QuickAddSide) => void;
}) {
  // Out of the way while the card is moved or resized, or while an arrow is
  // being drawn: either way they would trail the gesture across the canvas.
  const busy = useStore(
    useCallback(
      (s: ReactFlowState) => {
        const node = s.nodeLookup.get(nodeId);
        return !!node?.dragging || !!node?.resizing || s.connection.inProgress;
      },
      [nodeId],
    ),
  );
  const zoom = useStore((s: ReactFlowState) => s.transform[2]);
  if (busy) return null;

  return (
    <>
      {SIDES.map(([side, position, where]) => (
        <NodeToolbar
          key={side}
          nodeId={nodeId}
          isVisible
          position={position}
          offset={side === "bottom" ? OFFSET + hangBelow * zoom : OFFSET}
          // `nopan`: the toolbar sits inside React Flow's zoom pane, and a
          // press on it would otherwise start a pan.
          className={`as-quick-add${tint ? " as-quick-add--tinted" : ""} nopan nodrag`}
          style={tint ? ({ "--as-quick-add-tint": tint } as CSSProperties) : undefined}
        >
          <button
            type="button"
            className={`as-quick-add__btn as-quick-add__btn--${side}`}
            aria-label={`Add a connected ${kindLabel} ${where}`}
            title={`Add a connected ${kindLabel} ${where}`}
            onPointerDown={stop}
            onDoubleClick={stop}
            // Enter and Space press the button; the editor's own Enter is
            // "rename the selection", which would take the key first.
            onKeyDown={stop}
            onClick={(event) => {
              event.stopPropagation();
              onAdd(side);
            }}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M3 8h9.5M8.5 4 12.5 8l-4 4" />
            </svg>
          </button>
        </NodeToolbar>
      ))}
    </>
  );
}

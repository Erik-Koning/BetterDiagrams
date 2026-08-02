/**
 * history.ts — undo/redo over React Flow state.
 *
 * Snapshots are taken at *commit points* (drag end, connect, delete, inspector
 * change, import, AI generate) rather than on every state change. Snapshotting
 * every change would push one entry per pointermove during a drag and make
 * Cmd+Z useless.
 *
 * The stack is past / present / future. `commit(next)` moves the *previous*
 * present onto `past` — pushing the new state instead would make every undo
 * land one step short.
 */
import { useCallback, useRef, useState } from "react";
import type { Edge, Node } from "@xyflow/react";

export interface Snapshot {
  nodes: Node[];
  edges: Edge[];
  /** Document metadata (title etc.) — in the snapshot so retitling is undoable. */
  meta?: Record<string, unknown>;
  /**
   * The full derived document this state materialized. Undo restores from
   * this rather than re-deriving from the arrays, because the arrays hold
   * only the provider-visible subset — re-judging them against a later frame
   * would delete hidden nodes. Treated as immutable, so shared by reference.
   */
  template?: unknown;
}

export interface History {
  canUndo: boolean;
  canRedo: boolean;
  /** Record a new state. The state it replaces becomes the undo target. */
  commit: (snapshot: Snapshot) => void;
  /** Step back; returns the state to apply, or null when there is none. */
  undo: () => Snapshot | null;
  /** Step forward; returns the state to apply, or null. */
  redo: () => Snapshot | null;
  /** Drop all history and set a new baseline — used when the document is replaced. */
  reset: (snapshot: Snapshot) => void;
}

const LIMIT = 100;

/** Structural clone so later mutation of live state cannot corrupt history. */
function clone(snapshot: Snapshot): Snapshot {
  return {
    nodes: snapshot.nodes.map((n) => ({ ...n, data: { ...n.data }, position: { ...n.position } })),
    edges: snapshot.edges.map((e) => ({ ...e, data: { ...e.data } })),
    ...(snapshot.meta ? { meta: { ...snapshot.meta } } : {}),
    // Immutable by convention — every producer builds a fresh object.
    ...(snapshot.template ? { template: snapshot.template } : {}),
  };
}

/**
 * Compare only the fields the document actually persists. React Flow mutates
 * transient fields (`measured`, `dragging`, `selected`) constantly; keying off
 * those would record an undo entry every time the user clicks a node.
 */
function signature(snapshot: Snapshot): string {
  const nodes = snapshot.nodes.map((n) => [
    n.id,
    n.type,
    Math.round(n.position.x),
    Math.round(n.position.y),
    Math.round((n.width ?? (n.style?.width as number)) || 0),
    Math.round((n.height ?? (n.style?.height as number)) || 0),
    n.parentId ?? "",
    JSON.stringify(n.data ?? {}),
  ]);
  const edges = snapshot.edges.map((e) => [e.id, e.source, e.target, JSON.stringify(e.data ?? {})]);
  return JSON.stringify({ nodes, edges, meta: snapshot.meta ?? null });
}

export function useHistory(initial?: Snapshot): History {
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const present = useRef<Snapshot | null>(initial ? clone(initial) : null);
  const presentSig = useRef<string | null>(initial ? signature(initial) : null);
  const [, force] = useState(0);
  const rerender = useCallback(() => force((n) => n + 1), []);

  const commit = useCallback(
    (snapshot: Snapshot) => {
      const sig = signature(snapshot);
      // Nothing persisted actually changed — collapse into the current entry.
      if (sig === presentSig.current) return;

      if (present.current) {
        past.current.push(present.current);
        if (past.current.length > LIMIT) past.current.shift();
      }
      future.current = [];
      present.current = clone(snapshot);
      presentSig.current = sig;
      rerender();
    },
    [rerender],
  );

  const undo = useCallback(() => {
    const previous = past.current.pop();
    if (!previous) return null;
    if (present.current) future.current.push(present.current);
    present.current = previous;
    presentSig.current = signature(previous);
    rerender();
    return clone(previous);
  }, [rerender]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return null;
    if (present.current) past.current.push(present.current);
    present.current = next;
    presentSig.current = signature(next);
    rerender();
    return clone(next);
  }, [rerender]);

  const reset = useCallback(
    (snapshot: Snapshot) => {
      past.current = [];
      future.current = [];
      present.current = clone(snapshot);
      presentSig.current = signature(snapshot);
      rerender();
    },
    [rerender],
  );

  return {
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    commit,
    undo,
    redo,
    reset,
  };
}

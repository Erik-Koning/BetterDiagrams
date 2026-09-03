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

export interface CommitOptions {
  /**
   * Identifies a RUN of edits that should undo as one — typically one field of
   * one element, e.g. `node:api:label`.
   *
   * Typing into an inspector field commits on every keystroke, because the
   * host is told about every committed edit and a controlled document must
   * stay live. But "one keystroke, one undo entry" makes ⌘Z delete a character
   * at a time, and fixing a typo becomes a dozen presses. Consecutive commits
   * carrying the same key REPLACE the current entry instead of pushing a new
   * one, so a run of typing collapses into the edit it was. Moving to another
   * field, or pausing longer than `COALESCE_MS`, starts a new entry — which is
   * where a person would expect undo to stop.
   */
  coalesce?: string;
}

export interface History {
  canUndo: boolean;
  canRedo: boolean;
  /** Record a new state. The state it replaces becomes the undo target. */
  commit: (snapshot: Snapshot, opts?: CommitOptions) => void;
  /** Step back; returns the state to apply, or null when there is none. */
  undo: () => Snapshot | null;
  /** Step forward; returns the state to apply, or null. */
  redo: () => Snapshot | null;
  /** Drop all history and set a new baseline — used when the document is replaced. */
  reset: (snapshot: Snapshot) => void;
  /**
   * End any open coalescing run. Call it where a person would consider the
   * edit finished — leaving a field, or starting a different kind of action —
   * so the next keystroke cannot join a run it has nothing to do with.
   */
  endRun: () => void;
}

const LIMIT = 100;

/**
 * How long a coalescing run stays open. Long enough to cover ordinary typing,
 * short enough that going back to a field after a pause is its own edit.
 */
const COALESCE_MS = 1200;

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
  /** The coalescing run in progress: which field, and when it last grew. */
  const run = useRef<{ key: string | null; at: number }>({ key: null, at: 0 });
  const [, force] = useState(0);
  const rerender = useCallback(() => force((n) => n + 1), []);

  const commit = useCallback(
    (snapshot: Snapshot, opts?: CommitOptions) => {
      const sig = signature(snapshot);
      // Nothing persisted actually changed — collapse into the current entry.
      if (sig === presentSig.current) return;

      const now = Date.now();
      const key = opts?.coalesce;
      const continuing =
        !!key && key === run.current.key && now - run.current.at < COALESCE_MS && !!present.current;

      // A continuing run overwrites its own entry: the undo target stays the
      // state from BEFORE the run started, which is the state the user means.
      if (!continuing) {
        if (present.current) {
          past.current.push(present.current);
          if (past.current.length > LIMIT) past.current.shift();
        }
        future.current = [];
      }
      run.current = { key: key ?? null, at: now };
      present.current = clone(snapshot);
      presentSig.current = sig;
      rerender();
    },
    [rerender],
  );

  /** Close any open coalescing run, so the next commit starts a new entry. */
  const endRun = useCallback(() => {
    run.current = { key: null, at: 0 };
  }, []);

  const undo = useCallback(() => {
    run.current = { key: null, at: 0 };
    const previous = past.current.pop();
    if (!previous) return null;
    if (present.current) future.current.push(present.current);
    present.current = previous;
    presentSig.current = signature(previous);
    rerender();
    return clone(previous);
  }, [rerender]);

  const redo = useCallback(() => {
    run.current = { key: null, at: 0 };
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
      run.current = { key: null, at: 0 };
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
    endRun,
  };
}

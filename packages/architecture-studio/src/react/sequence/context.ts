/**
 * context.ts — ambient state for the sequence renderers, mirroring the
 * architecture editor's StudioContext: React Flow instantiates the node/edge
 * components itself, so they can't receive these as props.
 */
import { createContext, useContext } from "react";

export interface SequenceContextValue {
  readOnly: boolean;
  /** Number every message, from meta.autonumber. */
  autonumber: boolean;
  /**
   * Record the current canvas as a committed edit (microtask-deferred so the
   * triggering state update flushes first). Same contract as the
   * architecture editor's requestCommit.
   */
  requestCommit: () => void;
  /**
   * Re-anchor an activation bar or fragment node's span to the message rows
   * its box covers, rewrite its document object in `data`, and commit. The
   * gestures (press-drag creation, move, resize) all end here.
   */
  commitSpanGeometry: (nodeId: string) => void;
}

export const SequenceContext = createContext<SequenceContextValue>({
  readOnly: false,
  autonumber: false,
  requestCommit: () => {},
  commitSpanGeometry: () => {},
});

export const useSequence = (): SequenceContextValue => useContext(SequenceContext);

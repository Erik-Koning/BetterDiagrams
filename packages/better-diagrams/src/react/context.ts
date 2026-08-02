/**
 * context.ts — ambient state the custom node and edge renderers need.
 *
 * React Flow instantiates node/edge components itself, so they cannot receive
 * the registry as a prop. A context keeps the alternative — stuffing a copy of
 * the registry into every node's `data` — out of the serialised document.
 */
import { createContext, useContext } from "react";
import { createRegistry } from "./create-registry";
import type { ResolvedRegistry } from "./registry-types";

export interface StudioContextValue {
  registry: ResolvedRegistry;
  /** Editing is disabled; renderers hide affordances and block inline edits. */
  readOnly: boolean;
  /**
   * Active tag filter. Nodes carrying none of these tags render dimmed —
   * dimmed, never hidden, so the filter is purely presentational and can't
   * interact with what persists.
   */
  tagFilter: string[];
  /**
   * Render each node's owning-team badge. A view preference like the tag
   * filter — presentational only, so hiding badges can't touch what persists.
   */
  showTeams: boolean;
  /**
   * Ask the editor to record the current state — an undo point plus onChange.
   * Node renderers mutate state directly via updateNodeData/setNodes (inline
   * annotation editing, polygon vertex drags, resizes); without calling this
   * afterwards those edits are invisible to undo and to a controlled host
   * until some unrelated action commits.
   */
  requestCommit: () => void;
  /**
   * Present when the host supports cross-file navigation. A node whose `url`
   * uses the `file:` prefix renders its ↗ affix as a jump to that file
   * (resolved by the host — id first, then name) instead of a browser link.
   */
  navigateFile?: (ref: string) => void;
}

const FALLBACK: StudioContextValue = {
  registry: createRegistry(),
  readOnly: false,
  tagFilter: [],
  showTeams: true,
  requestCommit: () => {},
};

export const StudioContext = createContext<StudioContextValue>(FALLBACK);

export function useStudio(): StudioContextValue {
  return useContext(StudioContext);
}

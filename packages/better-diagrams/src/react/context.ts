/**
 * context.ts — ambient state the custom node and edge renderers need.
 *
 * React Flow instantiates node/edge components itself, so they cannot receive
 * the registry as a prop. A context keeps the alternative — stuffing a copy of
 * the registry into every node's `data` — out of the serialised document.
 */
import type { Notation } from "../contract/schema";
import { createContext, useContext } from "react";
import { createRegistry } from "./create-registry";
import type { ZoneBox } from "../contract/schema";
import type { FieldRef } from "../contract/fields";
import type { ResolvedRegistry } from "./registry-types";
import type { StudioMode } from "./theme";

export interface StudioContextValue {
  registry: ResolvedRegistry;
  /** Editing is disabled; renderers hide affordances and block inline edits. */
  readOnly: boolean;
  /**
   * The presentation mode (see `StudioMode`). Renderers read it for the few
   * things a stylesheet cannot decide — an SVG icon's pixel size, a gradient
   * definition — and never for behaviour: both modes have every capability.
   */
  mode: StudioMode;
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
   * Render the ↗ link affix on nodes that carry a `url`. The same kind of
   * view preference as the team badges: the links stay in the document, so
   * exports and the inspector still have them — only the canvas stops
   * wearing them, which a hundred imported tables can be glad of.
   */
  showLinks: boolean;
  /**
   * Ask the editor to record the current state — an undo point plus onChange.
   * Node renderers mutate state directly via updateNodeData/setNodes (inline
   * annotation editing, polygon vertex drags, resizes); without calling this
   * afterwards those edits are invisible to undo and to a controlled host
   * until some unrelated action commits.
   */
  requestCommit: () => void;
  /**
   * Zone-resize gesture, two-phase because the editor derives the document
   * every drag frame and re-judges zone membership against the mid-drag box:
   * `begin` captures the membership to scale, `end` scales those members
   * proportionally into the new box and commits once.
   */
  beginZoneResize: (zoneId: string, box: ZoneBox) => void;
  endZoneResize: (zoneId: string, box: ZoneBox) => void;
  /**
   * Present when the host supports cross-file navigation. A node whose `url`
   * uses the `file:` prefix renders its ↗ affix as a jump to that file
   * (resolved by the host — id first, then name) instead of a browser link.
   */
  navigateFile?: (ref: string) => void;
  /**
   * The drill-in position: null at the root level (C1), else the focused
   * node and how deep it sits. Renderers use it to suppress affordances that
   * would corrupt a scoped view (a chip's expand toggle) and to label levels.
   */
  focus: { id: string; depth: number } | null;
  /** Step one level into a node — the drill badge and double-click land here. */
  drillInto: (id: string) => void;
  /** Jump to the level that shows a node — a ghost's "go to definition". */
  navigateToNode: (id: string) => void;
  /**
   * Direct-child counts by DOCUMENT node id — the drill badge's number.
   * Computed from the document, not the canvas, so a card's hidden detail
   * still counts.
   */
  childCounts: ReadonlyMap<string, number>;
  /**
   * The element whose NAME is open for editing on the canvas, or null.
   *
   * Renaming needed a gesture of its own: double-click is the drill gesture
   * and worth keeping (it is how an empty level is started), so F2 — and
   * Enter on a single selection — opens the name in place instead. Held here
   * rather than in each renderer because the trigger is a keystroke the
   * studio owns and the field belongs to the node.
   */
  renamingId: string | null;
  setRenamingId: (id: string | null) => void;
  /**
   * Say something in the editor's status strip.
   *
   * Renderers need it for the gestures they own: a refused bend, a drop that
   * did nothing. A gesture that silently declines reads as the editor being
   * broken, which is worse than the limit it is enforcing.
   */
  showToast: (message: string) => void;
  /**
   * A field row was clicked or right-clicked. Present when the editor offers
   * a field menu; absent, rows stay inert. Renderers report where the press
   * landed so the menu can open there.
   */
  onFieldClick?: (ref: FieldRef, at: { clientX: number; clientY: number }) => void;
  /** `fieldKey`s of the pinned fields — a pinned row wears a mark; a pinned TABLE (no field) marks the card. */
  pinnedFields: ReadonlySet<string>;
  /** `fieldKey`s of the rows the reader was just taken to — a search hit, a pin chip, or both halves of a followed reference. */
  highlightFields: ReadonlySet<string>;
  /**
   * When set, every node NOT in it renders dimmed — the path panel's
   * "outside the reachable set" view. Presentational like the tag filter
   * (dimmed, never hidden), and combined with it.
   */
  dimmedIds: ReadonlySet<string> | null;
  /**
   * How a line's ends draw their cardinality — the document's
   * `settings.notation`, "both" when it says nothing. See `NOTATIONS`.
   */
  notation: Notation;
}

const FALLBACK: StudioContextValue = {
  registry: createRegistry(),
  readOnly: false,
  mode: "technical",
  tagFilter: [],
  showTeams: true,
  showLinks: true,
  requestCommit: () => {},
  beginZoneResize: () => {},
  endZoneResize: () => {},
  focus: null,
  drillInto: () => {},
  navigateToNode: () => {},
  childCounts: new Map(),
  renamingId: null,
  setRenamingId: () => {},
  showToast: () => {},
  pinnedFields: new Set(),
  highlightFields: new Set(),
  dimmedIds: null,
  notation: "both",
};

export const StudioContext = createContext<StudioContextValue>(FALLBACK);

export function useStudio(): StudioContextValue {
  return useContext(StudioContext);
}

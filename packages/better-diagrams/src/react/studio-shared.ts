/**
 * studio-shared.ts — the few definitions the architecture editor and its
 * inspectors (studio-inspectors.tsx) both read.
 */
import type { DiagramEdgeData, DiagramNodeData } from "../contract/schema";

/**
 * Which edge (or centreline) a selection lines up on. Named because three
 * places spell it — the keyboard chords, the Arrange menu and the multi-select
 * inspector — and a union repeated three times drifts.
 */
export type AlignMode = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";
/**
 * Whether a canvas node is pinned.
 *
 * Zone nodes carry their document under `data.zone`, every other kind spreads
 * its fields onto `data` directly — so a bare `data.locked` reads `undefined`
 * for every zone, and a locked region could still be nudged with the arrows
 * while ⌘⇧L could only ever re-lock it.
 */
export function isNodeLocked(node: { data?: unknown } | undefined | null): boolean {
  const data = node?.data as { locked?: boolean; zone?: { locked?: boolean } } | undefined;
  return !!(data?.zone ? data.zone.locked : data?.locked);
}
/**
 * What an inspector writes: the fields to set, or a function of the element's
 * current data producing them — for edits like "add this tag to whatever
 * each node already has" that a fixed object cannot express across a
 * selection.
 */
export type NodePatch = Partial<DiagramNodeData> | ((data: DiagramNodeData) => Partial<DiagramNodeData>);
export type EdgePatch = Partial<DiagramEdgeData> | ((data: DiagramEdgeData) => Partial<DiagramEdgeData>);

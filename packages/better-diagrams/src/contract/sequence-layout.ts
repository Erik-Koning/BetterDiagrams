/**
 * sequence-layout.ts — the coordinate model of a sequence diagram.
 *
 * Pure numeric helpers shared by the editor, the adapters, and the image
 * exporter, so a message row or a lifeline sits at the same y everywhere.
 *
 * The document stores NO coordinates: participant column = array order,
 * message time = array order. These helpers translate order to geometry
 * (`slotX`, `rowY`) and geometry back to order (`messageRowAt`) — the round
 * trip is exact, which is what makes the editor's inverse adapter total.
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** Left margin before the first participant column. */
export const MARGIN_X = 60;
/** Distance between participant column origins. */
export const COLUMN_SPACING = 200;
/** Participant header box. */
export const HEADER_W = 160;
export const HEADER_H = 48;
/** y of the first message row. */
export const FIRST_MSG_Y = 128;
/** Vertical distance between message rows. */
export const ROW_HEIGHT = 44;
/** Activation bar width, and how far a bar overhangs its first/last row. */
export const BAR_W = 12;
export const BAR_OVERHANG = 12;
export const MIN_BAR_H = 24;
/** Horizontal padding a fragment frame adds around its covered columns. */
export const FRAG_PAD_X = 24;
/** Height of a fragment's label tab row above its first covered message. */
export const FRAG_HEAD_H = 26;
/** Space below the last row before lifelines end. */
export const BOTTOM_PAD = 64;
/** Horizontal extent of a self-message loop to the right of the lifeline. */
export const SELF_LOOP_W = 56;

// ── Order ↔ geometry ─────────────────────────────────────────────────────────

/** Left edge of the participant header in column `order`. */
export const slotX = (order: number): number => MARGIN_X + order * COLUMN_SPACING;

/** The lifeline's x — centre of the participant column. */
export const lifelineX = (order: number): number => slotX(order) + HEADER_W / 2;

/** y of message row `index`. */
export const rowY = (index: number): number => FIRST_MSG_Y + index * ROW_HEIGHT;

/** Nearest message row for a y — exact inverse of `rowY` at row centres. */
export const messageRowAt = (y: number): number =>
  Math.max(0, Math.round((y - FIRST_MSG_Y) / ROW_HEIGHT));

/** Column order for an x — exact inverse of `slotX` at column origins. */
export const columnAt = (x: number): number =>
  Math.max(0, Math.round((x - MARGIN_X) / COLUMN_SPACING));

/** Total lifeline extent for a diagram with `messageCount` rows. */
export function diagramHeight(messageCount: number): number {
  return FIRST_MSG_Y + Math.max(messageCount, 1) * ROW_HEIGHT + BOTTOM_PAD;
}

/**
 * Stable ascending sort by a coordinate. `Array.prototype.sort` is stable, so
 * items already in coordinate order keep their relative order — applying this
 * twice equals applying it once, which the commit path relies on.
 */
export function orderByCoordinate<T>(items: readonly T[], coord: (item: T) => number): T[] {
  return [...items].sort((a, b) => coord(a) - coord(b));
}

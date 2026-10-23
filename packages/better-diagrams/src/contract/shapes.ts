/**
 * shapes.ts — how far each node silhouette eats into its box.
 *
 * The outlines themselves are SVG paths drawn by `react/shapes.ts`. What lives
 * here is the part validation needs as well: the room each shape leaves for
 * text. A wrapped card's height is measured inside that room
 * (`wrappedNodeHeight`), so validation, the canvas and the exporters must all
 * read the same numbers — and the contract may not import from `react/`.
 */

/** Every node silhouette, C4-style: shape conveys the element's nature at a glance. */
export const NODE_SHAPES = ["card", "person", "cylinder", "pipe", "diamond", "parallelogram"] as const;
/** Node silhouette — what a kind draws as (`NodeKindDef.shape`); `card` is the plain box. */
export type NodeShape = (typeof NODE_SHAPES)[number];

/** Room a shape's outline takes from its box, on top of the card's own padding. */
export interface ShapeInsets {
  /** Extra top inset the node content needs to clear the shape. */
  top: number;
  /**
   * Extra bottom inset, for a shape that narrows at the foot as well as the
   * head. Centred text sits midway between the two insets, so a shape that
   * set only `top` would centre its label below its middle.
   */
  bottom: number;
  /** Extra horizontal inset, each side (a pipe's rounded ends eat into the box). */
  inline: number;
}

/** The actor's head, sized against both axes so squat or narrow nodes stay plausible. */
export function personHeadRadius(w: number, h: number): number {
  return Math.min(13, h * 0.24, w * 0.16);
}

/** A cylinder's lid: the half-height of its elliptical top. */
export function cylinderLidRadius(h: number): number {
  return Math.min(9, h * 0.14);
}

/**
 * A pipe's rounded ends: a half-circle on a box of an ordinary height. Held
 * to 40px, so a pipe grown tall for its text keeps straight sides rather than
 * becoming a capsule whose ends eat ever more of the text's width — and to
 * half the width, so the ends never pass each other.
 */
export function pipeEndRadius(w: number, h: number): number {
  return Math.min(h / 2, w / 2, 40);
}

/** How far a parallelogram's top edge is pushed right of its bottom one. */
export function parallelogramSkew(w: number): number {
  return Math.min(18, w * 0.16);
}

/**
 * The insets for a silhouette drawn at `w` × `h` — the outline's own size,
 * which the renderers draw 0.75px inside the node's box so the stroke stays
 * on it. Anything that is not a known shape is a card, with none.
 */
export function shapeInsets(shape: NodeShape, w: number, h: number): ShapeInsets {
  switch (shape) {
    case "person":
      return { top: personHeadRadius(w, h) * 1.1, bottom: 0, inline: 0 };
    case "cylinder":
      return { top: cylinderLidRadius(h) * 1.6, bottom: 0, inline: 0 };
    case "pipe":
      return { top: 0, bottom: 0, inline: pipeEndRadius(w, h) * 0.55 };
    case "diamond":
      // The corners are gone: keep the text in the middle band — inset the
      // same at the foot as at the head, or a centred label sits low.
      return { top: h * 0.16, bottom: h * 0.16, inline: w * 0.18 };
    case "parallelogram":
      return { top: 0, bottom: 0, inline: parallelogramSkew(w) * 0.7 };
    default:
      return { top: 0, bottom: 0, inline: 0 };
  }
}

/**
 * shapes.ts — C4-style node silhouettes, as SVG path data.
 *
 * One generator produces ABSOLUTE-coordinate paths for a given box, so the
 * on-screen node (viewBox sized to the node, 1:1 units — no stretch, no
 * distorted circles) and the Canvas2D/SVG exporters draw byte-identical
 * geometry. This is the same parity discipline as `floatingEdgeGeometry`.
 *
 * Shapes:
 *   card     — the default rounded rectangle (screen renders it in CSS; the
 *              path exists for the exporters)
 *   person   — C4 actor: head circle over a round-shouldered body
 *   cylinder — data store: elliptical lid over a barrel
 *   pipe     — queue/bus: stadium (fully rounded ends)
 */
import type { NodeShape } from "./registry-types";

export interface Silhouette {
  /** The filled+stroked outline. May contain multiple subpaths. */
  body: string;
  /** Optional stroke-only detail (the cylinder's inner lid arc). */
  detail?: string;
  /** Extra top inset the node content needs to clear the shape. */
  contentTop: number;
  /** Extra horizontal inset (the pipe's rounded ends eat into the box). */
  contentInlinePad: number;
}

export function silhouettePath(shape: NodeShape, x: number, y: number, w: number, h: number): Silhouette {
  switch (shape) {
    case "person": {
      // Head sized against both axes so squat or narrow nodes stay plausible.
      const headR = Math.min(13, h * 0.24, w * 0.16);
      const cx = x + w / 2;
      const bodyTop = y + headR * 1.55;
      const r = Math.min(10, (h - (bodyTop - y)) / 2);
      const body =
        `M ${x + r} ${bodyTop} ` +
        `H ${x + w - r} A ${r} ${r} 0 0 1 ${x + w} ${bodyTop + r} ` +
        `V ${y + h - r} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} ` +
        `H ${x + r} A ${r} ${r} 0 0 1 ${x} ${y + h - r} ` +
        `V ${bodyTop + r} A ${r} ${r} 0 0 1 ${x + r} ${bodyTop} Z ` +
        // Head as its own subpath — same fill, one shape to the eye.
        `M ${cx - headR} ${y + headR} A ${headR} ${headR} 0 1 1 ${cx + headR} ${y + headR} ` +
        `A ${headR} ${headR} 0 1 1 ${cx - headR} ${y + headR} Z`;
      return { body, contentTop: headR * 1.1, contentInlinePad: 0 };
    }
    case "cylinder": {
      const ry = Math.min(9, h * 0.14);
      const body =
        `M ${x} ${y + ry} A ${w / 2} ${ry} 0 0 1 ${x + w} ${y + ry} ` +
        `V ${y + h - ry} A ${w / 2} ${ry} 0 0 1 ${x} ${y + h - ry} Z`;
      // The lid's lower arc — the line that makes a cylinder read as one.
      const detail = `M ${x} ${y + ry} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + ry}`;
      return { body, detail, contentTop: ry * 1.6, contentInlinePad: 0 };
    }
    case "pipe": {
      const r = h / 2;
      const body =
        `M ${x + r} ${y} H ${x + w - r} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} ` +
        `H ${x + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`;
      return { body, contentTop: 0, contentInlinePad: r * 0.55 };
    }
    default: {
      const r = 8;
      const body =
        `M ${x + r} ${y} H ${x + w - r} A ${r} ${r} 0 0 1 ${x + w} ${y + r} ` +
        `V ${y + h - r} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} ` +
        `H ${x + r} A ${r} ${r} 0 0 1 ${x} ${y + h - r} ` +
        `V ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`;
      return { body, contentTop: 0, contentInlinePad: 0 };
    }
  }
}


/**
 * Horizontal offset of the seq badge from the label centre — one formula for
 * the screen, the canvas exporter, and the SVG exporter, so the badge sits in
 * the same place in all three. Approximate metrics (11px mono ≈ 6.4px/char)
 * beat exact-but-divergent ones: parity is the goal.
 */
export function seqBadgeOffset(label: string | undefined): number {
  return label ? (label.length * 6.4) / 2 + 14 : 0;
}

/**
 * Stable colour for a team name — hash the name to a hue, so "Payments" is
 * the same colour on every node, in every session, on screen and in exports,
 * with no registry to maintain. Saturation/lightness are pinned mid-range so
 * every hue stays readable on both the dark and light themes.
 */
export function teamColor(team: string): string {
  let h = 0;
  for (let i = 0; i < team.length; i++) h = (h * 31 + team.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 60% 55%)`;
}

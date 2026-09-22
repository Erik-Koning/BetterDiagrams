/**
 * draw.ts — the export renderer as ONE emitter and two thin backends.
 *
 * Previously the canvas and SVG exporters were hand-kept mirrors: every visual
 * change had to be made twice, and they drifted (three different seq-badge
 * offset formulas at one point). Now a single `emitTemplate` walks the diagram
 * once and produces draw commands; `drawToCanvas` and `drawToSvg` translate
 * them mechanically. A backend cannot drift from the other because neither
 * contains any layout or styling decisions.
 *
 * Text measurement is deliberately APPROXIMATE (fixed per-font width factors)
 * so the emitter needs no canvas context — identical wrapping everywhere
 * matters more than typographically exact wrapping somewhere.
 *
 * The emitter takes an `ExportPalette`, which is what makes light-mode exports
 * a parameter instead of a second renderer.
 */
import {
  absolutePosition,
  depthOf,
  closedContainers,
  hiddenByCollapse,
  templateBounds,
  visibleAnchor,
  visibleElements,
  COLLAPSED_SIZE,
  DEFAULT_CONTAINER_OPACITY,
  DEFAULT_ZONE_OPACITY,
  EDGE_COLOR_HEX,
  EDGE_DASH,
  DEFAULT_FONT_SIZE,
  FIELD_ROW_H,
  FIELD_TAG_HIDDEN,
  fieldTagBadge,
  fieldAnchors,
  fieldListTop,
  resolveRouting,
  type DiagramEdge,
  onlyEdgeBetween,
  stackLevels,
  uncrossFieldAnchors,
  withEndSlots,
  type DiagramNode,
  type DiagramTemplate,
} from "../contract/schema";
import { zoneChipRadius, zoneCornerRadius, zoneOutline, type DiagramZone } from "../contract/zones";
import { dateToDay, effectiveNodeDates, formatDiagramDate, isOverdue, laterDate, type DiagramDate } from "../contract/timeline";
import {
  crowsFootPath,
  edgeGeometryFor,
  edgeHeadPath,
  endLabelInset,
  endNotation,
  startAngle,
  tAtDistance,
  type Box,
} from "../contract/geometry";
import { seqBadgeOffset, silhouettePath, teamColor } from "./shapes";
import { kindDef, iconPaths, providerDef, relationDef, zoneInk, type ResolvedRegistry } from "./registry-types";
import { resolveStudioMode, type StudioMode } from "./theme";

export const PAD = 48;

/** The container frame's corner, and therefore its name chip's outer corner. */
const GROUP_RADIUS = 10;

export const GRID = 24;

/**
 * The legend box's size, and the height of the title block above the content.
 * They are constants because the page's reserved margins are computed from
 * them BEFORE anything is drawn — the chrome has to get real space, not paint
 * over the diagram in the padding.
 */
const LEGEND_W = 150;
const LEGEND_ROW_H = 18;
/**
 * The legend's own padding, the height its title row occupies, and how far the
 * whole box sits in from the page corner.
 *
 * They are named because they were not: the box was built from an 8 here and a
 * 26 there, which left 7px above "INFRASTRUCTURE" and 1px under the last row —
 * the bottom row's descenders sat ON the border — and pinned the box 8px from
 * a page edge everything else clears by 48. They also have to agree with
 * `legendH`, which is computed from them before anything is drawn.
 */
const LEGEND_PAD = 12;
const LEGEND_TITLE_H = 18;
const LEGEND_INSET = 16;
/** Between the infra key and the relationships key when the box shows both. */
const LEGEND_SECTION_GAP = 8;
const TITLE_BLOCK_H = 46;

/**
 * A note's line pitch, as a factor of its own font size: 1.4 is what
 * `.as-annotation` inherits from the editor root, 1.3 what its description
 * line sets. The export used a flat `size + 5`, which agreed with the canvas
 * at the default 13px and drifted badly at the large sizes notes are often set
 * in — a 26px note lost four points of leading per line.
 */
const ANNOTATION_LINE_HEIGHT = 1.4;
const ANNOTATION_DESC_LINE_HEIGHT = 1.3;

/**
 * A card's description, `.as-node__desc` in the stylesheet: 11px on a 1.25
 * line-height, clamped to two lines. The export drew it at 10.5px over four
 * lines when the node wrapped, so the same document read differently on screen
 * and in its own PNG.
 */
const DESC_FONT_SIZE = 11;
const DESC_LINE_H = Math.round(DESC_FONT_SIZE * 1.25);

// ─── Palette ─────────────────────────────────────────────────────────────────

export interface ExportPalette {
  /** Page background. */
  bg: string;
  /** Node/chip body base. */
  surface: string;
  /** Chip/label surfaces one step off the base. */
  surface2: string;
  /** Primary text. */
  text: string;
  /** Secondary text. */
  textDim: string;
  /** Tertiary text (counts, eyebrows). */
  textFaint: string;
  /** Hairlines. */
  border: string;
  /** Grid dots. */
  gridDot: string;
  /** Ink on accent-coloured chips (the seq badge number). */
  accentInk: string;
  /** Deprecated status text (salmon family). */
  warn?: string;
  /** Past-due date chips on not-yet-active elements (amber family). */
  overdue?: string;
  /**
   * Per-edge-colour overrides. An object, or a JSON string of one —
   * `paletteFromTheme` has to squeeze through a string map, so the emitters
   * accept either.
   */
  edgeColors?: Record<string, string> | string;
  /** Per-participant-kind accents for the sequence emitter. Same encoding. */
  seqAccents?: Record<string, string> | string;
  /**
   * Per-node-kind accents. Same encoding, and the same reason the other two
   * exist: the registry's hues were picked for the dark canvas and sit around
   * 2:1 on a white card, so a light export drew its kind eyebrows and icons in
   * colours the screen had already replaced.
   */
  nodeAccents?: Record<string, string> | string;
}

/** Normalize the record-or-JSON palette fields. */
export function paletteRecord(
  value: Record<string, string> | string | undefined,
): Record<string, string> | undefined {
  if (!value) return undefined;
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export const DARK_EXPORT_PALETTE: ExportPalette = {
  bg: "#0f172a",
  surface: "#0b1220",
  surface2: "#1e293b",
  text: "#e2e8f0",
  textDim: "#94a3b8",
  textFaint: "#64748b",
  border: "#334155",
  gridDot: "#1e293b",
  accentInk: "#04121f",
  warn: "#fa8072",
  overdue: "#f59e0b",
};

/** The light node-kind accents, mirroring LIGHT_THEME.nodeAccents. */
const LIGHT_NODE_ACCENTS: Record<string, string> = {
  service: "#0369a1",
  database: "#b45309",
  queue: "#6d28d9",
  gateway: "#047857",
  client: "#0e7490",
  external: "#334155",
  table: "#0f766e",
  group: "#475569",
  text: "#475569",
  point: "#475569",
  decision: "#a16207",
  terminator: "#15803d",
  io: "#0369a1",
  "lm-small": "#a21caf",
  "lm-medium": "#9333ea",
  llm: "#7e22ce",
};

export const LIGHT_EXPORT_PALETTE: ExportPalette = {
  bg: "#f8fafc",
  surface: "#ffffff",
  surface2: "#f1f5f9",
  text: "#0f172a",
  textDim: "#475569",
  textFaint: "#94a3b8",
  border: "#e2e8f0",
  gridDot: "#e2e8f0",
  accentInk: "#ffffff",
  // Kept in step with LIGHT_THEME by hand, because they are the same decision
  // made twice: a host passing `theme={LIGHT_THEME}` gets those values through
  // `paletteFromTheme`, and a host that exports without a theme gets these.
  // Drifting apart means two light exports of the same diagram with different
  // colours. Every hue below clears 4.5:1 on this background.
  warn: "#c2410c",
  overdue: "#b45309",
  edgeColors: { slate: "#475569", sky: "#0369a1", emerald: "#047857", amber: "#b45309", rose: "#be123c", violet: "#6d28d9" },
  seqAccents: { actor: "#475569", service: "#0369a1", database: "#b45309", queue: "#6d28d9", external: "#334155" },
  nodeAccents: LIGHT_NODE_ACCENTS,
};

// ─── Presentation mode ───────────────────────────────────────────────────────

/**
 * `color-mix(in srgb, a t%, b)`, by hand.
 *
 * The stylesheet builds every marketing paint out of that one operation, and
 * the export has no CSS engine to run it — so it runs here instead, against
 * the same numbers, which is what keeps a PNG the same picture as the screen.
 *
 * Only `#rrggbb` can be mixed. A host palette holding an `hsl()` or a named
 * colour comes back untouched rather than black: a flat card in the host's own
 * colour is a small loss, a black one is a broken export.
 */
function mix(a: string, b: string, t: number): string {
  const hex = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i;
  const ma = hex.exec(a.trim());
  const mb = hex.exec(b.trim());
  if (!ma || !mb) return a;
  const ch = (i: number) =>
    Math.round(Number.parseInt(ma[i], 16) * t + Number.parseInt(mb[i], 16) * (1 - t))
      .toString(16)
      .padStart(2, "0");
  return `#${ch(1)}${ch(2)}${ch(3)}`;
}

/** Is this palette a LIGHT one? Relative luminance of the page, nothing more. */
function isLightPalette(palette: ExportPalette): boolean {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(palette.bg.trim());
  if (!m) return false;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => Number.parseInt(h, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
}

/** A linear fade from `from` to `to`, its endpoints in the drawing's user space. */
export interface Gradient {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * What a mode dresses the drawing in — the export's half of the stylesheet's
 * "Marketing mode" section, with the same numbers in the same order.
 *
 * It exists as one resolved object rather than `mode === "marketing" ? … : …`
 * scattered down the emitter for the reason the CSS keeps its restyle in one
 * block: the two modes must differ in exactly the ways listed here and in no
 * others, and that is only checkable if the list is in one place.
 *
 * The light/dark split is read off the PALETTE, not passed in, because that is
 * the only thing an export actually knows — a host rendering a light PNG from
 * a headless script never mentions a theme.
 */
export interface Skin {
  marketing: boolean;
  /** Card corners, and the collapsed chip's and the boxed note's. */
  radius: number;
  /** Container frame corners. */
  groupRadius: number;
  /** Title size for a node that carries no `fontSize` of its own. */
  titleSize: number;
  /** Description size, its line pitch, and its ink. */
  descSize: number;
  descLineH: number;
  descColor: string;
  /** Does the kind eyebrow print its KIND, or only a lifecycle status? */
  kindEyebrow: boolean;
  /** The icon chip's box and corner. */
  iconBox: number;
  iconRadius: number;
  /** Edge stroke width, and whether its `[tech]` sub-label prints. */
  edgeWidth: number;
  edgeTech: boolean;
  /** Edge labels, cardinalities and end dates. */
  labelFont: "mono" | "sans";
  labelSize: number;
  labelColor: string;
  /** Record rows: the name's face and size, and whether types/marks print. */
  fieldFont: "mono" | "sans";
  fieldSize: number;
  fieldTypes: boolean;
  /** Chip furniture — dates, team pills, group names, zone headers. */
  chipFont: "mono" | "sans";
  /**
   * The card's own paints, for one accent over one box. Marketing names one
   * of `gradient` or `fill` (the flat coat `gradients: false` paints
   * instead); technical names neither, and each caller draws the accent wash
   * it always drew — see `cardFill`.
   *
   * A RECORD's gradient runs top-down over the header band instead of corner
   * to corner: its content is a column of rows, and a band that fades below
   * the title is what makes the header read as a header
   * (`.as-root--marketing .as-node--record`).
   */
  card(accent: string, box: Box, record?: boolean): {
    gradient?: Gradient;
    fill?: string;
    stroke: string;
    strokeWidth: number;
    shadow?: { color: string; alpha: number; blur: number; dy: number };
  };
  /** The icon chip's fill, and the ink its glyph is stroked in. */
  iconChip(accent: string, x: number, y: number, size: number): {
    gradient?: Gradient;
    fill?: string;
    fillAlpha?: number;
    stroke?: string;
    strokeAlpha?: number;
  };
  iconInk(accent: string): string;
}

/**
 * The fill a card paint asks for, dimmed to `dim` for a lifecycle status.
 * Technical's `card()` names no paint of its own: that branch is the per-site
 * wash of the accent (`wash` × dim) every caller drew before the skin existed.
 */
export function cardFill(
  paint: { gradient?: Gradient; fill?: string },
  accent: string,
  wash: number,
  dim = 1,
): Pick<Extract<DrawCmd, { op: "path" }>, "gradient" | "fill" | "fillAlpha"> {
  if (paint.gradient) return { gradient: paint.gradient, ...(dim < 1 ? { fillAlpha: dim } : {}) };
  if (paint.fill) return { fill: paint.fill, ...(dim < 1 ? { fillAlpha: dim } : {}) };
  return { fill: accent, fillAlpha: wash * dim };
}

/**
 * @param gradients Marketing's one setting: `false` paints every fade the
 *   mode draws as a flat coat at the fade's midpoint (the stylesheet's
 *   `--as-mk-flat`, the same 50/50 `color-mix()` of the same two ends), so a
 *   flat card carries the same weight of its kind's hue as the gradient did
 *   on average. Nothing else in the skin changes, and technical ignores it.
 */
export function makeSkin(mode: StudioMode, palette: ExportPalette, gradients = true): Skin {
  if (mode !== "marketing") {
    return {
      marketing: false,
      radius: 8,
      groupRadius: GROUP_RADIUS,
      titleSize: 13,
      descSize: DESC_FONT_SIZE,
      descLineH: DESC_LINE_H,
      descColor: palette.textDim,
      kindEyebrow: true,
      iconBox: 28,
      iconRadius: 7,
      edgeWidth: 1.8,
      edgeTech: true,
      labelFont: "mono",
      labelSize: 11,
      labelColor: palette.textDim,
      fieldFont: "mono",
      fieldSize: 10.5,
      fieldTypes: true,
      chipFont: "mono",
      card: (accent) => ({ stroke: accent, strokeWidth: 1.2 }),
      iconChip: (accent) => ({ fill: accent, fillAlpha: 0.13 }),
      iconInk: (accent) => accent,
    };
  }

  const light = isLightPalette(palette);
  // The stylesheet's `--as-mk-grad-from` / `--as-mk-grad-to` / `--as-mk-edge`,
  // both branches of each `light-dark()`.
  const gradFrom = (accent: string) => mix(accent, palette.surface, light ? 0.24 : 0.17);
  const gradTo = (accent: string) => mix(accent, palette.surface, light ? 0.07 : 0.04);
  const edge = (accent: string) => mix(accent, palette.border, light ? 0.48 : 0.34);
  // One paint that fades `from` → `to` between two points — or, with
  // gradients off, sits flat a quarter of the way from the pale end (the
  // stylesheet's `--as-mk-flat`): a whole card at the fade's average reads
  // heavier than the fade did. Every marketing fill goes through here, so
  // the setting cannot miss one.
  const fade = (from: string, to: string, x1: number, y1: number, x2: number, y2: number) =>
    gradients ? { gradient: { from, to, x1, y1, x2, y2 } } : { fill: mix(from, to, 0.25) };

  return {
    marketing: true,
    radius: 12,
    groupRadius: 16,
    titleSize: 16,
    descSize: 12,
    descLineH: Math.round(12 * 1.35),
    // `--as-mk-text`: secondary copy pulled off the chrome grey toward the
    // body ink, because a card's own description is read, not glanced past.
    descColor: mix(palette.textDim, palette.text, 0.45),
    kindEyebrow: false,
    iconBox: 36,
    iconRadius: 11,
    edgeWidth: 2.2,
    edgeTech: false,
    labelFont: "sans",
    labelSize: 13,
    labelColor: mix(palette.textDim, palette.text, 0.45),
    fieldFont: "sans",
    fieldSize: 11.5,
    fieldTypes: false,
    chipFont: "sans",
    card: (accent, box, record) => ({
      // 135deg: the CSS angle, which runs top-left to bottom-right. A
      // record's runs straight down and finishes at the 46px header band —
      // both backends pad past the last stop, so the rows below it sit on
      // the flat end colour, which is what the CSS's third stop says too.
      ...fade(
        gradFrom(accent),
        gradTo(accent),
        box.x,
        box.y,
        record ? box.x : box.x + box.width,
        record ? box.y + 46 : box.y + box.height,
      ),
      stroke: edge(accent),
      strokeWidth: 1.2,
      // CSS spreads this one in (`-18px` on a 30px blur) and adds a second
      // 1px contact shadow; a canvas shadow has no spread, so it is one
      // tighter, denser layer instead of two.
      shadow: { color: accent, alpha: light ? 0.34 : 0.3, blur: 18, dy: 7 },
    }),
    iconChip: (accent, x, y, size) =>
      light
        ? {
            // On a light page the chip is the PALE tile — laying more of the
            // kind's hue over an already-tinted card just washes the card
            // twice. See the same inversion in styles.css.
            ...fade(palette.surface, mix(accent, palette.surface, 0.12), x, y, x + size, y + size),
            stroke: mix(accent, palette.surface, 0.3),
            strokeAlpha: 1,
          }
        : {
            ...fade(mix(accent, gradFrom(accent), 0.26), mix(accent, gradTo(accent), 0.1), x, y, x + size, y + size),
            stroke: accent,
            strokeAlpha: 0.22,
          },
    // `--as-node-ink` at the mode's own 60% mix, and nearly the raw hue on a
    // light page where the glyph has a near-white tile under it.
    iconInk: (accent) => mix(accent, palette.text, light ? 0.88 : 0.6),
  };
}

// ─── Command set ─────────────────────────────────────────────────────────────

/**
 * Which document element a command belongs to, and when that element lands
 * (as an epoch day — see `dateToDay`). Stamped by the emitters; the canvas
 * backend ignores it, the SVG backend groups consecutive same-tag commands in
 * a `<g data-el data-day>` so the interactive HTML export can scrub elements
 * in and out client-side without re-rendering anything.
 */
export interface DrawTag {
  id: string;
  day?: number;
}

export type DrawCmd = RawDrawCmd & { tag?: DrawTag };

type RawDrawCmd =
  | {
      op: "path";
      d: string;
      fill?: string;
      fillAlpha?: number;
      /**
       * A linear gradient fill, its endpoints in the same user space as `d`.
       * Wins over `fill` when both are present, so a caller can pass the flat
       * colour as the fallback a reader without gradient support would want.
       * Marketing mode with gradients on is the only thing that emits one.
       */
      gradient?: Gradient;
      /**
       * A soft drop shadow under the shape — `dy` down, no horizontal offset,
       * which is every shadow this editor draws. The colour is a hex and the
       * alpha is separate because the two backends want it both ways round:
       * the canvas needs one `rgba()` string, SVG needs flood-color plus
       * flood-opacity.
       */
      shadow?: { color: string; alpha: number; blur: number; dy: number };
      stroke?: string;
      strokeAlpha?: number;
      strokeWidth?: number;
      dash?: number[];
      /** Round caps/joins — icon strokes want them. */
      round?: boolean;
      /** Applied before drawing: translate then uniform scale. */
      transform?: { tx: number; ty: number; scale: number };
    }
  | {
      op: "poly";
      /** SVG-style points string in local space. */
      points: string;
      fill: string;
      tx: number;
      ty: number;
      rotateDeg: number;
    }
  | { op: "circle"; cx: number; cy: number; r: number; fill: string; stroke?: string; strokeWidth?: number }
  | {
      op: "text";
      x: number;
      y: number;
      text: string;
      size: number;
      font: "mono" | "sans";
      color: string;
      alpha?: number;
      weight?: number;
      anchor?: "start" | "middle" | "end";
      /** Knock a bg-coloured rect out behind the text (edge labels over lines). */
      knockout?: { color: string; padX: number; height: number };
      /**
       * A halo stroked BEHIND the glyphs, the `paint-order: stroke` the canvas
       * uses on edge text. Unlike `knockout` it hugs the letters instead of
       * filling a box, which is what edge labels need now that they paint over
       * the cards they cross — a page-coloured rectangle on a node reads as a
       * hole punched in it.
       */
      halo?: { color: string; width: number };
    }
  | { op: "grid"; x: number; y: number; w: number; h: number; step: number; color: string };

// ─── Shared approximate text metrics ─────────────────────────────────────────

// These live in the contract because `validateTemplate` grows a wrapped node's
// height with the same measurement the renderer lays it out with. Re-exported
// here so the drawing code keeps reading as one module.
import { approxTextWidth, ellipsise, wrapText, wrappedLineCount } from "../contract/text";

export { approxTextWidth, ellipsise, wrapText, wrappedLineCount };

// ─── Small path builders ─────────────────────────────────────────────────────

export function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const rad = Math.min(r, w / 2, h / 2);
  return (
    `M ${x + rad} ${y} H ${x + w - rad} A ${rad} ${rad} 0 0 1 ${x + w} ${y + rad} ` +
    `V ${y + h - rad} A ${rad} ${rad} 0 0 1 ${x + w - rad} ${y + h} ` +
    `H ${x + rad} A ${rad} ${rad} 0 0 1 ${x} ${y + h - rad} ` +
    `V ${y + rad} A ${rad} ${rad} 0 0 1 ${x + rad} ${y} Z`
  );
}

/**
 * A rectangle with a radius per corner — CSS's `border-radius: a b c d`, in
 * path form.
 *
 * The label chips that sit ON a container's corner need this: the chip's
 * outer corner has to trace the SAME arc as the frame it overlaps, or the two
 * curves cross and the chip reads as a sticker that missed. A uniform radius
 * cannot express "10 here, square there, 6 on the inside corner", which is
 * exactly what those chips are (see .as-group__label / .as-zone__header).
 */
function roundedRectCorners(
  x: number,
  y: number,
  w: number,
  h: number,
  corners: { tl?: number; tr?: number; br?: number; bl?: number },
): string {
  const want = {
    tl: Math.max(0, corners.tl ?? 0),
    tr: Math.max(0, corners.tr ?? 0),
    br: Math.max(0, corners.br ?? 0),
    bl: Math.max(0, corners.bl ?? 0),
  };
  // CSS's own overlap rule: shrink ALL radii by one factor until no edge is
  // asked for more than its length. Capping each corner at half the box
  // instead would clip a deliberately large corner that its edge can afford —
  // an 18px corner on a 22px-tall chip is fine when the corner below it is
  // square, and that case is precisely the chip tracing a zone's boundary.
  const ratio = (edge: number, a: number, b: number) => (a + b > 0 ? edge / (a + b) : Infinity);
  const f = Math.min(
    1,
    ratio(w, want.tl, want.tr),
    ratio(w, want.bl, want.br),
    ratio(h, want.tl, want.bl),
    ratio(h, want.tr, want.br),
  );
  const tl = want.tl * f;
  const tr = want.tr * f;
  const br = want.br * f;
  const bl = want.bl * f;
  // A square corner needs no command at all: the previous H/V already left
  // the pen exactly there.
  const arc = (r: number, ex: number, ey: number) =>
    r > 0 ? `A ${r} ${r} 0 0 1 ${ex} ${ey} ` : "";
  return (
    `M ${x + tl} ${y} H ${x + w - tr} ` +
    arc(tr, x + w, y + tr) +
    `V ${y + h - br} ` +
    arc(br, x + w - br, y + h) +
    `H ${x + bl} ` +
    arc(bl, x, y + h - bl) +
    `V ${y + tl} ` +
    arc(tl, x + tl, y) +
    "Z"
  );
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
}

// ─── Lifecycle stage vocabulary ──────────────────────────────────────────────

/**
 * Outline dashes and body dimming per lifecycle stage — the export half of the
 * `.as-node--status-*` rules. Shared by leaf cards and container frames
 * because the stages mean the same thing on both: a group marked `planned`
 * reads as future work on screen, and used to come back as an ordinary frame
 * in the PNG.
 */
const STATUS_DASH: Record<string, number[]> = {
  proposed: [2, 3],
  planned: [6, 5],
  stubbed: [10, 4],
};

const STATUS_DIM: Record<string, number> = {
  deprecated: 0.55,
  retired: 0.4,
  dark: 0.65,
  stubbed: 0.85,
};

const statusDashOf = (status: string | undefined) => (status ? STATUS_DASH[status] : undefined);
const statusDimOf = (status: string | undefined) => (status ? STATUS_DIM[status] ?? 1 : 1);

// ─── Layout pass (visibility + collapse, shared with nothing else) ───────────

interface Placed {
  node: DiagramNode;
  box: Box;
  depth: number;
  /** Drawn as a chip — the node's own `collapsed`, or the document folding it. */
  chip: boolean;
}

interface Layout {
  placed: Placed[];
  byId: Map<string, Placed>;
  zones: DiagramZone[];
  edges: DiagramEdge[];
  legend: Array<{ provider: string; count: number }>;
  /** The relationship kinds the drawn edges carry, in document order of first use. */
  relations: Array<{ relation: string; count: number }>;
}

function layout(template: DiagramTemplate, containerKinds?: readonly string[]): Layout {
  const visible = visibleElements(template);
  const collapseHidden = hiddenByCollapse(template, { containerKinds });
  // Chips for the same two reasons the canvas draws them: a group's own flag,
  // or `settings.groupContents: "hide"` folding every group with contents.
  const closed = closedContainers(template, { containerKinds });
  const nodeById = new Map(template.nodes.map((n) => [n.id, n]));

  const placed = template.nodes
    .filter((n) => visible.nodes.has(n.id) && !collapseHidden.has(n.id))
    .map((node) => {
      const { x, y } = absolutePosition(node, nodeById);
      const chip = closed.has(node.id);
      const width = chip ? COLLAPSED_SIZE.w : node.w;
      const height = chip ? COLLAPSED_SIZE.h : node.h;
      return { node, box: { x, y, width, height }, depth: depthOf(node, nodeById), chip };
    });
  placed.sort((a, b) => a.depth - b.depth);
  const placedIds = new Set(placed.map((p) => p.node.id));

  const zones = [...(template.zones ?? [])].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  const counts = new Map<string, number>();
  for (const zone of zones) counts.set(zone.provider, (counts.get(zone.provider) ?? 0) + 1);

  // Same collapse re-routing as toReactFlow: edges into hidden contents attach
  // to the chip; parallels converge to one; internal wiring disappears.
  const rerouteSeen = new Set<string>();
  const shown = template.edges.filter((e) => visible.edges.has(e.id));
  // …including the rule about which re-routes keep their words: a lone edge
  // summarises nothing. Shared with the canvas so a PNG cannot say less than
  // the screen it was exported from.
  const alone = onlyEdgeBetween(shown, (id) => visibleAnchor(id, nodeById, collapseHidden));
  const edges = shown.flatMap((e) => {
      const source = visibleAnchor(e.source, nodeById, collapseHidden);
      const target = visibleAnchor(e.target, nodeById, collapseHidden);
      if (!placedIds.has(source) || !placedIds.has(target)) return [];
      const rerouted = source !== e.source || target !== e.target;
      // Both ends RE-ROUTED onto one box is the internal wiring of a collapsed
      // group and is not drawn. A loop the document actually states is a retry
      // arrow — the same distinction toReactFlow draws, so the screen and the
      // export agree about which loops exist.
      if (source === target && rerouted) return [];
      if (rerouted) {
        const key = `${source}→${target}`;
        if (rerouteSeen.has(key)) return [];
        rerouteSeen.add(key);
        const summarising = !alone(e);
        // Anchors/waypoints describe the ORIGINAL endpoints' boxes — the
        // canvas drops them on re-route (toReactFlow), so exports must too.
        return [
          {
            ...e,
            source,
            target,
            // A stand-in for several originals is none of them: no words,
            // no step, and no relationship KIND either — the same rule
            // toReactFlow applies, so the picture's key counts what the
            // canvas's does.
            ...(summarising ? { label: "", tech: undefined, seq: undefined, relation: undefined } : {}),
            start: undefined,
            end: undefined,
            points: undefined,
          },
        ];
      }
      return [e];
    });

  const relationCounts = new Map<string, number>();
  for (const e of edges) if (e.relation) relationCounts.set(e.relation, (relationCounts.get(e.relation) ?? 0) + 1);

  return {
    placed,
    byId: new Map(placed.map((p) => [p.node.id, p])),
    zones,
    edges,
    legend: [...counts.entries()].map(([provider, count]) => ({ provider, count })),
    relations: [...relationCounts.entries()].map(([relation, count]) => ({ relation, count })),
  };
}

const defaultRoutingOf = (template: DiagramTemplate) => resolveRouting(template.meta?.routing);

function zoneOutlineAbs(zone: DiagramZone): Array<[number, number]> | null {
  const outline = zoneOutline(zone);
  if (!outline) return null;
  return outline.map(([nx, ny]): [number, number] => [zone.x + nx * zone.w, zone.y + ny * zone.h]);
}

// ─── The emitter ─────────────────────────────────────────────────────────────

export interface Emitted {
  cmds: DrawCmd[];
  /** Content bounds including padding — the image size. */
  width: number;
  height: number;
  /** Translate content by this to land at the padded origin. */
  originX: number;
  originY: number;
}

/**
 * Every date an image or HTML export prints carries its year.
 *
 * The editor's chips drop it for the current year — the reader is looking at
 * the calendar it was written in. An exported artefact outlives that year: a
 * PNG in next year's slide deck saying "Mar 2" is ambiguous, and the file has
 * no way to say which March it meant. (Mermaid already did this.)
 */
/** Drawn height of a date chip — the pill, not its text. */
const DATE_CHIP_H = 15;

const exportDate = (date: DiagramDate | undefined) => formatDiagramDate(date, { year: "always" });

export interface EmitOptions {
  /**
   * Which presentation mode the editor is showing (see `StudioMode`). An
   * export has to say what the screen says: a deck exported out of marketing
   * mode that comes back in the technical dress is the one disagreement
   * between screen and file this module exists to prevent.
   */
  mode?: StudioMode;
  /**
   * Whether marketing paints its gradients (the default) or the flat coat
   * `gradients={false}` shows on screen. Off, no command carries a
   * `gradient`, so an SVG has no `<linearGradient>` and a canvas no
   * `createLinearGradient` — a file for a consumer that mangles either.
   * Ignored in technical, which never had one.
   */
  gradients?: boolean;
}

/**
 * What a HOST can say about a picture's dress — the same two settings, with
 * `mode` a loose string rather than `StudioMode`, because the value a host
 * has is the one it threaded in from a query string or a saved preference.
 * `emitOptions` coerces it: anything unrecognised resolves to technical
 * rather than half-applying a look, and gradients are on unless said not.
 */
export interface PictureOptions {
  mode?: string;
  gradients?: boolean;
}

export function emitOptions(opts: PictureOptions): EmitOptions {
  return { mode: resolveStudioMode(opts.mode), gradients: opts.gradients !== false };
}

export function emitTemplate(
  template: DiagramTemplate,
  registry: ResolvedRegistry,
  paletteOverride: Partial<ExportPalette> = {},
  opts: EmitOptions = {},
): Emitted {
  const palette: ExportPalette = { ...DARK_EXPORT_PALETTE, ...paletteOverride };
  const skin = makeSkin(resolveStudioMode(opts.mode), palette, opts.gradients !== false);
  // Fixed-hex palettes re-resolve per theme: a light export darkens the edge
  // colours the same way the canvas's CSS variables do.
  const edgeHex = { ...EDGE_COLOR_HEX, ...paletteRecord(palette.edgeColors) };
  const { placed, byId, zones, edges, legend, relations: relationsUsed } = layout(template, registry.containerKinds);
  // The same order the canvas legend lists them in: the registry's, then
  // whatever the document names that nobody registered.
  const relations = [
    ...registry.relationOrder.filter((id) => relationsUsed.some((r) => r.relation === id)),
    ...relationsUsed.map((r) => r.relation).filter((id) => !registry.relationOrder.includes(id)),
  ].map((id) => ({ relation: id, count: relationsUsed.find((r) => r.relation === id)!.count }));
  const b = templateBounds(template, { onlyVisible: true, containerKinds: registry.containerKinds });

  // The page's chrome — legend, title block, version tag — is drawn in
  // RESERVED margin rather than over the drawing. A 150px legend box inside a
  // 48px pad lands on whatever occupies the top-right corner, and a version
  // tag stacked under a title block lands inside the content: both were
  // verified sitting on the example's region border and its "Cloud Region"
  // header. Growing the page is the only way an export carries all of it.
  const tag = template.meta?.versionTag ? String(template.meta.versionTag) : "";
  const tagPos = template.meta?.versionTagPosition ?? "top-left";
  const tagW = tag ? approxTextWidth(tag, 10, skin.chipFont) + 20 : 0;
  // One box for both keys — the infra providers, then the relationship kinds
  // — with a title row per section it shows and a gap between two.
  const legendSections = (legend.length ? 1 : 0) + (relations.length ? 1 : 0);
  const legendH = legendSections
    ? LEGEND_PAD * 2 +
      legendSections * LEGEND_TITLE_H +
      (legend.length + relations.length) * LEGEND_ROW_H +
      (legendSections > 1 ? LEGEND_SECTION_GAP : 0)
    : 0;
  // A top-right tag shares the corner with the legend, so it queues below it.
  const tagOffsetY =
    tagPos === "top-left" ? (template.meta?.title ? TITLE_BLOCK_H : 0) : legendH ? legendH + 8 : 0;
  const padTop = Math.max(
    PAD,
    template.meta?.title ? TITLE_BLOCK_H : 0,
    // The legend's own headroom. Without this term a legend taller than the
    // 48px pad hung down INTO the drawing — the very thing the comment above
    // says reserving the margin was for — and a five-provider document painted
    // its key over whatever was in the top-right corner.
    legendH ? LEGEND_INSET * 2 + legendH : 0,
    tag && tagPos.startsWith("top") ? 10 + tagOffsetY + 20 + 8 : 0,
  );
  const padRight =
    Math.max(PAD, tag && tagPos.endsWith("right") ? tagW + 20 : 0) +
    (legendSections ? LEGEND_W + LEGEND_INSET : 0);
  const width = Math.max(1, b.maxX - b.minX + PAD + padRight);
  const height = Math.max(1, b.maxY - b.minY + padTop + PAD);
  const cmds: DrawCmd[] = [];

  // Effective landing days, for tagging: nodes after the containment cascade,
  // edges never earlier than either endpoint — the same rules the editor's
  // scrubber applies, resolved here so a viewer only ever compares numbers.
  const nodeDates = effectiveNodeDates(template);
  const dayOf = (date?: string) => (date ? dateToDay(date) : undefined);
  /** Stamp everything pushed since `start` as belonging to one element. */
  const stamp = (start: number, id: string, day?: number) => {
    for (let i = start; i < cmds.length; i++) cmds[i].tag ??= { id, ...(day !== undefined ? { day } : {}) };
  };

  /**
   * Stacking bands — the export half of the canvas z-index policy (see
   * STACK_BAND). A node sitting ON another node — inside its box, or
   * overlapping most of it — paints in a later band, and so do the edges
   * attached to it, so a stacked card is never visible with its own wiring
   * buried under the card it sits on. Container
   * frames are excluded: they are the band edges already travel over, so
   * nesting in a group lifts nothing.
   *
   * Commands are emitted in one pass and MOVED afterwards rather than the
   * loops running once per band: each element's commands are the contiguous
   * tail of `cmds` at the moment it finishes (that is what `stamp` relies on
   * too), so splicing that tail into a bucket costs one line per element and
   * keeps every tag with the command it belongs to.
   */
  /**
   * A node's accent: its own colour, else the palette's value for its kind,
   * else the registry's. Same precedence the canvas uses, so a light export
   * draws the eyebrows and icons the screen was showing rather than the
   * dark-canvas hues the registry keeps as its fallback.
   */
  const paletteAccents = paletteRecord(palette.nodeAccents);
  const accentOf = (node: { kind: string; color?: string }, fallback: string) =>
    node.color || paletteAccents?.[node.kind] || fallback;

  const levels = stackLevels(
    placed
      .filter(({ node, chip }) => {
        const def = kindDef(registry, node.kind);
        return !def.container || chip;
      })
      .map(({ node, box }) => ({ id: node.id, box })),
  );
  const bandOf = (id: string) => levels.get(id) ?? 0;
  const deferred = new Map<number, DrawCmd[]>();
  /** Edge text, held back for the final pass — nothing may cover a label. */
  const labelCmds: DrawCmd[] = [];
  const defer = (band: number, start: number) => {
    if (band <= 0) return;
    const chunk = cmds.splice(start);
    const bucket = deferred.get(band);
    if (bucket) bucket.push(...chunk);
    else deferred.set(band, chunk);
  };
  /** Stamp a leaf and file it under its band — every exit of the leaf loop. */
  const endLeaf = (start: number, node: DiagramNode) => {
    stamp(start, `node:${node.id}`, dayOf(nodeDates.get(node.id)));
    defer(bandOf(node.id), start);
  };

  // Background + dot grid.
  cmds.push({
    op: "path",
    d: `M ${b.minX - PAD} ${b.minY - padTop} h ${width} v ${height} h ${-width} Z`,
    fill: palette.bg,
  });
  cmds.push({
    op: "grid",
    x: Math.floor((b.minX - PAD) / GRID) * GRID,
    y: Math.floor((b.minY - padTop) / GRID) * GRID,
    w: width + GRID,
    h: height + GRID,
    step: GRID,
    color: palette.gridDot,
  });

  // Zones, back to front. The ink (override or provider colour) mirrors what
  // the canvas paints — see zoneInk; the fill is the same colour tinted.
  for (const zone of zones) {
    const zoneStart = cmds.length;
    const def = providerDef(registry, zone.provider);
    const ink = zoneInk(registry, zone);
    const alpha = zone.opacity ?? DEFAULT_ZONE_OPACITY;
    const outlined = zone.outline !== "none";
    const filled = zone.fill !== false;
    const polygon = zoneOutlineAbs(zone);
    const d =
      zone.shape === "ellipse"
        ? ellipsePath(zone.x + zone.w / 2, zone.y + zone.h / 2, zone.w / 2, zone.h / 2)
        : polygon
          ? `M ${polygon.map(([px, py]) => `${px} ${py}`).join(" L ")} Z`
          : roundedRectPath(zone.x, zone.y, zone.w, zone.h, zoneCornerRadius(zone.shape));
    // No outline AND no fill leaves nothing to draw — skip rather than emit a
    // no-op path that would pollute the HTML player's tagged groups.
    if (outlined || filled) {
      cmds.push({
        op: "path",
        d,
        ...(filled ? { fill: ink, fillAlpha: alpha } : {}),
        ...(outlined
          ? {
              stroke: ink,
              strokeAlpha: 0.75,
              strokeWidth: 1.5,
              // Same dash tables the canvas CSS uses, so the outline in a PNG
              // is the outline on screen.
              ...(zone.outline === "dashed" || zone.outline === "dotted"
                ? { dash: EDGE_DASH[zone.outline] }
                : {}),
            }
          : {}),
      });
    }

    // The date rides inside the zone's own header chip rather than beside it,
    // so the chip's width formula stays the single source of its size. The
    // label keeps the PROVIDER's name — a recoloured zone is still hosted
    // where it is hosted.
    const label = `${zone.label}  ·  ${def.label}${
      zone.date ? `  ·  ${exportDate(zone.date)}` : ""
    }`;
    const chipW = approxTextWidth(label, skin.marketing ? 13 : 11, skin.chipFont) + 26;
    cmds.push({
      op: "path",
      // Same rule as the group chip: the outer corner is the zone's own, so
      // the header sits ON the boundary rather than beside it.
      d: roundedRectCorners(zone.x, zone.y, chipW, 22, { tl: zoneChipRadius(zone), br: 8 }),
      fill: ink,
      fillAlpha: 0.22,
      stroke: ink,
      strokeAlpha: 0.55,
      strokeWidth: 1,
    });
    // A 7px square at y+8 in technical, a 10px rounded one centred in the
    // 22px chip in marketing — the same swatch `.as-zone__swatch` grows into.
    const swatch = skin.marketing ? 10 : 7;
    cmds.push({ op: "path", d: roundedRectPath(zone.x + 8, zone.y + (skin.marketing ? 6 : 8), swatch, swatch, skin.marketing ? 3 : 1.5), fill: ink });
    cmds.push({ op: "text", x: zone.x + (skin.marketing ? 24 : 21), y: zone.y + 15, text: label, size: skin.marketing ? 13 : 11, font: skin.chipFont, weight: 600, color: palette.text });
    stamp(zoneStart, `zone:${zone.id}`, dayOf(zone.date));
  }

  // Date chip — the same outlined grey chip the editor renders (.as-date), so
  // "this lands in June" survives into the shared artefact rather than being
  // an editor-only affordance.
  // Marketing turns it into a sans pill (`.as-root--marketing .as-date`); the
  // width formula reads the mode's own face so the chip still fits its text.
  const DATE_SIZE = skin.marketing ? 10 : 9;
  const DATE_PAD = skin.marketing ? 7 : 6;
  const dateChipW = (date: string) =>
    approxTextWidth(exportDate(date), DATE_SIZE, skin.chipFont) + DATE_PAD * 2;
  const pushDateChip = (date: string, x: number, y: number, overdue = false) => {
    const text = exportDate(date);
    // Overdue — past date, element still pre-active — is the chip's one loud
    // moment: amber border and text, same as the editor.
    const ink = overdue ? (palette.overdue ?? "#f59e0b") : palette.textDim;
    const d = roundedRectPath(x, y, dateChipW(date), 15, skin.marketing ? 7.5 : 4);
    cmds.push({ op: "path", d, fill: palette.surface, fillAlpha: 0.7 });
    cmds.push({ op: "path", d, stroke: ink, strokeAlpha: overdue ? 0.65 : 0.4, strokeWidth: 1 });
    cmds.push({ op: "text", x: x + DATE_PAD, y: y + 11, text, size: DATE_SIZE, font: skin.chipFont, weight: 500, color: ink });
  };

  // Owning-team tag — the same pill the editor renders (see .as-node__team),
  // so ownership survives into the shared artefact.
  const teamPillW = (team: string) => approxTextWidth(team, 9, skin.chipFont) + 14;
  const pushTeamPill = (team: string, x: number, y: number) => {
    const c = teamColor(team);
    const d = roundedRectPath(x, y, teamPillW(team), 16, 8);
    cmds.push({ op: "path", d, fill: palette.surface });
    cmds.push({ op: "path", d, fill: c, fillAlpha: 0.14, stroke: c, strokeAlpha: 0.55, strokeWidth: 1 });
    cmds.push({ op: "text", x: x + 7, y: y + 11.5, text: team, size: 9, font: skin.chipFont, weight: 600, color: c });
  };

  // Expanded container boundaries. Collapsed chips paint later, with the
  // leaves — they are solid cards, and edges travel under cards, not over.
  for (const { node, box, chip } of placed) {
    const def = kindDef(registry, node.kind);
    if (!def.container || chip) continue;
    const nodeStart = cmds.length;
    // Frame styling, resolved exactly as GroupNode resolves it for the canvas
    // — the ink is the stored colour (or the kind accent), the fill is derived
    // from it, and `fill: false` / `outline: "none"` each drop their layer. A
    // frame with neither is invisible in the export too, which is the point:
    // an abstract grouping box must not reappear in the PNG.
    const frameInk = accentOf(node, def.accent);
    const frameTinted = !!node.color || node.opacity !== undefined;
    const frameOutline = node.outline ?? "dashed";
    // A lifecycle stage restyles the frame exactly as it restyles a card (see
    // .as-group.as-node--status-*): its dashes win over the frame's own, and
    // the whole boundary dims. `outline: "none"` still wins over both — the
    // canvas zeroes the border width there, so a deliberately invisible
    // grouping box stays invisible whatever stage it is at.
    const frameDim = statusDimOf(node.status);
    const frameDash =
      statusDashOf(node.status) ??
      (frameOutline === "dashed" ? [6, 5] : frameOutline === "dotted" ? [2, 4] : undefined);
    const frameD = roundedRectPath(box.x, box.y, box.width, box.height, skin.groupRadius);
    cmds.push({
      op: "path",
      d: frameD,
      // The default tint is the neutral surface wash groups have always used;
      // an ink-derived tint appears only once the node stores a colour.
      ...(node.fill === false
        ? {}
        : {
            fill: frameTinted ? frameInk : palette.surface2,
            fillAlpha: (node.opacity ?? DEFAULT_CONTAINER_OPACITY) * frameDim,
          }),
      ...(frameOutline === "none"
        ? {}
        : {
            stroke: frameInk,
            strokeWidth: 1.2,
            ...(frameDim < 1 ? { strokeAlpha: frameDim } : {}),
            ...(frameDash ? { dash: frameDash } : {}),
          }),
    });
    if (node.status === "dark" && frameOutline !== "none") {
      // Hazard tape, the group's own two-layer form: a black ring outside the
      // frame and white dashes on it (box-shadow + dashed border in the CSS).
      // Undimmed on purpose — "shipped but not switched on" IS the message.
      cmds.push({ op: "path", d: frameD, stroke: "#020617", strokeWidth: 3.5 });
      cmds.push({ op: "path", d: frameD, stroke: "#f8fafc", strokeWidth: 2, dash: [6, 6] });
    }
    // The stage's eyebrow, in the name chip rather than above the frame: a
    // boundary has no card body to hang one under, and the chip is where a
    // reader already looks for the group's name.
    const frameStatusText = node.status ? ` · ${node.status.toUpperCase()}` : "";
    const labelW = approxTextWidth(node.label, 11, skin.chipFont);
    const chipW = Math.max(60, labelW + approxTextWidth(frameStatusText, 11, skin.chipFont) + 18);
    cmds.push({
      op: "path",
      // border-radius: 10px 0 6px 0 — the top-left is the FRAME's radius, so
      // the two curves lie on top of each other instead of crossing.
      d: roundedRectCorners(box.x, box.y, chipW, 22, { tl: skin.groupRadius, br: skin.marketing ? 10 : 6 }),
      fill: palette.surface2,
      ...(frameDim < 1 ? { fillAlpha: frameDim } : {}),
    });
    cmds.push({ op: "text", x: box.x + 9, y: box.y + 15, text: node.label, size: 11, font: skin.chipFont, ...(skin.marketing ? { weight: 600 } : {}), color: skin.marketing ? palette.text : palette.textDim, ...(frameDim < 1 ? { alpha: frameDim } : {}) });
    if (frameStatusText) {
      cmds.push({
        op: "text",
        x: box.x + 9 + labelW,
        y: box.y + 15,
        text: frameStatusText,
        size: 11,
        font: skin.chipFont,
        // Same two-colour rule the leaf eyebrow uses: salmon for the stage
        // that means "on its way out", the element's own ink otherwise.
        color: node.status === "deprecated" ? palette.warn ?? "#fa8072" : frameInk,
        alpha: 0.9 * frameDim,
      });
    }
    // Beside the boundary's name chip, in the same order the editor's group
    // label renders them: date first, then the owning team.
    let cursor = box.x + chipW + 6;
    if (node.date) {
      pushDateChip(node.date, cursor, box.y + 4, isOverdue(node.date, node.status));
      cursor += dateChipW(node.date) + 6;
    }
    if (node.team) pushTeamPill(node.team, cursor, box.y + 3);
    stamp(nodeStart, `node:${node.id}`, dayOf(nodeDates.get(node.id)));
  }

  // Edges.
  const defaultRouting = defaultRoutingOf(template);
  // Field references resolve to row anchors here exactly as they do on the
  // canvas — same functions, so a foreign-key line lands on the same column
  // in the PNG as it does on screen, and the same pairs of lines trade rows
  // to keep from crossing.
  const anchorNode = ({ node, box }: Placed) => ({
    fields: node.fields,
    description: node.description,
    h: box.height,
    centerX: box.x + box.width / 2,
  });
  const endSlots = uncrossFieldAnchors(edges, (id) => {
    const p = byId.get(id);
    return p && { fields: p.node.fields, description: p.node.description, box: p.box };
  });
  for (const edge of edges) {
    const edgeStart = cmds.length;
    const s = byId.get(edge.source);
    const t = byId.get(edge.target);
    if (!s || !t) continue;
    const geo = edgeGeometryFor(edge.routing ?? defaultRouting, s.box, t.box, edge.labelT ?? 0.5, {
      ...withEndSlots(fieldAnchors(edge, anchorNode(s), anchorNode(t)), endSlots.get(edge.id)),
      points: edge.points,
    });
    const color = edgeHex[edge.color] ?? edgeHex.slate;
    const direction = edge.direction ?? "forward";

    cmds.push({ op: "path", d: geo.path, stroke: color, strokeWidth: skin.edgeWidth, dash: EDGE_DASH[edge.style], ...(skin.marketing ? { round: true } : {}) });
    // An end stating its cardinality draws the crow's-foot symbol instead of
    // an end glyph — the same rule the canvas applies, from the same parser.
    // Otherwise, the same glyph resolution as the canvas: `direction` decides
    // which ends carry one by default, startHead/endHead choose which.
    const startEnd = endNotation(edge.startLabel, template.settings?.notation);
    const endEnd = endNotation(edge.endLabel, template.settings?.notation);
    const startMarker = startEnd.marker;
    const endMarker = endEnd.marker;
    const endHead = edge.endHead ?? (direction !== "none" ? "arrow" : undefined);
    const startHead = edge.startHead ?? (direction === "both" ? "arrow" : undefined);
    if (endHead && !endMarker) {
      const glyph = edgeHeadPath(endHead, geo.tip, geo.angle);
      cmds.push(
        glyph.filled
          ? { op: "path", d: glyph.d, fill: color }
          : { op: "path", d: glyph.d, stroke: color, strokeWidth: skin.edgeWidth, round: true },
      );
    }
    if (startHead && !startMarker) {
      const glyph = edgeHeadPath(startHead, geo.at(0), startAngle(geo));
      cmds.push(
        glyph.filled
          ? { op: "path", d: glyph.d, fill: color }
          : { op: "path", d: glyph.d, stroke: color, strokeWidth: skin.edgeWidth, round: true },
      );
    }
    if (endMarker) {
      cmds.push({ op: "path", d: crowsFootPath(endMarker, geo.tip, geo.angle), stroke: color, strokeWidth: skin.edgeWidth, round: true });
    }
    if (startMarker) {
      cmds.push({ op: "path", d: crowsFootPath(startMarker, geo.at(0), startAngle(geo)), stroke: color, strokeWidth: skin.edgeWidth, round: true });
    }

    // Everything from here down is TEXT the edge carries, and it all paints
    // in the final pass — above every card, as it does on the canvas (see
    // .as-edge__labellayer). The commands stay contiguous so the whole run
    // can be moved in one splice below.
    const labelStart = cmds.length;
    if (edge.seq) {
      const cx = geo.label.x - seqBadgeOffset(edge.label);
      cmds.push({ op: "circle", cx, cy: geo.label.y - 9, r: 8, fill: color, stroke: palette.bg, strokeWidth: 1.5 });
      cmds.push({ op: "text", x: cx, y: geo.label.y - 5.6, text: String(edge.seq), size: 9, font: "mono", weight: 700, color: palette.accentInk, anchor: "middle" });
    }
    if (edge.label) {
      cmds.push({
        op: "text",
        x: geo.label.x + (edge.seq ? 6 : 0),
        y: geo.label.y - 4,
        text: edge.label,
        size: skin.labelSize,
        font: skin.labelFont,
        ...(skin.marketing ? { weight: 500 } : {}),
        color: skin.labelColor,
        anchor: "middle",
        halo: { color: palette.bg, width: 4 },
      });
    }
    // The technology sub-label is what marketing tucks away — the reader of a
    // slide does not need "[AMQP]" under "enqueue".
    if (edge.tech && skin.edgeTech) {
      cmds.push({
        op: "text",
        x: geo.label.x,
        y: geo.label.y + (edge.label ? 8 : -4),
        text: `[${edge.tech}]`,
        size: 9,
        font: "mono",
        color: palette.textDim,
        alpha: 0.8,
        anchor: "middle",
        halo: { color: palette.bg, width: 3 },
      });
    }
    // Cardinality, a fixed distance in from each box — near the end it
    // describes rather than wherever the middle label sits.
    for (const [text, fromEnd, marker] of [
      [startEnd.text, false, startMarker],
      [endEnd.text, true, endMarker],
    ] as const) {
      if (!text) continue;
      const at = geo.at(tAtDistance(geo, endLabelInset(marker), fromEnd));
      cmds.push({
        op: "text",
        x: at.x,
        y: at.y - 4,
        text,
        size: 10,
        font: skin.chipFont,
        weight: 600,
        color: palette.text,
        anchor: "middle",
        halo: { color: palette.bg, width: 3.5 },
      });
    }
    if (edge.date) {
      cmds.push({
        op: "text",
        x: geo.label.x,
        y: geo.label.y + (edge.label ? 8 : -4) + (edge.tech && skin.edgeTech ? 11 : 0),
        text: exportDate(edge.date),
        size: 9,
        font: skin.chipFont,
        color: palette.textDim,
        alpha: 0.7,
        anchor: "middle",
        halo: { color: palette.bg, width: 3 },
      });
    }
    stamp(
      edgeStart,
      `edge:${edge.id}`,
      dayOf(laterDate(edge.date, laterDate(nodeDates.get(edge.source), nodeDates.get(edge.target)))),
    );
    // Text first — it is the tail of this edge's commands, so lifting it out
    // leaves the line and its glyphs as the tail for the band splice below.
    labelCmds.push(...cmds.splice(labelStart));
    // The higher end wins: a line into a stacked node has to clear the card
    // that node sits on, or the node is visible and its wiring is not.
    defer(Math.max(bandOf(edge.source), bandOf(edge.target)), edgeStart);
  }

  // Leaves, annotations, and collapsed-container chips — everything edges
  // must pass under.
  for (const { node, box, chip } of placed) {
    const def = kindDef(registry, node.kind);
    if (def.container && !chip) continue;
    const leafStart = cmds.length;
    const accent = accentOf(node, def.accent);

    // A dangling-arrow endpoint: just the dot the canvas shows (.as-point__dot
    // — 7px, dim, on a bg ring), never a card. Its box still routed the edge.
    if (def.point) {
      cmds.push({
        op: "circle",
        cx: box.x + box.width / 2,
        cy: box.y + box.height / 2,
        r: 3.5,
        fill: palette.textDim,
        stroke: palette.bg,
        strokeWidth: 1,
      });
      endLeaf(leafStart, node);
      continue;
    }

    if (def.container) {
      // A collapsed group is a mini-card, so it takes the card's paints
      // (`.as-root--marketing .as-group-chip` shares them on the canvas too).
      const chipPaint = skin.card(accent, box);
      const d = roundedRectPath(box.x, box.y, box.width, box.height, skin.marketing ? skin.radius : 9);
      cmds.push({ op: "path", d, fill: palette.surface, ...(chipPaint.shadow ? { shadow: chipPaint.shadow } : {}) });
      cmds.push({
        op: "path",
        d,
        ...cardFill(chipPaint, accent, 0.1),
        stroke: chipPaint.stroke,
        strokeAlpha: skin.marketing ? 1 : 0.45,
        strokeWidth: 1,
      });
      cmds.push({
        op: "text",
        x: box.x + 10,
        y: box.y + box.height / 2 + 4,
        text: ellipsise(`▸ ${node.label}`, skin.marketing ? 13 : 11, skin.chipFont, box.width - 18),
        size: skin.marketing ? 13 : 11,
        font: skin.chipFont,
        weight: 600,
        color: palette.text,
      });
      if (node.date) pushDateChip(node.date, box.x + box.width - dateChipW(node.date) - 8, box.y + (box.height - 15) / 2, isOverdue(node.date, node.status));
      if (node.team) {
        const shift = node.date ? dateChipW(node.date) + 6 : 0;
        pushTeamPill(node.team, box.x + box.width - teamPillW(node.team) - 8 - shift, box.y + (box.height - 16) / 2);
      }
      endLeaf(leafStart, node);
      continue;
    }

    if (def.annotation) {
      const size = node.fontSize || 13;
      // Notes are boxed unless they opt out — matching `.as-annotation--boxed`.
      const boxed = !node.plain;
      const pad = boxed ? 9 : 4;
      if (boxed) {
        cmds.push({
          op: "path",
          d: roundedRectPath(box.x, box.y, box.width, box.height, skin.radius),
          fill: palette.surface,
          fillAlpha: skin.marketing ? 0.85 : 0.78,
          stroke: palette.border,
          strokeWidth: 1,
          ...(skin.marketing ? { shadow: { color: palette.text, alpha: 0.14, blur: 14, dy: 6 } } : {}),
        });
      }
      // `.as-annotation` inherits the editor root's 1.4 line-height and does
      // not clip (`overflow: visible`), so a note typed as four lines shows
      // four lines on screen however tall its box is. The export says the
      // same: no line cap, or `wrapText`'s hard newline breaks — the very
      // thing that makes a note read as the user typed it — would be silently
      // reflowed away by a height the canvas never enforced.
      const lineH = Math.round(size * ANNOTATION_LINE_HEIGHT);
      const lines = wrapText(node.label, size, "sans", box.width - pad * 2, Number.MAX_SAFE_INTEGER);
      const top = box.y + (boxed ? 6 : 0);
      lines.forEach((line, i) =>
        cmds.push({ op: "text", x: box.x + pad, y: top + size + i * lineH, text: line, size, font: "sans", color: palette.text }),
      );
      // The note's description, as a dim sub-line under its sentence —
      // .as-annotation__desc on the canvas, 0.85em of the note's own size at
      // its own tighter 1.3 line-height.
      const descSize = Math.max(9, Math.round(size * 0.85));
      const descLineH = Math.round(descSize * ANNOTATION_DESC_LINE_HEIGHT);
      const descLines = node.description
        ? wrapText(node.description, descSize, "sans", box.width - pad * 2, 3)
        : [];
      const descTop = top + lines.length * lineH + 3;
      descLines.forEach((line, i) =>
        cmds.push({
          op: "text",
          x: box.x + pad,
          y: descTop + descSize + i * descLineH,
          text: line,
          size: descSize,
          font: "sans",
          color: palette.textDim,
        }),
      );
      if (node.date) {
        // Under the last line of the note, and NOT clamped to the outline:
        // `.as-annotation` lets its content overflow (the chip lands past the
        // bottom edge on screen too), and clamping while the sentence runs on
        // would drop the chip into the middle of the words.
        pushDateChip(
          node.date,
          box.x + pad,
          (descLines.length ? descTop + descLines.length * descLineH : top + lines.length * lineH) + 2,
        );
      }
      endLeaf(leafStart, node);
      continue;
    }

    // Lifecycle status: outline style for not-built-yet, dimming for on-the-
    // way-out — the same conventions the editor's CSS applies. `stubbed` gets
    // the heavy construction dash; `dark` gets a hazard-tape ring on top.
    const status = node.status;
    const statusDash = statusDashOf(status);
    const dim = statusDimOf(status);

    const sil = silhouettePath(def.shape ?? "card", box.x + 0.75, box.y + 0.75, box.width - 1.5, box.height - 1.5, {
      radius: skin.radius,
    });
    const paint = skin.card(accent, box, !!node.fields?.length);
    // Base coat first, so a gradient with light stops still sits on the
    // surface rather than on the page. The shadow rides the base coat: it is
    // the SHAPE's shadow, and stacking it under both layers would double it.
    cmds.push({
      op: "path",
      d: sil.body,
      fill: palette.surface,
      ...(paint.shadow && dim >= 1 ? { shadow: paint.shadow } : {}),
    });
    cmds.push({
      op: "path",
      d: sil.body,
      // Technical washes the surface with 6% of the accent; marketing lays a
      // full gradient — or its flat coat — over it (`.as-root--marketing
      // .as-node`).
      ...cardFill(paint, accent, 0.06, dim),
      stroke: paint.stroke,
      strokeAlpha: (skin.marketing ? 1 : 0.4) * dim,
      strokeWidth: paint.strokeWidth,
      ...(statusDash ? { dash: statusDash } : {}),
    });
    if (sil.detail) cmds.push({ op: "path", d: sil.detail, stroke: accent, strokeAlpha: 0.35 * dim, strokeWidth: 1.2 });
    if (status === "dark") {
      // Black/white hazard tape: a black underlay with white dashes over it,
      // matching the editor's two-layer border. Undimmed on purpose — the
      // warning IS the point, whatever the body fades to.
      cmds.push({ op: "path", d: sil.body, stroke: "#020617", strokeWidth: 2.5 });
      cmds.push({ op: "path", d: sil.body, stroke: "#f8fafc", strokeWidth: 1.8, dash: [6, 6] });
    }

    const cTop = sil.contentTop;
    const icon = iconPaths(registry, node.icon);
    // The card's own padding and the flex gap either side of the icon chip —
    // `.as-node` is 6px/12px with a 10px gap, and marketing widens both.
    const chipInset = skin.marketing ? 14 : 12;
    const chipGap = skin.marketing ? 12 : 10;
    const textX = box.x + sil.contentInlinePad + (icon ? chipInset + skin.iconBox + chipGap : 14);
    const contentMidY = box.y + cTop + (box.height - cTop) / 2;
    // Icon and text share one flex line on the canvas, so the icon follows
    // the node's vertical alignment too — centred by default, pinned to the
    // padding edge when the text is (records included, which pin to the top).
    // Half the chip plus the card's top padding: where a pinned chip centres,
    // which moves with the chip's own size.
    const iconInset = 6 + skin.iconBox / 2;
    const iconMidY =
      node.fields?.length || node.textVAlign === "top"
        ? box.y + cTop + iconInset
        : node.textVAlign === "bottom"
          ? box.y + box.height - iconInset
          : contentMidY;
    if (icon) {
      const chipX = box.x + sil.contentInlinePad + chipInset;
      const chipY = iconMidY - skin.iconBox / 2;
      const glyph = skin.iconBox * (17 / 28);
      cmds.push({
        op: "path",
        d: roundedRectPath(chipX, chipY, skin.iconBox, skin.iconBox, skin.iconRadius),
        ...skin.iconChip(accent, chipX, chipY, skin.iconBox),
        ...(skin.marketing ? { strokeWidth: 1 } : {}),
      });
      for (const d of icon) {
        cmds.push({
          op: "path",
          d,
          stroke: skin.iconInk(accent),
          strokeWidth: 1.8,
          round: true,
          transform: {
            tx: chipX + (skin.iconBox - glyph) / 2,
            ty: chipY + (skin.iconBox - glyph) / 2,
            scale: glyph / 24,
          },
        });
      }
    }

    const textW = box.width - (textX - box.x) - 10;
    const kindText = def.label.toUpperCase();
    const statusText = status ? ` · ${status.toUpperCase()}` : "";

    // Text layout — mirrors the CSS classes ShapeNode applies, so an export
    // reproduces what the user arranged rather than a second interpretation.
    // `anchorX` is where a run of text is placed FROM; the anchor tells the
    // backend which end of the run that x refers to.
    // A node's own `fontSize` wins — that number is the author's, not the
    // mode's — but `validateTemplate` stamps every node with the DEFAULT size,
    // so "the author set one" means "set one that isn't the default". That is
    // the same test the canvas applies before it declares `--as-node-font`;
    // without it the marketing step never fired on any real document.
    //
    // `wrap` keeps the technical size in both modes for the reason the
    // stylesheet does (`.as-node--wrap .as-node__title`): the box's height was
    // MEASURED at 13px and holds exactly those lines.
    const authorSize = node.fontSize && node.fontSize !== DEFAULT_FONT_SIZE ? node.fontSize : undefined;
    const fontSize = authorSize ?? (skin.marketing && !node.wrap ? skin.titleSize : DEFAULT_FONT_SIZE);
    // Marketing tucks the kind away — the icon has already said it — and keeps
    // the row only for a lifecycle status, which the icon has not.
    const eyebrow = skin.kindEyebrow || !!status;
    const align = node.textAlign ?? "left";
    const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
    const anchorX = align === "center" ? textX + textW / 2 : align === "right" ? textX + textW : textX;
    const aligned = anchor === "start" ? {} : ({ anchor } as const);

    // A wrapped title takes as many lines as it needs; validateTemplate has
    // already grown the box to hold them, using this same measurement.
    const titleLines = node.wrap
      ? wrapText(node.label, fontSize, "sans", textW, Number.MAX_SAFE_INTEGER)
      : [ellipsise(node.label, fontSize, "sans", textW)];
    const lineH = Math.round(fontSize * 1.35);
    // What the extra lines push down: description, strike-through, everything
    // after the title.
    const titleOverflow = Math.max(0, titleLines.length - 1) * lineH;

    const rows = node.fields ?? [];
    // A node with rows holds its description to ONE line: the rows below are
    // placed by a shared formula, and a second line would shift every one of
    // them out from under its edge anchor.
    //
    // `wrap` lifts the two-line clamp on the canvas (.as-node--wrap
    // .as-node__desc), but validateTemplate only grows a node's height for its
    // TITLE — so the box, not the text, is what bounds it. Cap the wrapped
    // description at the lines that fit above the bottom edge; unbounded, a
    // long one prints straight through the silhouette.
    const descRoom = Math.max(
      1,
      Math.floor((box.height - cTop - 49 - titleOverflow) / skin.descLineH) + 1,
    );
    const descLines = node.description
      ? wrapText(node.description, skin.descSize, "sans", textW, rows.length ? 1 : node.wrap ? descRoom : 2)
      : [];

    // Vertical placement moves the whole text block inside the box.
    //
    // The offsets below (16 for the eyebrow, 31 for the title, 45+ for the
    // description) are measured from the TOP of the content area — `blockH`
    // is exactly where that block ends — so `top` is the un-shifted layout
    // and the other two push down into the slack beneath it. The canvas says
    // the same thing with one flex line: `.as-node` centres its children,
    // `--valign-top`/`--valign-bottom` swap that for flex-start/flex-end.
    //
    // Record nodes are excluded: their rows sit at offsets a field-anchored
    // edge also computes, so shifting them would leave every foreign-key line
    // pointing between columns. (The canvas agrees — .as-node--record pins to
    // the top.)
    // Baselines inside the content box. Technical's are the 16/31/45 this
    // emitter has always used; a marketing card with its eyebrow gone has to
    // close that row up, or the title floats where the eyebrow used to be —
    // the canvas closes it by having one fewer flex child.
    const TITLE_DY = eyebrow ? 31 : Math.round(fontSize * 1.2) + 2;
    const DESC_DY = TITLE_DY + 14;
    const blockH = DESC_DY + titleOverflow + descLines.length * skin.descLineH;
    const slack = Math.max(0, box.height - cTop - blockH);
    const vShift = rows.length
      ? 0
      : node.textVAlign === "top"
        ? 0
        : node.textVAlign === "bottom"
          ? slack
          : slack / 2;
    const ty = (offset: number) => box.y + cTop + offset + vShift;

    // The kind half of the eyebrow, dropped in marketing; the status half is
    // never dropped, in either mode.
    const eyebrowKind = skin.kindEyebrow ? kindText : "";
    const eyebrowSep = skin.kindEyebrow ? statusText : status ? status.toUpperCase() : "";
    const eyebrowFont = skin.marketing ? "sans" : "mono";
    if (eyebrow && status === "deprecated") {
      // The status token gets the editor's salmon; the node's own dimming
      // still applies through the shared alpha, exactly as opacity does on
      // the canvas. Centred/right-aligned nodes draw the eyebrow as one run so
      // the two halves can't drift apart under a non-start anchor.
      const eyebrowX = align === "left" ? textX : anchorX;
      if (eyebrowKind) {
        cmds.push({ op: "text", x: eyebrowX, y: ty(16), text: eyebrowKind, size: 9, font: eyebrowFont, color: accent, alpha: 0.8 * dim, ...aligned });
      }
      if (align === "left" || !eyebrowKind) {
        cmds.push({
          op: "text",
          x: eyebrowKind ? textX + approxTextWidth(eyebrowKind, 9, eyebrowFont) : eyebrowX,
          y: ty(16),
          text: eyebrowSep,
          size: 9,
          font: eyebrowFont,
          weight: skin.marketing ? 600 : undefined,
          color: palette.warn ?? "#fa8072",
          alpha: 0.8 * dim,
          ...(eyebrowKind ? {} : aligned),
        });
      }
    } else if (eyebrow) {
      cmds.push({ op: "text", x: anchorX, y: ty(16), text: eyebrowKind + eyebrowSep, size: 9, font: eyebrowFont, weight: skin.marketing ? 600 : undefined, color: accent, alpha: 0.8 * dim, ...aligned });
    }
    titleLines.forEach((line, i) =>
      cmds.push({ op: "text", x: anchorX, y: ty(TITLE_DY + i * lineH), text: line, size: fontSize, font: "sans", weight: 600, color: palette.text, ...aligned, ...(dim < 1 ? { alpha: dim } : {}) }),
    );
    if (status === "retired") {
      const strikeW = approxTextWidth(titleLines[0] ?? "", fontSize, "sans");
      const strikeX = align === "center" ? anchorX - strikeW / 2 : align === "right" ? anchorX - strikeW : textX;
      cmds.push({ op: "path", d: `M ${strikeX} ${ty(TITLE_DY - 4.5)} L ${strikeX + strikeW} ${ty(TITLE_DY - 4.5)}`, stroke: palette.text, strokeAlpha: dim, strokeWidth: 1 });
    }
    descLines.forEach((line, i) =>
      cmds.push({ op: "text", x: anchorX, y: ty(DESC_DY + titleOverflow + i * skin.descLineH), text: line, size: skin.descSize, font: "sans", color: skin.descColor, ...aligned, ...(dim < 1 ? { alpha: dim } : {}) }),
    );

    // Field rows — the same list the canvas draws, from the same metrics.
    const listTop = box.y + fieldListTop(!!node.description);
    if (rows.length) {
      const rightEdge = box.x + box.width - 10;
      cmds.push({
        op: "path",
        d: `M ${textX} ${listTop - 4} L ${rightEdge} ${listTop - 4}`,
        stroke: palette.border,
        strokeWidth: 1,
        strokeAlpha: dim,
      });
      rows.forEach((field, i) => {
        const rowTop = listTop + i * FIELD_ROW_H;
        // A hidden row prints quiet, as the canvas's `.as-node__field--hidden` does.
        const rowDim = field.tags?.includes(FIELD_TAG_HIDDEN) ? dim * 0.45 : dim;
        let nameX = textX;
        if (field.key) {
          const badge = field.key.toUpperCase();
          const badgeW = Math.max(20, approxTextWidth(badge, 8, "mono") + 6);
          const d = roundedRectPath(textX, rowTop + 3.5, badgeW, 12, 3);
          // A primary key identifies the record and carries the tint; a
          // foreign key only points elsewhere, so it stays an outline —
          // matching .as-node__fieldkey--pk in the stylesheet.
          if (field.key !== "fk") {
            cmds.push({ op: "path", d, fill: accent, fillAlpha: 0.18 * rowDim });
          }
          cmds.push({ op: "path", d, stroke: accent, strokeAlpha: 0.45 * rowDim, strokeWidth: 1 });
          cmds.push({
            op: "text",
            x: textX + (badgeW - approxTextWidth(badge, 8, "mono")) / 2,
            y: rowTop + 12.5,
            text: badge,
            size: 8,
            font: "mono",
            weight: 700,
            color: accent,
            ...(rowDim < 1 ? { alpha: rowDim } : {}),
          });
          nameX = textX + badgeW + 6;
        }
        // The type takes the right edge; the name gets whatever is left, so a
        // long column name ellipsises rather than running under its own type.
        // Marketing prints neither the type nor the required mark — both are
        // still in the document, the inspector and the JSON — so the name
        // takes the whole row (`.as-node__fieldtype`, `.as-node__fieldreq`).
        const typeText = skin.fieldTypes ? (field.type ?? "") : "";
        const typeW = typeText ? approxTextWidth(typeText, 9.5, "mono") : 0;
        // A unique column wears a small UQ badge after its name (the canvas's
        // `.as-node__fieldflag`), then one badge per row tag (`hidden` dims
        // instead), a derived one UML's leading slash. Marketing drops the
        // badges with the other marks.
        const flags = skin.fieldTypes
          ? [...(field.unique ? ["UQ"] : []), ...(field.tags ?? []).map(fieldTagBadge).filter((b): b is string => !!b)]
          : [];
        const flagWs = flags.map((text) => approxTextWidth(text, 8, "mono") + 6);
        const flagsW = flagWs.reduce((sum, w) => sum + w + 4, 0);
        const nameW = rightEdge - nameX - (typeW ? typeW + 8 : 0) - flagsW;
        const nameText = `${field.derived ? "/" : ""}${field.name}${field.required && skin.fieldTypes ? "*" : ""}`;
        const drawnName = ellipsise(nameText, skin.fieldSize, skin.fieldFont, nameW);
        cmds.push({
          op: "text",
          x: nameX,
          y: rowTop + 13,
          text: drawnName,
          size: skin.fieldSize,
          font: skin.fieldFont,
          color: palette.text,
          ...(rowDim < 1 ? { alpha: rowDim } : {}),
        });
        let fx = nameX + approxTextWidth(drawnName, skin.fieldSize, skin.fieldFont) + 4;
        flags.forEach((text, f) => {
          const flagW = flagWs[f]!;
          const d = roundedRectPath(fx, rowTop + 3.5, flagW, 12, 3);
          cmds.push({ op: "path", d, stroke: accent, strokeAlpha: 0.45 * rowDim, strokeWidth: 1 });
          cmds.push({
            op: "text",
            x: fx + 3,
            y: rowTop + 12.5,
            text,
            size: 8,
            font: "mono",
            weight: 700,
            color: accent,
            ...(rowDim < 1 ? { alpha: rowDim } : {}),
          });
          fx += flagW + 4;
        });
        if (typeText) {
          cmds.push({
            op: "text",
            x: rightEdge - typeW,
            y: rowTop + 13,
            text: typeText,
            size: 9.5,
            font: "mono",
            color: palette.textFaint,
            ...(rowDim < 1 ? { alpha: rowDim } : {}),
          });
        }
      });
    }

    let dateBottom = -Infinity;
    if (node.date) {
      // Stacked under whatever text the node ended up with — exactly where
      // the canvas puts it. Clamping it back inside a default-height box was
      // worse than letting it sit low: on a node whose description wrapped to
      // two lines the chip was pushed UP onto the second line and printed
      // over the words, while the canvas (which lets its content overflow the
      // card) showed both. An export that disagrees with the screen is the one
      // thing this emitter exists to prevent.
      const below = rows.length
        ? listTop + rows.length * FIELD_ROW_H + 2
        : ty(DESC_DY - 9 + descLines.length * skin.descLineH);
      pushDateChip(node.date, textX, below, isOverdue(node.date, node.status));
      dateBottom = below + DATE_CHIP_H;
    }
    // Bottom-right, riding the edge — mirrors the editor's placement, unless
    // the text ran long enough that the date chip is already there. Two pieces
    // of chrome printed on top of each other is worse than one sitting a few
    // pixels lower than the edge it usually rides.
    if (node.team) {
      pushTeamPill(
        node.team,
        box.x + box.width - teamPillW(node.team) - 6,
        Math.max(box.y + box.height - 8, dateBottom + 2),
      );
    }
    endLeaf(leafStart, node);
  }

  // Raised bands, in order — each bucket already holds its edges before its
  // leaves, because that is the order they were emitted in.
  for (const band of [...deferred.keys()].sort((a, b) => a - b)) {
    cmds.push(...deferred.get(band)!);
  }
  // Then every edge label, over all of it. Only the diagram's own chrome
  // (legend, title, version tag) paints after this.
  cmds.push(...labelCmds);

  // Legend — in the right-hand gutter reserved for it above, clear of the
  // drawing rather than on top of it.
  if (legendSections) {
    const rowH = LEGEND_ROW_H;
    const boxW = LEGEND_W;
    const boxH = legendH;
    const lx = b.maxX + padRight - boxW - LEGEND_INSET;
    const ly = b.minY - padTop + LEGEND_INSET;
    cmds.push({
      op: "path",
      d: roundedRectPath(lx, ly, boxW, boxH, skin.radius),
      fill: palette.surface,
      fillAlpha: 0.92,
      stroke: palette.border,
      strokeWidth: 1,
      ...(skin.marketing ? { shadow: { color: palette.text, alpha: 0.16, blur: 16, dy: 6 } } : {}),
    });
    // The title's baseline sits one cap-height below the pad; the rows start a
    // title-row below that, and the last one ends a full pad above the floor.
    // Anchored to the box's right pad, not placed at it: a three-digit
    // count drawn from that x ran out through the border.
    const countAt = (y: number, count: number) =>
      cmds.push({ op: "text", x: lx + boxW - LEGEND_PAD, y: y + 13, text: String(count), size: 10, font: skin.chipFont, color: palette.textFaint, anchor: "end" });
    let cursor = ly + LEGEND_PAD;
    if (legend.length) {
      cmds.push({ op: "text", x: lx + LEGEND_PAD, y: cursor + 9, text: "INFRASTRUCTURE", size: 9, font: skin.chipFont, weight: 600, color: palette.textDim });
      cursor += LEGEND_TITLE_H;
      for (const { provider, count } of legend) {
        const def = providerDef(registry, provider);
        cmds.push({ op: "path", d: roundedRectPath(lx + LEGEND_PAD, cursor + 3.5, 11, 11, skin.marketing ? 3 : 2), fill: def.color, fillAlpha: 0.3, stroke: def.color, strokeAlpha: 0.7, strokeWidth: 1 });
        cmds.push({ op: "text", x: lx + LEGEND_PAD + 18, y: cursor + 13, text: def.label, size: 11, font: "sans", color: palette.text });
        if (count > 1) countAt(cursor, count);
        cursor += rowH;
      }
      if (relations.length) cursor += LEGEND_SECTION_GAP;
    }
    // The relationships key: each kind's line drawn as the sample — its dash,
    // its colour, its end glyphs through the same head-path maths as the
    // real lines — so the PNG's key is the canvas legend's.
    if (relations.length) {
      cmds.push({ op: "text", x: lx + LEGEND_PAD, y: cursor + 9, text: "RELATIONSHIPS", size: 9, font: skin.chipFont, weight: 600, color: palette.textDim });
      cursor += LEGEND_TITLE_H;
      for (const { relation, count } of relations) {
        const def = relationDef(registry, relation);
        const ink = edgeHex[def.color] ?? edgeHex.slate;
        const x0 = lx + LEGEND_PAD;
        const y = cursor + 9;
        cmds.push({ op: "path", d: `M ${x0 + 1} ${y} H ${x0 + 31}`, stroke: ink, strokeWidth: skin.edgeWidth, dash: EDGE_DASH[def.style] });
        for (const glyph of [
          def.startHead ? edgeHeadPath(def.startHead, { x: x0 + 1, y }, Math.PI) : null,
          def.endHead ? edgeHeadPath(def.endHead, { x: x0 + 31, y }, 0) : null,
        ]) {
          if (!glyph) continue;
          cmds.push(
            glyph.filled
              ? { op: "path", d: glyph.d, fill: ink }
              : { op: "path", d: glyph.d, fill: palette.surface, stroke: ink, strokeWidth: 1.5, round: true },
          );
        }
        cmds.push({ op: "text", x: x0 + 38, y: cursor + 13, text: def.label, size: 11, font: "sans", color: palette.text });
        if (relations.length > 1 || count > 1) countAt(cursor, count);
        cursor += rowH;
      }
    }
  }

  // Title block — top-left, in the headroom reserved above the content.
  if (template.meta?.title) {
    cmds.push({ op: "text", x: b.minX - PAD + 10, y: b.minY - padTop + 24, text: String(template.meta.title), size: skin.marketing ? 17 : 15, font: "sans", weight: 700, color: palette.text });
    cmds.push({
      op: "text",
      x: b.minX - PAD + 10,
      y: b.minY - padTop + 40,
      text: `${placed.length} elements · ${edges.length} connections`,
      size: 10,
      font: "mono",
      color: palette.textFaint,
    });
  }

  // Version tag notice — pinned in its corner, same as the editor's chip, and
  // in margin the bounds above already made room for: it queues under the
  // title block on the left and under the legend on the right.
  if (tag) {
    const px = tagPos.endsWith("left") ? b.minX - PAD + 10 : b.maxX + padRight - tagW - 10;
    const py = tagPos.startsWith("top") ? b.minY - padTop + 10 + tagOffsetY : b.maxY + PAD - 30;
    cmds.push({ op: "path", d: roundedRectPath(px, py, tagW, 20, 10), fill: palette.surface, fillAlpha: 0.92, stroke: palette.border, strokeWidth: 1 });
    cmds.push({ op: "text", x: px + 10, y: py + 14, text: tag, size: 10, font: skin.chipFont, weight: 600, color: palette.textDim });
  }

  return { cmds, width, height, originX: -b.minX + PAD, originY: -b.minY + padTop };
}

// ─── Backends ────────────────────────────────────────────────────────────────

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const SANS = "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";
const fontOf = (font: "mono" | "sans") => (font === "mono" ? MONO : SANS);

/**
 * Set `ctx` up to paint `color` at `alpha`, and return the style to assign.
 *
 * `#rrggbb` folds into an `rgba()` string. Anything else — an `hsl()` from a
 * host's palette, a named colour — keeps its own form and gets the alpha
 * through `globalAlpha` instead. The alternative, returning the colour
 * untouched, is how a 14%-tinted team pill came to paint at full strength
 * with its own label invisible inside it: SVG honoured `fill-opacity` and the
 * canvas silently did not, so one document exported as two different pictures.
 *
 * Always writes `globalAlpha`, including the opaque case, because a path fills
 * and then strokes inside one save/restore and the second must not inherit the
 * first's transparency.
 */
/**
 * `#rrggbb` + alpha as an `rgba()` string, for the two places that need the
 * alpha INSIDE the colour rather than as a separate channel: the canvas
 * `shadowColor` (which has no alpha of its own) and SVG's flood-color. A
 * colour that is not a hex comes back untouched and takes the alpha it was
 * already carrying.
 */
function rgba(color: string, alpha: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color.trim());
  if (!m) return color;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => Number.parseInt(h, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function withAlpha(ctx: CanvasRenderingContext2D, color: string, alpha: number | undefined): string {
  ctx.globalAlpha = 1;
  if (alpha === undefined || alpha >= 1) return color;
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color.trim());
  if (!m) {
    ctx.globalAlpha = alpha;
    return color;
  }
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => Number.parseInt(h, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function drawToCanvas(ctx: CanvasRenderingContext2D, cmds: DrawCmd[]): void {
  for (const cmd of cmds) {
    switch (cmd.op) {
      case "grid": {
        ctx.fillStyle = cmd.color;
        for (let gx = cmd.x; gx < cmd.x + cmd.w; gx += cmd.step) {
          for (let gy = cmd.y; gy < cmd.y + cmd.h; gy += cmd.step) {
            ctx.fillRect(gx, gy, 1.2, 1.2);
          }
        }
        break;
      }
      case "path": {
        ctx.save();
        if (cmd.transform) {
          ctx.translate(cmd.transform.tx, cmd.transform.ty);
          ctx.scale(cmd.transform.scale, cmd.transform.scale);
        }
        const path = new Path2D(cmd.d);
        if (cmd.shadow) {
          ctx.shadowColor = rgba(cmd.shadow.color, cmd.shadow.alpha);
          ctx.shadowBlur = cmd.shadow.blur;
          ctx.shadowOffsetY = cmd.shadow.dy;
        }
        if (cmd.gradient) {
          const g = ctx.createLinearGradient(cmd.gradient.x1, cmd.gradient.y1, cmd.gradient.x2, cmd.gradient.y2);
          g.addColorStop(0, cmd.gradient.from);
          g.addColorStop(1, cmd.gradient.to);
          ctx.globalAlpha = 1;
          ctx.fillStyle = g;
          ctx.fill(path);
        } else if (cmd.fill) {
          ctx.fillStyle = withAlpha(ctx, cmd.fill, cmd.fillAlpha);
          ctx.fill(path);
        }
        // The shadow belongs to the SHAPE, not to each paint of it: leaving it
        // armed would draw it a second time under the outline, doubling its
        // density exactly along the edge where it is most visible.
        ctx.shadowColor = "rgba(0, 0, 0, 0)";
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
        if (cmd.stroke) {
          ctx.strokeStyle = withAlpha(ctx, cmd.stroke, cmd.strokeAlpha);
          ctx.lineWidth = cmd.strokeWidth ?? 1;
          if (cmd.round) {
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
          }
          ctx.setLineDash(cmd.dash ?? []);
          ctx.stroke(path);
        }
        ctx.restore();
        break;
      }
      case "poly": {
        ctx.save();
        ctx.fillStyle = cmd.fill;
        ctx.translate(cmd.tx, cmd.ty);
        ctx.rotate((cmd.rotateDeg * Math.PI) / 180);
        ctx.beginPath();
        const pts = cmd.points.split(" ").map((p) => p.split(",").map(Number));
        pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        break;
      }
      case "circle": {
        ctx.save();
        ctx.fillStyle = cmd.fill;
        ctx.beginPath();
        ctx.arc(cmd.cx, cmd.cy, cmd.r, 0, Math.PI * 2);
        ctx.fill();
        if (cmd.stroke) {
          ctx.strokeStyle = cmd.stroke;
          ctx.lineWidth = cmd.strokeWidth ?? 1;
          ctx.stroke();
        }
        ctx.restore();
        break;
      }
      case "text": {
        ctx.save();
        ctx.font = `${cmd.weight ?? 400} ${cmd.size}px ${fontOf(cmd.font)}`;
        ctx.textAlign = cmd.anchor === "middle" ? "center" : cmd.anchor === "end" ? "right" : "left";
        if (cmd.knockout) {
          const w = approxTextWidth(cmd.text, cmd.size, cmd.font) + cmd.knockout.padX * 2;
          const left =
            cmd.anchor === "middle"
              ? cmd.x - w / 2
              : cmd.anchor === "end"
                ? cmd.x - w + cmd.knockout.padX
                : cmd.x - cmd.knockout.padX;
          ctx.fillStyle = cmd.knockout.color;
          ctx.fillRect(left, cmd.y - cmd.knockout.height + 4, w, cmd.knockout.height);
        }
        if (cmd.halo) {
          ctx.strokeStyle = cmd.halo.color;
          ctx.lineWidth = cmd.halo.width;
          ctx.lineJoin = "round";
          ctx.miterLimit = 2;
          ctx.strokeText(cmd.text, cmd.x, cmd.y);
        }
        ctx.fillStyle = withAlpha(ctx, cmd.color, cmd.alpha);
        ctx.fillText(cmd.text, cmd.x, cmd.y);
        ctx.restore();
        break;
      }
    }
  }
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function drawToSvg(cmds: DrawCmd[], opts: { gridId?: string } = {}): string {
  // Several SVGs inlined into ONE page (the multi-view HTML export) must not
  // share a <pattern> id — the browser resolves url(#…) document-wide.
  const gridId = opts.gridId ?? "as-grid";
  const out: string[] = [];
  // Gradients and drop shadows are referenced by id, and several SVGs are
  // inlined into one page by the multi-view HTML export — so every id is
  // built from `gridId`, which is already per-view unique, plus a counter.
  const defs: string[] = [];
  const defId = () => `${gridId}-d${defs.length}`;
  const gradientRef = (g: Gradient) => {
    const id = defId();
    defs.push(
      `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}">` +
        `<stop offset="0" stop-color="${g.from}"/><stop offset="1" stop-color="${g.to}"/></linearGradient>`,
    );
    return id;
  };
  const shadowRef = (sh: { color: string; alpha: number; blur: number; dy: number }) => {
    const id = defId();
    // A generous region: the default -10%..120% filter box clips a soft
    // shadow's tail on a small shape, which reads as a hard edge under the
    // card rather than as light falling off.
    defs.push(
      `<filter id="${id}" x="-40%" y="-40%" width="180%" height="180%">` +
        `<feDropShadow dx="0" dy="${sh.dy}" stdDeviation="${sh.blur / 2}" flood-color="${sh.color}" flood-opacity="${sh.alpha}"/></filter>`,
    );
    return id;
  };
  // Consecutive commands stamped with one tag render inside one group, so a
  // whole element can be shown, dimmed, or hidden by touching a single <g>.
  // The emitters push each element's commands contiguously, which is what
  // makes run-length grouping sufficient.
  let openTag: string | null = null;
  const keyOf = (tag?: DrawTag) => (tag ? `${tag.id}\u0000${tag.day ?? ""}` : null);
  for (const cmd of cmds) {
    const key = keyOf(cmd.tag);
    if (key !== openTag) {
      if (openTag !== null) out.push("</g>");
      if (key !== null) {
        const tag = cmd.tag!;
        out.push(
          `<g class="bd-el" data-el="${esc(tag.id)}"${tag.day !== undefined ? ` data-day="${tag.day}"` : ""}>`,
        );
      }
      openTag = key;
    }
    switch (cmd.op) {
      case "grid": {
        // A pattern keeps the SVG small where canvas just loops.
        out.push(
          `<defs><pattern id="${gridId}" width="${cmd.step}" height="${cmd.step}" patternUnits="userSpaceOnUse" x="${cmd.x}" y="${cmd.y}"><rect width="1.2" height="1.2" fill="${cmd.color}"/></pattern></defs>`,
          `<rect x="${cmd.x}" y="${cmd.y}" width="${cmd.w}" height="${cmd.h}" fill="url(#${gridId})"/>`,
        );
        break;
      }
      case "path": {
        const gradId = cmd.gradient ? gradientRef(cmd.gradient) : null;
        const shadowId = cmd.shadow ? shadowRef(cmd.shadow) : null;
        const attrs = [
          gradId ? `fill="url(#${gradId})"` : cmd.fill ? `fill="${cmd.fill}"` : `fill="none"`,
          cmd.fillAlpha !== undefined && !gradId ? `fill-opacity="${cmd.fillAlpha}"` : "",
          shadowId ? `filter="url(#${shadowId})"` : "",
          cmd.stroke ? `stroke="${cmd.stroke}"` : "",
          cmd.strokeAlpha !== undefined ? `stroke-opacity="${cmd.strokeAlpha}"` : "",
          cmd.strokeWidth ? `stroke-width="${cmd.strokeWidth}"` : "",
          cmd.dash?.length ? `stroke-dasharray="${cmd.dash.join(" ")}"` : "",
          cmd.round ? `stroke-linecap="round" stroke-linejoin="round"` : "",
        ]
          .filter(Boolean)
          .join(" ");
        const el = `<path d="${cmd.d}" ${attrs}/>`;
        out.push(
          cmd.transform
            ? `<g transform="translate(${cmd.transform.tx} ${cmd.transform.ty}) scale(${cmd.transform.scale})">${el}</g>`
            : el,
        );
        break;
      }
      case "poly": {
        out.push(
          `<polygon points="${cmd.points}" fill="${cmd.fill}" transform="translate(${cmd.tx} ${cmd.ty}) rotate(${cmd.rotateDeg})"/>`,
        );
        break;
      }
      case "circle": {
        out.push(
          `<circle cx="${cmd.cx}" cy="${cmd.cy}" r="${cmd.r}" fill="${cmd.fill}"${cmd.stroke ? ` stroke="${cmd.stroke}" stroke-width="${cmd.strokeWidth ?? 1}"` : ""}/>`,
        );
        break;
      }
      case "text": {
        if (cmd.knockout) {
          const w = approxTextWidth(cmd.text, cmd.size, cmd.font) + cmd.knockout.padX * 2;
          const left =
            cmd.anchor === "middle"
              ? cmd.x - w / 2
              : cmd.anchor === "end"
                ? cmd.x - w + cmd.knockout.padX
                : cmd.x - cmd.knockout.padX;
          out.push(
            `<rect x="${left}" y="${cmd.y - cmd.knockout.height + 4}" width="${w}" height="${cmd.knockout.height}" fill="${cmd.knockout.color}"/>`,
          );
        }
        const attrs = [
          `font-size="${cmd.size}"`,
          `font-family="${fontOf(cmd.font)}"`,
          cmd.weight ? `font-weight="${cmd.weight}"` : "",
          `fill="${cmd.color}"`,
          cmd.alpha !== undefined ? `fill-opacity="${cmd.alpha}"` : "",
          cmd.anchor === "middle" ? `text-anchor="middle"` : "",
          cmd.anchor === "end" ? `text-anchor="end"` : "",
        ]
          .filter(Boolean)
          .join(" ");
        // The halo is a SEPARATE stroke-only copy underneath rather than
        // `paint-order="stroke"` on one element: paint-order is SVG 2, and a
        // reader that ignores it would stroke 4px over 11px glyphs and render
        // the label unreadable. Two elements say the same thing everywhere.
        if (cmd.halo) {
          out.push(
            `<text x="${cmd.x}" y="${cmd.y}" ${attrs.replace(`fill="${cmd.color}"`, 'fill="none"')} stroke="${cmd.halo.color}" stroke-width="${cmd.halo.width}" stroke-linejoin="round">${esc(cmd.text)}</text>`,
          );
        }
        out.push(`<text x="${cmd.x}" y="${cmd.y}" ${attrs}>${esc(cmd.text)}</text>`);
        break;
      }
    }
  }
  if (openTag !== null) out.push("</g>");
  // One defs block, first: a `url(#…)` may be resolved before the element that
  // defines it in some readers, and putting them all up front costs nothing.
  if (defs.length) out.unshift(`<defs>${defs.join("")}</defs>`);
  return out.join("\n");
}

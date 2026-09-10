/**
 * ui-icons.tsx — the chrome's icon set.
 *
 * Distinct from `icons.tsx`, which draws things ON the diagram: those paths
 * also feed the Canvas2D exporter and are chosen to say what a NODE is. These
 * say what a BUTTON does, and they exist because the editor used to spell that
 * with literal characters — `↺`, `⧉`, `⤓`, `🔒`. Text glyphs are the wrong
 * material for a control:
 *
 *   - they resolve to whatever face on the machine happens to carry them, so
 *     one toolbar mixed four typefaces and `🔒` arrived as a full-colour emoji
 *     sitting in a monochrome bar;
 *   - their optical sizes disagree — `↺` renders small and thin next to `✕`,
 *     and no amount of padding lines them up;
 *   - several have no glyph at all on Windows and render as a blank box.
 *
 * Same 24×24, stroke-only idiom as `icons.tsx`, so the two sets sit together
 * on the same bar without looking like they came from different kits.
 */
import type { CSSProperties } from "react";
import type { IconPaths } from "./icons";

export const UI_ICONS = {
  /** The one caret. Every dropdown on the bar wears it, closed or open. */
  chevronDown: ["M6 9.5l6 6 6-6"],
  chevronLeft: ["M14.5 5.5l-6 6.5 6 6.5"],
  chevronRight: ["M9.5 5.5l6 6.5-6 6.5"],

  // ── History ──────────────────────────────────────────────────────────────
  undo: ["M8 5.5L3.5 10 8 14.5", "M3.5 10h10a5.5 5.5 0 0 1 0 11h-3.5"],
  redo: ["M16 5.5L20.5 10 16 14.5", "M20.5 10h-10a5.5 5.5 0 0 0 0 11H14"],

  // ── Object actions ───────────────────────────────────────────────────────
  close: ["M6 6l12 12", "M18 6L6 18"],
  plus: ["M12 5v14", "M5 12h14"],
  minus: ["M5 12h14"],
  check: ["M4.5 12.5l5 5 10-11"],
  /** A row that must be filled in — the record editor's required toggle. */
  asterisk: ["M12 5v14", "M5.9 8.5l12.2 7", "M18.1 8.5l-12.2 7"],
  trash: ["M4 6.5h16", "M9.5 6.5V4h5v2.5", "M6.5 6.5L7.5 20h9l1-13.5", "M10 10v6", "M14 10v6"],
  pencil: ["M4 20h4L18.6 9.4a2.05 2.05 0 0 0-2.9-2.9L5 17.1z", "M14.8 7.3l2.9 2.9"],
  /** Duplicate: a sheet in front of the sheet it was copied from. */
  copy: ["M9.5 8.5h10v11h-10z", "M15 6V4.5H4.5v11H6"],
  /** Reverse a connection — two lanes running opposite ways. */
  swap: ["M4 8.5h14", "M15 5.5l3 3-3 3", "M20 15.5H6", "M9 12.5l-3 3 3 3"],
  externalLink: ["M14 4h6v6", "M20 4l-8.5 8.5", "M18.5 13.5V19a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1H10"],
  lock: ["M5.5 10.5h13v10h-13z", "M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"],
  /** The shackle sprung open, so lock and unlock differ in shape, not colour. */
  unlock: ["M5.5 10.5h13v10h-13z", "M8.5 10.5V7.5a3.5 3.5 0 0 1 6.6-1.7"],
  arrowUp: ["M12 19.5v-15", "M6 10.5l6-6 6 6"],
  arrowDown: ["M12 4.5v15", "M6 13.5l6 6 6-6"],
  /** Derivation, conversion, "and then this" — one thing becoming another. */
  arrowRight: ["M4.5 12h15", "M13.5 6l6 6-6 6"],
  /**
   * Settings — three sliders, not a cogwheel. A gear at 15px is a circle with
   * eight ticks round it, which reads as a sun; sliders survive the size.
   */
  settings: [
    "M3.5 7h5.5",
    "M13 7h7.5",
    "M11 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4",
    "M3.5 12h11.5",
    "M19 12h1.5",
    "M17 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4",
    "M3.5 17h3.5",
    "M11 17h9.5",
    "M9 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4",
  ],

  // ── Arrangement ──────────────────────────────────────────────────────────
  //
  // A rail and two bars measured against it: the rail is the edge everything
  // lands on, and the bars' unequal lengths are what make left readable as
  // left rather than as right seen in a mirror.
  alignLeft: ["M4 3.5v17", "M7.5 8h12", "M7.5 16h7"],
  alignCenterX: ["M12 3.5v17", "M6 8h12", "M8.5 16h7"],
  alignRight: ["M20 3.5v17", "M4.5 8h12", "M9.5 16h7"],
  alignTop: ["M3.5 4h17", "M8 7.5v12", "M16 7.5v7"],
  alignCenterY: ["M3.5 12h17", "M8 6v12", "M16 8.5v7"],
  alignBottom: ["M3.5 20h17", "M8 4.5v12", "M16 9.5v7"],
  distributeX: ["M4 3.5v17", "M20 3.5v17", "M12 7v10"],
  distributeY: ["M3.5 4h17", "M3.5 20h17", "M7 12h10"],
  /** Stacking, not motion: the arrow travels toward the rail it will sit on. */
  bringForward: ["M3.5 4h17", "M12 20.5V8.5", "M7.5 13L12 8.5l4.5 4.5"],
  sendBackward: ["M3.5 20h17", "M12 3.5v12", "M7.5 11L12 15.5l4.5-4.5"],
  group: ["M3.5 7.5v-4h4", "M16.5 3.5h4v4", "M20.5 16.5v4h-4", "M7.5 20.5h-4v-4", "M8.5 8.5h7v7h-7z"],

  // ── Files and views ──────────────────────────────────────────────────────
  /** Export writes a file out to the disk: the download arrow. */
  download: ["M12 3.5v11.5", "M7.5 10.5L12 15l4.5-4.5", "M4 20h16"],
  /** Import reads one back in. */
  upload: ["M12 20.5V9", "M7.5 13.5L12 9l4.5 4.5", "M4 4h16"],
  /** Compare: the baseline document beside the live one. */
  compare: ["M3.5 5h7v14h-7z", "M13.5 5h7v14h-7z", "M12 2.5v19"],
  /** Zoom to fit — the four corners of the frame, and nothing inside it. */
  fit: ["M4 9V5a1 1 0 0 1 1-1h4", "M15 4h4a1 1 0 0 1 1 1v4", "M20 15v4a1 1 0 0 1-1 1h-4", "M9 20H5a1 1 0 0 1-1-1v-4"],
  search: ["M11 18.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15", "M20.5 20.5l-4.2-4.2"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18", "M12 7v5.2l3.4 2"],
  /** The AI affordance, shared with the node kit so the two never diverge. */
  sparkle: [
    "M11 3l1.7 4.3L17 9l-4.3 1.7L11 15l-1.7-4.3L5 9l4.3-1.7z",
    "M18 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z",
  ],
  file: ["M6 3h8l4 4v14H6z", "M14 3v4h4"],
  /** A finding, in the shape of the lint dot it opens. */
  shield: ["M12 3l7.5 2.8v5.7c0 4.7-3.2 8.8-7.5 10.3-4.3-1.5-7.5-5.6-7.5-10.3V5.8z", "M8.8 12l2.3 2.3 4.1-4.6"],
  warning: ["M12 3.5l9.5 17h-19z", "M12 10v4.5", "M12 17.5h0.01"],
} as const satisfies Record<string, IconPaths>;

export type UiIconName = keyof typeof UI_ICONS;

export interface UiIconProps {
  name: UiIconName;
  /** Optical size in px. 15 suits the 30px control height the chrome uses. */
  size?: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * One icon, drawn in the current text colour.
 *
 * Always `aria-hidden`: every control that carries one also carries a label —
 * visible text, or an `aria-label` when the icon is the whole button — so the
 * glyph is decoration and announcing it would only double the name.
 */
export function UiIcon({ name, size = 15, className, style }: UiIconProps) {
  return (
    <svg
      className={className ? `as-icon ${className}` : "as-icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      {UI_ICONS[name].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

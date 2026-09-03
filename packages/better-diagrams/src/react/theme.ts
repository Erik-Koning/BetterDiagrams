/**
 * theme.ts — the design tokens the stylesheet reads.
 *
 * Every visual constant in `styles.css` resolves through a `--as-*` custom
 * property, so a host app restyles the editor without a CSS override war:
 *
 *   <ArchitectureStudio theme={{ accent: "#f59e0b", radius: "2px" }} />
 *
 * Tokens are applied inline on the root element, so they win over the
 * stylesheet's `:where()` defaults without needing `!important`.
 */
import type { CSSProperties } from "react";

export interface Theme {
  /** Canvas backdrop. */
  bg?: string;
  /** Toolbar, panels, menus. */
  surface?: string;
  /** Inputs and hover states. */
  surface2?: string;
  /** Hairlines. */
  border?: string;
  /** Primary text. */
  text?: string;
  /** Secondary/meta text. */
  textDim?: string;
  /** Selection, focus rings, primary buttons. */
  accent?: string;
  /** Text drawn ON accent fills — primary buttons, sequence badges. */
  accentInk?: string;
  /** Destructive actions. */
  danger?: string;
  /** Compare-mode added elements. */
  diffAdded?: string;
  /** Compare-mode removed elements. */
  diffRemoved?: string;
  /** Compare-mode changed elements. */
  diffChanged?: string;
  /** The deprecated status text at rest (salmon). */
  warn?: string;
  /** The deprecated status text under cursor/selection (red). */
  warnStrong?: string;
  /** Past-due date chips on not-yet-active elements. */
  overdue?: string;
  /** The dark-status hazard ring's dark half. Rarely worth theming. */
  hazardInk?: string;
  /** The dark-status hazard ring's light half. */
  hazardTape?: string;
  /** Per-edge-colour overrides, e.g. { sky: "#0284c7" } for light themes. */
  edgeColors?: Partial<Record<string, string>>;
  /** Per-participant-kind accent overrides for the sequence editor. */
  seqAccents?: Partial<Record<string, string>>;
  /**
   * Per-node-kind accent overrides, e.g. { service: "#0369a1" }. The registry's
   * accents are chosen for the dark canvas and land at 2.2–2.5:1 on a light
   * card; these are the light-legible counterparts, keyed by kind id. A kind
   * the theme doesn't name — a cloud pack's, a host's own — keeps its registry
   * accent, so an extension needs no theme entry to work.
   */
  nodeAccents?: Partial<Record<string, string>>;
  /**
   * Ink for the drop shadows under menus, modals and the inspector. 45% black
   * is right over a dark canvas and reads as soot on a white page, where
   * ~10–15% is conventional. Offsets and blur stay in the stylesheet.
   */
  shadowInk?: string;
  /**
   * What the browser's OWN widgets should assume — the date input's calendar
   * glyph, `select` popups, scrollbars. Without it they render in the UA's
   * light scheme over the dark editor (a black calendar icon on #1e293b).
   */
  colorScheme?: "light" | "dark";
  /** Corner rounding for nodes and controls. */
  radius?: string;
  /** UI font stack. */
  font?: string;
  /** Monospace stack, used for labels and chips. */
  mono?: string;
  /** Background grid dot colour. */
  gridDot?: string;
}

const TOKEN: Record<keyof Theme, string> = {
  bg: "--as-bg",
  surface: "--as-surface",
  surface2: "--as-surface-2",
  border: "--as-border",
  text: "--as-text",
  textDim: "--as-text-dim",
  accent: "--as-accent",
  accentInk: "--as-accent-ink",
  danger: "--as-danger",
  diffAdded: "--as-diff-added",
  diffRemoved: "--as-diff-removed",
  diffChanged: "--as-diff-changed",
  warn: "--as-warn",
  warnStrong: "--as-warn-strong",
  overdue: "--as-overdue",
  hazardInk: "--as-hazard-ink",
  hazardTape: "--as-hazard-tape",
  edgeColors: "",
  seqAccents: "",
  nodeAccents: "",
  shadowInk: "--as-shadow-ink",
  colorScheme: "--as-color-scheme",
  radius: "--as-radius",
  font: "--as-font",
  mono: "--as-mono",
  gridDot: "--as-grid-dot",
};

/**
 * The stylesheet's built-in look, spelled out as a Theme. Passing it is the
 * same as passing no theme — it exists so a host can start from it and
 * override a token or two, and so `paletteFromTheme` has the full dark set.
 */
export const DARK_THEME: Theme = {
  bg: "#0f172a",
  surface: "#0b1220",
  surface2: "#1e293b",
  border: "#334155",
  text: "#e2e8f0",
  textDim: "#94a3b8",
  accent: "#38bdf8",
  accentInk: "#04121f",
  danger: "#fb7185",
  gridDot: "#1e293b",
  shadowInk: "rgb(0 0 0 / 45%)",
  colorScheme: "dark",
};

/**
 * A complete light theme:
 *
 *   <ArchitectureStudio theme={LIGHT_THEME} />
 *
 * Every token is overridden, so nothing from the dark defaults bleeds
 * through, and image exports follow automatically via `paletteFromTheme`.
 */
/*
 * Every ink here is one step darker than the obvious Tailwind-500 choice, for
 * one reason: this palette is used as TEXT on white, and a -500 hue is not.
 * The whole set was measured against the surface it actually lands on rather
 * than against white in the abstract, and the smallest ratio in it is 4.54:1
 * (the accent's own "on" state); most sit between 5 and 7.
 *
 * What that fixed, measured before: white on the sky-600 accent was 4.10:1 on
 * the AI and Save buttons, `.as-btn--on` 3.25, `.as-btn--danger` 3.71, the
 * toast 4.10, the amber shared by `diffChanged` and `overdue` 3.04, `warn`
 * 3.22 — and the plain toolbar button label, `textDim` on `surface2`, 4.34.
 * Every one of those was under AA on the editor's own primary controls.
 */
export const LIGHT_THEME: Theme = {
  bg: "#f8fafc",
  surface: "#ffffff",
  surface2: "#f1f5f9",
  border: "#e2e8f0",
  text: "#0f172a",
  // slate-600, not -500: every toolbar button's label is this on `surface2`,
  // which at #64748b was 4.34:1 — the whole toolbar just under AA. 6.92:1.
  textDim: "#475569",
  // sky-700, not -600: white on it is 5.93:1 (was 4.10), and the accent-on-
  // accent-tint "on" state that toolbar toggles use clears AA at 4.54:1.
  accent: "#0369a1",
  accentInk: "#ffffff",
  // rose-700: the danger button draws its own colour on a 15% wash of itself,
  // which is 4.82:1 here and was 3.71 at rose-600.
  danger: "#be123c",
  gridDot: "#e2e8f0",
  // Shadows on a white page are a suggestion, not the 45% black that reads
  // correctly over the dark canvas.
  shadowInk: "rgb(15 23 42 / 14%)",
  colorScheme: "light",
  // Darker warning/comparison hues — the dark-canvas values sit near 2:1
  // contrast on a light page.
  diffAdded: "#047857",
  diffRemoved: "#be123c",
  diffChanged: "#b45309",
  warn: "#c2410c",
  warnStrong: "#b91c1c",
  overdue: "#b45309",
  // The fixed edge/sequence palettes were picked for the dark canvas; these
  // are their light-legible counterparts (sky #38bdf8 on white is ~2.2:1).
  edgeColors: { slate: "#475569", sky: "#0369a1", emerald: "#047857", amber: "#b45309", rose: "#be123c", violet: "#6d28d9" },
  seqAccents: { actor: "#475569", service: "#0369a1", database: "#b45309", queue: "#6d28d9", external: "#334155" },
  // Node-kind accents. The registry's are dark-canvas values and stay the
  // fallback for anything not named here (cloud packs keep their brand hue);
  // these are their light counterparts, each at least 4.6:1 as text on the
  // card it tints. Fuchsia's three strengths stay a family — darker is
  // heavier — the way the dark set uses brightness for the same thing.
  nodeAccents: {
    service: "#0369a1",
    database: "#b45309",
    queue: "#6d28d9",
    gateway: "#047857",
    client: "#475569",
    external: "#52627a",
    table: "#0f766e",
    group: "#475569",
    text: "#0369a1",
    decision: "#c2410c",
    terminator: "#15803d",
    io: "#1d4ed8",
    point: "#475569",
    "lm-small": "#a21caf",
    "lm-medium": "#86198f",
    llm: "#701a75",
  },
};

/** Turn a Theme into inline CSS custom properties for the root element. */
export function themeToStyle(theme: Theme | undefined): CSSProperties {
  if (!theme) return {};
  const style: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme)) {
    const token = TOKEN[key as keyof Theme];
    if (token && typeof value === "string") style[token] = value;
  }
  // The two record-valued tokens fan out to one custom property per entry —
  // `--as-edge-sky`, `--as-seq-database` — which is what lets fixed-hex
  // palettes re-resolve per theme without a second stylesheet.
  for (const [k, v] of Object.entries(theme.edgeColors ?? {})) {
    if (typeof v === "string") style[`--as-edge-${k}`] = v;
  }
  for (const [k, v] of Object.entries(theme.seqAccents ?? {})) {
    if (typeof v === "string") style[`--as-seq-${k}`] = v;
  }
  for (const [k, v] of Object.entries(theme.nodeAccents ?? {})) {
    if (typeof v === "string") style[`--as-node-${k}`] = v;
  }
  return style as CSSProperties;
}


/**
 * Derive an export palette from a Theme, so exported images match the editor.
 * Falls back to the dark defaults for any token the theme doesn't override.
 */
export function paletteFromTheme(theme: Theme | undefined): Record<string, string> | undefined {
  if (!theme) return undefined;
  const out: Record<string, string> = {};
  if (theme.bg) out.bg = theme.bg;
  if (theme.surface) out.surface = theme.surface;
  if (theme.surface2) out.surface2 = theme.surface2;
  if (theme.text) out.text = theme.text;
  if (theme.textDim) out.textDim = theme.textDim;
  // The exporters draw a third text tier the theme doesn't distinguish.
  if (theme.textDim) out.textFaint = theme.textDim;
  if (theme.border) out.border = theme.border;
  if (theme.gridDot) out.gridDot = theme.gridDot;
  if (theme.accentInk) out.accentInk = theme.accentInk;
  if (theme.warn) out.warn = theme.warn;
  if (theme.overdue) out.overdue = theme.overdue;
  // Record-valued entries ride through as JSON — ExportPalette is a string
  // map, and the emitters parse these two keys back out.
  if (theme.edgeColors) out.edgeColors = JSON.stringify(theme.edgeColors);
  if (theme.seqAccents) out.seqAccents = JSON.stringify(theme.seqAccents);
  if (theme.nodeAccents) out.nodeAccents = JSON.stringify(theme.nodeAccents);
  return Object.keys(out).length ? out : undefined;
}

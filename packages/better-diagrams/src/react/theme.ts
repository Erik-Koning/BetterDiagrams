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
};

/**
 * A complete light theme:
 *
 *   <ArchitectureStudio theme={LIGHT_THEME} />
 *
 * Every token is overridden, so nothing from the dark defaults bleeds
 * through, and image exports follow automatically via `paletteFromTheme`.
 */
export const LIGHT_THEME: Theme = {
  bg: "#f8fafc",
  surface: "#ffffff",
  surface2: "#f1f5f9",
  border: "#e2e8f0",
  text: "#0f172a",
  textDim: "#64748b",
  accent: "#0284c7",
  accentInk: "#ffffff",
  danger: "#e11d48",
  gridDot: "#e2e8f0",
  // Darker warning/comparison hues — the dark-canvas values sit near 2:1
  // contrast on a light page.
  diffAdded: "#059669",
  diffRemoved: "#e11d48",
  diffChanged: "#d97706",
  warn: "#e0674f",
  warnStrong: "#dc2626",
  overdue: "#d97706",
  // The fixed edge/sequence palettes were picked for the dark canvas; these
  // are their light-legible counterparts (sky #38bdf8 on white is ~2.2:1).
  edgeColors: { slate: "#475569", sky: "#0284c7", emerald: "#059669", amber: "#d97706", rose: "#e11d48", violet: "#7c3aed" },
  seqAccents: { actor: "#64748b", service: "#0284c7", database: "#d97706", queue: "#7c3aed", external: "#475569" },
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
  return Object.keys(out).length ? out : undefined;
}

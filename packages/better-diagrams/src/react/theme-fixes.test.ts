/**
 * The theme's accessibility contract, pinned.
 *
 * `LIGHT_THEME` is not decoration: it is the palette the editor's own primary
 * controls are drawn with, and it used to fail WCAG AA on most of them — white
 * on the accent was 4.10:1 for the Save and AI buttons, the "on" state of a
 * toolbar toggle 3.25, the danger button 3.71, and the plain button label
 * 4.34. Those are the numbers this file exists to stop drifting back.
 *
 * The ratios are computed here rather than eyeballed, against the surface each
 * colour actually lands on — a colour is only readable relative to something.
 */
import { describe, expect, it } from "vitest";
import { DARK_THEME, LIGHT_THEME, themeToStyle } from "./theme";
import { BUILTIN_NODE_KINDS } from "./registry";

const AA = 4.5;

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast between two opaque colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** What `color-mix(in srgb, top P%, bottom)` computes to for opaque colours. */
function mix(top: string, part: number, bottom: string): string {
  const [tr, tg, tb] = rgb(top);
  const [br, bg, bb] = rgb(bottom);
  const chan = (t: number, b: number) =>
    Math.round(t * part + b * (1 - part))
      .toString(16)
      .padStart(2, "0");
  return `#${chan(tr, br)}${chan(tg, bg)}${chan(tb, bb)}`;
}

/** Every token this file measures is set by LIGHT_THEME; the type is optional. */
function token(value: string | undefined, name: string): string {
  if (!value) throw new Error(`LIGHT_THEME.${name} is unset — the palette is incomplete`);
  return value;
}

describe("LIGHT_THEME clears AA on the controls it paints", () => {
  const t = {
    bg: token(LIGHT_THEME.bg, "bg"),
    surface: token(LIGHT_THEME.surface, "surface"),
    surface2: token(LIGHT_THEME.surface2, "surface2"),
    textDim: token(LIGHT_THEME.textDim, "textDim"),
    accent: token(LIGHT_THEME.accent, "accent"),
    accentInk: token(LIGHT_THEME.accentInk, "accentInk"),
    danger: token(LIGHT_THEME.danger, "danger"),
    warn: token(LIGHT_THEME.warn, "warn"),
    overdue: token(LIGHT_THEME.overdue, "overdue"),
    diffChanged: token(LIGHT_THEME.diffChanged, "diffChanged"),
  };

  it("draws accent-ink on the accent (the Save and AI buttons)", () => {
    expect(contrast(t.accentInk, t.accent)).toBeGreaterThanOrEqual(AA);
  });

  it("keeps a plain toolbar button's label readable on its own surface", () => {
    // .as-btn — `--as-text-dim` on `--as-surface-2`.
    expect(contrast(t.textDim, t.surface2)).toBeGreaterThanOrEqual(AA);
  });

  it("keeps a toggled button's label readable on its 18% accent wash", () => {
    // .as-btn--on — the accent, on a tint of itself over the toolbar.
    expect(contrast(t.accent, mix(t.accent, 0.18, t.surface))).toBeGreaterThanOrEqual(AA);
  });

  it("keeps a destructive button's label readable on its 15% wash", () => {
    // .as-btn--danger, and .as-error's 12% variant.
    expect(contrast(t.danger, mix(t.danger, 0.15, t.surface))).toBeGreaterThanOrEqual(AA);
    expect(contrast(t.danger, mix(t.danger, 0.12, t.surface))).toBeGreaterThanOrEqual(AA);
  });

  it("keeps a toast readable on the canvas", () => {
    // .as-toast — the accent on a near-opaque surface over the canvas.
    expect(contrast(t.accent, mix(t.surface, 0.92, t.bg))).toBeGreaterThanOrEqual(AA);
  });

  it("keeps the warning hues readable on a light page", () => {
    // The deprecated status word, overdue date chips, changed-in-compare chips.
    for (const hue of [t.warn, t.overdue, t.diffChanged]) {
      expect(contrast(hue, t.surface)).toBeGreaterThanOrEqual(AA);
      expect(contrast(hue, t.bg)).toBeGreaterThanOrEqual(AA);
    }
  });
});

describe("per-kind node accents", () => {
  it("names every generic built-in kind", () => {
    // Cloud packs are deliberately absent: a brand colour is the point of an
    // AWS node, and the stylesheet's ink mix keeps its label readable anyway.
    const named = new Set(Object.keys(LIGHT_THEME.nodeAccents ?? {}));
    const missing = Object.keys(BUILTIN_NODE_KINDS).filter((k) => !named.has(k));
    expect(missing).toEqual([]);
  });

  it("gives each of them a hue that can be read on a light card", () => {
    // The card is the accent at 6% over the surface, which is what the
    // stylesheet mixes — so each accent is measured against its OWN card.
    const surface = token(LIGHT_THEME.surface, "surface");
    const failures = Object.entries(LIGHT_THEME.nodeAccents ?? {})
      .map(([kind, hex]) => [kind, contrast(hex!, mix(hex!, 0.06, surface))] as const)
      .filter(([, ratio]) => ratio < AA)
      .map(([kind, ratio]) => `${kind} ${ratio.toFixed(2)}:1`);
    expect(failures).toEqual([]);
  });

  it("leaves the registry's dark accents alone as the fallback", () => {
    // A theme entry overrides; it never rewrites the registry, so a host that
    // passes no theme — or names no kind — still gets these.
    expect(BUILTIN_NODE_KINDS.service.accent).toBe("#38bdf8");
    expect(BUILTIN_NODE_KINDS.table.accent).toBe("#2dd4bf");
    expect(BUILTIN_NODE_KINDS.terminator.accent).toBe("#4ade80");
  });
});

describe("themeToStyle", () => {
  it("fans record tokens out to one custom property each", () => {
    const style = themeToStyle(LIGHT_THEME) as Record<string, string>;
    expect(style["--as-node-service"]).toBe(LIGHT_THEME.nodeAccents!.service);
    expect(style["--as-node-lm-small"]).toBe(LIGHT_THEME.nodeAccents!["lm-small"]);
    expect(style["--as-edge-sky"]).toBe(LIGHT_THEME.edgeColors!.sky);
    expect(style["--as-seq-database"]).toBe(LIGHT_THEME.seqAccents!.database);
  });

  it("carries the scalar tokens the browser's own widgets read", () => {
    // Without `color-scheme` the UA paints its LIGHT date picker, select
    // popups and scrollbars over the dark editor.
    expect((themeToStyle(DARK_THEME) as Record<string, string>)["--as-color-scheme"]).toBe("dark");
    expect((themeToStyle(LIGHT_THEME) as Record<string, string>)["--as-color-scheme"]).toBe("light");
    // 45% black is right over the dark canvas and reads as soot on a page.
    expect((themeToStyle(LIGHT_THEME) as Record<string, string>)["--as-shadow-ink"]).toBe(
      LIGHT_THEME.shadowInk,
    );
  });

  it("ignores record tokens when turning a theme into scalars", () => {
    const style = themeToStyle({ nodeAccents: { service: "#123456" } }) as Record<string, string>;
    expect(style["--as-node-service"]).toBe("#123456");
    expect(Object.keys(style)).not.toContain("");
  });
});

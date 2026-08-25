/**
 * icons.tsx — icon glyphs as raw SVG path data.
 *
 * Paths are stored as strings rather than JSX so the same data drives both the
 * on-screen <svg> and the Canvas2D export (via `new Path2D(d)`). A registry can
 * contribute more entries; anything with a 24x24 viewBox works.
 */
import type { CSSProperties } from "react";

export type IconPaths = readonly string[];

export const BUILTIN_ICON_PATHS: Record<string, IconPaths> = {
  user: ["M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8", "M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"],
  users: [
    "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
    "M2 21c0-3.9 3.1-7 7-7s7 3.1 7 7",
    "M16 3.5a4 4 0 0 1 0 7.4",
    "M17.5 14.5c2.7 1 4.5 3.4 4.5 6.5",
  ],
  database: [
    "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3",
    "M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6",
    "M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  ],
  server: ["M3 4h18v6H3z", "M3 14h18v6H3z", "M7 7h0.01", "M7 17h0.01"],
  layers: ["M12 2l10 6-10 6L2 8z", "M2 16l10 6 10-6"],
  globe: [
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20",
    "M2 12h20",
    "M12 2c3 3.5 3 16.5 0 20",
    "M12 2c-3 3.5-3 16.5 0 20",
  ],
  cloud: ["M7 18a5 5 0 1 1 1.2-9.9A6 6 0 0 1 19.7 10.5 4 4 0 0 1 19 18z"],
  window: ["M3 5h18v14H3z", "M3 9h18", "M6 7h0.01"],
  mobile: ["M8 3h8v18H8z", "M11 18h2"],
  lock: ["M6 11h12v10H6z", "M9 11V8a3 3 0 0 1 6 0v3"],
  gear: [
    "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
    "M12 2v3",
    "M12 19v3",
    "M2 12h3",
    "M19 12h3",
    "M4.5 4.5l2.2 2.2",
    "M17.3 17.3l2.2 2.2",
    "M19.5 4.5l-2.2 2.2",
    "M4.5 19.5l2.2-2.2",
  ],
  bolt: ["M13 2L4 14h6l-1 8 9-12h-6z"],
  doc: ["M6 2h9l4 4v16H6z", "M15 2v4h4", "M9 13h6", "M9 17h6"],
  code: ["M8 6l-5 6 5 6", "M16 6l5 6-5 6"],
  mail: ["M3 5h18v14H3z", "M3 6l9 7 9-7"],
  box: ["M12 2l9 5v10l-9 5-9-5V7z", "M3 7l9 5 9-5", "M12 12v10"],
  shield: ["M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5z"],
  // Two sparkles — the glyph everything AI-shaped has converged on, and the
  // one thing on this list that reads as "a model" without a brain cliché.
  sparkle: [
    "M11 3l1.7 4.3L17 9l-4.3 1.7L11 15l-1.7-4.3L5 9l4.3-1.7z",
    "M18 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z",
  ],
};

export interface SvgIconProps {
  paths: IconPaths | undefined;
  size?: number;
  color?: string;
  style?: CSSProperties;
  className?: string;
}

export function SvgIcon({ paths, size = 22, color = "currentColor", style, className }: SvgIconProps) {
  if (!paths || paths.length === 0) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}
      className={className}
      aria-hidden="true"
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

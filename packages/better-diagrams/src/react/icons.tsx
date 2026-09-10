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

  // ── Second wave ────────────────────────────────────────────────────────
  //
  // The original nineteen covered the C4 primitives — a box, a cylinder, a
  // person, a cloud — and nothing else, so every scheduler, load balancer,
  // dashboard and webhook in a real diagram wore `gear` or `box`. These are
  // the roles that kept coming up, drawn in the same 24x24 stroke-only
  // idiom (no fills: SvgIcon sets `fill="none"`, and the Canvas2D exporter
  // strokes the same `d` strings).

  // Access and secrets.
  key: ["M7 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6", "M10 12h11", "M17 12v3.5", "M20.5 12v3"],
  // Analytics, reporting, a BI surface.
  chart: ["M3 20h18", "M6 20V11", "M12 20V4", "M18 20v-6"],
  search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16", "M21 21l-4.35-4.35"],
  // A transform stage — the ETL step a plain arrow never showed.
  filter: ["M3 4h18l-7 8v7l-4 2v-9z"],
  folder: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
  // Replication, a sync job, anything that runs both ways on a schedule.
  sync: ["M20.5 12a8.5 8.5 0 0 1-14.6 5.9", "M3.5 12A8.5 8.5 0 0 1 18.1 6.1", "M21 5v5h-5", "M3 19v-5h5"],
  cpu: [
    "M5 5h14v14H5z",
    "M9.5 9.5h5v5h-5z",
    "M9 2v3",
    "M15 2v3",
    "M9 19v3",
    "M15 19v3",
    "M2 9h3",
    "M2 15h3",
    "M19 9h3",
    "M19 15h3",
  ],
  // A job runner, a CLI, anything you shell into.
  terminal: ["M3 4h18v16H3z", "M7 9.5l3 2.5-3 2.5", "M12.5 15H17"],
  // A load balancer, and the only glyph here that says "shared evenly".
  balance: ["M12 3v18", "M4 7h16", "M7 7l-3 6h6z", "M17 7l-3 6h6z"],
  // Fan-out: pub/sub, a topic, a mesh.
  share: [
    "M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
    "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
    "M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
    "M8.6 10.6l6.8-4.1",
    "M8.6 13.4l6.8 4.1",
  ],
  // A fleet: replicas, shards, a node pool.
  grid: ["M3 3h8v8H3z", "M13 3h8v8h-8z", "M3 13h8v8H3z", "M13 13h8v8h-8z"],
  // A repo, a pipeline, an environment that forks and merges back.
  branch: [
    "M6 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
    "M6 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
    "M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
    "M6 8v8",
    "M18 8v2a4 4 0 0 1-4 4H6",
  ],
  clock: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20", "M12 6.5V12l3.5 2"],
  calendar: ["M3 5h18v16H3z", "M3 10h18", "M8 3v4", "M16 3v4"],
  bell: ["M18 16v-5a6 6 0 1 0-12 0v5l-2 3h16z", "M10 22h4"],
  card: ["M2 6h20v12H2z", "M2 10h20", "M6 15h4"],
  cart: [
    "M2 3h3l2.6 12h11L21 7H6",
    "M9.5 20.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3",
    "M17.5 20.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3",
  ],
  // Monitoring: the heartbeat line every dashboard opens with.
  activity: ["M2 12h4l3 8 4-16 3 8h6"],
  eye: [
    "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7",
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
  ],
  warning: ["M12 3l10 18H2z", "M12 10v4.5", "M12 18h0.01"],
  check: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20", "M8 12.5l3 3 5-6"],
  // A webhook, an integration, a link between two systems.
  link: [
    "M10.5 13.5a5 5 0 0 0 7.1 0l2.4-2.4a5 5 0 0 0-7.1-7.1L11.6 5.2",
    "M13.5 10.5a5 5 0 0 0-7.1 0L4 12.9a5 5 0 0 0 7.1 7.1l1.3-1.3",
  ],
  image: ["M3 5h18v14H3z", "M3 16l5-5 4 4 3-3 6 6", "M8.5 9.5h0.01"],
  video: ["M3 6h12v12H3z", "M15 10l6-3v10l-6-3z"],
  // A region, a point of presence, an edge location.
  pin: ["M12 22s7-6.4 7-12a7 7 0 1 0-14 0c0 5.6 7 12 7 12", "M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6"],
  // An agent. `sparkle` is the model itself; this is the thing acting on it.
  robot: [
    "M5 9h14v10H5z",
    "M12 6.5V9",
    "M12 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3",
    "M9.5 13h0.01",
    "M14.5 13h0.01",
    "M2 12v4",
    "M22 12v4",
  ],
  // A test environment, a lab, anything not yet production.
  flask: ["M9.5 2v7L4.6 18.9A2 2 0 0 0 6.4 22h11.2a2 2 0 0 0 1.8-3.1L14.5 9V2", "M8 2h8", "M7.5 15h9"],
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

/**
 * RoadmapChrome.tsx — the calendar under a plan laid out by date.
 *
 * Two layers, both drawn in screen space from React Flow's transform, so a
 * line stays one crisp pixel at any zoom:
 *
 * - `RoadmapBackdrop`: a line where each week, month or quarter begins, and
 *   the today line, behind every frame and card the way the dot grid is.
 *   Frames are see-through, so the lines run on through them.
 * - `RoadmapRuler`: the strip along the top of the canvas naming those
 *   units, with a Today marker and the Unscheduled column's label. It pans
 *   sideways with the canvas and stays put vertically.
 *
 * The unit follows the zoom (`roadmapTicks` picks the finest whose labels
 * fit), so zooming out goes from weeks to months to quarters. Both ignore the
 * pointer; the cards under them are what a reader acts on.
 */
import { useStore, type ReactFlowState } from "@xyflow/react";
import { dayX, roadmapTicks, type RoadmapAxis, type RoadmapTick } from "../contract/roadmap";
import type { DiagramDate } from "../contract/timeline";

/**
 * Roughly how much of the ruler a label takes, its padding and a gap
 * included — at 11px a character is about 5.5px wide. A label that would run
 * into the one before it is left out rather than printed over it; its
 * gridline still shows.
 */
const labelRoom = (text: string) => 9 + text.length * 5.5;
/** Half the Today pill, and a little clearance either side of it. */
const TODAY_HALF = 25;

/**
 * The ticks on screen now, and where a canvas x lands on screen. The
 * calendar starts where the dates do — right of the Unscheduled column, when
 * there is one — and `start` is that edge on screen.
 */
function useAxisView(axis: RoadmapAxis, unscheduledEdge: number | null) {
  const [tx, , zoom] = useStore((s: ReactFlowState) => s.transform);
  const width = useStore((s: ReactFlowState) => s.width);
  const x0 = Math.max(-tx / zoom, unscheduledEdge ?? -Infinity);
  const { ticks } = roadmapTicks(axis, x0, (width - tx) / zoom, axis.dayWidth * zoom);
  const screen = (x: number) => tx + x * zoom;
  return {
    ticks,
    screen,
    width,
    start: screen(x0),
    today: (date: DiagramDate) => screen(dayX(axis, date) + axis.dayWidth / 2),
  };
}

export function RoadmapBackdrop({
  axis,
  today,
  unscheduledEdge = null,
}: {
  axis: RoadmapAxis;
  today: DiagramDate;
  /** The Unscheduled column's right edge in canvas x (`unscheduledEdge`): no lines left of it. */
  unscheduledEdge?: number | null;
}) {
  const view = useAxisView(axis, unscheduledEdge);
  const now = view.today(today);
  return (
    <svg className="as-roadmap-backdrop" aria-hidden="true">
      {view.ticks.map((t) => {
        if (view.screen(t.x) < view.start) return null;
        const x = Math.round(view.screen(t.x)) + 0.5;
        return (
          <line
            key={t.date}
            className={`as-roadmap-backdrop__line${t.major ? " as-roadmap-backdrop__line--major" : ""}`}
            x1={x}
            x2={x}
            y1={0}
            y2="100%"
          />
        );
      })}
      {now >= 0 && now <= view.width ? (
        <line className="as-roadmap-backdrop__today" x1={now} x2={now} y1={0} y2="100%" />
      ) : null}
    </svg>
  );
}

export function RoadmapRuler({
  axis,
  today,
  unscheduledEdge = null,
}: {
  axis: RoadmapAxis;
  today: DiagramDate;
  /** The Unscheduled column's right edge in canvas x (`unscheduledEdge`), or null when nothing is undated. */
  unscheduledEdge?: number | null;
}) {
  const view = useAxisView(axis, unscheduledEdge);
  const now = view.today(today);
  const column = unscheduledEdge === null ? null : view.screen(unscheduledEdge);
  // The unit the calendar's left edge falls in keeps its name pinned there,
  // unless the next one is close enough to collide with it.
  const start = Math.max(0, view.start);
  const candidates = view.ticks.flatMap((tick, i) => {
    const x = view.screen(tick.x);
    if (x >= start) return [{ tick, x, pinned: false }];
    const next = view.ticks[i + 1];
    return next && view.screen(next.x) - start < labelRoom(tick.full) ? [] : [{ tick, x: start, pinned: true }];
  });
  const todayOn = now >= 0 && now <= view.width;
  const shown: Array<{ tick: RoadmapTick; x: number; pinned: boolean; text: string }> = [];
  let taken = -Infinity;
  for (const c of candidates) {
    // Whichever label comes first names the year.
    const text = shown.length ? c.tick.label : c.tick.full;
    const room = labelRoom(text);
    if (c.x < taken) continue;
    if (todayOn && c.x < now + TODAY_HALF && c.x + room > now - TODAY_HALF) continue;
    shown.push({ ...c, text });
    taken = c.x + room;
  }
  return (
    <div className="as-roadmap-ruler" aria-hidden="true">
      {shown.map(({ tick, x, pinned, text }) => (
        <span
          key={tick.date}
          className={`as-roadmap-ruler__unit${tick.major ? " as-roadmap-ruler__unit--major" : ""}${pinned ? " as-roadmap-ruler__unit--pinned" : ""}`}
          style={{ left: x }}
        >
          {text}
        </span>
      ))}
      {column !== null && column > 0 ? (
        <span className="as-roadmap-ruler__unscheduled" style={{ right: view.width - column }}>
          Unscheduled
        </span>
      ) : null}
      {todayOn ? (
        <span className="as-roadmap-ruler__today" style={{ left: now }}>
          Today
        </span>
      ) : null}
    </div>
  );
}

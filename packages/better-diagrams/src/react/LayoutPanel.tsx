/**
 * LayoutPanel.tsx — how good the picture is, and ways to make it better.
 *
 * A score and what is behind it, fixes that keep the arrangement, and the
 * different arrangements this document could take, drawn small so they can be
 * compared by looking. Everything here is one undoable edit, so trying something
 * costs nothing. Presentational: the studio owns the document and applies changes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  LAYOUT_RULES,
  buildScene,
  lintLayout,
  type LayoutFinding,
  type LayoutReport,
  type LintLayoutOptions,
} from "../contract/layout-lint";
import { layoutCandidates, layoutGaps, type ArrangeOptions, type LayoutCandidate } from "../contract/arrange";
import {
  LAYOUT_ALGORITHMS,
  LAYOUT_DIRECTIONS,
  LAYOUT_ENDS,
  LAYOUT_GAP_RANGE,
  LAYOUT_SHAPES,
  LAYOUT_SPACINGS,
  type DiagramTemplate,
  type LayoutAlgorithm,
  type LayoutDirection,
  type LayoutEnds,
  type LayoutPreferences,
  type LayoutShape,
  type LayoutSpacing,
} from "../contract/schema";
import { UiIcon } from "./ui-icons";

export interface LayoutState {
  kind: "layout";
  /** The finding being pointed at, which the canvas shows by dimming the rest. */
  pointing?: LayoutFinding | null;
}

/** Past this many boxes the gallery waits to be asked: every candidate is a full layout. */
const GALLERY_LIMIT = 120;

/** How many findings of one rule are listed; the count beside the rule is all of them. */
const FINDINGS_SHOWN = 60;

/** How long the document has to stay still before the panel measures it again. */
const SETTLE_MS = 250;

/**
 * The document once it has stopped changing. A drag hands the panel a new one on
 * every frame and a click hands it one with the same contents, and each card in
 * the gallery is a full layout: measuring all of those would stall the canvas for
 * as long as the panel is open. A document with the same contents keeps the one
 * already measured.
 */
function useSettled(template: DiagramTemplate): DiagramTemplate {
  const [settled, setSettled] = useState(template);
  const settledText = useRef<string | null>(null);
  useEffect(() => {
    if (template === settled) return;
    const timer = setTimeout(() => {
      settledText.current ??= JSON.stringify(settled);
      const text = JSON.stringify(template);
      if (text === settledText.current) return;
      settledText.current = text;
      setSettled(template);
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [template, settled]);
  return settled;
}

const ALGORITHM_LABEL: Record<LayoutAlgorithm, { label: string; title: string }> = {
  auto: { label: "Best fit", title: "Try every family that suits this diagram and keep what measures best" },
  layered: { label: "Layered", title: "Ranks along one direction, for flows and pipelines" },
  tree: { label: "Tree", title: "A tidy hierarchy, each parent centred on its children" },
  radial: { label: "Radial", title: "Rings around the best-connected box" },
  organic: { label: "Organic", title: "Connected boxes pull together, for a mesh with no direction" },
  grid: { label: "Grid", title: "Rows and columns, for boxes with little joining them" },
};
const DIRECTION_LABEL: Record<LayoutDirection, { label: string; title: string }> = {
  auto: { label: "Auto", title: "Measure the options and keep the better one" },
  right: { label: "→", title: "Left to right" },
  down: { label: "↓", title: "Top to bottom" },
  left: { label: "←", title: "Right to left" },
  up: { label: "↑", title: "Bottom to top" },
};
const INNER_LABEL: Record<LayoutDirection, { label: string; title: string }> = {
  auto: { label: "Auto", title: "Inside: measure the options and keep the better one" },
  right: { label: "→", title: "Inside: left to right" },
  down: { label: "↓", title: "Inside: top to bottom" },
  left: { label: "←", title: "Inside: right to left" },
  up: { label: "↑", title: "Inside: bottom to top" },
};
const SHAPE_LABEL: Record<LayoutShape, { label: string; title: string }> = {
  any: { label: "Any", title: "No target: the diagram comes out the shape its structure has" },
  wide: { label: "Wide", title: "Aim for a wide picture, for a slide" },
  tall: { label: "Tall", title: "Aim for a tall picture, for a sidebar or a page" },
  square: { label: "Square", title: "Aim for a square picture" },
};
const ENDS_LABEL: Record<LayoutEnds, { label: string; title: string }> = {
  spread: { label: "Spread", title: "Each line gets its own place on a box, so it can be followed from the start" },
  bundled: { label: "Bundled", title: "Lines meeting one side stay tight together, so a fan reads as one thing that divides" },
};
const SPACING_LABEL: Record<LayoutSpacing, { label: string; title: string }> = {
  compact: { label: "Compact", title: "Boxes closer together" },
  normal: { label: "Normal", title: "The default spacing" },
  airy: { label: "Airy", title: "More room around everything" },
};

/** A choice, or undefined to go back to letting the document decide. */
export type LayoutPatch = { [K in keyof LayoutPreferences]?: LayoutPreferences[K] | undefined };

export interface LayoutPanelProps {
  template: DiagramTemplate;
  /** Which canvas is on screen, and what the arrangements need to know about it. */
  options: ArrangeOptions & LintLayoutOptions;
  canEdit: boolean;
  /** How many boxes are selected, for Arrange selection. */
  selected: number;
  /** How many lines are selected, for Straighten. */
  selectedLines: number;
  onPrefs: (patch: LayoutPatch) => void;
  onArrange: () => void;
  onPolish: () => void;
  onArrangeSelection: () => void;
  onStraighten: () => void;
  onCandidate: (candidate: LayoutCandidate) => void;
  onJump: (finding: LayoutFinding) => void;
  /** Show this finding on the canvas, or stop. */
  onPoint: (finding: LayoutFinding | null) => void;
  onClose: () => void;
}

/**
 * What's behind the number, counted: the score bends as it falls, so the counts
 * are what tell a picture with a handful of problems from one with hundreds.
 */
function problemCount(report: LayoutReport): string {
  const by = { error: 0, warning: 0, info: 0 };
  for (const f of report.findings) by[f.severity] += 1;
  const part = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : null);
  return [part(by.error, "error", "errors"), part(by.warning, "warning", "warnings"), part(by.info, "note", "notes")].filter(Boolean).join(", ");
}

function scoreWord(score: number): string {
  if (score >= 95) return "Reads cleanly";
  if (score >= 80) return "A few rough spots";
  if (score >= 60) return "Hard to read in places";
  return "Needs arranging";
}

export function LayoutPanel({
  template,
  options,
  canEdit,
  selected,
  selectedLines,
  onPrefs,
  onArrange,
  onPolish,
  onArrangeSelection,
  onStraighten,
  onCandidate,
  onJump,
  onPoint,
  onClose,
}: LayoutPanelProps) {
  const measured = useSettled(template);
  const report = useMemo(() => lintLayout(measured, options), [measured, options]);
  // The choices show what was just picked, not what was last measured.
  const prefs = template.settings?.layout ?? {};
  // Arrange follows how the document says it is arranged, which the choices only steer when that is "auto".
  const mode = template.settings?.arrange ?? "auto";
  // The sliders start where an arrangement would put the gaps, so a nudge is a nudge from there.
  const gaps = layoutGaps(template, options);

  return (
    <div className="as-panel as-panel--paths as-layout" role="region" aria-label="Layout">
      <div className="as-panel__head">
        <h2 className="as-panel__title">Layout</h2>
        <button type="button" className="as-btn as-btn--icon" onClick={onClose} aria-label="Close layout panel">
          <UiIcon name="close" />
        </button>
      </div>

      <div className="as-layout__score" role="status" aria-label={`Layout score ${report.score} out of 100`}>
        <span className="as-layout__number">{report.score}</span>
        <span className="as-layout__scoretext">
          <span className="as-layout__scoreword">{scoreWord(report.score)}</span>
          {report.findings.length ? <span className="as-paths__hint">{problemCount(report)}</span> : null}
          <span className="as-paths__hint">
            {report.metrics.boxes} boxes, {report.metrics.lines} lines, {Math.round(report.metrics.width)} × {Math.round(report.metrics.height)}
            {report.metrics.zoom < 0.995 ? `, fits a window at ${Math.round(report.metrics.zoom * 100)}%` : ""}
          </span>
        </span>
      </div>

      {canEdit ? (
        <div className="as-layout__actions">
          <button type="button" className="as-btn as-btn--primary" onClick={onArrange}
            title={
              mode === "auto"
                ? "Place everything from the graph, using the choices below"
                : "Arrange again the way this diagram is set to be arranged. Picking a choice below switches it to them"
            }
          >
            Arrange
          </button>
          <button type="button" className="as-btn" onClick={onPolish} title="Keep this arrangement. Line up what's nearly in line, clear overlaps, and route lines and labels around what's in the way">
            Polish
          </button>
          <button
            type="button"
            className="as-btn"
            disabled={selected < 2}
            onClick={onArrangeSelection}
            title={selected < 2 ? "Select at least two boxes" : "Arrange only the selected boxes, around where they are now"}
          >
            Selection
          </button>
          <button
            type="button"
            className="as-btn"
            disabled={selectedLines < 1}
            onClick={onStraighten}
            title={selectedLines < 1 ? "Select a line to straighten" : "Move a box so the selected lines run dead straight"}
          >
            Straighten
          </button>
        </div>
      ) : null}

      {canEdit ? (
        <>
          <Choice
            caption="Style"
            options={LAYOUT_ALGORITHMS}
            labels={ALGORITHM_LABEL}
            value={prefs.algorithm ?? "auto"}
            onPick={(algorithm) => onPrefs({ algorithm })}
          />
          <Choice
            caption="Direction"
            options={LAYOUT_DIRECTIONS}
            labels={DIRECTION_LABEL}
            value={prefs.direction ?? "auto"}
            onPick={(direction) => onPrefs({ direction })}
          />
          <Choice
            caption="Inside groups and zones"
            options={LAYOUT_DIRECTIONS}
            labels={INNER_LABEL}
            value={prefs.inner ?? "auto"}
            onPick={(inner) => onPrefs({ inner })}
          />
          <Choice
            caption="Shape"
            options={LAYOUT_SHAPES}
            labels={SHAPE_LABEL}
            value={prefs.shape ?? "any"}
            onPick={(shape) => onPrefs({ shape })}
          />
          <Choice
            caption="Spacing"
            options={LAYOUT_SPACINGS}
            labels={SPACING_LABEL}
            value={prefs.spacing ?? "normal"}
            onPick={(spacing) => onPrefs({ spacing, rankGap: undefined, nodeGap: undefined })}
          />
          <Choice
            caption="Line ends"
            options={LAYOUT_ENDS}
            labels={ENDS_LABEL}
            value={prefs.ends ?? "spread"}
            onPick={(ends) => onPrefs({ ends })}
          />
          <Gap
            label="Between ranks"
            title="Room between one rank and the next"
            value={gaps.rankGap}
            onCommit={(rankGap) => onPrefs({ rankGap })}
          />
          <Gap
            label="Between boxes"
            title="Room between the boxes in a rank"
            value={gaps.nodeGap}
            onCommit={(nodeGap) => onPrefs({ nodeGap })}
          />
        </>
      ) : null}

      {canEdit ? <Gallery template={measured} options={options} onPick={onCandidate} /> : null}

      <Findings report={report} onJump={onJump} onPoint={onPoint} />
    </div>
  );
}

function Choice<T extends string>({
  caption,
  options,
  labels,
  value,
  onPick,
}: {
  caption: string;
  options: readonly T[];
  labels: Record<T, { label: string; title: string }>;
  value: T;
  onPick: (value: T) => void;
}) {
  return (
    <div className="as-layout__choice">
      <div className="as-paths__caption">{caption}</div>
      <div className="as-seg as-layout__seg" role="group" aria-label={caption}>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            className={`as-btn${value === option ? " as-btn--on" : ""}`}
            aria-pressed={value === option}
            title={labels[option].title}
            // Words name themselves, and the title says more; an arrow needs saying.
            aria-label={/^[\p{L}\p{N} ]+$/u.test(labels[option].label) ? undefined : labels[option].title}
            onClick={() => onPick(option)}
          >
            {labels[option].label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A gap, applied when the slider is let go. Every change is a whole layout and one
 * undo step, so it waits for the drag to finish rather than arranging on every pixel.
 */
function Gap({
  label,
  title,
  value,
  onCommit,
}: {
  label: string;
  title: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <label className="as-layout__gap" title={title}>
      <span className="as-paths__caption">{label}</span>
      <input
        type="range"
        min={LAYOUT_GAP_RANGE.min}
        // Wide enough for most; a document that stores more still shows where it is.
        max={Math.max(Math.min(LAYOUT_GAP_RANGE.max, 320), value)}
        step={4}
        value={shown}
        aria-label={label}
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="as-layout__gapvalue">{shown}</span>
    </label>
  );
}

/** The arrangements this document could take, drawn small. */
function Gallery({
  template,
  options,
  onPick,
}: {
  template: DiagramTemplate;
  options: ArrangeOptions & LintLayoutOptions;
  onPick: (candidate: LayoutCandidate) => void;
}) {
  const large = template.nodes.length > GALLERY_LIMIT;
  const [asked, setAsked] = useState(false);
  const show = !large || asked;
  const candidates = useMemo(() => (show ? layoutCandidates(template, options) : []), [show, template, options]);
  return (
    <div className="as-paths__section">
      <div className="as-paths__caption">Other arrangements</div>
      {!show ? (
        <button type="button" className="as-btn" onClick={() => setAsked(true)}>
          Compare arrangements
        </button>
      ) : (
        <div className="as-layout__gallery">
          {candidates.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className="as-layout__card"
              title={`Use this arrangement: ${candidate.label}, scoring ${candidate.report.score}`}
              onClick={() => onPick(candidate)}
            >
              <Thumbnail template={candidate.template} options={options} />
              <span className="as-layout__cardname">
                {candidate.label}
                <span className="as-layout__cardscore">{candidate.report.score}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Thumbnail({ template, options }: { template: DiagramTemplate; options: ArrangeOptions & LintLayoutOptions }) {
  const frame = typeof options.frames === "object" ? options.frames.drill : null;
  const scene = useMemo(
    () => buildScene(template, { containerKinds: options.containerKinds, frame }),
    [template, options.containerKinds, frame],
  );
  const rects = [...scene.zones, ...scene.boxes];
  if (!rects.length) return <svg className="as-layout__thumb" aria-hidden="true" />;
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.w));
  const maxY = Math.max(...rects.map((r) => r.y + r.h));
  const pad = Math.max(maxX - minX, maxY - minY) * 0.03;
  return (
    <svg
      className="as-layout__thumb"
      aria-hidden="true"
      viewBox={`${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {scene.zones.map((z) => (
        <rect key={z.id} className="as-layout__thumbzone" x={z.x} y={z.y} width={z.w} height={z.h} rx={10} />
      ))}
      {scene.boxes
        .filter((b) => b.frame)
        .map((b) => (
          <rect key={b.id} className="as-layout__thumbframe" x={b.x} y={b.y} width={b.w} height={b.h} rx={8} />
        ))}
      {scene.lines.map((line) => (
        <polyline key={line.edge.id} className="as-layout__thumbline" points={line.samples.map((p) => `${p.x},${p.y}`).join(" ")} />
      ))}
      {scene.boxes
        .filter((b) => !b.frame)
        .map((b) => (
          <rect key={b.id} className="as-layout__thumbbox" x={b.x} y={b.y} width={b.w} height={b.h} rx={8} />
        ))}
    </svg>
  );
}

function Findings({
  report,
  onJump,
  onPoint,
}: {
  report: LayoutReport;
  onJump: (finding: LayoutFinding) => void;
  onPoint: (finding: LayoutFinding | null) => void;
}) {
  const groups = useMemo(() => {
    const byRule = new Map<LayoutFinding["rule"], LayoutFinding[]>();
    for (const f of report.findings) {
      const g = byRule.get(f.rule);
      if (g) g.push(f);
      else byRule.set(f.rule, [f]);
    }
    return [...byRule.entries()];
  }, [report]);
  // A finding that is pointed at can go away under the pointer (an undo, a
  // polish, a pick), and then nothing leaves or blurs to say so.
  const point = useRef(onPoint);
  point.current = onPoint;
  useEffect(() => () => point.current(null), [report]);
  if (!groups.length) {
    return <p className="as-paths__empty">Nothing to fix. No overlaps, nothing in the way of a line, no label on top of anything.</p>;
  }
  return (
    <div className="as-paths__section">
      <div className="as-paths__caption">What the checks found</div>
      {groups.map(([rule, findings]) => (
        <details key={rule} className="as-layout__group">
          <summary title={LAYOUT_RULES[rule].description}>
            <span className={`as-layout__dot as-layout__dot--${LAYOUT_RULES[rule].severity}`} />
            {LAYOUT_RULES[rule].label}
            <span className="as-layout__count">{findings.length}</span>
          </summary>
          <p className="as-paths__hint">{LAYOUT_RULES[rule].description}</p>
          <ul className="as-layout__list">
            {findings.slice(0, FINDINGS_SHOWN).map((finding, i) => (
              <li key={i}>
                <button
                  type="button"
                  className="as-layout__item"
                  onClick={() => onJump(finding)}
                  onPointerEnter={() => onPoint(finding)}
                  onPointerLeave={() => onPoint(null)}
                  onFocus={() => onPoint(finding)}
                  onBlur={() => onPoint(null)}
                >
                  {finding.message}
                </button>
              </li>
            ))}
          </ul>
          {findings.length > FINDINGS_SHOWN ? <p className="as-paths__hint">and {findings.length - FINDINGS_SHOWN} more</p> : null}
        </details>
      ))}
    </div>
  );
}

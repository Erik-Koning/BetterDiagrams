/**
 * LineagePanel.tsx — where a column's values come from, and where they go.
 *
 * The subject column, which way (upstream to what it is computed from,
 * downstream to what it feeds, or both) and how many links deep. Columns are
 * listed by direction and distance with the transform that made them; point
 * at one and its chain from the subject stands out among the lineage lines
 * on the canvas. A column a sensitive column's values reach without carrying
 * a sensitive tag says so. Presentational: the analysis sidebar runs
 * `traceLineage` (contract/lineage.ts) and draws the lines.
 */
import type { FieldRef } from "../contract/fields";
import { fieldKey } from "../contract/fields";
import { lineageHeadline, type LineageLink, type LineageTrace } from "../contract/lineage";
import { UiIcon } from "./ui-icons";
import { plural } from "./analysis-text";

export interface LineageState {
  kind: "lineage";
  subject: FieldRef;
  direction: "upstream" | "downstream" | "both";
  maxDepth: number | null;
}

export interface LineagePanelProps {
  state: LineageState;
  trace: LineageTrace;
  links: ReadonlyMap<string, LineageLink>;
  /** `fieldKey`s of columns sensitive values reach without a sensitive tag. */
  untagged: ReadonlySet<string>;
  /** `fieldKey`s of traced columns the model doesn't list. */
  missing?: ReadonlySet<string>;
  nodeLabel: (id: string) => string;
  onChange: (patch: Partial<LineageState>) => void;
  onNavigateField: (ref: FieldRef) => void;
  onHover: (ref: FieldRef | null) => void;
  onClose: () => void;
}

const LIST_CAP = 500;
const DIRECTIONS: Array<{ id: LineageState["direction"]; label: string; title: string }> = [
  { id: "both", label: "Both", title: "Where it comes from and where it goes" },
  { id: "upstream", label: "Upstream", title: "The columns it is computed from" },
  { id: "downstream", label: "Downstream", title: "The columns it feeds" },
];

export function LineagePanel({ state, trace, links, untagged, missing, nodeLabel, onChange, onNavigateField, onHover, onClose }: LineagePanelProps) {
  const col = (ref: FieldRef) => `${nodeLabel(ref.nodeId)}.${ref.fieldId}`;
  const section = (dir: "upstream" | "downstream") => {
    const columns = trace.columns.filter((c) => c.direction === dir);
    if (!columns.length) return null;
    const title = dir === "upstream" ? "Comes from" : "Flows into";
    return (
      <section className="as-paths__section" aria-label={title}>
        <h3 className="as-paths__caption">
          {title} <span className="as-paths__count">{columns.length}</span>
        </h3>
        <ul className="as-paths__list">
          {columns.slice(0, LIST_CAP).map((c) => {
            const link = links.get(c.via);
            const detail = [c.depth > 1 ? plural(c.depth, "link") : "", link?.transform ?? "", link?.job ? `· ${link.job}` : ""].filter(Boolean).join(" ");
            return (
              <li key={fieldKey(c.ref)}>
                <button
                  type="button"
                  className="as-paths__item"
                  title={`Go to ${col(c.ref)}`}
                  onClick={() => onNavigateField(c.ref)}
                  onMouseEnter={() => onHover(c.ref)}
                  onMouseLeave={() => onHover(null)}
                  onFocus={() => onHover(c.ref)}
                  onBlur={() => onHover(null)}
                >
                  <span className="as-paths__itemlabel">{col(c.ref)}</span>
                  {missing?.has(fieldKey(c.ref)) ? (
                    <span className="as-impact__badge" title="A lineage link names this column, but its table doesn't list it — renamed or dropped?">
                      not in the model
                    </span>
                  ) : null}
                  {untagged.has(fieldKey(c.ref)) ? (
                    <span className="as-impact__badge as-impact__badge--cascade" title="Sensitive values reach this column, which carries no sensitive tag">
                      untagged
                    </span>
                  ) : null}
                  {detail ? <span className="as-paths__itemdetail">{detail}</span> : null}
                </button>
              </li>
            );
          })}
          {columns.length > LIST_CAP ? <li className="as-paths__more">… and {columns.length - LIST_CAP} more</li> : null}
        </ul>
      </section>
    );
  };
  return (
    <div className="as-panel as-panel--paths" role="region" aria-label="Lineage">
      <div className="as-panel__head">
        <h2 className="as-panel__title">Lineage</h2>
        <button type="button" className="as-btn as-btn--icon" onClick={onClose} aria-label="Close lineage panel">
          <UiIcon name="close" />
        </button>
      </div>
      <div className="as-paths__pins">
        <button type="button" className="as-chip as-chip--on" title={`Go to ${col(state.subject)}`} onClick={() => onNavigateField(state.subject)}>
          {col(state.subject)}
        </button>
      </div>
      <div className="as-paths__controls">
        <div className="as-seg" role="group" aria-label="Direction">
          {DIRECTIONS.map((d) => (
            <button
              key={d.id}
              type="button"
              title={d.title}
              className={`as-btn${state.direction === d.id ? " as-btn--on" : ""}`}
              aria-pressed={state.direction === d.id}
              onClick={() => onChange({ direction: d.id })}
            >
              {d.label}
            </button>
          ))}
        </div>
        <div className="as-seg" role="group" aria-label="Depth">
          <span className="as-seg__caption">Links</span>
          {([1, 2, 3, null] as const).map((d) => (
            <button
              key={String(d)}
              type="button"
              className={`as-btn${state.maxDepth === d ? " as-btn--on" : ""}`}
              aria-pressed={state.maxDepth === d}
              onClick={() => onChange({ maxDepth: d })}
            >
              {d ?? "All"}
            </button>
          ))}
        </div>
      </div>
      <p className="as-paths__hint" role="status">
        {lineageHeadline(trace)}
        {trace.truncated ? " — more beyond this depth" : ""}
      </p>
      {trace.columns.length ? (
        <>
          {section("upstream")}
          {section("downstream")}
        </>
      ) : (
        <p className="as-paths__empty">No lineage reaches this column{state.direction === "both" ? "" : ` ${state.direction}`}.</p>
      )}
    </div>
  );
}

/**
 * ImpactPanel.tsx — what depends on a table or a key, in the left sidebar.
 *
 * The subject, which way (what depends on it, or what it depends on), how
 * far, and whether only keys count. The headline says how many and how many
 * a delete would cascade to; blockers — keys whose delete rule refuses — are
 * listed first; then every table by distance, with the key that reached it.
 * Hover a table and the chain from the subject to it lights. Download CSV
 * takes the list. Presentational: the analysis sidebar runs `impactOf`.
 */
import type { Pin } from "../contract/fields";
import { impactHeadline, type ImpactResult } from "../contract/impact";
import { UiIcon } from "./ui-icons";
import { impactCsv } from "./analysis-text";

export interface ImpactState {
  kind: "impact";
  subject: Pin;
  direction: "dependents" | "dependencies";
  maxDepth: number | null;
  via: "keys" | "all";
}

export interface ImpactPanelProps {
  state: ImpactState;
  result: ImpactResult;
  subjectLabel: string;
  nodeLabel: (id: string) => string;
  onChange: (patch: Partial<ImpactState>) => void;
  onNavigate: (nodeId: string) => void;
  /** A table under the pointer: light the chain from the subject to it. */
  onHover: (nodeId: string | null) => void;
  onDownload: (csv: string) => void;
  onClose: () => void;
  /** Keep this analysis with the model (a saved analysis). Absent, no Save button. */
  onSave?: () => void;
}

const LIST_CAP = 500;

export function ImpactPanel({ state, result, subjectLabel, nodeLabel, onChange, onNavigate, onHover, onDownload, onClose, onSave }: ImpactPanelProps) {
  const byId = new Map(result.nodes.map((n) => [n.id, n]));
  const row = (id: string, detail: string, badges: string[]) => (
    <li key={id}>
      <button
        type="button"
        className="as-paths__item"
        title={`Go to ${nodeLabel(id)}`}
        onClick={() => onNavigate(id)}
        onMouseEnter={() => onHover(id)}
        onMouseLeave={() => onHover(null)}
        onFocus={() => onHover(id)}
        onBlur={() => onHover(null)}
      >
        <span className="as-paths__itemlabel">{nodeLabel(id)}</span>
        {badges.map((b) => (
          <span key={b} className={`as-impact__badge as-impact__badge--${b}`}>
            {b}
          </span>
        ))}
        <span className="as-paths__itemdetail">{detail}</span>
      </button>
    </li>
  );
  const via = (id: string) => {
    const n = byId.get(id);
    return n ? `via ${nodeLabel(n.via.from)}${n.via.field ? `.${n.via.field}` : ""}` : "";
  };
  return (
    <div className="as-panel as-panel--paths" role="region" aria-label="Impact">
      <div className="as-panel__head">
        <h2 className="as-panel__title">Impact</h2>
        <button type="button" className="as-btn" disabled={!result.nodes.length} onClick={() => onDownload(impactCsv(result, nodeLabel))}>
          Download CSV
        </button>
        {onSave ? (
          <button type="button" className="as-btn" title="Keep this analysis with the model, to open and re-run later" onClick={onSave}>
            Save…
          </button>
        ) : null}
        <button type="button" className="as-btn as-btn--icon" onClick={onClose} aria-label="Close impact panel">
          <UiIcon name="close" />
        </button>
      </div>
      <div className="as-paths__pins">
        <button type="button" className="as-chip as-chip--on" title={`Go to ${subjectLabel}`} onClick={() => onNavigate(state.subject.nodeId)}>
          {subjectLabel}
        </button>
      </div>
      <div className="as-paths__controls">
        <div className="as-seg" role="group" aria-label="Direction">
          {(["dependents", "dependencies"] as const).map((d) => (
            <button
              key={d}
              type="button"
              className={`as-btn${state.direction === d ? " as-btn--on" : ""}`}
              aria-pressed={state.direction === d}
              title={d === "dependents" ? "What depends on it — what a change or a delete reaches" : "What it depends on"}
              onClick={() => onChange({ direction: d })}
            >
              {d === "dependents" ? "Dependents" : "Dependencies"}
            </button>
          ))}
        </div>
        <div className="as-seg" role="group" aria-label="Depth">
          <span className="as-seg__caption">Hops</span>
          {[1, 2, 3, null].map((d) => (
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
        <label className="as-check" title="Walk only lines that carry a key; off, any line counts">
          <input type="checkbox" checked={state.via === "keys"} onChange={(event) => onChange({ via: event.target.checked ? "keys" : "all" })} />
          Keys only
        </label>
      </div>
      <p className="as-paths__hint" role="status">{impactHeadline(result, subjectLabel)}</p>
      {result.blockers.length ? (
        <section className="as-paths__section" aria-label="Would block a delete">
          <h3 className="as-paths__caption">
            Would block a delete <span className="as-paths__count">{result.blockers.length}</span>
          </h3>
          <ul className="as-paths__list">{result.blockers.map((b) => row(b.from, b.field ? `${b.field}: restrict` : "restrict", []))}</ul>
        </section>
      ) : null}
      {result.byDepth.length ? (
        result.byDepth.map((ids, i) => (
          <section key={i} className="as-paths__section" aria-label={`${i + 1} hop${i === 0 ? "" : "s"} away`}>
            <h3 className="as-paths__caption">
              {i + 1} hop{i === 0 ? "" : "s"} away <span className="as-paths__count">{ids.length}</span>
            </h3>
            <ul className="as-paths__list">
              {ids.slice(0, LIST_CAP).map((id) => {
                const n = byId.get(id)!;
                return row(id, via(id), [...(n.cascade ? ["cascade"] : []), ...(n.required ? ["required"] : []), ...(result.outsideModel.includes(id) ? ["external"] : [])]);
              })}
              {ids.length > LIST_CAP ? <li className="as-paths__more">… and {ids.length - LIST_CAP} more</li> : null}
            </ul>
          </section>
        ))
      ) : (
        <p className="as-paths__empty">
          {state.direction === "dependents" ? "Nothing depends on it" : "It depends on nothing"}
          {state.via === "keys" ? " through a key" : ""}.
        </p>
      )}
    </div>
  );
}

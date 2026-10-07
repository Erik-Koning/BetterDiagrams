/**
 * NeighbourhoodPanel.tsx — "this table and everything within N joins".
 *
 * The focus (one table, or several), a depth, a direction — out along the
 * keys a table carries, in along the keys pointing at it, or both — and
 * whether only keys count or any line does. The canvas dims to the set; the
 * list groups it by distance, every table a jump, and any of them can become
 * the new focus. Presentational: the studio's analysis sidebar owns the
 * state and runs `neighbourhood` (contract/graph.ts).
 */
import { UiIcon } from "./ui-icons";
import { neighbourhoodHeadline } from "./analysis-text";

export interface NeighbourhoodState {
  kind: "neighbourhood";
  from: string[];
  depth: number;
  direction: "out" | "in" | "both";
  keysOnly: boolean;
}

export interface NeighbourhoodPanelProps {
  state: NeighbourhoodState;
  /** Every node reached, with its distance (0 for a focus). */
  reached: ReadonlyMap<string, number>;
  nodeLabel: (id: string) => string;
  onChange: (patch: Partial<NeighbourhoodState>) => void;
  onNavigate: (nodeId: string) => void;
  onClose: () => void;
  /** Keep this analysis with the model (a saved analysis). Absent, no Save button. */
  onSave?: () => void;
}

const LIST_CAP = 500;
const DIRECTIONS: Array<{ id: NeighbourhoodState["direction"]; label: string; title: string }> = [
  { id: "both", label: "Both", title: "Keys either way" },
  { id: "out", label: "Out", title: "The tables it references" },
  { id: "in", label: "In", title: "The tables referencing it" },
];


export function NeighbourhoodPanel({ state, reached, nodeLabel, onChange, onNavigate, onClose, onSave }: NeighbourhoodPanelProps) {
  const byDistance = new Map<number, string[]>();
  for (const [id, d] of reached) {
    if (d === 0) continue;
    const list = byDistance.get(d);
    if (list) list.push(id);
    else byDistance.set(d, [id]);
  }
  const others = [...byDistance.values()].reduce((n, l) => n + l.length, 0);
  return (
    <div className="as-panel as-panel--paths" role="region" aria-label="Neighbourhood">
      <div className="as-panel__head">
        <h2 className="as-panel__title">Neighbourhood</h2>
        {onSave ? (
          <button type="button" className="as-btn" title="Keep this analysis with the model, to open and re-run later" onClick={onSave}>
            Save…
          </button>
        ) : null}
        <button type="button" className="as-btn as-btn--icon" onClick={onClose} aria-label="Close neighbourhood panel">
          <UiIcon name="close" />
        </button>
      </div>
      <div className="as-paths__pins">
        {state.from.map((id) => (
          <button key={id} type="button" className="as-chip as-chip--on" title={`Go to ${nodeLabel(id)}`} onClick={() => onNavigate(id)}>
            {nodeLabel(id)}
          </button>
        ))}
      </div>
      <div className="as-paths__controls">
        <div className="as-seg" role="group" aria-label="Depth">
          <span className="as-seg__caption">Joins</span>
          {[1, 2, 3].map((d) => (
            <button key={d} type="button" className={`as-btn${state.depth === d ? " as-btn--on" : ""}`} aria-pressed={state.depth === d} onClick={() => onChange({ depth: d })}>
              {d}
            </button>
          ))}
        </div>
        <div className="as-seg" role="group" aria-label="Direction">
          {DIRECTIONS.map((dir) => (
            <button
              key={dir.id}
              type="button"
              title={dir.title}
              className={`as-btn${state.direction === dir.id ? " as-btn--on" : ""}`}
              aria-pressed={state.direction === dir.id}
              onClick={() => onChange({ direction: dir.id })}
            >
              {dir.label}
            </button>
          ))}
        </div>
        <label className="as-check" title="Walk only lines that carry a key; off, any line counts">
          <input type="checkbox" checked={state.keysOnly} onChange={(event) => onChange({ keysOnly: event.target.checked })} />
          Keys only
        </label>
      </div>
      <p className="as-paths__hint" role="status">{neighbourhoodHeadline(others, state.depth)}</p>
      {others ? (
        [...byDistance.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([d, ids]) => (
            <section key={d} className="as-paths__section" aria-label={`${d} join${d === 1 ? "" : "s"} away`}>
              <h3 className="as-paths__caption">
                {d} join{d === 1 ? "" : "s"} away <span className="as-paths__count">{ids.length}</span>
              </h3>
              <ul className="as-paths__list">
                {ids.slice(0, LIST_CAP).map((id) => (
                  <li key={id} className="as-analysis__row">
                    <button type="button" className="as-paths__item" title={`Go to ${nodeLabel(id)}`} onClick={() => onNavigate(id)}>
                      <span className="as-paths__itemlabel">{nodeLabel(id)}</span>
                    </button>
                    <button
                      type="button"
                      className="as-btn as-analysis__rowaction"
                      title={`Focus the neighbourhood on ${nodeLabel(id)}`}
                      onClick={() => onChange({ from: [id] })}
                    >
                      Focus
                    </button>
                  </li>
                ))}
                {ids.length > LIST_CAP ? <li className="as-paths__more">… and {ids.length - LIST_CAP} more</li> : null}
              </ul>
            </section>
          ))
      ) : (
        <p className="as-paths__empty">Nothing is within {state.depth} join{state.depth === 1 ? "" : "s"}{state.keysOnly ? " over keys" : ""}.</p>
      )}
    </div>
  );
}

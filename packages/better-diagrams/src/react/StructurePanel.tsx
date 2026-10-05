/**
 * StructurePanel.tsx — the shape of the model: its hubs, the tables and keys
 * holding it together, and the domains it falls into.
 *
 * Three tabs. Hubs ranks tables by how many shortest routes run through them;
 * pointing at one dims the canvas to it and its direct neighbours. Bridges
 * lists the tables and keys whose loss splits the model. Domains lists the
 * suggested clusters — pick one to dim to it, colour every table by its
 * domain (a display pass, never the document), or select a domain's tables
 * so ⌘G can group them — and the tables whose keys lead mostly into another
 * group than their own. Presentational: the analysis sidebar runs
 * `modelStructure` (contract/structure.ts) and summarises it.
 */
import type { StructureSummary } from "../contract/structure";
import { EDGE_COLOR_HEX } from "../contract/schema";
import { UiIcon } from "./ui-icons";
import { domainColor, plural, structureHeadline } from "./analysis-text";

export interface StructureState {
  kind: "structure";
  tab: "hubs" | "bridges" | "domains";
  /** Colour every table by its suggested domain. */
  tint: boolean;
  /** The domain the canvas dims to, if any. */
  domain: string | null;
}

export interface StructurePanelProps {
  state: StructureState;
  summary: StructureSummary;
  nodeLabel: (id: string) => string;
  onChange: (patch: Partial<StructureState>) => void;
  onNavigate: (nodeId: string) => void;
  /** Point at a hub (or a bridge's table) — null when the pointer leaves. */
  onHover: (nodeId: string | null) => void;
  /** Select these tables on the canvas. Absent, the Select action is not offered. */
  onSelect?: (nodeIds: readonly string[]) => void;
  onClose: () => void;
}

const LIST_CAP = 300;
const TABS: Array<{ id: StructureState["tab"]; label: string }> = [
  { id: "hubs", label: "Hubs" },
  { id: "bridges", label: "Bridges" },
  { id: "domains", label: "Domains" },
];

export function StructurePanel({ state, summary, nodeLabel, onChange, onNavigate, onHover, onSelect, onClose }: StructurePanelProps) {
  const top = summary.hubs[0]?.centrality || 1;
  const hover = (id: string) => ({ onMouseEnter: () => onHover(id), onMouseLeave: () => onHover(null), onFocus: () => onHover(id), onBlur: () => onHover(null) });
  return (
    <div className="as-panel as-panel--paths" role="region" aria-label="Model structure">
      <div className="as-panel__head">
        <h2 className="as-panel__title">Model structure</h2>
        <button type="button" className="as-btn as-btn--icon" onClick={onClose} aria-label="Close model structure panel">
          <UiIcon name="close" />
        </button>
      </div>
      <p className="as-paths__hint" role="status">
        {structureHeadline(summary)}
        {summary.approximate ? " · centrality estimated from a sample" : ""}
      </p>
      <div className="as-paths__controls">
        <div className="as-seg" role="tablist" aria-label="Structure view">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={state.tab === t.id}
              className={`as-btn${state.tab === t.id ? " as-btn--on" : ""}`}
              onClick={() => onChange({ tab: t.id })}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {state.tab === "hubs" ? (
        summary.hubs.length ? (
          <ul className="as-coverage__bars" aria-label="Hubs">
            {summary.hubs.slice(0, LIST_CAP).map((h) => (
              <li key={h.id}>
                <button type="button" className="as-coverage__bar" title={`Go to ${nodeLabel(h.id)}`} onClick={() => onNavigate(h.id)} {...hover(h.id)}>
                  <span className="as-coverage__barlabel">{nodeLabel(h.id)}</span>
                  <span className="as-coverage__track" aria-hidden="true">
                    <span className="as-coverage__fill" style={{ width: `${Math.round((h.centrality / top) * 100)}%` }} />
                  </span>
                  <span className="as-coverage__barvalue" title="Keys in and out">
                    {h.degree}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="as-paths__empty">No key joins two tables yet.</p>
        )
      ) : null}

      {state.tab === "bridges" ? (
        <>
          <section className="as-paths__section" aria-label="Tables holding the model together">
            <h3 className="as-paths__caption">
              Tables holding it together <span className="as-paths__count">{summary.articulation.length}</span>
            </h3>
            {summary.articulation.length ? (
              <ul className="as-paths__list">
                {summary.articulation.slice(0, LIST_CAP).map((a) => (
                  <li key={a.id}>
                    <button type="button" className="as-paths__item" title={`Go to ${nodeLabel(a.id)}`} onClick={() => onNavigate(a.id)} {...hover(a.id)}>
                      <span className="as-paths__itemlabel">{nodeLabel(a.id)}</span>
                      <span className="as-paths__itemdetail">without it: {a.splits} pieces</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="as-paths__empty">No single table’s loss would split the model.</p>
            )}
          </section>
          <section className="as-paths__section" aria-label="Bridge keys">
            <h3 className="as-paths__caption">
              Bridge keys <span className="as-paths__count">{summary.bridges.length}</span>
            </h3>
            {summary.bridges.length ? (
              <ul className="as-paths__list">
                {summary.bridges.slice(0, LIST_CAP).map((b) => (
                  <li key={b.edgeId}>
                    <button type="button" className="as-paths__item" title={`Go to ${nodeLabel(b.source)}`} onClick={() => onNavigate(b.source)} {...hover(b.source)}>
                      <span className="as-paths__itemlabel">
                        {nodeLabel(b.source)}
                        {b.field ? `.${b.field}` : ""} → {nodeLabel(b.target)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="as-paths__empty">Every key has another route around it.</p>
            )}
          </section>
          {summary.islands.length ? (
            <details className="as-paths__section">
              <summary className="as-paths__caption">
                No key joins them <span className="as-paths__count">{summary.islands.length}</span>
              </summary>
              <ul className="as-paths__list">
                {summary.islands.slice(0, LIST_CAP).map((id) => (
                  <li key={id}>
                    <button type="button" className="as-paths__item" onClick={() => onNavigate(id)}>
                      <span className="as-paths__itemlabel">{nodeLabel(id)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}

      {state.tab === "domains" ? (
        <>
          <div className="as-paths__controls">
            <label className="as-check" title="Outline every table in its domain’s colour — a view, not an edit">
              <input type="checkbox" checked={state.tint} onChange={(event) => onChange({ tint: event.target.checked })} />
              Colour tables by domain
            </label>
          </div>
          {summary.domains.length ? (
            <ul className="as-paths__list" aria-label="Domains">
              {summary.domains.slice(0, LIST_CAP).map((d, i) => {
                const on = state.domain === d.id;
                return (
                  <li key={d.id} className="as-analysis__row">
                    <button
                      type="button"
                      className={`as-paths__item${on ? " as-paths__item--on" : ""}`}
                      aria-pressed={on}
                      title={on ? "Show every table again" : `Dim the canvas to ${d.label}’s domain`}
                      onClick={() => onChange({ domain: on ? null : d.id })}
                    >
                      <span className="as-structure__swatch" style={{ background: EDGE_COLOR_HEX[domainColor(i)] }} aria-hidden="true" />
                      <span className="as-paths__itemlabel">{d.label}</span>
                      <span className="as-paths__itemdetail" title={`${d.internalKeys} keys inside, ${d.externalKeys} leading out`}>
                        {plural(d.tables.length, "table")} · {d.externalKeys} out
                      </span>
                    </button>
                    {onSelect ? (
                      <button
                        type="button"
                        className="as-btn as-analysis__rowaction"
                        title={`Select ${d.label}’s ${plural(d.tables.length, "table")} — ⌘G groups them`}
                        onClick={() => onSelect(d.tables)}
                      >
                        Select
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="as-paths__empty">{summary.shared.length ? "Every key runs through the shared tables." : "No key joins two tables yet."}</p>
          )}
          {summary.shared.length ? (
            <section className="as-paths__section" aria-label="Shared tables">
              <h3 className="as-paths__caption" title="So many tables point at these that they belong to no one domain">
                Shared by every domain <span className="as-paths__count">{summary.shared.length}</span>
              </h3>
              <ul className="as-paths__list">
                {summary.shared.slice(0, LIST_CAP).map((id) => (
                  <li key={id}>
                    <button type="button" className="as-paths__item" title={`Go to ${nodeLabel(id)}`} onClick={() => onNavigate(id)} {...hover(id)}>
                      <span className="as-paths__itemlabel">{nodeLabel(id)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {summary.unassigned.length ? (
            <details className="as-paths__section">
              <summary className="as-paths__caption">
                Joined only through shared tables <span className="as-paths__count">{summary.unassigned.length}</span>
              </summary>
              <ul className="as-paths__list">
                {summary.unassigned.slice(0, LIST_CAP).map((id) => (
                  <li key={id}>
                    <button type="button" className="as-paths__item" title={`Go to ${nodeLabel(id)}`} onClick={() => onNavigate(id)}>
                      <span className="as-paths__itemlabel">{nodeLabel(id)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {summary.misplaced.length ? (
            <section className="as-paths__section" aria-label="Misplaced tables">
              <h3 className="as-paths__caption">
                Keys lead elsewhere <span className="as-paths__count">{summary.misplaced.length}</span>
              </h3>
              <ul className="as-paths__list">
                {summary.misplaced.slice(0, LIST_CAP).map((m) => (
                  <li key={m.nodeId}>
                    <button type="button" className="as-paths__item" title={`Go to ${nodeLabel(m.nodeId)}`} onClick={() => onNavigate(m.nodeId)}>
                      <span className="as-paths__itemlabel">{nodeLabel(m.nodeId)}</span>
                      <span className="as-paths__itemdetail">
                        in {nodeLabel(m.group)}, {Math.round(m.share * 100)}% of keys to {nodeLabel(m.pullsToward)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

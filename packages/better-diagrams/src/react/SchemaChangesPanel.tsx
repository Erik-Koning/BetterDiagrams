/**
 * SchemaChangesPanel.tsx — what changed against the compare baseline, column
 * by column, in the left sidebar while Compare is open.
 *
 * Summary chips (breaking / caution / safe) filter the list; changes group
 * by table, breaking first, each with the one line a reviewer reads. The
 * report downloads as Markdown from the head. Presentational: the analysis
 * sidebar runs `schemaDiff` (contract/schema-diff.ts) against the baseline.
 */
import type { ChangeImpact, ColumnChange, SchemaDiff } from "../contract/schema-diff";
import { UiIcon } from "./ui-icons";
import { changesSummary } from "./analysis-text";

export interface SchemaChangesState {
  kind: "changes";
  impact: "all" | ChangeImpact;
}

export interface SchemaChangesPanelProps {
  state: SchemaChangesState;
  diff: SchemaDiff;
  nodeLabel: (id: string) => string;
  onChange: (patch: Partial<SchemaChangesState>) => void;
  onDownload: () => void;
  onClose: () => void;
}

const RANK: Record<ChangeImpact, number> = { breaking: 0, caution: 1, safe: 2 };

export function SchemaChangesPanel({ state, diff, nodeLabel, onChange, onDownload, onClose }: SchemaChangesPanelProps) {
  const shown = diff.columns.filter((c) => state.impact === "all" || c.impact === state.impact);
  const byTable = new Map<string, ColumnChange[]>();
  for (const c of shown) (byTable.get(c.nodeId) ?? byTable.set(c.nodeId, []).get(c.nodeId)!).push(c);
  const tables = [...byTable.entries()].sort((a, b) => Math.min(...a[1].map((c) => RANK[c.impact])) - Math.min(...b[1].map((c) => RANK[c.impact])));
  return (
    <div className="as-panel as-panel--paths" role="region" aria-label="Schema changes">
      <div className="as-panel__head">
        <h2 className="as-panel__title">Schema changes</h2>
        <button type="button" className="as-btn" onClick={onDownload} disabled={!diff.columns.length}>
          Report .md
        </button>
        <button type="button" className="as-btn as-btn--icon" onClick={onClose} aria-label="Close schema changes panel">
          <UiIcon name="close" />
        </button>
      </div>
      <p className="as-paths__hint" role="status">{changesSummary(diff.summary)}</p>
      <div className="as-seg" role="group" aria-label="Impact">
        {(["all", "breaking", "caution", "safe"] as const).map((impact) => (
          <button
            key={impact}
            type="button"
            className={`as-btn${state.impact === impact ? " as-btn--on" : ""}`}
            aria-pressed={state.impact === impact}
            onClick={() => onChange({ impact })}
          >
            {impact === "all" ? "All" : `${impact[0]!.toUpperCase()}${impact.slice(1)} ${diff.summary[impact]}`}
          </button>
        ))}
      </div>
      {diff.tables.renamed.length ? (
        <p className="as-paths__note">
          Possibly renamed: {diff.tables.renamed.map((r) => `${nodeLabel(r.from)} → ${nodeLabel(r.to)}`).join(", ")}
        </p>
      ) : null}
      {tables.length ? (
        tables.map(([nodeId, changes]) => (
          <section key={nodeId} className="as-paths__section" aria-label={nodeLabel(nodeId)}>
            <h3 className="as-paths__caption">
              {nodeLabel(nodeId)} <span className="as-paths__count">{changes.length}</span>
            </h3>
            <ul className="as-paths__list">
              {[...changes].sort((a, b) => RANK[a.impact] - RANK[b.impact]).map((c) => (
                <li key={`${c.kind}:${c.fieldId}`} className="as-paths__item as-changes__row">
                  <span className={`as-changes__impact as-changes__impact--${c.impact}`}>{c.impact}</span>
                  <span className="as-paths__itemlabel">{c.to?.name ?? c.from?.name ?? c.fieldId}</span>
                  <span className="as-paths__itemdetail" title={c.reason}>
                    {c.kind === "changed" ? c.reason : c.kind === "renamed" ? c.reason : c.reason === c.kind ? c.kind : `${c.kind} · ${c.reason}`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))
      ) : (
        <p className="as-paths__empty">{diff.columns.length ? "No change of this impact." : "No table or column changed."}</p>
      )}
    </div>
  );
}

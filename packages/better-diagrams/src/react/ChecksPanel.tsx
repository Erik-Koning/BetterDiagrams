/**
 * ChecksPanel.tsx — every finding, in the left sidebar.
 *
 * The Checks menu shows the first few; a model of a thousand tables can
 * have hundreds. Here they are grouped by rule, filtered by severity and a
 * search, each one a jump that marks the columns it is about, with Ignore
 * (a `lint-ignore:<rule>` tag, one undoable edit) and a rule's quick fix
 * where it has one. Download CSV takes the filtered list. Presentational:
 * the studio owns the findings and applies ignores and fixes.
 */
import type { LintFinding, LintSeverity } from "../contract/lint";
import { UiIcon } from "./ui-icons";
import { checksSummary, filterFindings, findingsCsv, groupFindings } from "./analysis-text";

export interface ChecksState {
  kind: "checks";
  severity: "all" | LintSeverity;
  query: string;
}

export interface ChecksPanelProps {
  state: ChecksState;
  findings: readonly LintFinding[];
  ruleInfo: (rule: string) => { label: string; description?: string };
  nodeLabel: (id: string) => string;
  /** Hand-authored documents only: an imported model's rows belong to its source. */
  canEdit: boolean;
  onChange: (patch: Partial<ChecksState>) => void;
  onJump: (finding: LintFinding) => void;
  onIgnore: (finding: LintFinding) => void;
  onFix: (finding: LintFinding) => void;
  onDownload: (csv: string) => void;
  onClose: () => void;
}

const GROUP_CAP = 300;
const SEVERITIES: Array<{ id: ChecksState["severity"]; label: string }> = [
  { id: "all", label: "All" },
  { id: "error", label: "Errors" },
  { id: "warning", label: "Warnings" },
  { id: "info", label: "Info" },
];

export function ChecksPanel({ state, findings, ruleInfo, nodeLabel, canEdit, onChange, onJump, onIgnore, onFix, onDownload, onClose }: ChecksPanelProps) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const shown = filterFindings(findings, state.severity, state.query, (r) => ruleInfo(r).label);
  const groups = groupFindings(shown);
  return (
    <div className="as-panel as-panel--paths" role="region" aria-label="Checks">
      <div className="as-panel__head">
        <h2 className="as-panel__title">Checks</h2>
        <button type="button" className="as-btn" onClick={() => onDownload(findingsCsv(shown, (r) => ruleInfo(r).label, nodeLabel))} disabled={!shown.length}>
          Download CSV
        </button>
        <button type="button" className="as-btn as-btn--icon" onClick={onClose} aria-label="Close checks panel">
          <UiIcon name="close" />
        </button>
      </div>
      <p className="as-paths__hint" role="status">{checksSummary(counts)}</p>
      <div className="as-paths__controls">
        <div className="as-seg" role="group" aria-label="Severity">
          {SEVERITIES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`as-btn${state.severity === s.id ? " as-btn--on" : ""}`}
              aria-pressed={state.severity === s.id}
              onClick={() => onChange({ severity: s.id })}
            >
              {s.label}
            </button>
          ))}
        </div>
        <input
          className="as-input"
          type="search"
          value={state.query}
          placeholder="Filter findings…"
          aria-label="Filter findings"
          onChange={(event) => onChange({ query: event.target.value })}
        />
      </div>
      {groups.length ? (
        groups.map(({ rule, findings: list }) => {
          const info = ruleInfo(rule);
          return (
            <details key={rule} className="as-paths__section" open={groups.length <= 6}>
              <summary className="as-paths__caption" title={info.description}>
                {info.label} <span className="as-paths__count">{list.length}</span>
              </summary>
              <ul className="as-paths__list" aria-label={info.label}>
                {list.slice(0, GROUP_CAP).map((f, i) => (
                  <li key={i} className="as-analysis__row">
                    <button type="button" className="as-paths__item" title="Go to it" onClick={() => onJump(f)}>
                      <span className={`as-check__sev as-check__sev--${f.severity}`} aria-label={f.severity} />
                      <span className="as-paths__itemlabel">{f.message}</span>
                    </button>
                    {canEdit && f.fix ? (
                      <button type="button" className="as-btn as-analysis__rowaction" title={f.fix.label} onClick={() => onFix(f)}>
                        Fix
                      </button>
                    ) : null}
                    {canEdit ? (
                      <button type="button" className="as-btn as-analysis__rowaction" title={`Tag it lint-ignore:${rule}`} onClick={() => onIgnore(f)}>
                        Ignore
                      </button>
                    ) : null}
                  </li>
                ))}
                {list.length > GROUP_CAP ? <li className="as-paths__more">… and {list.length - GROUP_CAP} more</li> : null}
              </ul>
            </details>
          );
        })
      ) : (
        <p className="as-paths__empty">{findings.length ? "No finding matches the filter." : "Nothing to report."}</p>
      )}
    </div>
  );
}

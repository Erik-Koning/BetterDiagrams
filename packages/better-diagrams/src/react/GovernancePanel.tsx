/**
 * GovernancePanel.tsx — how documented, owned and sensitive the model is.
 *
 * Four meters (tables described, fields described, fields labelled, tables
 * owned), owners and their tables, sensitive columns by tag, and the tables
 * within reach of one — every name a jump. The data dictionary downloads
 * from the head, as Markdown or CSV. Presentational: the analysis sidebar
 * runs `governanceReport` and `dataDictionary` (contract/dictionary.ts).
 */
import type { FieldRef } from "../contract/fields";
import type { GovernanceReport } from "../contract/dictionary";
import { UiIcon } from "./ui-icons";
import { governanceLines } from "./analysis-text";

export interface GovernanceState {
  kind: "governance";
}

export interface GovernancePanelProps {
  report: GovernanceReport;
  nodeLabel: (id: string) => string;
  onNavigate: (nodeId: string) => void;
  onNavigateField: (ref: FieldRef) => void;
  onDownload: (format: "md" | "csv") => void;
  onClose: () => void;
}

const LIST_CAP = 300;

export function GovernancePanel({ report, nodeLabel, onNavigate, onNavigateField, onDownload, onClose }: GovernancePanelProps) {
  const nodeRow = (id: string, detail?: string) => (
    <li key={id}>
      <button type="button" className="as-paths__item" title={`Go to ${nodeLabel(id)}`} onClick={() => onNavigate(id)}>
        <span className="as-paths__itemlabel">{nodeLabel(id)}</span>
        {detail ? <span className="as-paths__itemdetail">{detail}</span> : null}
      </button>
    </li>
  );
  return (
    <div className="as-panel as-panel--paths" role="region" aria-label="Governance">
      <div className="as-panel__head">
        <h2 className="as-panel__title">Governance</h2>
        <button type="button" className="as-btn" title="The data dictionary as Markdown" onClick={() => onDownload("md")}>
          Dictionary .md
        </button>
        <button type="button" className="as-btn" title="The data dictionary as CSV, a row per field" onClick={() => onDownload("csv")}>
          .csv
        </button>
        <button type="button" className="as-btn as-btn--icon" onClick={onClose} aria-label="Close governance panel">
          <UiIcon name="close" />
        </button>
      </div>
      {report.incomplete.length ? (
        <p className="as-paths__note">
          {report.incomplete.length} table{report.incomplete.length === 1 ? " lists" : "s list"} only its first fields — every number is “at least”.
        </p>
      ) : null}
      <section className="as-paths__section" aria-label="Documentation">
        <h3 className="as-paths__caption">Documentation</h3>
        <ul className="as-coverage__bars">
          {governanceLines(report).map((line) => (
            <li key={line.label} className="as-governance__line">
              <span className="as-coverage__barlabel">{line.label}</span>
              <span className="as-coverage__track" aria-hidden="true">
                <span className="as-coverage__fill" style={{ width: line.value === "—" ? "0%" : line.value }} />
              </span>
              <span className="as-coverage__barvalue" title={line.detail}>
                {line.value}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <details className="as-paths__section">
        <summary className="as-paths__caption">
          Owners <span className="as-paths__count">{report.ownership.byOwner.length}</span>
        </summary>
        <ul className="as-paths__list">
          {report.ownership.byOwner.map((o) => (
            <li key={o.owner}>
              <details>
                <summary className="as-paths__item">
                  <span className="as-paths__itemlabel">{o.owner}</span>
                  <span className="as-paths__itemdetail">{o.tables.length}</span>
                </summary>
                <ul className="as-paths__list">{o.tables.slice(0, LIST_CAP).map((id) => nodeRow(id))}</ul>
              </details>
            </li>
          ))}
        </ul>
        {report.ownership.unowned.length ? (
          <details>
            <summary className="as-paths__caption">
              No owner <span className="as-paths__count">{report.ownership.unowned.length}</span>
            </summary>
            <ul className="as-paths__list">{report.ownership.unowned.slice(0, LIST_CAP).map((id) => nodeRow(id))}</ul>
          </details>
        ) : null}
      </details>
      <section className="as-paths__section" aria-label="Sensitive columns">
        <h3 className="as-paths__caption">
          Sensitive columns <span className="as-paths__count">{report.sensitivity.reduce((n, s) => n + s.fields.length, 0)}</span>
        </h3>
        {report.sensitivity.length ? (
          report.sensitivity.map((s) => (
            <ul key={s.tag} className="as-paths__list" aria-label={s.tag}>
              {s.fields.slice(0, LIST_CAP).map((ref) => (
                <li key={`${ref.nodeId}.${ref.fieldId}`}>
                  <button type="button" className="as-paths__item" onClick={() => onNavigateField(ref)}>
                    <span className="as-paths__itemlabel">
                      {nodeLabel(ref.nodeId)}.{ref.fieldId}
                    </span>
                    <span className="as-paths__itemdetail">{s.tag}</span>
                  </button>
                </li>
              ))}
            </ul>
          ))
        ) : (
          <p className="as-paths__empty">No column carries a sensitivity tag (pii, pii:…, sensitive, confidential).</p>
        )}
      </section>
      {report.suggested.length ? (
        <details className="as-paths__section" aria-label="Looks sensitive, not tagged">
          <summary className="as-paths__caption" title="Names that say personal data, on columns with no sensitive tag — see Checks to tag or dismiss them">
            Looks sensitive, not tagged <span className="as-paths__count">{report.suggested.length}</span>
          </summary>
          <ul className="as-paths__list">
            {report.suggested.slice(0, LIST_CAP).map((x) => (
              <li key={`${x.ref.nodeId}.${x.ref.fieldId}`}>
                <button type="button" className="as-paths__item" title={`Looks like ${x.what}`} onClick={() => onNavigateField(x.ref)}>
                  <span className="as-paths__itemlabel">
                    {nodeLabel(x.ref.nodeId)}.{x.ref.fieldId}
                  </span>
                  <span className="as-paths__itemdetail">{x.tag}?</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {report.untaggedFlows.length ? (
        <section className="as-paths__section" aria-label="Untagged sensitive flows">
          <h3 className="as-paths__caption">
            Sensitive values in untagged columns <span className="as-paths__count">{report.untaggedFlows.length}</span>
          </h3>
          <ul className="as-paths__list">
            {report.untaggedFlows.slice(0, LIST_CAP).map((x) => (
              <li key={`${x.ref.nodeId}.${x.ref.fieldId}`}>
                <button type="button" className="as-paths__item" title="Lineage carries a sensitive column's values here" onClick={() => onNavigateField(x.ref)}>
                  <span className="as-paths__itemlabel">
                    {nodeLabel(x.ref.nodeId)}.{x.ref.fieldId}
                  </span>
                  <span className="as-paths__itemdetail">
                    from {nodeLabel(x.source.nodeId)}.{x.source.fieldId}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {report.exposure.length ? (
        <details className="as-paths__section">
          <summary className="as-paths__caption">
            Within reach of a sensitive column <span className="as-paths__count">{report.exposure.length}</span>
          </summary>
          <ul className="as-paths__list">
            {report.exposure.slice(0, LIST_CAP).map((x) => nodeRow(x.nodeId, `${x.hops} hop${x.hops === 1 ? "" : "s"} · ${nodeLabel(x.nearest.nodeId)}.${x.nearest.fieldId}`))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * CoveragePanel.tsx — how much of the model a chosen set of keys reaches.
 *
 * A bar per key: the chosen ones stacked with the running percentage, then
 * every candidate ranked by what it would add. Click a bar to add or drop
 * the key; hover a candidate and the canvas shows what it would bring in.
 * "Find smallest set" fills the chosen set from `minimalKeyCover` and says
 * whether that answer is proven or merely the smallest found.
 *
 * Presentational: the studio owns the keys, the scope and the computed
 * numbers (`keyCoverage` / `marginalGains` in contract/coverage.ts).
 */
import type { FieldRef } from "../contract/fields";
import { fieldKey } from "../contract/fields";
import type { CoverageResult, CoverageScope, KeyGain } from "../contract/coverage";
import { UiIcon } from "./ui-icons";

export interface CoveragePanelProps {
  coverage: CoverageResult;
  /** Every key not chosen, most gain first. */
  gains: KeyGain[];
  keys: readonly FieldRef[];
  scope: CoverageScope;
  /** The table a "from" scope could start at — the single selected table, if any. */
  root: { id: string; label: string } | null;
  labelOf: (ref: FieldRef) => string;
  nodeLabel: (id: string) => string;
  /** What the last "Find smallest set" said about its answer, until the keys change. */
  smallest: { optimal: boolean; truncated: boolean } | null;
  onToggleKey: (ref: FieldRef) => void;
  onScopeChange: (scope: CoverageScope) => void;
  onFindSmallest: () => void;
  onHoverKey: (ref: FieldRef | null) => void;
  onClear: () => void;
  onClose: () => void;
}

/** More bars than this and the list says how many it left out. */
const LIST_CAP = 500;

const pct = (fraction: number): string => `${Math.round(fraction * 100)}%`;

export function CoveragePanel({
  coverage,
  gains,
  keys,
  scope,
  root,
  labelOf,
  nodeLabel,
  smallest,
  onToggleKey,
  onScopeChange,
  onFindSmallest,
  onHoverKey,
  onClear,
  onClose,
}: CoveragePanelProps) {
  const { reached, total, fraction, byKey, unreachable } = coverage;
  const reachable = total - unreachable;
  // The running percentage after each chosen key, in the order they were chosen.
  let running = 0;
  const chosen = keys.map((ref) => {
    const adds = byKey.get(fieldKey(ref)) ?? [];
    running += adds.length;
    return { ref, adds, running };
  });
  const candidates = gains.slice(0, LIST_CAP);

  return (
    <div className="as-coverage" role="region" aria-label="Key coverage">
      <div className="as-panel__head">
        <h2 className="as-panel__title">Key coverage</h2>
        <button type="button" className="as-btn as-btn--icon" onClick={onClose} aria-label="Close coverage panel">
          <UiIcon name="close" />
        </button>
      </div>

      <div className="as-coverage__stat" role="status">
        <span className="as-coverage__pct">{pct(fraction)}</span>
        <span className="as-coverage__detail">
          {reached.size} of {total} table{total === 1 ? "" : "s"} · {keys.length} key{keys.length === 1 ? "" : "s"}
        </span>
        <span className="as-coverage__meter" aria-hidden="true">
          <span className="as-coverage__meterfill" style={{ width: pct(fraction) }} />
          {reachable < total ? (
            <span className="as-coverage__meterceil" style={{ left: pct(total ? reachable / total : 0) }} title="The most any key can reach" />
          ) : null}
        </span>
        {total === 0 ? (
          <span className="as-coverage__note">
            Nothing here to score: coverage counts nodes that store fields, and this document has none.
          </span>
        ) : unreachable ? (
          <span className="as-coverage__note">
            {unreachable} table{unreachable === 1 ? "" : "s"} no key reaches{scope.kind === "from" ? ` from ${nodeLabel(scope.nodeId)}` : ""}.
          </span>
        ) : null}
      </div>

      <div className="as-coverage__controls">
        <div className="as-seg" role="group" aria-label="Coverage scope">
          <button
            type="button"
            className={`as-btn${scope.kind === "all" ? " as-btn--on" : ""}`}
            aria-pressed={scope.kind === "all"}
            onClick={() => onScopeChange({ kind: "all" })}
          >
            All tables
          </button>
          <button
            type="button"
            className={`as-btn${scope.kind === "from" ? " as-btn--on" : ""}`}
            aria-pressed={scope.kind === "from"}
            disabled={!root && scope.kind !== "from"}
            title={
              root
                ? scope.kind === "from" && root.id !== scope.nodeId
                  ? `Scope to ${root.label} instead of ${nodeLabel(scope.nodeId)}`
                  : `Reachable from ${root.label} over the chosen keys`
                : "Select a table to scope coverage from it"
            }
            onClick={() => (root ? onScopeChange({ kind: "from", nodeId: root.id }) : undefined)}
          >
            {scope.kind === "from" ? `From ${nodeLabel(scope.nodeId)}` : root ? `From ${root.label}` : "From a table"}
          </button>
        </div>
        <button type="button" className="as-btn" onClick={onFindSmallest} title="The fewest keys that reach everything any key can">
          Find smallest set
        </button>
        <button type="button" className="as-btn as-btn--outline" onClick={onClear} disabled={!keys.length}>
          Clear
        </button>
      </div>
      {smallest ? (
        <p className="as-paths__note" role="status">
          {smallest.truncated
            ? "The exact search ran out of time — this is the smallest set found, not a proven one."
            : smallest.optimal
              ? "Smallest set, proven: no fewer keys reach as much."
              : "Smallest set found; too many keys to prove it exactly."}
        </p>
      ) : null}

      <section className="as-paths__section" aria-label="Chosen keys">
        <h3 className="as-paths__caption">
          Chosen <span className="as-paths__count">{keys.length}</span>
        </h3>
        {chosen.length ? (
          <ul className="as-coverage__bars">
            {chosen.map(({ ref, adds, running: runningTotal }) => (
              <li key={fieldKey(ref)}>
                <button
                  type="button"
                  aria-pressed={true}
                  className="as-coverage__bar as-coverage__bar--on"
                  title={`Drop ${labelOf(ref)} — it adds ${adds.length} table${adds.length === 1 ? "" : "s"}`}
                  onClick={() => onToggleKey(ref)}
                  onMouseEnter={() => onHoverKey(ref)}
                  onMouseLeave={() => onHoverKey(null)}
                  onFocus={() => onHoverKey(ref)}
                  onBlur={() => onHoverKey(null)}
                >
                  <span className="as-coverage__barlabel">{labelOf(ref)}</span>
                  <span className="as-coverage__track" aria-hidden="true">
                    <span className="as-coverage__fill" style={{ width: pct(total ? adds.length / total : 0) }} />
                  </span>
                  <span className="as-coverage__barvalue">
                    +{adds.length} · {pct(total ? runningTotal / total : 0)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="as-paths__empty">No keys chosen — click a candidate below, or find the smallest set.</p>
        )}
      </section>

      <section className="as-paths__section" aria-label="Candidate keys">
        <h3 className="as-paths__caption">
          Candidates <span className="as-paths__count">{gains.length}</span>
        </h3>
        {candidates.length ? (
          <ul className="as-coverage__bars">
            {candidates.map((g) => (
              <li key={fieldKey(g.ref)}>
                <button
                  type="button"
                  aria-pressed={false}
                  className={`as-coverage__bar${g.adds.length ? "" : " as-coverage__bar--none"}`}
                  title={
                    g.adds.length
                      ? `Add ${labelOf(g.ref)} — reaches ${g.adds.map(nodeLabel).slice(0, 8).join(", ")}${g.adds.length > 8 ? "…" : ""}`
                      : `${labelOf(g.ref)} adds nothing the chosen keys don't already reach`
                  }
                  onClick={() => onToggleKey(g.ref)}
                  onMouseEnter={() => onHoverKey(g.ref)}
                  onMouseLeave={() => onHoverKey(null)}
                  onFocus={() => onHoverKey(g.ref)}
                  onBlur={() => onHoverKey(null)}
                >
                  <span className="as-coverage__barlabel">{labelOf(g.ref)}</span>
                  <span className="as-coverage__track" aria-hidden="true">
                    <span className="as-coverage__fill as-coverage__fill--gain" style={{ width: pct(g.fraction) }} />
                  </span>
                  <span className="as-coverage__barvalue">+{g.adds.length}</span>
                </button>
              </li>
            ))}
            {gains.length > candidates.length ? <li className="as-paths__more">… and {gains.length - candidates.length} more</li> : null}
          </ul>
        ) : (
          <p className="as-paths__empty">{keys.length ? "Every key is chosen." : "This document has no keys — no field anchors a line."}</p>
        )}
      </section>
    </div>
  );
}

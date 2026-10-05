/**
 * KeyUsagePanel.tsx — which tables carry a field, by name, in the left
 * sidebar.
 *
 * Search the model's field names (or just its keys), pick one or more, and
 * the panel scores them: the share of tables that carry them, those tables
 * with the fields each one has, and the tables that don't. "Any" counts a
 * table carrying one of the picks, "All" only one carrying every pick; the
 * targets switch also counts the tables a key points at. Hover a name and
 * the canvas shows what picking it would cover.
 *
 * Presentational: the studio owns the picks and computes the index and the
 * score (`fieldUsage` / `usageCoverage` in contract/key-usage.ts).
 */
import type { FieldRef } from "../contract/fields";
import {
  inconsistencySummary,
  usageHeadline,
  variantSummary,
  type FieldUsage,
  type FieldUsageIndex,
  type UsageCoverage,
} from "../contract/key-usage";
import { UiIcon } from "./ui-icons";

export interface KeyUsagePanelProps {
  index: FieldUsageIndex;
  /** The names the search matches, in the index's order. */
  results: readonly FieldUsage[];
  query: string;
  onQueryChange: (query: string) => void;
  keysOnly: boolean;
  onKeysOnlyChange: (keysOnly: boolean) => void;
  /** Only names stored as more than one type, or nullable in some tables and not others. */
  inconsistentOnly: boolean;
  onInconsistentOnlyChange: (only: boolean) => void;
  /** One way a picked name is stored, focused: the list and the canvas narrow to its tables. */
  variantFocus: { id: string; family: string } | null;
  onVariantFocus: (focus: { id: string; family: string } | null) => void;
  /** Picked names, by `FieldUsage.id`, in the order they were picked. */
  chosen: readonly string[];
  onToggle: (id: string) => void;
  onClear: () => void;
  match: "any" | "all";
  onMatchChange: (match: "any" | "all") => void;
  includeTargets: boolean;
  onIncludeTargetsChange: (include: boolean) => void;
  coverage: UsageCoverage;
  nodeLabel: (id: string) => string;
  /** A name under the pointer: the canvas previews picking it. */
  onHover: (id: string | null) => void;
  /** A table in the lists: go to it with the picked fields it carries marked. */
  onNavigate: (nodeId: string, fields: readonly FieldRef[]) => void;
  onClose: () => void;
  /** Keep this analysis with the model (a saved analysis). Absent, no Save button. */
  onSave?: () => void;
}

/** More rows than this and a list says how many it left out. */
const LIST_CAP = 500;

const pct = (fraction: number): string => `${Math.round(fraction * 100)}%`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function KeyUsagePanel({
  index,
  results,
  query,
  onQueryChange,
  keysOnly,
  onKeysOnlyChange,
  inconsistentOnly,
  onInconsistentOnlyChange,
  variantFocus,
  onVariantFocus,
  chosen,
  onToggle,
  onClear,
  match,
  onMatchChange,
  includeTargets,
  onIncludeTargetsChange,
  coverage,
  nodeLabel,
  onHover,
  onNavigate,
  onClose,
  onSave,
}: KeyUsagePanelProps) {
  const total = index.tables.length;
  const picked = new Set(chosen);
  const chosenFields = chosen.map((id) => index.byId.get(id)).filter((f): f is FieldUsage => !!f);
  const nameOf = (id: string) => index.byId.get(id)?.name ?? id;

  const bar = (field: FieldUsage, on: boolean) => {
    const used = on ? (coverage.perKey.get(field.id) ?? field.tables.length) : field.tables.length;
    const tables = field.tables.map((t) => nodeLabel(t.nodeId));
    const badge = field.tables.some((t) => t.key === "pk" || t.key === "pfk") ? "PK" : field.isKey ? "FK" : null;
    return (
      <li key={field.id}>
        <button
          type="button"
          aria-pressed={on}
          className={`as-coverage__bar${on ? " as-coverage__bar--on" : ""}`}
          title={`${on ? "Drop" : "Pick"} ${field.name} — in ${tables.slice(0, 8).join(", ")}${tables.length > 8 ? "…" : ""}${
            field.targets.length ? `; points at ${field.targets.map(nodeLabel).join(", ")}` : ""
          }`}
          onClick={() => onToggle(field.id)}
          onMouseEnter={() => onHover(field.id)}
          onMouseLeave={() => onHover(null)}
          onFocus={() => onHover(field.id)}
          onBlur={() => onHover(null)}
        >
          <span className="as-coverage__barlabel">
            <span className="as-usage__name">{field.name}</span>
            {badge ? <span className="as-usage__badge">{badge}</span> : null}
            {field.consistent ? null : (
              <span className="as-usage__badge as-usage__badge--mixed" title={inconsistencySummary(field)}>
                mixed
              </span>
            )}
            {field.targets.length ? <span className="as-usage__target"> → {field.targets.map(nodeLabel).join(" | ")}</span> : null}
          </span>
          <span className="as-coverage__track" aria-hidden="true">
            <span className={`as-coverage__fill${on ? "" : " as-coverage__fill--gain"}`} style={{ width: pct(total ? used / total : 0) }} />
          </span>
          <span className="as-coverage__barvalue">{plural(used, "table")}</span>
        </button>
      </li>
    );
  };

  const shownResults = results.slice(0, LIST_CAP);
  const focusedVariant = variantFocus
    ? index.byId.get(variantFocus.id)?.variants.find((v) => v.family === variantFocus.family)
    : undefined;
  const focusedTables = focusedVariant ? new Set(focusedVariant.tables.map((t) => t.nodeId)) : null;
  const usingAll = focusedTables ? coverage.covered.filter((c) => focusedTables.has(c.nodeId)) : coverage.covered;
  const covered = usingAll.slice(0, LIST_CAP);

  return (
    <div className="as-panel as-panel--paths as-usage" role="region" aria-label="Key usage">
      <div className="as-panel__head">
        <h2 className="as-panel__title">Key usage</h2>
        {onSave ? (
          <button type="button" className="as-btn" title="Keep this analysis with the model, to open and re-run later" onClick={onSave}>
            Save…
          </button>
        ) : null}
        <button type="button" className="as-btn as-btn--icon" onClick={onClose} aria-label="Close key usage panel">
          <UiIcon name="close" />
        </button>
      </div>
      <p className="as-paths__hint">Which tables carry a field. Pick one or more to see the share of the model that has them.</p>

      <div className="as-usage__search">
        <input
          className="as-input"
          type="search"
          value={query}
          placeholder="Search field names or keys…"
          aria-label="Search field names or keys"
          autoFocus
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter picks the top match, the quickest way to build a set.
            if (event.key === "Enter" && results[0] && !picked.has(results[0].id)) onToggle(results[0].id);
            // The editor ignores keys typed into a field, so Escape is the
            // box's own: it clears the query, then closes the panel.
            if (event.key === "Escape") {
              if (query) onQueryChange("");
              else onClose();
            }
          }}
        />
        <div className="as-usage__filters">
          <label className="as-check">
            <input type="checkbox" checked={keysOnly} onChange={(event) => onKeysOnlyChange(event.target.checked)} />
            Keys only
          </label>
          <label className="as-check" title="Names stored as more than one type, or nullable in some tables and not others">
            <input type="checkbox" checked={inconsistentOnly} onChange={(event) => onInconsistentOnlyChange(event.target.checked)} />
            Inconsistent only
          </label>
        </div>
      </div>
      {index.truncated.length ? (
        <p className="as-paths__note">
          {index.truncated.length} table{index.truncated.length === 1 ? " lists" : "s list"} only its first fields — every count is “at least”.
        </p>
      ) : null}

      <section className="as-paths__section" aria-label={query.trim() ? "Matching fields" : "Shared fields"}>
        <h3 className="as-paths__caption">
          {query.trim() ? "Matches" : inconsistentOnly ? "Inconsistent" : "Shared by several tables"} <span className="as-paths__count">{results.length}</span>
        </h3>
        {shownResults.length ? (
          <ul className="as-coverage__bars as-usage__results">
            {shownResults.map((f) => bar(f, picked.has(f.id)))}
            {results.length > shownResults.length ? <li className="as-paths__more">… and {results.length - shownResults.length} more</li> : null}
          </ul>
        ) : (
          <p className="as-paths__empty">
            {query.trim()
              ? `No ${keysOnly ? "key" : "field"} name contains “${query.trim()}”.`
              : inconsistentOnly
                ? "Every name is stored one way."
                : total
                ? "No field name is shared by two tables — search for one."
                : "Nothing to search: no node here stores fields."}
          </p>
        )}
      </section>

      {chosenFields.length ? (
        <>
          <section className="as-paths__section" aria-label="Picked fields">
            <div className="as-usage__pickedhead">
              <h3 className="as-paths__caption">
                Picked <span className="as-paths__count">{chosenFields.length}</span>
              </h3>
              <button type="button" className="as-btn as-btn--outline" onClick={onClear}>
                Clear
              </button>
            </div>
            <ul className="as-coverage__bars">
              {chosenFields.flatMap((f) => [
                bar(f, true),
                // How an inconsistent pick is stored, one line per way — a
                // line focuses the list and the canvas on those tables.
                f.consistent ? null : (
                  <li key={`${f.id}\u0000variants`}>
                    <ul className="as-usage__variants" aria-label={`How ${f.name} is stored`}>
                      {f.variants.map((v) => {
                        const on = variantFocus?.id === f.id && variantFocus.family === v.family;
                        return (
                          <li key={v.family}>
                            <button
                              type="button"
                              className={`as-paths__item${on ? " as-paths__item--sticky" : ""}`}
                              aria-pressed={on}
                              title={on ? "Show every table again" : `Show only the tables storing ${f.name} this way`}
                              onClick={() => onVariantFocus(on ? null : { id: f.id, family: v.family })}
                            >
                              <span className="as-paths__itemlabel">{variantSummary(v)}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ),
              ])}
            </ul>
          </section>

          <div className="as-coverage__controls">
            <div className="as-seg" role="group" aria-label="Count a table that has">
              <span className="as-seg__caption">Tables with</span>
              <button type="button" className={`as-btn${match === "any" ? " as-btn--on" : ""}`} aria-pressed={match === "any"} onClick={() => onMatchChange("any")}>
                Any
              </button>
              <button type="button" className={`as-btn${match === "all" ? " as-btn--on" : ""}`} aria-pressed={match === "all"} onClick={() => onMatchChange("all")}>
                All
              </button>
            </div>
            <label className="as-check" title="A foreign key also counts for the table it points at">
              <input type="checkbox" checked={includeTargets} onChange={(event) => onIncludeTargetsChange(event.target.checked)} />
              Count the tables they point at
            </label>
          </div>

          <div className="as-coverage__stat" role="status">
            <span className="as-coverage__pct">{pct(coverage.fraction)}</span>
            <span className="as-coverage__detail">{usageHeadline(coverage, match, chosenFields.length)}</span>
            <span className="as-coverage__meter" aria-hidden="true">
              <span className="as-coverage__meterfill" style={{ width: pct(coverage.fraction) }} />
            </span>
          </div>

          <section className="as-paths__section" aria-label="Tables using them">
            <h3 className="as-paths__caption">
              {focusedVariant && variantFocus ? `Storing ${nameOf(variantFocus.id)} as ${focusedVariant.family}` : "Tables using them"}{" "}
              <span className="as-paths__count">{usingAll.length}</span>
            </h3>
            {covered.length ? (
              <ul className="as-paths__list">
                {covered.map((c) => {
                  const fields = [
                    ...c.carries.map((r) => r.fieldId),
                    ...c.pointedAtBy.filter((id) => !c.carries.some((r) => r.fieldId.toLowerCase() === id)).map((id) => `← ${nameOf(id)}`),
                  ].join(", ");
                  return (
                    <li key={c.nodeId}>
                      <button type="button" className="as-paths__item" title={`Go to ${nodeLabel(c.nodeId)}`} onClick={() => onNavigate(c.nodeId, c.carries)}>
                        <span className="as-paths__itemlabel">{nodeLabel(c.nodeId)}</span>
                        <span className="as-paths__itemdetail as-usage__fields">{fields}</span>
                      </button>
                    </li>
                  );
                })}
                {usingAll.length > covered.length ? <li className="as-paths__more">… and {usingAll.length - covered.length} more</li> : null}
              </ul>
            ) : (
              <p className="as-paths__empty">No table {match === "all" ? "has all of them" : "uses them"}.</p>
            )}
          </section>

          {coverage.missing.length ? (
            <details className="as-paths__section">
              <summary className="as-paths__caption">
                Tables without them <span className="as-paths__count">{coverage.missing.length}</span>
              </summary>
              <ul className="as-paths__list">
                {coverage.missing.slice(0, LIST_CAP).map((id) => (
                  <li key={id}>
                    <button type="button" className="as-paths__item" title={`Go to ${nodeLabel(id)}`} onClick={() => onNavigate(id, [])}>
                      <span className="as-paths__itemlabel">{nodeLabel(id)}</span>
                    </button>
                  </li>
                ))}
                {coverage.missing.length > LIST_CAP ? <li className="as-paths__more">… and {coverage.missing.length - LIST_CAP} more</li> : null}
              </ul>
            </details>
          ) : null}
        </>
      ) : (
        <p className="as-paths__empty">Pick a field above to see which tables carry it{total ? ` — of ${plural(total, "table")}` : ""}.</p>
      )}
    </div>
  );
}

/**
 * schema-report-html.ts — the schema change report as one self-contained
 * page: the summary, a filter by impact, and every table's changes, breaking
 * first. The diff is computed when the page is made (`schemaDiff`), so the
 * page carries answers, not the analysis — a dozen lines of script filter
 * the rows, and there is nothing else to run. No network, no dependencies,
 * like the interactive export.
 */
import type { ChangeImpact, ColumnChange, SchemaDiff } from "../contract/schema-diff";
import type { ExportPalette } from "./draw";
import { DARK_EXPORT_PALETTE } from "./draw";
import { changesSummary } from "./analysis-text";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const RANK: Record<ChangeImpact, number> = { breaking: 0, caution: 1, safe: 2 };

export interface SchemaReportOptions {
  diff: SchemaDiff;
  /** A table's label, from either version (a removed table is only in the baseline). */
  label: (nodeId: string) => string;
  title: string;
  palette?: Partial<ExportPalette>;
}

export function buildSchemaReportHtml({ diff, label, title, palette: override }: SchemaReportOptions): string {
  const palette: ExportPalette = { ...DARK_EXPORT_PALETTE, ...override };
  const byTable = new Map<string, ColumnChange[]>();
  for (const c of diff.columns) (byTable.get(c.nodeId) ?? byTable.set(c.nodeId, []).get(c.nodeId)!).push(c);
  const tables = [...byTable.entries()].sort(
    (a, b) => Math.min(...a[1].map((c) => RANK[c.impact])) - Math.min(...b[1].map((c) => RANK[c.impact])) || label(a[0]).localeCompare(label(b[0])),
  );
  const row = (c: ColumnChange) => {
    const what = c.kind === "changed" || c.kind === "renamed" ? c.reason : c.reason === c.kind ? c.kind : `${c.kind} · ${c.reason}`;
    return `<tr data-impact="${c.impact}"><td class="impact ${c.impact}">${c.impact}</td><td class="mono">${esc(c.to?.name ?? c.from?.name ?? c.fieldId)}</td><td>${esc(what)}</td></tr>`;
  };
  const sections = tables
    .map(([id, changes]) => {
      const worst = changes.reduce<ChangeImpact>((w, c) => (RANK[c.impact] < RANK[w] ? c.impact : w), "safe");
      return `<section data-worst="${worst}"><h2>${esc(label(id))} <span class="count">${changes.length}</span></h2><table><tbody>${[...changes]
        .sort((a, b) => RANK[a.impact] - RANK[b.impact])
        .map(row)
        .join("")}</tbody></table></section>`;
    })
    .join("\n");
  const refs = [
    ...diff.references.added.map((l) => `<li><span class="impact safe">added</span> ${esc(label(l.from.nodeId))}.${esc(l.from.fieldId)} → ${esc(label(l.to.nodeId))}</li>`),
    ...diff.references.removed.map((l) => `<li><span class="impact breaking">removed</span> ${esc(label(l.from.nodeId))}.${esc(l.from.fieldId)} → ${esc(label(l.to.nodeId))}</li>`),
  ].join("");
  const renamed = diff.tables.renamed.map((r) => `${esc(label(r.from))} → ${esc(label(r.to))} (${Math.round(r.confidence * 100)}%)`).join(", ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>
  :root { color-scheme: dark light; }
  body { margin: 0; padding: 24px; background: ${palette.bg}; color: ${palette.text}; font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { margin: 0 0 4px; font-size: 20px; }
  .summary { margin: 0 0 16px; color: ${palette.textDim}; }
  .filters { display: flex; gap: 6px; margin: 0 0 18px; }
  .filters button { padding: 4px 10px; border: 1px solid ${palette.border}; border-radius: 6px; background: ${palette.surface2}; color: ${palette.textDim}; font: inherit; font-size: 12px; cursor: pointer; }
  .filters button[aria-pressed="true"] { color: ${palette.text}; border-color: ${palette.text}; }
  section { margin: 0 0 18px; padding: 12px 14px; border: 1px solid ${palette.border}; border-radius: 10px; background: ${palette.surface}; }
  h2 { margin: 0 0 8px; font-size: 14px; }
  .count { color: ${palette.textDim}; font-weight: 400; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 4px 8px 4px 0; border-top: 1px solid ${palette.border}; vertical-align: top; }
  tr:first-child td { border-top: 0; }
  .mono { font-family: ui-monospace, Menlo, monospace; }
  .impact { width: 76px; font-family: ui-monospace, Menlo, monospace; font-size: 11px; text-transform: uppercase; color: ${palette.textDim}; }
  .impact.breaking { color: #f43f5e; }
  .impact.caution { color: ${palette.overdue ?? "#d97706"}; }
  .note { color: ${palette.textDim}; }
  ul { padding-left: 18px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <h1>${esc(title)}</h1>
  <p class="summary">${esc(changesSummary(diff.summary))}${diff.tables.added.length ? ` · ${diff.tables.added.length} table${diff.tables.added.length === 1 ? "" : "s"} added` : ""}${diff.tables.removed.length ? ` · ${diff.tables.removed.length} removed` : ""}</p>
  ${renamed ? `<p class="note">Possibly renamed: ${renamed}</p>` : ""}
  <div class="filters" role="group" aria-label="Impact">
    <button type="button" data-filter="all" aria-pressed="true">All</button>
    <button type="button" data-filter="breaking" aria-pressed="false">Breaking ${diff.summary.breaking}</button>
    <button type="button" data-filter="caution" aria-pressed="false">Caution ${diff.summary.caution}</button>
    <button type="button" data-filter="safe" aria-pressed="false">Safe ${diff.summary.safe}</button>
  </div>
  <main id="changes">
${sections || '<p class="note">No table or column changed.</p>'}
  </main>
  ${refs ? `<section><h2>References</h2><ul>${refs}</ul></section>` : ""}
<script>
(function () {
  var buttons = [].slice.call(document.querySelectorAll("[data-filter]"));
  buttons.forEach(function (b) {
    b.addEventListener("click", function () {
      var f = b.getAttribute("data-filter");
      buttons.forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      [].slice.call(document.querySelectorAll("#changes section")).forEach(function (s) {
        var shown = 0;
        [].slice.call(s.querySelectorAll("tr[data-impact]")).forEach(function (r) {
          var on = f === "all" || r.getAttribute("data-impact") === f;
          r.hidden = !on;
          if (on) shown++;
        });
        s.hidden = !shown;
      });
    });
  });
})();
</script>
</body>
</html>
`;
}

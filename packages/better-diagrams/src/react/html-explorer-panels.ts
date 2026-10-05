/**
 * html-explorer-panels.ts — the data-model analysis panels of the
 * interactive HTML export: neighbourhood, impact, checks, model structure,
 * governance and lineage.
 *
 * Each is a small object the page's runtime (html-explorer-runtime.ts)
 * shows in its left sidebar: it draws itself, says what stays bright on the
 * picture, and names any walks to light. It reaches the page only through a
 * `PanelKit` — the runtime's DOM helpers, navigation and marks — so these
 * panels stay independent of the runtime's closure, and every analysis they
 * run is the contract's own, bundled with them.
 */
import type { GraphWalk } from "../contract/graph";
import { neighbourhood } from "../contract/graph";
import { edgeFieldIds, fieldKey, fieldRecords, type FieldRef, type Pin } from "../contract/fields";
import type { LintFinding } from "../contract/lint";
import { impactChain, impactHeadline, impactOf } from "../contract/impact";
import type { ExplorerDocument, HtmlExplorerData } from "./html-explorer";
import { checksSummary, domainColor, filterFindings, findingsCsv, governanceLines, groupFindings, impactCsv, neighbourhoodHeadline, plural, structureHeadline } from "./analysis-text";
import type { GovernanceReport } from "../contract/dictionary";
import type { StructureSummary } from "../contract/structure";
import type { SavedAnalysis, SavedAnalysisBody } from "../contract/analyses";
import { ANALYSIS_KIND_LABEL, analysisDrift } from "../contract/analyses";
import { keyCoverage } from "../contract/coverage";
import type { CoverageScope } from "../contract/coverage";
import { readAnalysis } from "./saved-analyses";
import { lineageChain, lineageHeadline, sensitiveLineage, traceLineage } from "../contract/lineage";

type Child = Node | string | null | undefined | false;

/** What the runtime lends a panel. */
export interface PanelKit {
  doc: Document;
  model: ExplorerDocument;
  data: HtmlExplorerData;
  /** The sidebar element a panel draws into (cleared before `render`). */
  panel: HTMLElement;
  h: <K extends keyof HTMLElementTagNameMap>(tag: K, props?: Partial<Record<string, string | boolean | number>>, ...children: Child[]) => HTMLElementTagNameMap[K];
  button: (cls: string, label: string, onClick: () => void, props?: Record<string, string | boolean>) => HTMLButtonElement;
  panelHead: (title: string, onClose: () => void, closeLabel: string) => HTMLElement;
  section: (caption: string | null, count: number | null, ...body: Array<Node | null | false>) => HTMLElement;
  nodeList: (ids: readonly string[], empty: string | null, detail?: (id: string) => string) => Node | null;
  hoverable: (el: HTMLElement, enter: () => void, leave: () => void) => void;
  nodeLabel: (id: string) => string;
  navigate: (id: string) => void;
  /** Mark rows (field keys) and repaint. */
  mark: (keys: readonly string[]) => void;
  /** Redraw the panel and the picture. */
  refresh: () => void;
  /** Repaint the picture only — for hover, which must not rebuild the list under the pointer. */
  paint: () => void;
  close: () => void;
  toast: (text: string) => void;
  copy: (text: string) => void;
  download: (filename: string, text: string, type: string) => void;
}

/** What stays bright on the picture while a panel shows something. */
export interface PanelMask {
  keep: Set<string>;
  keepEdges: Set<string> | null;
}

export interface PagePanel {
  /** The sidebar's accessible name. */
  label: string;
  render(): void;
  mask(): PanelMask | null;
  /** Walks to light, in a colour; one walk is drawn bright. */
  walks?(): Array<{ walk: GraphWalk; color?: string }>;
  /** A colour per table to outline it in (domains), or null. */
  tints?(): Map<string, string> | null;
  /** The question this panel is asking, as a saved analysis would keep it — for a shared link. */
  save?(): SavedAnalysisBody | null;
  /** Rows to mark (`fieldKey`s), besides the reader's own marks. */
  rows?(): ReadonlySet<string> | null;
  /** Lines to draw row to row (column lineage), one bright when `emphasis`. */
  links?(): Array<{ id: string; from: FieldRef; to: FieldRef; emphasis: boolean }>;
}

const carriesKey = (e: ExplorerDocument["edges"][number]) => edgeFieldIds(e).start !== undefined;

/** A segmented control: one button per option, the current one pressed. */
function seg<T extends string | number>(
  kit: PanelKit,
  caption: string | null,
  label: string,
  options: ReadonlyArray<{ id: T; text: string; title?: string }>,
  current: T,
  pick: (id: T) => void,
): HTMLElement {
  const group = kit.h("div", { class: "bd-seg", role: "group", "aria-label": label }, caption ? kit.h("span", { class: "bd-seg__caption", text: caption }) : null);
  for (const o of options) {
    group.append(kit.button(`bd-btn${o.id === current ? " bd-btn--on" : ""}`, o.text, () => pick(o.id), {
      "aria-pressed": String(o.id === current),
      ...(o.title ? { title: o.title } : {}),
    }));
  }
  return group;
}

function checkbox(kit: PanelKit, text: string, checked: boolean, change: (on: boolean) => void, title?: string): HTMLElement {
  const input = kit.h("input", { type: "checkbox", checked }) as HTMLInputElement;
  input.addEventListener("change", () => change(input.checked));
  return kit.h("label", { class: "bd-check", ...(title ? { title } : {}) }, input, text);
}

// ── Neighbourhood ──────────────────────────────────────────────────────────

export function neighbourhoodPanel(
  kit: PanelKit,
  from: string[],
  init: Partial<{ depth: number; direction: "out" | "in" | "both"; keysOnly: boolean }> = {},
): PagePanel {
  const s = { from, depth: 1, direction: "both" as "out" | "in" | "both", keysOnly: false, ...init };
  const reach = () =>
    neighbourhood(kit.model, s.from, s.depth, { direction: s.direction, ...(s.keysOnly ? { edgeFilter: carriesKey } : {}) });
  return {
    label: "Neighbourhood",
    save: () => ({ kind: "neighbourhood", from: s.from, depth: s.depth, direction: s.direction, keysOnly: s.keysOnly }),
    mask() {
      const r = reach();
      return { keep: new Set(r.nodes.keys()), keepEdges: new Set(r.edges) };
    },
    render() {
      const { h, panel } = kit;
      const r = reach();
      const byDistance = new Map<number, string[]>();
      for (const [id, d] of r.nodes) {
        if (d === 0) continue;
        const list = byDistance.get(d);
        if (list) list.push(id);
        else byDistance.set(d, [id]);
      }
      const others = r.nodes.size - s.from.filter((id) => r.nodes.has(id)).length;
      panel.append(
        kit.panelHead("Neighbourhood", kit.close, "Close neighbourhood panel"),
        h("div", { class: "bd-panel__pins" }, ...s.from.map((id) => kit.button("bd-chip", kit.nodeLabel(id), () => kit.navigate(id), { title: `Go to ${kit.nodeLabel(id)}` }))),
        h("div", { class: "bd-panel__controls" },
          seg(kit, "Joins", "Depth", [1, 2, 3].map((d) => ({ id: d, text: String(d) })), s.depth, (d) => { s.depth = d; kit.refresh(); }),
          seg(kit, null, "Direction", [
            { id: "both" as const, text: "Both", title: "Keys either way" },
            { id: "out" as const, text: "Out", title: "The tables it references" },
            { id: "in" as const, text: "In", title: "The tables referencing it" },
          ], s.direction, (d) => { s.direction = d; kit.refresh(); }),
          checkbox(kit, "Keys only", s.keysOnly, (on) => { s.keysOnly = on; kit.refresh(); }, "Walk only lines that carry a key"),
        ),
        h("p", { class: "bd-hint", role: "status", text: neighbourhoodHeadline(others, s.depth) }),
      );
      if (!others) {
        panel.append(h("p", { class: "bd-empty", text: `Nothing is within ${plural(s.depth, "join")}${s.keysOnly ? " over keys" : ""}.` }));
        return;
      }
      for (const [d, ids] of [...byDistance.entries()].sort((a, b) => a[0] - b[0])) {
        const list = h("ul", { class: "bd-list" });
        for (const id of ids.slice(0, 500)) {
          const go = kit.button("bd-item", "", () => kit.navigate(id), { title: `Go to ${kit.nodeLabel(id)}` });
          go.append(h("span", { class: "bd-item__label", text: kit.nodeLabel(id) }));
          list.append(h("li", { class: "bd-rowpair" }, go, kit.button("bd-btn bd-rowaction", "Focus", () => { s.from = [id]; kit.refresh(); }, { title: `Focus the neighbourhood on ${kit.nodeLabel(id)}` })));
        }
        panel.append(kit.section(`${plural(d, "join")} away`, ids.length, list));
      }
    },
  };
}

// ── Checks ─────────────────────────────────────────────────────────────────

/**
 * Every finding the export carried, grouped by rule, filtered by severity
 * and a search; each one a jump that marks the columns it is about. The
 * findings were computed when the page was made (a host's rules are
 * functions), so there is nothing to ignore or fix here — the editor does.
 */
export function checksPanel(kit: PanelKit, findings: readonly LintFinding[]): PagePanel {
  const s = { severity: "all", query: "" };
  const ruleLabel = (rule: string) => kit.data.rules?.[rule]?.label ?? rule;
  let body: HTMLElement | null = null;
  const jump = (f: LintFinding) => {
    const target = f.fields?.[0]?.nodeId ?? f.nodeIds?.[0];
    if (target) kit.navigate(target);
    kit.mark((f.fields ?? []).map(fieldKey));
  };
  const fill = () => {
    if (!body) return;
    const { h } = kit;
    body.textContent = "";
    const shown = filterFindings(findings, s.severity, s.query, ruleLabel);
    const groups = groupFindings(shown);
    if (!groups.length) {
      body.append(h("p", { class: "bd-empty", text: findings.length ? "No finding matches the filter." : "Nothing to report." }));
      return;
    }
    for (const { rule, findings: list } of groups) {
      const items = h("ul", { class: "bd-list", "aria-label": ruleLabel(rule) });
      for (const f of list.slice(0, 300)) {
        const b = kit.button("bd-item", "", () => jump(f), { title: "Go to it" });
        b.append(h("span", { class: `bd-sev bd-sev--${f.severity}`, "aria-label": f.severity }), h("span", { class: "bd-item__label", text: f.message }));
        items.append(h("li", {}, b));
      }
      if (list.length > 300) items.append(h("li", { class: "bd-more", text: `… and ${list.length - 300} more` }));
      const details = h("details", { class: "bd-section" },
        h("summary", { class: "bd-pcap", title: kit.data.rules?.[rule]?.description ?? "" }, ruleLabel(rule), h("span", { class: "bd-pcount", text: String(list.length) })),
        items,
      );
      (details as HTMLDetailsElement).open = groups.length <= 6;
      body.append(details);
    }
  };
  return {
    label: "Checks",
    mask: () => null,
    render() {
      const { h, panel } = kit;
      const counts = { error: 0, warning: 0, info: 0 };
      for (const f of findings) counts[f.severity]++;
      const filter = h("input", { class: "bd-filter", type: "search", placeholder: "Filter findings…", "aria-label": "Filter findings" }) as HTMLInputElement;
      filter.value = s.query;
      filter.addEventListener("input", () => { s.query = filter.value; fill(); });
      const head = kit.panelHead("Checks", kit.close, "Close checks panel");
      head.insertBefore(kit.button("bd-btn", "Download CSV", () => kit.download("checks.csv", findingsCsv(filterFindings(findings, s.severity, s.query, ruleLabel), ruleLabel, kit.nodeLabel), "text/csv")), head.lastChild);
      body = h("div", {});
      panel.append(head, h("p", { class: "bd-hint", role: "status", text: checksSummary(counts) }));
      if (kit.data.findingsTruncated) {
        panel.append(h("p", { class: "bd-note", text: `The page carries the first ${findings.length}; ${kit.data.findingsTruncated} more are in the editor.` }));
      }
      panel.append(
        h("div", { class: "bd-panel__controls" },
          seg(kit, null, "Severity", [
            { id: "all", text: "All" },
            { id: "error", text: "Errors" },
            { id: "warning", text: "Warnings" },
            { id: "info", text: "Info" },
          ], s.severity, (id) => { s.severity = id; kit.refresh(); }),
          filter,
        ),
        body,
      );
      fill();
    },
  };
}

// ── Impact ─────────────────────────────────────────────────────────────────

/** What depends on a table or a key — `impactOf`, the editor's own — with the chain to a table under the pointer lit. */
export function impactPanel(
  kit: PanelKit,
  subject: Pin,
  init: Partial<{ direction: "dependents" | "dependencies"; maxDepth: number | null; keysOnly: boolean }> = {},
): PagePanel {
  const s = { direction: "dependents" as "dependents" | "dependencies", maxDepth: null as number | null, keysOnly: true, hover: null as string | null, ...init };
  const result = () =>
    impactOf(kit.model, subject, { direction: s.direction, via: s.keysOnly ? "keys" : "all", ...(s.maxDepth !== null ? { maxDepth: s.maxDepth } : {}) });
  const subjectLabel = subject.fieldId ? `${kit.nodeLabel(subject.nodeId)} · ${subject.fieldId}` : kit.nodeLabel(subject.nodeId);
  return {
    label: "Impact",
    save: () => ({
      kind: "impact",
      subject,
      direction: s.direction,
      via: s.keysOnly ? "keys" : "all",
      ...(s.maxDepth !== null ? { maxDepth: s.maxDepth } : {}),
    }),
    mask() {
      const r = result();
      return { keep: new Set([subject.nodeId, ...r.nodes.map((n) => n.id)]), keepEdges: new Set(r.edges) };
    },
    walks() {
      if (!s.hover) return [];
      const walk = impactChain(result(), s.hover);
      return walk ? [{ walk }] : [];
    },
    render() {
      const { h, panel } = kit;
      const r = result();
      const byId = new Map(r.nodes.map((n) => [n.id, n]));
      const head = kit.panelHead("Impact", kit.close, "Close impact panel");
      head.insertBefore(kit.button("bd-btn", "Download CSV", () => kit.download("impact.csv", impactCsv(r, kit.nodeLabel), "text/csv")), head.lastChild);
      panel.append(
        head,
        h("div", { class: "bd-panel__pins" }, kit.button("bd-chip", subjectLabel, () => kit.navigate(subject.nodeId), { title: `Go to ${subjectLabel}` })),
        h("div", { class: "bd-panel__controls" },
          seg(kit, null, "Direction", [
            { id: "dependents" as const, text: "Dependents", title: "What depends on it — what a change or a delete reaches" },
            { id: "dependencies" as const, text: "Dependencies", title: "What it depends on" },
          ], s.direction, (d) => { s.direction = d; kit.refresh(); }),
          seg(kit, "Hops", "Depth", [{ id: "1", text: "1" }, { id: "2", text: "2" }, { id: "3", text: "3" }, { id: "all", text: "All" }], s.maxDepth === null ? "all" : String(s.maxDepth), (d) => {
            s.maxDepth = d === "all" ? null : Number(d);
            kit.refresh();
          }),
          checkbox(kit, "Keys only", s.keysOnly, (on) => { s.keysOnly = on; kit.refresh(); }, "Walk only lines that carry a key"),
        ),
        h("p", { class: "bd-hint", role: "status", text: impactHeadline(r, subjectLabel) }),
      );
      const row = (id: string, detail: string, badges: string[]) => {
        const b = kit.button("bd-item", "", () => kit.navigate(id), { title: `Go to ${kit.nodeLabel(id)}` });
        b.append(h("span", { class: "bd-item__label", text: kit.nodeLabel(id) }));
        for (const badge of badges) b.append(h("span", { class: `bd-badge bd-badge--${badge}`, text: badge }));
        b.append(h("span", { class: "bd-item__detail", text: detail }));
        kit.hoverable(b, () => { s.hover = id; kit.paint(); }, () => { s.hover = null; kit.paint(); });
        return h("li", {}, b);
      };
      if (r.blockers.length) {
        const list = h("ul", { class: "bd-list" });
        for (const bl of r.blockers) list.append(row(bl.from, bl.field ? `${bl.field}: restrict` : "restrict", []));
        panel.append(kit.section("Would block a delete", r.blockers.length, list));
      }
      if (!r.byDepth.length) {
        panel.append(h("p", { class: "bd-empty", text: `${s.direction === "dependents" ? "Nothing depends on it" : "It depends on nothing"}${s.keysOnly ? " through a key" : ""}.` }));
        return;
      }
      r.byDepth.forEach((ids, i) => {
        const list = h("ul", { class: "bd-list" });
        for (const id of ids.slice(0, 500)) {
          const n = byId.get(id)!;
          const badges = [...(n.cascade ? ["cascade"] : []), ...(n.required ? ["required"] : []), ...(r.outsideModel.includes(id) ? ["external"] : [])];
          list.append(row(id, `via ${kit.nodeLabel(n.via.from)}${n.via.field ? `.${n.via.field}` : ""}`, badges));
        }
        panel.append(kit.section(`${plural(i + 1, "hop")} away`, ids.length, list));
      });
    },
  };
}

// ── Governance ─────────────────────────────────────────────────────────────

/** How documented, owned and sensitive the model is — the report the export computed. */
export function governancePanel(kit: PanelKit, report: GovernanceReport): PagePanel {
  return {
    label: "Governance",
    mask: () => null,
    render() {
      const { h, panel } = kit;
      panel.append(kit.panelHead("Governance", kit.close, "Close governance panel"));
      if (report.incomplete.length) {
        panel.append(h("p", { class: "bd-note", text: `${report.incomplete.length} table${report.incomplete.length === 1 ? " lists" : "s list"} only its first fields — every number is “at least”.` }));
      }
      const lines = h("ul", { class: "bd-ubars" });
      for (const line of governanceLines(report)) {
        const fill = h("span", { class: "bd-ubar__fill" });
        fill.style.width = line.value === "—" ? "0%" : line.value;
        lines.append(h("li", { class: "bd-gline" },
          h("span", { class: "bd-ubar__label", text: line.label }),
          h("span", { class: "bd-ubar__track", "aria-hidden": "true" }, fill),
          h("span", { class: "bd-ubar__value", text: line.value, title: line.detail }),
        ));
      }
      panel.append(kit.section("Documentation", null, lines));
      const owners = h("ul", { class: "bd-list" });
      for (const o of report.ownership.byOwner) {
        const b = kit.button("bd-item", "", () => kit.navigate(o.tables[0]!), { title: o.tables.map(kit.nodeLabel).join(", ") });
        b.append(h("span", { class: "bd-item__label", text: o.owner }), h("span", { class: "bd-item__detail", text: plural(o.tables.length, "table") }));
        owners.append(h("li", {}, b));
      }
      panel.append(kit.section("Owners", report.ownership.byOwner.length, report.ownership.byOwner.length ? owners : h("p", { class: "bd-empty", text: "No table names an owner." })));
      if (report.ownership.unowned.length) {
        panel.append(h("details", { class: "bd-section" },
          h("summary", { class: "bd-pcap" }, "No owner", h("span", { class: "bd-pcount", text: String(report.ownership.unowned.length) })),
          kit.nodeList(report.ownership.unowned, null),
        ));
      }
      const sensitive = h("ul", { class: "bd-list" });
      for (const s of report.sensitivity) {
        for (const ref of s.fields.slice(0, 300)) {
          const b = kit.button("bd-item", "", () => {
            kit.navigate(ref.nodeId);
            kit.mark([fieldKey(ref)]);
          });
          b.append(h("span", { class: "bd-item__label", text: `${kit.nodeLabel(ref.nodeId)}.${ref.fieldId}` }), h("span", { class: "bd-item__detail", text: s.tag }));
          sensitive.append(h("li", {}, b));
        }
      }
      const sensitiveCount = report.sensitivity.reduce((n, s) => n + s.fields.length, 0);
      panel.append(kit.section("Sensitive columns", sensitiveCount, sensitiveCount ? sensitive : h("p", { class: "bd-empty", text: "No column carries a sensitivity tag (pii, pii:…, sensitive, confidential)." })));
      if (report.suggested?.length) {
        const list = h("ul", { class: "bd-list" });
        for (const x of report.suggested.slice(0, 300)) {
          const b = kit.button("bd-item", "", () => {
            kit.navigate(x.ref.nodeId);
            kit.mark([fieldKey(x.ref)]);
          }, { title: `Looks like ${x.what}` });
          b.append(h("span", { class: "bd-item__label", text: `${kit.nodeLabel(x.ref.nodeId)}.${x.ref.fieldId}` }), h("span", { class: "bd-item__detail", text: `${x.tag}?` }));
          list.append(h("li", {}, b));
        }
        panel.append(h("details", { class: "bd-section", "aria-label": "Looks sensitive, not tagged" },
          h("summary", { class: "bd-pcap" }, "Looks sensitive, not tagged", h("span", { class: "bd-pcount", text: String(report.suggested.length) })),
          list,
        ));
      }
      if (report.untaggedFlows?.length) {
        const flows = h("ul", { class: "bd-list" });
        for (const x of report.untaggedFlows.slice(0, 300)) {
          const b = kit.button("bd-item", "", () => {
            kit.navigate(x.ref.nodeId);
            kit.mark([fieldKey(x.ref)]);
          }, { title: "Lineage carries a sensitive column's values here" });
          b.append(
            h("span", { class: "bd-item__label", text: `${kit.nodeLabel(x.ref.nodeId)}.${x.ref.fieldId}` }),
            h("span", { class: "bd-item__detail", text: `from ${kit.nodeLabel(x.source.nodeId)}.${x.source.fieldId}` }),
          );
          flows.append(h("li", {}, b));
        }
        panel.append(kit.section("Sensitive values in untagged columns", report.untaggedFlows.length, flows));
      }
      if (report.exposure.length) {
        panel.append(h("details", { class: "bd-section" },
          h("summary", { class: "bd-pcap" }, "Within reach of a sensitive column", h("span", { class: "bd-pcount", text: String(report.exposure.length) })),
          kit.nodeList(report.exposure.map((x) => x.nodeId), null, (id) => {
            const x = report.exposure.find((e) => e.nodeId === id)!;
            return `${plural(x.hops, "hop")} · ${kit.nodeLabel(x.nearest.nodeId)}.${x.nearest.fieldId}`;
          }),
        ));
      }
    },
  };
}

// ── Model structure ───────────────────────────────────────────────────────

/** Hubs, the tables and keys holding the model together, suggested domains — computed at export. */
export function structurePanel(kit: PanelKit, summary: StructureSummary): PagePanel {
  const s = { tab: "hubs" as "hubs" | "bridges" | "domains", tint: false, domain: null as string | null, hover: null as string | null };
  const colorOf = (i: number) => kit.data.edgeHex[domainColor(i)] ?? kit.data.routeColor;
  const hoverable = (el: HTMLElement, id: string) =>
    kit.hoverable(el, () => { s.hover = id; kit.paint(); }, () => { s.hover = null; kit.paint(); });
  return {
    label: "Model structure",
    mask() {
      if (s.hover) {
        const near = neighbourhood(kit.model, [s.hover], 1, { direction: "both", edgeFilter: carriesKey });
        return { keep: new Set(near.nodes.keys()), keepEdges: new Set(near.edges) };
      }
      const d = s.domain ? summary.domains.find((x) => x.id === s.domain) : null;
      if (!d) return null;
      const keep = new Set(d.tables);
      return { keep, keepEdges: new Set(kit.model.edges.filter((e) => keep.has(e.source) && keep.has(e.target)).map((e) => e.id)) };
    },
    tints() {
      if (!s.tint) return null;
      const out = new Map<string, string>();
      summary.domains.forEach((d, i) => { for (const id of d.tables) out.set(id, colorOf(i)); });
      return out;
    },
    render() {
      const { h, panel } = kit;
      panel.append(
        kit.panelHead("Model structure", kit.close, "Close model structure panel"),
        h("p", { class: "bd-hint", role: "status", text: structureHeadline(summary) + (summary.approximate ? " · centrality estimated from a sample" : "") }),
      );
      const tabs = h("div", { class: "bd-seg", role: "tablist", "aria-label": "Structure view" });
      for (const t of [{ id: "hubs", text: "Hubs" }, { id: "bridges", text: "Bridges" }, { id: "domains", text: "Domains" }] as const) {
        tabs.append(kit.button(`bd-btn${s.tab === t.id ? " bd-btn--on" : ""}`, t.text, () => { s.tab = t.id; s.hover = null; kit.refresh(); }, {
          role: "tab",
          "aria-selected": String(s.tab === t.id),
        }));
      }
      panel.append(h("div", { class: "bd-panel__controls" }, tabs));
      const item = (id: string, detail: string) => {
        const b = kit.button("bd-item", "", () => kit.navigate(id), { title: `Go to ${kit.nodeLabel(id)}` });
        b.append(h("span", { class: "bd-item__label", text: kit.nodeLabel(id) }), h("span", { class: "bd-item__detail", text: detail }));
        hoverable(b, id);
        return h("li", {}, b);
      };

      if (s.tab === "hubs") {
        if (!summary.hubs.length) {
          panel.append(h("p", { class: "bd-empty", text: "No key joins two tables yet." }));
          return;
        }
        const top = summary.hubs[0]!.centrality || 1;
        const bars = h("ul", { class: "bd-ubars", "aria-label": "Hubs" });
        for (const hub of summary.hubs) {
          const fill = h("span", { class: "bd-ubar__fill" });
          fill.style.width = `${Math.round((hub.centrality / top) * 100)}%`;
          const b = kit.button("bd-ubar", "", () => kit.navigate(hub.id), { title: `Go to ${kit.nodeLabel(hub.id)}` });
          b.append(
            h("span", { class: "bd-ubar__label", text: kit.nodeLabel(hub.id) }),
            h("span", { class: "bd-ubar__track", "aria-hidden": "true" }, fill),
            h("span", { class: "bd-ubar__value", text: String(hub.degree), title: "Keys in and out" }),
          );
          hoverable(b, hub.id);
          bars.append(h("li", {}, b));
        }
        panel.append(bars);
        return;
      }

      if (s.tab === "bridges") {
        const cuts = h("ul", { class: "bd-list" });
        for (const a of summary.articulation.slice(0, 300)) cuts.append(item(a.id, `without it: ${a.splits} pieces`));
        panel.append(kit.section("Tables holding it together", summary.articulation.length,
          summary.articulation.length ? cuts : h("p", { class: "bd-empty", text: "No single table’s loss would split the model." })));
        const keys = h("ul", { class: "bd-list" });
        for (const b of summary.bridges.slice(0, 300)) {
          const btn = kit.button("bd-item", "", () => kit.navigate(b.source), { title: `Go to ${kit.nodeLabel(b.source)}` });
          btn.append(h("span", { class: "bd-item__label", text: `${kit.nodeLabel(b.source)}${b.field ? `.${b.field}` : ""} → ${kit.nodeLabel(b.target)}` }));
          hoverable(btn, b.source);
          keys.append(h("li", {}, btn));
        }
        panel.append(kit.section("Bridge keys", summary.bridges.length,
          summary.bridges.length ? keys : h("p", { class: "bd-empty", text: "Every key has another route around it." })));
        if (summary.islands.length) {
          panel.append(h("details", { class: "bd-section" },
            h("summary", { class: "bd-pcap" }, "No key joins them", h("span", { class: "bd-pcount", text: String(summary.islands.length) })),
            kit.nodeList(summary.islands, null),
          ));
        }
        return;
      }

      panel.append(h("div", { class: "bd-panel__controls" },
        checkbox(kit, "Colour tables by domain", s.tint, (on) => { s.tint = on; kit.paint(); }, "Outline every table in its domain’s colour")));
      const sharedLists = () => {
        if (summary.shared.length) {
          const list = h("ul", { class: "bd-list" });
          for (const id of summary.shared.slice(0, 300)) list.append(item(id, ""));
          panel.append(kit.section("Shared by every domain", summary.shared.length, list));
        }
        if (summary.unassigned.length) {
          panel.append(h("details", { class: "bd-section" },
            h("summary", { class: "bd-pcap" }, "Joined only through shared tables", h("span", { class: "bd-pcount", text: String(summary.unassigned.length) })),
            kit.nodeList(summary.unassigned, null),
          ));
        }
      };
      if (!summary.domains.length) {
        panel.append(h("p", { class: "bd-empty", text: summary.shared.length ? "Every key runs through the shared tables." : "No key joins two tables yet." }));
        sharedLists();
        return;
      }
      const list = h("ul", { class: "bd-list", "aria-label": "Domains" });
      summary.domains.forEach((d, i) => {
        const on = s.domain === d.id;
        const b = kit.button(`bd-item${on ? " bd-item--on" : ""}`, "", () => { s.domain = on ? null : d.id; kit.refresh(); }, {
          "aria-pressed": String(on),
          title: on ? "Show every table again" : `Dim the picture to ${d.label}’s domain`,
        });
        const sw = h("span", { class: "bd-swatch", "aria-hidden": "true" });
        sw.style.background = colorOf(i);
        b.append(sw, h("span", { class: "bd-item__label", text: d.label }), h("span", { class: "bd-item__detail", text: `${plural(d.tables.length, "table")} · ${d.externalKeys} out`, title: `${d.internalKeys} keys inside, ${d.externalKeys} leading out` }));
        list.append(h("li", {}, b));
      });
      panel.append(list);
      sharedLists();
      if (summary.misplaced.length) {
        const mis = h("ul", { class: "bd-list" });
        for (const m of summary.misplaced.slice(0, 300)) mis.append(item(m.nodeId, `in ${kit.nodeLabel(m.group)}, ${Math.round(m.share * 100)}% of keys to ${kit.nodeLabel(m.pullsToward)}`));
        panel.append(kit.section("Keys lead elsewhere", summary.misplaced.length, mis));
      }
    },
  };
}

// ── Key coverage (a saved analysis, opened) ────────────────────────────────

/** What share of the model a set of keys reaches — the editor's coverage score, read-only. */
export function coveragePanel(kit: PanelKit, keys: FieldRef[], scope: CoverageScope): PagePanel {
  const result = () => keyCoverage(kit.model, keys, { scope });
  return {
    label: "Key coverage",
    save: () => ({ kind: "coverage", keys, scope }),
    mask() {
      const r = result();
      return { keep: new Set(r.reached), keepEdges: null };
    },
    render() {
      const { h, panel } = kit;
      const r = result();
      panel.append(
        kit.panelHead("Key coverage", kit.close, "Close coverage panel"),
        h("p", { class: "bd-hint", role: "status", text: `${r.reached.size} of ${plural(r.total, "table")} reached (${Math.round(r.fraction * 100)}%)` }),
      );
      if (scope.kind === "from") panel.append(h("p", { class: "bd-note", text: `From ${kit.nodeLabel(scope.nodeId)}` }));
      const list = h("ul", { class: "bd-list", "aria-label": "Keys" });
      for (const ref of keys) {
        const added = r.byKey.get(fieldKey(ref)) ?? [];
        const b = kit.button("bd-item", "", () => { kit.navigate(ref.nodeId); kit.mark([fieldKey(ref)]); });
        b.append(h("span", { class: "bd-item__label", text: `${kit.nodeLabel(ref.nodeId)}.${ref.fieldId}` }), h("span", { class: "bd-item__detail", text: `+${added.length}` }));
        list.append(h("li", {}, b));
      }
      panel.append(kit.section("Keys", keys.length, list));
    },
  };
}

// ── Saved analyses ─────────────────────────────────────────────────────────

/** The document's saved analyses: what each says now, how far it drifted, and a way in. */
export function analysesPanel(kit: PanelKit, analyses: readonly SavedAnalysis[], open: (a: SavedAnalysis) => void): PagePanel {
  return {
    label: "Analyses",
    mask: () => null,
    render() {
      const { h, panel } = kit;
      panel.append(kit.panelHead("Analyses", kit.close, "Close analyses panel"));
      const list = h("ul", { class: "bd-list", "aria-label": "Saved analyses" });
      for (const a of analyses) {
        const now = readAnalysis(kit.model, a, kit.nodeLabel);
        const drift = analysisDrift(a.kind, a.snapshot, now);
        const b = kit.button("bd-item bd-item--stack", "", () => open(a), a.note ? { title: a.note } : {});
        b.append(
          h("span", { class: "bd-item__label", text: a.title }),
          h("span", { class: "bd-item__detail", text: `${ANALYSIS_KIND_LABEL[a.kind]} · ${now.headline}` }),
        );
        if (drift) b.append(h("span", { class: "bd-item__drift", text: drift }));
        list.append(h("li", {}, b));
      }
      panel.append(list);
    },
  };
}

// ── Column lineage ─────────────────────────────────────────────────────────

/** Where a column's values come from and where they go — the model's lineage, traced in the page. */
export function lineagePanel(kit: PanelKit, subject: FieldRef): PagePanel {
  const lineage = kit.model.lineage ?? [];
  const byId = new Map(lineage.map((l) => [l.id, l]));
  const untagged = new Set(sensitiveLineage(kit.model).map((x) => fieldKey(x.ref)));
  /** A column a link names but its table doesn't list (a cut-short table may just not list it). */
  const missing = (ref: FieldRef) => {
    const node = kit.model.nodes.find((n) => n.id === ref.nodeId);
    if (!node) return true;
    if ((node.data?.model as { fieldsTruncated?: boolean } | undefined)?.fieldsTruncated) return false;
    return !fieldRecords(node, kit.model).some((r) => r.id === ref.fieldId);
  };
  const s = { direction: "both" as "upstream" | "downstream" | "both", maxDepth: null as number | null, hover: null as FieldRef | null };
  const trace = () => traceLineage(lineage, subject, { direction: s.direction, ...(s.maxDepth !== null ? { maxDepth: s.maxDepth } : {}) });
  const col = (ref: FieldRef) => `${kit.nodeLabel(ref.nodeId)}.${ref.fieldId}`;
  return {
    label: "Lineage",
    mask() {
      const t = trace();
      return { keep: new Set([subject.nodeId, ...t.columns.map((c) => c.ref.nodeId)]), keepEdges: new Set<string>() };
    },
    rows() {
      const t = trace();
      return new Set([fieldKey(subject), ...t.columns.map((c) => fieldKey(c.ref))]);
    },
    links() {
      const t = trace();
      const chain = s.hover ? new Set((lineageChain(lineage, t, s.hover) ?? []).map((l) => l.id)) : null;
      return t.links.flatMap((id) => {
        const l = byId.get(id);
        return l ? [{ id: l.id, from: l.from, to: l.to, emphasis: chain?.has(l.id) ?? false }] : [];
      });
    },
    render() {
      const { h, panel } = kit;
      const t = trace();
      panel.append(
        kit.panelHead("Lineage", kit.close, "Close lineage panel"),
        h("div", { class: "bd-panel__pins" }, kit.button("bd-chip", col(subject), () => { kit.navigate(subject.nodeId); }, { title: `Go to ${col(subject)}` })),
        h("div", { class: "bd-panel__controls" },
          seg(kit, null, "Direction", [
            { id: "both" as const, text: "Both", title: "Where it comes from and where it goes" },
            { id: "upstream" as const, text: "Upstream", title: "The columns it is computed from" },
            { id: "downstream" as const, text: "Downstream", title: "The columns it feeds" },
          ], s.direction, (d) => { s.direction = d; kit.refresh(); }),
          seg(kit, "Links", "Depth", [{ id: "1", text: "1" }, { id: "2", text: "2" }, { id: "3", text: "3" }, { id: "all", text: "All" }], s.maxDepth === null ? "all" : String(s.maxDepth), (d) => {
            s.maxDepth = d === "all" ? null : Number(d);
            kit.refresh();
          }),
        ),
        h("p", { class: "bd-hint", role: "status", text: lineageHeadline(t) + (t.truncated ? " — more beyond this depth" : "") }),
      );
      if (!t.columns.length) {
        panel.append(h("p", { class: "bd-empty", text: "No lineage reaches this column." }));
        return;
      }
      for (const dir of ["upstream", "downstream"] as const) {
        const columns = t.columns.filter((c) => c.direction === dir);
        if (!columns.length) continue;
        const list = h("ul", { class: "bd-list" });
        for (const c of columns.slice(0, 500)) {
          const link = byId.get(c.via);
          const b = kit.button("bd-item", "", () => { kit.navigate(c.ref.nodeId); }, { title: `Go to ${col(c.ref)}` });
          b.append(h("span", { class: "bd-item__label", text: col(c.ref) }));
          if (missing(c.ref)) b.append(h("span", { class: "bd-badge", text: "not in the model", title: "A lineage link names this column, but its table doesn't list it — renamed or dropped?" }));
          if (untagged.has(fieldKey(c.ref))) b.append(h("span", { class: "bd-badge bd-badge--cascade", text: "untagged", title: "Sensitive values reach this column, which carries no sensitive tag" }));
          const detail = [c.depth > 1 ? plural(c.depth, "link") : "", link?.transform ?? "", link?.job ? `· ${link.job}` : ""].filter(Boolean).join(" ");
          if (detail) b.append(h("span", { class: "bd-item__detail", text: detail }));
          kit.hoverable(b, () => { s.hover = c.ref; kit.paint(); }, () => { s.hover = null; kit.paint(); });
          list.append(h("li", {}, b));
        }
        panel.append(kit.section(dir === "upstream" ? "Comes from" : "Flows into", columns.length, list));
      }
    },
  };
}

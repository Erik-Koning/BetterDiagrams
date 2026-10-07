/**
 * html-explorer.ts — search and relationship analysis in the interactive
 * HTML export: what the page is given, and the chrome it adds.
 *
 * The analysis runs IN the page, from the editor's own code. The runtime
 * (`html-explorer-runtime.ts`) imports `computeRouteView`, `keyReferences`,
 * `searchFields` and the stand-in rule (`representatives`) rather than
 * restating them, and is bundled into one inline script —
 * `html-explorer-runtime.generated.ts`, rebuilt by `npm run build:explorer`;
 * a test fails while it is stale. This module prepares what that script
 * reads — the document slice, what each level's SVG draws — and the styles
 * and markup hooks around it.
 *
 * DOM-free string building, like html-export.ts.
 */
import type { DiagramTemplate, NodeField } from "../contract/schema";
import type { LintFinding } from "../contract/lint";
import type { GovernanceReport } from "../contract/dictionary";
import type { StructureSummary } from "../contract/structure";
import type { SavedAnalysis } from "../contract/analyses";
import type { LineageLink } from "../contract/lineage-links";
import type { ExportPalette } from "./draw";
import { EXPLORER_RUNTIME } from "./html-explorer-runtime.generated";

/** A node as the page's analysis reads it: identity, search text, rows, and the field data a dialect keeps. */
export interface ExplorerNode {
  id: string;
  label?: string;
  kind?: string;
  description?: string;
  tags?: string[];
  parentId?: string;
  /** The owning team and lifecycle status — governance reads them. */
  team?: string;
  status?: string;
  fields?: NodeField[];
  data?: Record<string, unknown>;
}

export interface ExplorerEdge {
  id: string;
  source: string;
  target: string;
  direction?: string;
  startField?: string;
  endField?: string;
  /** The relationship kind and the cardinality at each end — impact and SQL read them. */
  relation?: string;
  startLabel?: string;
  endLabel?: string;
  data?: Record<string, unknown>;
}

/** The structural slice of a document the searches read — a `FieldDocument`. */
export interface ExplorerDocument {
  nodes: ExplorerNode[];
  edges: ExplorerEdge[];
  /** Column lineage — the trace and governance's untagged flows read it. */
  lineage?: LineageLink[];
}

/** What one level's SVG draws: its node ids, and each line as `[id, source, target]` between the boxes it is DRAWN between. */
export interface ExplorerLevel {
  nodes: string[];
  edges: Array<[string, string, string]>;
}

export interface HtmlExplorerData {
  doc: ExplorerDocument;
  /** Per page level ("" is the root): what its SVG draws. */
  levels: Record<string, ExplorerLevel>;
  /** The drill stack that shows each nested node (`focusPath`); absent means the root level. */
  homes: Record<string, string[]>;
  /** Colours routes take, in order (`transientPathColors`), and the hex each name paints. */
  routeColors: string[];
  edgeHex: Record<string, string>;
  /** The highlighter one route is singled out in. */
  routeColor: string;
  /**
   * Checks, run at export time — a host's rules are functions and cannot run
   * in the page — capped at `FINDINGS_CAP`, with how many were left out.
   */
  findings?: LintFinding[];
  findingsTruncated?: number;
  /** What each rule is called, for grouping the findings. */
  rules?: Record<string, { label: string; description?: string }>;
  /** The governance report, computed at export time — static, so the page carries the answer. */
  governance?: GovernanceReport;
  /** Hubs, bridges and suggested domains, computed at export time (two tables or more). */
  structure?: StructureSummary;
  /** The document's saved analyses — the page re-runs them over the slice it carries. */
  analyses?: SavedAnalysis[];
}

/** Findings a page carries before it says how many it left out. */
export const FINDINGS_CAP = 5000;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Copy the named keys a bag actually has. */
function pick(bag: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (bag[k] !== undefined) out[k] = bag[k];
  return Object.keys(out).length ? out : undefined;
}

/**
 * The part of a `data` bag the analyses read: a data-model import's field
 * list, field metadata, entity shape, name, label, namespace, row count and
 * truncation, or a host's `data.fields`; on an edge, the dialect's record of
 * the fields it joins, its kind, whether it is required, and what a delete
 * does. Everything else in a bag is the host's own business and stays
 * out of a file that may be mailed around. The slice is pinned by a test
 * that runs the analysis on both and compares.
 */
function dataSlice(data: Record<string, unknown> | undefined, modelKeys: readonly string[], ownKeys: readonly string[]) {
  if (!data) return undefined;
  const model = isRecord(data.model) ? pick(data.model, modelKeys) : undefined;
  const own = pick(data, ownKeys);
  const out = { ...own, ...(model ? { model } : {}) };
  return Object.keys(out).length ? out : undefined;
}

export function explorerDocument(template: Pick<DiagramTemplate, "nodes" | "edges" | "lineage">): ExplorerDocument {
  return {
    nodes: template.nodes.map((n) => {
      const data = dataSlice(
        n.data,
        ["fields", "fieldMeta", "shape", "name", "label", "namespace", "recordCount", "fieldsTruncated", "profile"],
        ["fields"],
      );
      return {
        id: n.id,
        ...(n.label !== undefined ? { label: n.label } : {}),
        ...(n.kind !== undefined ? { kind: String(n.kind) } : {}),
        ...(n.description ? { description: n.description } : {}),
        ...(n.tags?.length ? { tags: n.tags } : {}),
        ...(n.parentId ? { parentId: n.parentId } : {}),
        ...(n.team ? { team: n.team } : {}),
        ...(n.status ? { status: n.status } : {}),
        ...(n.fields?.length ? { fields: n.fields } : {}),
        ...(data ? { data } : {}),
      };
    }),
    edges: template.edges.map((e) => {
      const data = dataSlice(
        e.data,
        ["field", "targetField", "kind", "required", "cascadeDelete", "deleteConstraint", "relationshipName", "referenceTo"],
        [],
      );
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        ...(e.direction !== undefined ? { direction: e.direction } : {}),
        ...(e.startField !== undefined ? { startField: e.startField } : {}),
        ...(e.endField !== undefined ? { endField: e.endField } : {}),
        ...(e.relation ? { relation: e.relation } : {}),
        ...(e.startLabel ? { startLabel: e.startLabel } : {}),
        ...(e.endLabel ? { endLabel: e.endLabel } : {}),
        ...(data ? { data } : {}),
      };
    }),
    ...(template.lineage?.length ? { lineage: template.lineage } : {}),
  };
}

/** A drawn level (`drawnElements`) as the page carries it. */
export function explorerLevel(drawn: { nodes: string[]; edges: Array<{ id: string; source: string; target: string }> }): ExplorerLevel {
  return { nodes: drawn.nodes, edges: drawn.edges.map((e) => [e.id, e.source, e.target]) };
}

/** Styles for the explorer's chrome and its marks on the picture. */
export function explorerCss(palette: ExportPalette, accent: string, routeColor: string, light: boolean): string {
  return `
  /* ── Explorer: search, pins, the references and paths panels, and their
     marks on the picture. ── */
  .bd-stage { place-items: safe center; }
  .bd-searchwrap { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .bd-search {
    width: 220px; height: 28px; padding: 0 9px; border: 1px solid ${palette.border}; border-radius: 6px;
    background: ${palette.surface2}; color: ${palette.text}; font: inherit; font-size: 12px;
  }
  .bd-search:focus { outline: 2px solid ${accent}; outline-offset: -1px; }
  .bd-searchcount { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: ${palette.textDim}; white-space: nowrap; }
  .bd-searchhit {
    max-width: 260px; overflow: hidden; padding: 2px 8px; border-radius: 999px;
    background: color-mix(in srgb, ${accent} 14%, transparent); color: ${palette.text};
    font-size: 11px; text-overflow: ellipsis; white-space: nowrap;
  }
  .bd-searchcount[hidden], .bd-searchhit[hidden] { display: none; }
  .bd-menu .bd-menuhint { margin: 0; padding: 2px 12px 8px; color: ${palette.textDim}; font-size: 11px; line-height: 1.4; }
  .bd-pinstrip {
    display: flex; align-items: center; gap: 10px; flex: 0 0 auto;
    padding: 6px 14px; border-bottom: 1px solid ${palette.border}; background: ${palette.surface};
  }
  .bd-pinstrip[hidden] { display: none; }
  .bd-pinstrip__caption { font-family: ui-monospace, Menlo, monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: ${palette.textDim}; white-space: nowrap; }
  .bd-pinstrip__chips { display: flex; flex: 1; flex-wrap: wrap; gap: 4px; min-width: 0; }
  .bd-pinchip { display: inline-flex; }
  .bd-chip {
    max-width: 240px; height: 22px; overflow: hidden; padding: 0 8px;
    border: 1px solid color-mix(in srgb, ${accent} 45%, transparent); border-radius: 999px;
    background: color-mix(in srgb, ${accent} 12%, transparent); color: ${palette.text};
    font: inherit; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; cursor: pointer;
  }
  .bd-chip:hover { border-color: ${accent}; }
  .bd-pinchip .bd-chip:first-child { border-radius: 999px 0 0 999px; border-right: 0; }
  .bd-pinchip .bd-chip--x { padding: 0 7px; border-radius: 0 999px 999px 0; }
  .bd-btn--on { border-color: ${accent}; color: ${accent}; }
  /* The left sidebar, as in the editor: paths, references and key usage take turns in it. */
  .bd-panel {
    position: fixed; top: var(--bd-top, 56px); left: 12px; bottom: 12px; z-index: 30; width: 330px;
    overflow: auto; padding: 12px; border: 1px solid ${palette.border}; border-radius: 10px;
    background: ${palette.surface}; box-shadow: 0 12px 32px rgb(0 0 0 / ${light ? "18%" : "45%"}); font-size: 12px;
  }
  .bd-panel[hidden] { display: none; }
  /* The page can't pan out from under the sidebar the way the editor's canvas
     can, so while it is open the stage keeps that strip free and the picture
     lays out beside it, not under it. */
  body.bd-x-sidebar .bd-stage { padding-left: 358px; }
  .bd-panel__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  .bd-panel__title { margin: 0; font-size: 13px; font-weight: 600; }
  .bd-panel__pins { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px; }
  .bd-panel__controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-bottom: 8px; }
  .bd-check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  .bd-seg { display: inline-flex; align-items: center; gap: 4px; }
  .bd-seg__caption { color: ${palette.textDim}; font-size: 11px; }
  .bd-note { margin: 6px 0; padding: 6px 8px; border-radius: 6px; background: ${palette.surface2}; font-size: 11px; line-height: 1.4; }
  .bd-section { margin-top: 12px; }
  .bd-pcap {
    margin: 0 0 6px; font-family: ui-monospace, Menlo, monospace; font-size: 10px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.06em; color: ${palette.textDim};
  }
  summary.bd-pcap { cursor: pointer; }
  .bd-pcount { margin-left: 4px; color: ${palette.text}; }
  .bd-list { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
  .bd-item {
    display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 8px;
    border: 1px solid transparent; border-radius: 6px; background: none; color: ${palette.text};
    font: inherit; font-size: 12px; text-align: left; cursor: pointer;
  }
  .bd-item:hover:not(:disabled), .bd-item--hover { background: ${palette.surface2}; }
  .bd-item--sticky { border-color: ${accent}; background: color-mix(in srgb, ${accent} 12%, transparent); }
  .bd-item:disabled { cursor: default; opacity: 0.75; }
  .bd-item__label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bd-item__detail { flex: 0 0 auto; font-family: ui-monospace, Menlo, monospace; font-size: 10px; color: ${palette.textDim}; }
  .bd-item--stack { flex-direction: column; align-items: flex-start; gap: 2px; }
  .bd-item--stack .bd-item__detail { flex: 1 1 auto; white-space: normal; }
  .bd-item__drift { font-size: 10px; color: ${palette.overdue ?? "#d97706"}; }
  .bd-share { flex: 0 0 48px; height: 4px; overflow: hidden; border-radius: 2px; background: ${palette.surface2}; }
  .bd-share > span { display: block; height: 100%; background: ${accent}; }
  .bd-route { align-items: flex-start; }
  .bd-route__body { display: grid; flex: 1; gap: 2px; min-width: 0; }
  .bd-route__title { overflow-wrap: anywhere; }
  .bd-route__keys { display: flex; flex-wrap: wrap; gap: 2px 4px; font-family: ui-monospace, Menlo, monospace; font-size: 10px; color: ${palette.textDim}; }
  .bd-route .bd-swatch2 { margin-top: 3px; }
  .bd-swatch2 {
    display: inline-block; flex: 0 0 auto; width: 10px; height: 10px; border-radius: 3px;
    border: 1px solid var(--bd-c); background: color-mix(in srgb, var(--bd-c) 35%, transparent);
  }
  .bd-empty, .bd-hint { margin: 4px 0; color: ${palette.textDim}; font-size: 11px; }
  .bd-more { padding: 3px 8px; color: ${palette.textDim}; font-size: 11px; }
  .bd-expand { margin-top: 6px; }
  #bd-usagebtn[hidden], #bd-checksbtn[hidden], #bd-govbtn[hidden], #bd-structbtn[hidden], #bd-dictbtn[hidden], #bd-analysesbtn[hidden] { display: none; }
  .bd-gline { display: grid; grid-template-columns: minmax(0, 1fr) 72px auto; align-items: center; gap: 8px; padding: 3px 8px; font-size: 11px; }
  .bd-sev { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: ${palette.textDim}; }
  .bd-sev--error { background: #f43f5e; }
  .bd-sev--warning { background: ${palette.overdue ?? "#d97706"}; }
  .bd-sev--info { background: ${accent}; }
  .bd-badge { flex: 0 0 auto; padding: 0 4px; border: 1px solid ${palette.border}; border-radius: 3px; font-family: ui-monospace, Menlo, monospace; font-size: 9px; color: ${palette.textDim}; }
  .bd-badge--cascade { border-color: #f43f5e; color: #f43f5e; }
  .bd-filter { width: 100%; height: 26px; padding: 0 8px; border: 1px solid ${palette.border}; border-radius: 6px; background: ${palette.surface2}; color: ${palette.text}; font: inherit; font-size: 12px; }
  /* ── Key usage: which tables carry a field, and the share of the model. ── */
  .bd-usage__searchbox { display: grid; gap: 6px; margin-bottom: 4px; }
  .bd-usage__search {
    width: 100%; height: 28px; padding: 0 8px; border: 1px solid ${palette.border}; border-radius: 6px;
    background: ${palette.surface2}; color: ${palette.text}; font: inherit; font-size: 12px;
  }
  .bd-usage__search:focus { outline: 2px solid ${accent}; outline-offset: -1px; }
  .bd-usage__pickedhead { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
  .bd-usage__pickedhead .bd-pcap { margin: 0; }
  .bd-usage__controls { margin-top: 10px; }
  .bd-usage__fields { max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bd-ubars { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
  /* The results feed the score below them: kept short enough that picking one never pushes it away. */
  .bd-ubars--results { max-height: 30vh; overflow: auto; }
  .bd-ubar {
    display: grid; grid-template-columns: minmax(0, 1fr) 72px auto; align-items: center; gap: 8px;
    width: 100%; padding: 5px 8px; border: 1px solid transparent; border-radius: 6px;
    background: none; color: ${palette.text}; font: inherit; font-size: 11px; text-align: left; cursor: pointer;
  }
  .bd-ubar:hover, .bd-ubar:focus-visible { background: color-mix(in srgb, ${accent} 10%, transparent); outline: none; }
  .bd-ubar--on { border-color: color-mix(in srgb, ${accent} 45%, transparent); background: color-mix(in srgb, ${accent} 8%, transparent); }
  .bd-ubar__label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bd-ubar__name { font-family: ui-monospace, Menlo, monospace; }
  .bd-ubar__badge {
    margin-left: 6px; padding: 0 4px; border: 1px solid color-mix(in srgb, ${accent} 45%, transparent); border-radius: 3px;
    color: ${accent}; font-family: ui-monospace, Menlo, monospace; font-size: 9px; font-weight: 700;
  }
  .bd-ubar__target { color: ${palette.textDim}; }
  .bd-ubar__track { height: 8px; overflow: hidden; border-radius: 4px; background: ${palette.surface2}; }
  .bd-ubar__fill { display: block; height: 100%; border-radius: 4px; background: ${accent}; }
  .bd-ubar__fill--gain { background: color-mix(in srgb, ${accent} 55%, ${palette.textDim}); }
  .bd-ubar__value { font-family: ui-monospace, Menlo, monospace; font-size: 10px; color: ${palette.textDim}; white-space: nowrap; }
  .bd-ubar__badge--mixed { border-color: color-mix(in srgb, ${palette.overdue ?? "#d97706"} 55%, transparent); color: ${palette.overdue ?? "#d97706"}; }
  .bd-usage__filters { display: flex; flex-wrap: wrap; gap: 4px 14px; }
  .bd-usage__variants { display: grid; gap: 1px; margin: 0 0 4px 14px; padding: 0 0 0 8px; list-style: none; border-left: 2px solid color-mix(in srgb, ${accent} 30%, transparent); }
  /* ── A row with an action beside it: a route and its SQL, a table and "Focus". ── */
  .bd-routeitem, .bd-rowpair { display: flex; align-items: flex-start; gap: 4px; }
  .bd-routeitem > .bd-item, .bd-rowpair > .bd-item { flex: 1; min-width: 0; }
  .bd-sqlbtn, .bd-rowaction { flex: 0 0 auto; height: 24px; padding: 0 7px; font-size: 10px; }
  .bd-sql { display: grid; gap: 6px; margin: 2px 0 8px 18px; padding: 8px; border: 1px solid ${palette.border}; border-radius: 6px; background: ${palette.surface2}; }
  .bd-sql__controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .bd-sql__select { height: 24px; padding: 0 4px; border: 1px solid ${palette.border}; border-radius: 5px; background: ${palette.surface}; color: ${palette.text}; font: inherit; font-size: 11px; }
  .bd-sql__code { max-height: 220px; margin: 0; overflow: auto; font-family: ui-monospace, Menlo, monospace; font-size: 11px; line-height: 1.45; white-space: pre; color: ${palette.text}; }
  .bd-sql__warnings { margin: 0; padding: 0 0 0 16px; color: ${palette.textDim}; font-size: 11px; }
  .bd-sql__warning--double-fan-out, .bd-sql__warning--no-key { color: ${palette.overdue ?? "#d97706"}; }
  .bd-stat { display: grid; grid-template-columns: auto 1fr; align-items: baseline; gap: 6px 10px; margin-top: 12px; }
  .bd-stat__pct { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; color: ${accent}; }
  .bd-stat__detail { font-size: 12px; color: ${palette.textDim}; }
  .bd-stat__meter { grid-column: 1 / -1; height: 8px; overflow: hidden; border-radius: 4px; background: ${palette.surface2}; }
  .bd-stat__meter > span { display: block; height: 100%; border-radius: 4px; background: ${accent}; }
  .bd-context {
    position: fixed; z-index: 50; min-width: 210px; max-width: 320px; padding: 4px 0;
    border: 1px solid ${palette.border}; border-radius: 8px; background: ${palette.surface};
    box-shadow: 0 12px 32px rgb(0 0 0 / ${light ? "18%" : "45%"});
  }
  .bd-context[hidden] { display: none; }
  .bd-context__caption {
    overflow: hidden; padding: 6px 12px 4px; font-family: ui-monospace, Menlo, monospace; font-size: 10px;
    color: ${palette.textDim}; text-overflow: ellipsis; white-space: nowrap;
  }
  .bd-context__item {
    display: flex; justify-content: space-between; gap: 14px; width: 100%; padding: 7px 12px;
    border: 0; background: none; color: ${palette.text}; font: inherit; font-size: 12px; text-align: left; cursor: pointer;
  }
  .bd-context__item:hover, .bd-context__item:focus-visible { background: ${palette.surface2}; outline: none; }
  .bd-context__item > :first-child { flex: 0 0 auto; white-space: nowrap; }
  .bd-context__hint { min-width: 0; overflow: hidden; color: ${palette.textDim}; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .bd-context__rule { margin: 4px 0; border: 0; border-top: 1px solid ${palette.border}; }
  .bd-modal { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; background: rgb(0 0 0 / 45%); }
  .bd-modal[hidden] { display: none; }
  .bd-grid {
    display: flex; flex-direction: column; width: min(1100px, 94vw); max-height: 86vh;
    border: 1px solid ${palette.border}; border-radius: 10px; background: ${palette.surface};
  }
  .bd-grid__head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid ${palette.border}; }
  .bd-grid__title { flex: 1; min-width: 0; margin: 0; overflow: hidden; font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .bd-grid__filter {
    width: 200px; height: 28px; padding: 0 8px; border: 1px solid ${palette.border}; border-radius: 6px;
    background: ${palette.surface2}; color: ${palette.text}; font: inherit; font-size: 12px;
  }
  .bd-grid__body { overflow: auto; }
  .bd-grid table { width: max-content; min-width: 100%; border-collapse: collapse; font-size: 12px; }
  .bd-grid th {
    position: sticky; top: 0; padding: 6px 8px; border-bottom: 1px solid ${palette.border};
    background: ${palette.surface2}; font-weight: 600; text-align: left; white-space: nowrap; cursor: pointer; user-select: none;
  }
  .bd-grid td {
    max-width: 320px; overflow: hidden; padding: 4px 8px; border-bottom: 1px solid color-mix(in srgb, ${palette.border} 60%, transparent);
    text-overflow: ellipsis; white-space: nowrap;
  }
  .bd-grid td.bd-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .bd-grid .bd-center { text-align: center; }
  .bd-grid tr.bd-grid__hit td { background: color-mix(in srgb, ${accent} 16%, transparent); }
  .bd-grid tr.bd-grid__pinned td:first-child { box-shadow: inset 2px 0 0 ${accent}; }
  .bd-link { padding: 0; border: 0; background: none; color: ${accent}; font: inherit; cursor: pointer; }
  .bd-link:hover { text-decoration: underline; }
  .bd-grid__empty { padding: 16px; color: ${palette.textDim}; }
  .bd-toast {
    position: fixed; bottom: 20px; left: 50%; z-index: 70; padding: 8px 14px; transform: translateX(-50%);
    border: 1px solid ${palette.border}; border-radius: 8px; background: ${palette.surface2}; color: ${palette.text}; font-size: 12px;
  }
  .bd-toast[hidden] { display: none; }
  /* ── On the picture: rows take the pointer; marks are strokes cloned from
     an element's own outline, so they follow its shape. ── */
  .bd-row { cursor: pointer; }
  .bd-row:hover { fill: ${accent}; fill-opacity: 0.08; }
  .bd-row.bd-x-match { fill: ${accent}; fill-opacity: 0.18; }
  .bd-x-bar { fill: ${accent}; pointer-events: none; }
  .bd-x-ring, .bd-x-halo, .bd-x-pinring, .bd-x-matchglow { fill: none; stroke: ${accent}; pointer-events: none; }
  .bd-x-ring { stroke-width: 2; }
  .bd-x-halo { stroke-width: 7; stroke-opacity: 0.22; }
  .bd-x-pinring { stroke-width: 2; stroke-dasharray: 5 3; }
  .bd-x-lineage { fill: none; stroke: #8b5cf6; stroke-width: 1.75; stroke-dasharray: 6 4; opacity: 0.8; pointer-events: none; }
  .bd-x-lineage--on { stroke-width: 3; stroke-dasharray: none; opacity: 1; }
  .bd-x-lineage-arrow { fill: #8b5cf6; }
  .bd-x-domain { fill: none; stroke: var(--bd-c); stroke-width: 4; stroke-opacity: 0.85; pointer-events: none; }
  .bd-swatch { flex: 0 0 auto; width: 10px; height: 10px; border-radius: 3px; }
  .bd-item--on { border-color: ${accent}; }
  .bd-x-matchglow { stroke-width: 9; stroke-opacity: 0.4; filter: blur(3px); }
  .bd-el.bd-x-unmarked { opacity: 0.55; }
  .bd-el.bd-x-unmarked:hover { opacity: 1; }
  .bd-el.bd-x-dim { opacity: 0.22; }
  .bd-el.bd-x-dim:hover { opacity: 1; }
  @keyframes bd-x-flash { 0%, 100% { stroke-opacity: 0.22; } 30% { stroke-opacity: 0.9; } }
  .bd-x-flash { animation: bd-x-flash 600ms ease-in-out 2; }
  @keyframes bd-x-pulse { 0%, 100% { opacity: 0.45; } 14% { opacity: 1; } 32% { opacity: 0.45; } }
  @keyframes bd-x-flow { to { stroke-dashoffset: -22; } }
  [data-route] {
    --bd-cycle: calc(var(--bd-steps, 1) * 420ms);
    --bd-delay: calc((var(--bd-step, 0) - var(--bd-steps, 1)) * 420ms);
    stroke: var(--bd-c); pointer-events: none;
  }
  .bd-x-glowline, .bd-x-glowbody {
    fill: none; stroke-width: 9; stroke-linecap: round; stroke-linejoin: round;
    stroke-opacity: ${light ? "0.85" : "0.65"}; opacity: 0.6; filter: blur(${light ? "1.5px" : "2.5px"});
  }
  .bd-x-glowbody { stroke-width: 7; }
  .bd-x-flowline { fill: none; stroke-width: 2.4; stroke-linecap: round; stroke-dasharray: 7 15; }
  .bd-x-moving.bd-x-glowline, .bd-x-moving.bd-x-glowbody { animation: bd-x-pulse var(--bd-cycle) ease-in-out var(--bd-delay) infinite; }
  .bd-x-moving.bd-x-flowline { animation: bd-x-flow 900ms linear infinite; }
  .bd-x-moving.bd-x-flowline.bd-x-reverse { animation-direction: reverse; }
  .bd-x-keybadge rect { fill: ${palette.bg}; stroke: ${routeColor}; stroke-width: 1; }
  .bd-x-keybadge text { fill: ${routeColor}; font-family: ui-monospace, Menlo, monospace; font-size: 10px; font-weight: 600; }
  .bd-x-keybadge { pointer-events: none; }
  @media (prefers-reduced-motion: reduce) { [data-route], .bd-x-flash { animation: none !important; } }
`;
}

/** The search box and the key-usage button, for the header bar. */
export const explorerSearchMarkup = `
    <div class="bd-searchwrap">
      <input class="bd-search" id="bd-search" type="search" placeholder="Search…" aria-label="Search nodes and fields" autocomplete="off" spellcheck="false" />
      <span class="bd-searchcount" id="bd-searchcount" aria-live="polite" title="Enter for the next match, Shift+Enter for the previous" hidden></span>
      <span class="bd-searchhit" id="bd-searchhit" hidden></span>
    </div>
    <button class="bd-btn" id="bd-usagebtn" type="button" aria-pressed="false" title="Which tables carry a field, and what share of the model" hidden>Key usage</button>
    <button class="bd-btn" id="bd-checksbtn" type="button" aria-pressed="false" title="Architecture and data-model findings" hidden>Checks</button>
    <button class="bd-btn" id="bd-analysesbtn" type="button" aria-pressed="false" title="The analyses saved with this model" hidden>Analyses</button>`;

/** How to reach it, for the ⋯ menu: nothing on the page says rows can be clicked. */
export const explorerMenuMarkup = `
        <div class="bd-caption">Explore</div>
        <p class="bd-menuhint">Click a field row, or right-click a node, to pin it, follow its keys, or show what points at it. Shift-click to select several. Key usage lists the tables that carry a field.</p>
        <button class="bd-menubtn" id="bd-govbtn" type="button" hidden>Governance</button>
        <button class="bd-menubtn" id="bd-structbtn" type="button" hidden>Model structure</button>
        <button class="bd-menubtn" id="bd-linkbtn" type="button" title="A link that opens this page on the routes, key usage, impact or neighbourhood on show">Copy link to this analysis</button>
        <button class="bd-menubtn" id="bd-dictbtn" type="button" hidden>Download data dictionary (CSV)</button>`;

/** The pinned-fields strip, under the header and timeline bars. */
export const explorerStripMarkup = `
  <div class="bd-pinstrip" id="bd-pinstrip" role="toolbar" aria-label="Pinned fields" hidden></div>`;

/** Panels, menus and the field grid: fixed over the stage, filled by the runtime. */
export const explorerOverlayMarkup = `
  <aside class="bd-panel" id="bd-panel" hidden></aside>
  <div class="bd-context" id="bd-context" role="menu" aria-label="Actions" hidden></div>
  <div class="bd-modal" id="bd-grid" hidden></div>
  <div class="bd-toast" id="bd-toast" role="status" hidden></div>`;

/**
 * The data and the runtime. The data rides in a JSON script block with every
 * "<" escaped, so no label, description or field name can close it.
 */
export function explorerScripts(data: HtmlExplorerData): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<script type="application/json" id="bd-explorer-data">${json}</script>
<script>
(function () {
${EXPLORER_RUNTIME}
BDExplorer.mountExplorer(document, JSON.parse(document.getElementById("bd-explorer-data").textContent));
})();
</script>
`;
}

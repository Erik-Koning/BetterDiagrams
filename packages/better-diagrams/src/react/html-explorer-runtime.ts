/**
 * html-explorer-runtime.ts — search and relationship analysis, running
 * inside the interactive HTML export.
 *
 * Bundled by `scripts/build-explorer-runtime.mjs` into one IIFE (the
 * `BDExplorer` global, inside the page's own closure) and inlined by
 * `explorerScripts`. It imports the editor's analysis instead of restating
 * it — `computeRouteView` and `litRoutes` for the paths panel,
 * `keyReferences` for the references panel, `fieldUsage` and
 * `usageCoverage` for key usage, `searchFields` and the node match rule for
 * the search, `representatives` for which drawn box stands
 * for a table on each level — so the page and the editor answer the same
 * question the same way.
 *
 * Plain DOM, no framework: a handful of state, `paint()` redrawing the marks
 * on the level being shown, and the panels rebuilt from the state. Levels
 * are switched through the multi-view page's navigator by event (`bd:show`
 * out, `bd:view` back), so a single-level page needs no navigator at all.
 */
import type { EdgeColor } from "../contract/schema";
import {
  buildFieldIndex,
  edgeKeyOf,
  fieldKey,
  fieldRecords,
  keyReferences,
  referencedKey,
  referencesTo,
  sameFieldRef,
  searchFields,
  type FieldIndex,
  type FieldRecord,
  type FieldRef,
  type FieldTarget,
  type KeyLink,
  type KeyReferences,
  type Pin,
} from "../contract/fields";
import { computeRouteView, litRoutes, ROUTE_CAP, shownRouteIndices, type RouteView } from "./field-routes";
import { documentNodeId, keptOnCanvas, representatives } from "./path-view";
import { cellText, fileSlug, filterRecords, gridColumnsFor, sortRecords, toCsv, type GridColumn } from "./field-grid";
import {
  fieldUsage,
  inconsistencySummary,
  searchFieldUsage,
  usageCoverage,
  usageHeadline,
  variantSummary,
  type FieldUsage,
  type FieldUsageIndex,
} from "../contract/key-usage";
import type { GraphWalk } from "../contract/graph";
import { routeSql, SQL_DIALECTS, type RouteSqlOptions, type SqlDialect } from "../contract/route-sql";
import {
  analysesPanel,
  checksPanel,
  coveragePanel,
  governancePanel,
  impactPanel,
  neighbourhoodPanel,
  structurePanel,
  lineagePanel,
  type PagePanel,
  type PanelKit,
} from "./html-explorer-panels";
import { validateAnalyses, type SavedAnalysisBody } from "../contract/analyses";
import { dataDictionary, dictionaryCsv } from "../contract/dictionary";
import type { ExplorerNode, HtmlExplorerData } from "./html-explorer";

/** More rows than this and a list says how many it left out — the editor's panels' cap. */
const LIST_CAP = 500;
const SVG_NS = "http://www.w3.org/2000/svg";
/** Attributes a cloned outline must not inherit from the shape it traces. */
const STRIP = ["fill", "fill-opacity", "stroke", "stroke-opacity", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "class", "filter", "style"];

type SearchMatch =
  | { kind: "node"; id: string }
  | { kind: "field"; id: string; fieldId: string; name: string; row: boolean; nodeLabel: string };

/** One level of the page as the explorer works with it. */
interface Level {
  key: string;
  root: Element;
  /** `data-el` → the groups carrying it (an element can span several: labels paint last). */
  groups: Map<string, Element[]>;
  /** Document node → the drawn node standing for it (`representatives`). */
  reps: Map<string, string>;
  /** Document edge → the drawn line showing it. */
  lineOf: Map<string, string>;
  /** Every drawn line with the document edges it stands for. */
  lines: Array<{ id: string; edges: string[] }>;
}

interface State {
  view: string;
  /** Document node ids. */
  selection: string[];
  pins: Pin[];
  /** Row and table marks, as `fieldKey`s — a table's ends in an empty field. */
  marks: Set<string>;
  /** What the left sidebar shows — one panel at a time, as in the editor. */
  panel: "paths" | "refs" | "usage" | "analysis" | null;
  /** The analysis panel on show when `panel` is "analysis" (html-explorer-panels.ts). */
  analysis: PagePanel | null;
  /** Which route's SQL is open ("route:3", "key:…"), and the reader's SQL choices. */
  sqlOpen: string | null;
  sql: Required<Pick<RouteSqlOptions, "dialect" | "join" | "select">>;
  refPin: Pin | null;
  undirected: boolean;
  mode: "between" | "reachable";
  hoverRoute: number | null;
  stickyRoute: number | null;
  hoverKey: string | null;
  stickyKey: string | null;
  routesExpanded: boolean;
  query: string;
  /** The match the page is on; -1 is "typed, not yet jumped". */
  matchIndex: number;
  flash: string | null;
  /** Key usage: its search, and the field names picked (lowercased, as the index keys them). */
  usageQuery: string;
  usageKeysOnly: boolean;
  usageInconsistentOnly: boolean;
  /** One way a picked name is stored, focused: the list and the picture narrow to its tables. */
  usageVariant: { id: string; family: string } | null;
  usageKeys: string[];
  usageMatch: "any" | "all";
  usageTargets: boolean;
  usageHover: string | null;
}

const DIALECT_KEY = "bd-explorer:sql-dialect";

/** The reader's last SQL dialect, remembered across pages where storage allows. */
function storedDialect(): SqlDialect {
  try {
    const v = globalThis.localStorage?.getItem(DIALECT_KEY);
    return SQL_DIALECTS.some((d) => d.id === v) ? (v as SqlDialect) : "ansi";
  } catch {
    return "ansi";
  }
}

export function mountExplorer(doc: Document, data: HtmlExplorerData): void {
  const $ = (id: string) => doc.getElementById(id);
  const stage = $("bd-stage")!;
  const panel = $("bd-panel")!;
  const context = $("bd-context")!;
  const gridModal = $("bd-grid")!;
  const toastEl = $("bd-toast")!;
  const strip = $("bd-pinstrip")!;
  const search = $("bd-search") as HTMLInputElement;
  const searchCount = $("bd-searchcount")!;
  const searchHit = $("bd-searchhit")!;
  const usageButton = $("bd-usagebtn") as HTMLButtonElement | null;
  const checksButton = $("bd-checksbtn") as HTMLButtonElement | null;
  const analysesButton = $("bd-analysesbtn") as HTMLButtonElement | null;

  const model = data.doc;
  const nodeById = new Map<string, ExplorerNode>(model.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(model.edges.map((e) => [e.id, e]));
  const childCount = new Map<string, number>();
  for (const n of model.nodes) if (n.parentId) childCount.set(n.parentId, (childCount.get(n.parentId) ?? 0) + 1);
  const nodeLabel = (id: string) => nodeById.get(id)?.label ?? id;
  /** "Account · AccountId" — a table pin is the label alone. */
  const pinLabel = (ref: Pin) => (ref.fieldId ? `${nodeLabel(ref.nodeId)} · ${ref.fieldId}` : nodeLabel(ref.nodeId));
  const endLabel = (ref: Pin) => `${nodeLabel(ref.nodeId)}${ref.fieldId ? `.${ref.fieldId}` : ""}`;
  const records = (id: string): FieldRecord[] => {
    const n = nodeById.get(id);
    return n ? fieldRecords(n, model) : [];
  };
  const hex = (color: string) => data.edgeHex[color] ?? data.edgeHex.slate ?? "#94a3b8";
  /** Every column a lineage link names — the field menu offers "Trace lineage" on these. */
  const lineageKeys = new Set((model.lineage ?? []).flatMap((l) => [fieldKey(l.from), fieldKey(l.to)]));
  const keyColor = (data.routeColors[0] ?? "sky") as EdgeColor;

  const state: State = {
    view: "",
    selection: [],
    pins: [],
    marks: new Set(),
    panel: null,
    refPin: null,
    undirected: true,
    mode: "between",
    hoverRoute: null,
    stickyRoute: null,
    hoverKey: null,
    stickyKey: null,
    routesExpanded: false,
    query: "",
    matchIndex: -1,
    flash: null,
    usageQuery: "",
    usageKeysOnly: false,
    usageInconsistentOnly: false,
    usageVariant: null,
    analysis: null,
    sqlOpen: null,
    sql: { dialect: storedDialect(), join: "auto", select: "star" },
    usageKeys: [],
    usageMatch: "any",
    usageTargets: false,
    usageHover: null,
  };
  let usageIndex: FieldUsageIndex | null = null;
  /** The key-usage panel's changing half — rebuilt as the reader types and picks; its search box stays put. */
  let usageBody: HTMLElement | null = null;

  // ── Levels ───────────────────────────────────────────────────────────────

  const levelCache = new Map<string, Level>();
  function levelRoot(key: string): Element {
    for (const section of Array.from(doc.querySelectorAll(".bd-view"))) {
      if (section.getAttribute("data-view") === key) return section;
    }
    return stage;
  }
  function level(key: string): Level {
    const cached = levelCache.get(key);
    if (cached) return cached;
    const root = levelRoot(key);
    const drawn = data.levels[key] ?? { nodes: [], edges: [] };
    const groups = new Map<string, Element[]>();
    for (const g of Array.from(root.querySelectorAll(".bd-el[data-el]"))) {
      const el = g.getAttribute("data-el")!;
      const list = groups.get(el);
      if (list) list.push(g);
      else groups.set(el, [g]);
    }
    const reps = representatives(model, drawn.nodes);
    // A line keeps its document edge's id, or a derived one (`ghost:`) on a
    // drilled level; one drawn between other boxes than its edge's ends is a
    // stand-in, and bundles every edge whose ends land on the same two.
    const byPair = new Map<string, string[]>();
    for (const e of model.edges) {
      const s = reps.get(e.source);
      const t = reps.get(e.target);
      if (s === undefined || t === undefined || s === t) continue;
      const key2 = `${s}\u0000${t}`;
      const list = byPair.get(key2);
      if (list) list.push(e.id);
      else byPair.set(key2, [e.id]);
    }
    const lines: Level["lines"] = [];
    const lineOf = new Map<string, string>();
    for (const [id, source, target] of drawn.edges) {
      const own = edgeById.get(id);
      const standIn = !own || own.source !== source || own.target !== target;
      const edges = standIn ? (byPair.get(`${source}\u0000${target}`) ?? []) : [id];
      lines.push({ id, edges });
      for (const e of edges) if (!lineOf.has(e)) lineOf.set(e, id);
    }
    const out: Level = { key, root, groups, reps, lineOf, lines };
    levelCache.set(key, out);
    return out;
  }
  /** The level that shows a node: the last of its drill stack, or the root. */
  const homeOf = (id: string) => data.homes[id]?.at(-1) ?? "";

  /**
   * Ask the page's navigator for a level. It answers synchronously with
   * `bd:view`, so the state is on the new level when this returns; a
   * single-level page has no navigator and stays where it is.
   */
  function showLevel(key: string): boolean {
    if (key === state.view) return false;
    doc.dispatchEvent(new CustomEvent("bd:show", { detail: key }));
    return state.view === key;
  }
  doc.addEventListener("bd:view", (event) => {
    const key = (event as CustomEvent<string>).detail;
    if (key === state.view) return;
    state.view = key;
    // A drill clears the selection on the way — never the marks or the pins.
    state.selection = [];
    closeContext();
    paint();
  });

  // ── Marks on the picture ─────────────────────────────────────────────────

  /** What the last paint added, and the classes it set — undone first next time. */
  let added: Element[] = [];
  let classed: Array<[Element, string]> = [];
  const addClass = (el: Element, cls: string) => {
    el.classList.add(cls);
    classed.push([el, cls]);
  };
  /** An element's own outline: the first path drawn directly in its group. */
  function outlineOf(g: Element): SVGElement | null {
    for (const child of Array.from(g.children)) {
      if (child.tagName.toLowerCase() === "path" && !child.hasAttribute("data-path") && !child.hasAttribute("data-x")) {
        return child as SVGElement;
      }
    }
    return null;
  }
  function trace(src: Element, cls: string): Element {
    const el = src.cloneNode(false) as Element;
    for (const a of STRIP) el.removeAttribute(a);
    el.setAttribute("class", cls);
    el.setAttribute("data-x", "");
    el.setAttribute("fill", "none");
    added.push(el);
    return el;
  }
  /** Trace the first group of an element that has an outline, over or under it. */
  function decorate(groups: readonly Element[] | undefined, cls: string, under = false): Element | null {
    for (const g of groups ?? []) {
      const src = outlineOf(g);
      if (!src) continue;
      const el = trace(src, cls);
      if (under) g.insertBefore(el, g.firstChild);
      else g.appendChild(el);
      return el;
    }
    return null;
  }
  function svgEl(tag: string, attrs: Record<string, string | number>): Element {
    const el = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    el.setAttribute("data-x", "");
    added.push(el);
    return el;
  }
  const rowsOf = (g: Element) => Array.from(g.querySelectorAll("rect.bd-row"));

  /** A drawn outline's box, from its absolute path commands — the page has no layout engine to ask. */
  function outlineBox(g: readonly Element[] | undefined): { x: number; y: number; w: number; h: number } | null {
    for (const el of g ?? []) {
      const d = outlineOf(el)?.getAttribute("d");
      if (!d) continue;
      const xs: number[] = [];
      const ys: number[] = [];
      for (const [, cmd, args] of d.matchAll(/([MLHVCSQTA])([^A-Za-z]*)/g)) {
        const n = (args!.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
        const step = cmd === "A" ? 7 : cmd === "C" ? 6 : cmd === "S" || cmd === "Q" ? 4 : cmd === "H" || cmd === "V" ? 1 : 2;
        for (let i = step - 1; i < n.length; i += step) {
          if (cmd === "H") xs.push(n[i]!);
          else if (cmd === "V") ys.push(n[i]!);
          else {
            xs.push(n[i - 1]!);
            ys.push(n[i]!);
          }
        }
      }
      if (xs.length && ys.length) {
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
      }
    }
    return null;
  }
  /** Where a column sits on this level: its row, or the middle of the card standing for its table. */
  function rowPoint(lvl: Level, ref: FieldRef): { x: number; y: number; w: number } | null {
    const canvasId = lvl.reps.get(ref.nodeId);
    if (canvasId === undefined) return null;
    const groups = lvl.groups.get(`node:${canvasId}`);
    if (canvasId === ref.nodeId) {
      for (const g of groups ?? []) {
        const row = rowsOf(g).find((r) => r.getAttribute("data-field") === ref.fieldId);
        if (row) {
          const x = Number(row.getAttribute("x"));
          return { x, y: Number(row.getAttribute("y")) + Number(row.getAttribute("height")) / 2, w: Number(row.getAttribute("width")) };
        }
      }
    }
    const box = outlineBox(groups);
    return box ? { x: box.x, y: box.y + box.h / 2, w: box.w } : null;
  }
  function drawLineage(lvl: Level, links: ReadonlyArray<{ id: string; from: FieldRef; to: FieldRef; emphasis: boolean }>): void {
    const svg = lvl.root.tagName.toLowerCase() === "svg" ? lvl.root : lvl.root.querySelector("svg");
    if (!svg) return;
    const defs = svgEl("defs", {});
    const marker = svgEl("marker", { id: "bd-x-lineage-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
    marker.appendChild(svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", class: "bd-x-lineage-arrow" }));
    defs.appendChild(marker);
    svg.appendChild(defs);
    for (const l of links) {
      const a = rowPoint(lvl, l.from);
      const b = rowPoint(lvl, l.to);
      if (!a || !b || (a.x === b.x && a.y === b.y)) continue;
      const rightward = b.x + b.w / 2 >= a.x + a.w / 2;
      const x1 = rightward ? a.x + a.w : a.x;
      const x2 = rightward ? b.x : b.x + b.w;
      const bend = Math.max(40, Math.abs(x2 - x1) / 2) * (rightward ? 1 : -1);
      svg.appendChild(svgEl("path", {
        class: `bd-x-lineage${l.emphasis ? " bd-x-lineage--on" : ""}`,
        "data-lineage": l.id,
        d: `M ${x1} ${a.y} C ${x1 + bend} ${a.y}, ${x2 - bend} ${b.y}, ${x2} ${b.y}`,
        "marker-end": "url(#bd-x-lineage-arrow)",
      }));
    }
  }

  function paint(): void {
    for (const el of added) el.remove();
    for (const [el, cls] of classed) el.classList.remove(cls);
    added = [];
    classed = [];
    const lvl = level(state.view);
    const pinKeys = new Set(state.pins.map(fieldKey));
    const selected = new Set(state.selection.map((id) => lvl.reps.get(id)).filter((id): id is string => id !== undefined));
    // The reader's marks, and an analysis panel's rows (a lineage trace).
    const panelRows = state.panel === "analysis" ? (state.analysis?.rows?.() ?? null) : null;
    const marks = panelRows ? new Set([...state.marks, ...panelRows]) : state.marks;
    const tableMarks = [...state.marks].some((k) => k.endsWith("\u0000"));
    const marked = (docId: string) => {
      const prefix = `${docId}\u0000`;
      for (const k of marks) if (k.startsWith(prefix)) return true;
      return false;
    };
    const view = currentRouteView();
    const panelMask = state.panel === "analysis" ? (state.analysis?.mask() ?? null) : null;
    const tints = state.panel === "analysis" ? (state.analysis?.tints?.() ?? null) : null;
    const mask = usageMask() ?? panelMask?.keep ?? null;
    const keep = mask ?? view?.keep ?? null;
    const kept = keep ? keptOnCanvas(keep, lvl.reps) : null;
    // Key usage keeps the lines between two tables it keeps; the paths panel its own.
    const keepEdges = panelMask
      ? panelMask.keepEdges
      : mask
        ? new Set(model.edges.filter((e) => mask.has(e.source) && mask.has(e.target)).map((e) => e.id))
        : (view?.keepEdges ?? null);

    for (const [el, groups] of lvl.groups) {
      if (!el.startsWith("node:")) continue;
      const canvasId = el.slice(5);
      const docId = documentNodeId(canvasId);
      if (docId === null) continue;
      if (kept && !kept.has(docId)) for (const g of groups) addClass(g, "bd-x-dim");
      if (tableMarks && !marked(docId)) for (const g of groups) addClass(g, "bd-x-unmarked");
      if (marks.has(fieldKey({ nodeId: docId }))) decorate(groups, "bd-x-matchglow", true);
      if (pinKeys.has(fieldKey({ nodeId: docId }))) decorate(groups, "bd-x-pinring");
      const tint = tints?.get(docId);
      if (tint) (decorate(groups, "bd-x-domain") as SVGElement | null)?.style.setProperty("--bd-c", tint);
      if (selected.has(canvasId)) {
        decorate(groups, `bd-x-halo${state.flash === docId ? " bd-x-flash" : ""}`);
        decorate(groups, "bd-x-ring");
      }
      for (const g of groups) {
        for (const row of rowsOf(g)) {
          const key = fieldKey({ nodeId: docId, fieldId: row.getAttribute("data-field")! });
          const match = marks.has(key);
          if (match) addClass(row, "bd-x-match");
          if (match || pinKeys.has(key)) {
            g.appendChild(svgEl("rect", {
              class: "bd-x-bar",
              x: row.getAttribute("x")!,
              y: row.getAttribute("y")!,
              width: pinKeys.has(key) ? 3 : 2,
              height: row.getAttribute("height")!,
            }));
          }
        }
      }
    }

    // Column lineage: lines row to row, drawn over the picture.
    const lineageLinks = state.panel === "analysis" ? (state.analysis?.links?.() ?? []) : [];
    if (lineageLinks.length) drawLineage(lvl, lineageLinks);

    if (keepEdges) {
      for (const line of lvl.lines) {
        if (line.edges.some((e) => keepEdges.has(e))) continue;
        for (const g of lvl.groups.get(`edge:${line.id}`) ?? []) addClass(g, "bd-x-dim");
      }
    }

    // Walks: the routes the paths panel lights, or an analysis panel's
    // (an impact chain, a lineage trace) — in their colours, or one bright.
    const lit: Array<{ walk: GraphWalk; color: string }> = view
      ? litRoutes(view, routeFocus(), nodeLabel, keyColor).map((w) => ({ walk: w.walk, color: hex(w.color) }))
      : state.panel === "analysis" && state.analysis?.walks
        ? state.analysis.walks().map((w) => ({ walk: w.walk, color: w.color ?? data.routeColor }))
        : [];
    if (lit.length) {
      const bright = lit.length === 1;
      // One walk moves: the one singled out, else the shortest lit.
      let moving = 0;
      lit.forEach((w, i) => { if (w.walk.edges.length < lit[moving]!.walk.edges.length) moving = i; });
      lit.forEach((w, k) => {
        const color = bright ? data.routeColor : w.color;
        const steps = w.walk.nodes.length + w.walk.edges.length;
        const anim = k === moving ? " bd-x-moving" : "";
        const style = (el: Element, step: number) => {
          el.setAttribute("data-route", String(k));
          (el as SVGElement).style.setProperty("--bd-c", color);
          (el as SVGElement).style.setProperty("--bd-step", String(step));
          (el as SVGElement).style.setProperty("--bd-steps", String(steps));
        };
        const seen = new Set<string>();
        w.walk.nodes.forEach((id, i) => {
          const canvasId = lvl.reps.get(id);
          if (canvasId === undefined || seen.has(canvasId)) return;
          seen.add(canvasId);
          const el = decorate(lvl.groups.get(`node:${canvasId}`), `bd-x-glowbody${anim}`, true);
          if (el) style(el, i * 2);
        });
        w.walk.edges.forEach((id, i) => {
          const lineId = lvl.lineOf.get(id);
          if (lineId === undefined) return;
          const groups = lvl.groups.get(`edge:${lineId}`);
          const glow = decorate(groups, `bd-x-glowline${anim}`, true);
          if (!glow) return;
          style(glow, i * 2 + 1);
          const reversed = edgeById.get(id)?.source !== w.walk.nodes[i];
          const flow = decorate(groups, `bd-x-flowline${anim}${reversed ? " bd-x-reverse" : ""}`);
          if (flow) style(flow, i * 2 + 1);
          const edge = edgeById.get(id);
          const key = bright && edge ? edgeKeyOf(edge) : undefined;
          if (key && flow) keyBadge(flow, key);
        });
      });
    }
  }

  /** A bright route names the key carrying each hop, on the line's midpoint. */
  function keyBadge(line: Element, key: string): void {
    const path = line as SVGPathElement;
    if (typeof path.getTotalLength !== "function") return;
    let mid: DOMPoint;
    try {
      mid = path.getPointAtLength(path.getTotalLength() / 2);
    } catch {
      return;
    }
    const w = key.length * 6.1 + 10;
    const badge = svgEl("g", { class: "bd-x-keybadge" });
    const rect = svgEl("rect", { x: mid.x - w / 2, y: mid.y - 8, width: w, height: 16, rx: 4 });
    const text = svgEl("text", { x: mid.x, y: mid.y + 3.5, "text-anchor": "middle" });
    text.textContent = key;
    badge.appendChild(rect);
    badge.appendChild(text);
    line.parentNode?.appendChild(badge);
  }

  // ── Routes and references ────────────────────────────────────────────────

  let routeCache: { key: string; view: RouteView } | null = null;
  function currentRouteView(): RouteView | null {
    if (state.panel !== "paths" || state.pins.length < 2) return null;
    const key = `${state.pins.map(fieldKey).join("\u0001")}|${state.undirected}|${state.mode}`;
    if (routeCache?.key !== key) {
      routeCache = { key, view: computeRouteView(model, { pins: state.pins, undirected: state.undirected, mode: state.mode }, data.routeColors as EdgeColor[]) };
      // A new view (other pins, the direction toggled) folds the route list back.
      state.routesExpanded = false;
    }
    return routeCache.view;
  }
  const routeFocus = () => ({
    expanded: state.routesExpanded,
    hoverRoute: state.hoverRoute,
    stickyRoute: state.stickyRoute,
    hoverKey: state.hoverKey,
    stickyKey: state.stickyKey,
  });

  // ── Selection and navigation ─────────────────────────────────────────────

  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  /** Select one node and bring it into view — drilling to the level that draws it, if this one doesn't. */
  function navigate(id: string): void {
    if (!nodeById.has(id)) return;
    let moved = false;
    if (level(state.view).reps.get(id) !== id) moved = showLevel(homeOf(id));
    state.selection = [id];
    state.flash = id;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      state.flash = null;
    }, 1300);
    paint();
    const canvasId = level(state.view).reps.get(id);
    if (canvasId === undefined) return;
    const bring = () => reveal(level(state.view).groups.get(`node:${canvasId}`) ?? [], true);
    // A level just shown is still easing in; measure it once it has landed.
    if (moved) setTimeout(bring, 220);
    else bring();
  }
  /**
   * Scroll the stage so the elements sit in its middle. `closeUp` also leaves
   * fit-to-window when that shrank the picture below 90% — a jump should
   * land somewhere readable, as the editor's does.
   */
  function reveal(els: readonly Element[], closeUp: boolean): void {
    if (!els.length || typeof els[0]!.getBoundingClientRect !== "function") return;
    const fit = $("bd-fit") as HTMLInputElement | null;
    const svg = level(state.view).root.querySelector("svg");
    if (closeUp && fit?.checked && svg) {
      const drawnW = svg.getBoundingClientRect().width;
      const ownW = Number(svg.getAttribute("width"));
      if (drawnW > 0 && ownW > 0 && drawnW / ownW < 0.9) {
        fit.checked = false;
        fit.dispatchEvent(new Event("change"));
      }
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      minX = Math.min(minX, r.left);
      minY = Math.min(minY, r.top);
      maxX = Math.max(maxX, r.right);
      maxY = Math.max(maxY, r.bottom);
    }
    if (minX === Infinity) return;
    const box = stage.getBoundingClientRect();
    // The sidebar covers the stage's left edge: centre in what it leaves.
    const left = panel.hidden ? box.left : Math.max(box.left, panel.getBoundingClientRect().right);
    stage.scrollBy({
      left: (minX + maxX) / 2 - (left + box.right) / 2,
      top: (minY + maxY) / 2 - (box.top + box.bottom) / 2,
      behavior: "smooth",
    });
  }
  function setSelection(ids: string[]): void {
    state.selection = ids;
    // Selecting something the marks did not touch lifts them, as in the editor.
    if (state.marks.size && ids.length && !ids.some((id) => [...state.marks].some((k) => k.startsWith(`${id}\u0000`)))) {
      state.marks = new Set();
    }
    paint();
  }
  const setMarks = (keys: Iterable<string>) => {
    state.marks = new Set(keys);
  };

  function navigateField(ref: FieldRef): void {
    navigate(ref.nodeId);
    setMarks([fieldKey(ref)]);
    paint();
  }
  const jumpToPin = (pin: Pin) => (pin.fieldId ? navigateField({ nodeId: pin.nodeId, fieldId: pin.fieldId }) : navigate(pin.nodeId));
  /** Follow a reference: the table it points at, with both halves of the join marked. */
  function followReference(from: FieldRef, target: FieldTarget): void {
    if (!target.nodeId) return;
    navigate(target.nodeId);
    const key = referencedKey(model, target);
    setMarks([fieldKey(from), ...(key ? [fieldKey(key)] : [])]);
    paint();
  }
  function followLink(link: KeyLink): void {
    navigate(link.to.nodeId);
    setMarks([fieldKey(link.from), ...(link.to.fieldId ? [fieldKey(link.to)] : [])]);
    paint();
  }
  /** Mark everything pointing at a key (or a table), and open the references panel on it. */
  function showReferences(ref: Pin): void {
    const refs = referencesTo(model, ref);
    const marks = new Set<string>([fieldKey(ref), fieldKey({ nodeId: ref.nodeId })]);
    for (const r of refs) {
      marks.add(fieldKey({ nodeId: r.nodeId }));
      if (r.fieldId) marks.add(fieldKey(r));
    }
    state.marks = marks;
    state.refPin = { ...ref };
    state.panel = "refs";
    const tables = new Set(refs.map((r) => r.nodeId)).size;
    toast(refs.length ? `${refs.length} reference${refs.length === 1 ? "" : "s"} from ${tables} table${tables === 1 ? "" : "s"} marked` : "Nothing points at it");
    renderAll();
  }
  function closeRefPanel(): void {
    state.panel = null;
    state.refPin = null;
    state.marks = new Set();
    renderAll();
  }

  // ── Pins ─────────────────────────────────────────────────────────────────

  function setPins(pins: Pin[]): void {
    state.pins = pins;
    // Fewer than two pins, nothing to search; a new set forgets what was kept.
    if (pins.length < 2 && state.panel === "paths") state.panel = null;
    state.hoverRoute = state.stickyRoute = null;
    state.hoverKey = state.stickyKey = null;
    renderAll();
  }
  const isPinned = (ref: Pin) => state.pins.some((p) => sameFieldRef(p, ref));
  const togglePin = (ref: Pin) => setPins(isPinned(ref) ? state.pins.filter((p) => !sameFieldRef(p, ref)) : [...state.pins, ref]);
  function toggleTablePins(ids: readonly string[]): void {
    const tablePinned = (id: string) => state.pins.some((p) => !p.fieldId && p.nodeId === id);
    setPins(
      ids.every(tablePinned)
        ? state.pins.filter((p) => p.fieldId || !ids.includes(p.nodeId))
        : [...state.pins, ...ids.filter((id) => !tablePinned(id)).map((nodeId) => ({ nodeId }))],
    );
  }
  function openPaths(): void {
    state.panel = "paths";
    state.refPin = null;
    renderAll();
  }
  function togglePaths(): void {
    if (state.panel === "paths") {
      state.panel = null;
      renderAll();
    } else openPaths();
  }

  // ── Rendering helpers ────────────────────────────────────────────────────

  function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Partial<Record<string, string | boolean | number>> = {},
    ...children: Array<Node | string | null | undefined | false>
  ): HTMLElementTagNameMap[K] {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === false) continue;
      if (k === "text") el.textContent = String(v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children) if (c) el.append(c);
    return el;
  }
  function button(cls: string, label: string, onClick: () => void, props: Record<string, string | boolean> = {}): HTMLButtonElement {
    const b = h("button", { type: "button", class: cls, ...props }, label);
    b.addEventListener("click", onClick);
    return b;
  }
  const pinChip = (pin: Pin) => button("bd-chip", pinLabel(pin), () => jumpToPin(pin), { title: `Go to ${pinLabel(pin)}` });

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function toast(text: string): void {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, 2400);
  }

  function renderAll(): void {
    renderStrip();
    renderPanel();
    paint();
  }

  function renderStrip(): void {
    strip.textContent = "";
    strip.hidden = !state.pins.length;
    if (!state.pins.length) return placePanel();
    const chips = h("div", { class: "bd-pinstrip__chips" });
    for (const pin of state.pins) {
      chips.append(
        h("span", { class: "bd-pinchip" },
          pinChip(pin),
          button("bd-chip bd-chip--x", "×", () => togglePin(pin), { title: "Unpin", "aria-label": `Unpin ${pinLabel(pin)}` }),
        ),
      );
    }
    const paths = button(`bd-btn${state.panel === "paths" ? " bd-btn--on" : ""}`, "Show paths", togglePaths, {
      "aria-pressed": String(state.panel === "paths"),
      title: state.pins.length < 2 ? "Pin a second field or table to search for paths" : "Routes between the pins",
      disabled: state.pins.length < 2,
    });
    strip.append(h("span", { class: "bd-pinstrip__caption", text: `${state.pins.length} pinned` }), chips, paths, button("bd-btn", "Clear", () => setPins([])));
    placePanel();
  }

  /** The panel hangs from the stage's top edge, which moves as bars come and go. */
  function placePanel(): void {
    const top = stage.getBoundingClientRect?.().top ?? 0;
    doc.documentElement.style.setProperty("--bd-top", `${Math.max(12, top + 12)}px`);
  }
  if (typeof ResizeObserver === "function") new ResizeObserver(placePanel).observe(stage);

  function panelHead(title: string, onClose: () => void, closeLabel: string): HTMLElement {
    return h("div", { class: "bd-panel__head" },
      h("h2", { class: "bd-panel__title", text: title }),
      button("bd-btn bd-btn--icon", "×", onClose, { "aria-label": closeLabel }),
    );
  }
  function section(caption: string | null, count: number | null, ...body: Array<Node | null | false>): HTMLElement {
    return h("section", { class: "bd-section", "aria-label": caption ?? undefined },
      caption ? h("h3", { class: "bd-pcap" }, caption, count !== null ? h("span", { class: "bd-pcount", text: String(count) }) : null) : null,
      ...body,
    );
  }
  function nodeList(ids: readonly string[], empty: string | null, detail?: (id: string) => string): Node | null {
    if (!ids.length) return empty ? h("p", { class: "bd-empty", text: empty }) : null;
    const list = h("ul", { class: "bd-list" });
    for (const id of ids.slice(0, LIST_CAP)) {
      const b = button("bd-item", "", () => navigate(id), { title: `Go to ${nodeLabel(id)}` });
      b.append(h("span", { class: "bd-item__label", text: nodeLabel(id) }));
      if (detail) b.append(h("span", { class: "bd-item__detail", text: detail(id) }));
      list.append(h("li", {}, b));
    }
    if (ids.length > LIST_CAP) list.append(h("li", { class: "bd-more", text: `… and ${ids.length - LIST_CAP} more` }));
    return list;
  }

  function renderPanel(): void {
    panel.textContent = "";
    usageBody = null;
    const refs = state.panel === "refs" && state.refPin ? keyReferences(model, state.refPin) : null;
    const view = currentRouteView();
    const usageOpen = state.panel === "usage";
    const analysisOpen = state.panel === "analysis" && !!state.analysis;
    panel.hidden = !refs && !view && !usageOpen && !analysisOpen;
    doc.body.classList.toggle("bd-x-sidebar", !panel.hidden);
    if (usageButton) {
      usageButton.classList.toggle("bd-btn--on", usageOpen);
      usageButton.setAttribute("aria-pressed", String(usageOpen));
    }
    if (checksButton) {
      const on = analysisOpen && state.analysis?.label === "Checks";
      checksButton.classList.toggle("bd-btn--on", on);
      checksButton.setAttribute("aria-pressed", String(on));
    }
    if (analysesButton) {
      const on = analysisOpen && state.analysis?.label === "Analyses";
      analysesButton.classList.toggle("bd-btn--on", on);
      analysesButton.setAttribute("aria-pressed", String(on));
    }
    if (refs && state.refPin) renderReferences(state.refPin, refs);
    else if (view) renderPaths(view);
    else if (usageOpen) renderUsage();
    else if (analysisOpen && state.analysis) {
      panel.setAttribute("aria-label", state.analysis.label);
      state.analysis.render();
    }
  }

  function renderReferences(pin: Pin, view: KeyReferences): void {
    panel.setAttribute("aria-label", "References");
    const linkList = (caption: string, links: readonly KeyLink[], text: (l: KeyLink) => string, pick: (l: KeyLink) => void, empty: string) => {
      const list = links.length ? h("ul", { class: "bd-list" }) : h("p", { class: "bd-empty", text: empty });
      for (const link of links.slice(0, LIST_CAP)) {
        const b = button("bd-item", "", () => pick(link), { title: `Go to ${text(link)}` });
        b.append(h("span", { class: "bd-item__label", text: text(link) }));
        if (link.edgeId === undefined) b.append(h("span", { class: "bd-item__detail", text: "not drawn" }));
        list.append(h("li", {}, b));
      }
      if (links.length > LIST_CAP) list.append(h("li", { class: "bd-more", text: `… and ${links.length - LIST_CAP} more` }));
      return section(caption, links.length, list);
    };
    panel.append(
      panelHead("References", closeRefPanel, "Close references panel"),
      h("div", { class: "bd-panel__pins" }, pinChip(pin)),
      linkList(pin.fieldId ? "Points at" : "Keys it carries", view.carries, (l) => `${l.from.fieldId} → ${endLabel(l.to)}`, followLink, pin.fieldId ? "Not a reference." : "No foreign keys of its own."),
      linkList("Referenced by", view.referencedBy, (l) => `${endLabel(l.from)} → ${l.to.fieldId ?? nodeLabel(l.to.nodeId)}`, (l) => navigateField(l.from), "Nothing points at it."),
    );
  }

  function renderPaths(view: RouteView): void {
    panel.setAttribute("aria-label", "Paths between pinned fields");
    const pair = view.kind === "pair";
    const pins = state.pins;
    const undirected = h("input", { type: "checkbox", checked: state.undirected }) as HTMLInputElement;
    undirected.addEventListener("change", () => {
      state.undirected = undirected.checked;
      renderAll();
    });
    const controls = h("div", { class: "bd-panel__controls" }, h("label", { class: "bd-check" }, undirected, "Ignore arrow direction"));
    if (!pair) {
      const seg = h("div", { class: "bd-seg", role: "group", "aria-label": "Dim the canvas to" }, h("span", { class: "bd-seg__caption", text: "Dim to" }));
      for (const [mode, label] of [["between", "Between"], ["reachable", "Reachable"]] as const) {
        seg.append(button(`bd-btn${state.mode === mode ? " bd-btn--on" : ""}`, label, () => {
          state.mode = mode;
          renderAll();
        }, { "aria-pressed": String(state.mode === mode) }));
      }
      controls.append(seg);
    }
    panel.append(
      panelHead(pair ? "Paths between pins" : `Between ${pins.length} pins`, () => {
        state.panel = null;
        renderAll();
      }, "Close paths panel"),
      h("div", { class: "bd-panel__pins" }, ...pins.map(pinChip)),
      controls,
    );
    if (view.truncated) {
      panel.append(h("p", { class: "bd-note", role: "status", text: "The search stopped at its limits — more routes or tables may exist. Fewer pins, or pins closer together, narrow it." }));
    }
    for (const ref of view.constrainedFallback) {
      panel.append(h("p", { class: "bd-note" }, h("strong", { text: pinLabel(ref) }), " anchors no line on this document; searched from the table instead."));
    }
    if (view.pinsIgnored) {
      panel.append(h("p", { class: "bd-note", text: `Pairwise search looks at the first ${pins.length - view.pinsIgnored} pins; ${view.pinsIgnored} more are not compared.` }));
    }

    // First: the direct answer to "how do these join". With two pins it stays
    // even when empty, so a missing first section never reads as a glitch;
    // with more, it shows only when some pair has a key.
    if (view.directKeys.length || pair) {
      const list = h("ul", { class: "bd-list" });
      view.directKeys.slice(0, LIST_CAP).forEach((link, k) => {
        const key = fieldKey(link.from);
        const drawn = link.edgeId !== undefined;
        const b = keyButton(key, drawn ? "Hover to light this key on the canvas; click to keep it lit" : "The document draws no line for this reference");
        b.disabled = !drawn;
        b.append(h("span", { class: "bd-item__label", text: `${nodeLabel(link.from.nodeId)}.${link.from.fieldId} → ${endLabel(link.to)}` }));
        if (!drawn) b.append(h("span", { class: "bd-item__detail", text: "not drawn" }));
        const sqlId = `key:${key}\u0000${fieldKey(link.to)}`;
        list.append(h("li", {},
          h("div", { class: "bd-routeitem" }, b, drawn ? sqlToggle(sqlId, `key ${k + 1}`) : null),
          drawn ? sqlBlock(sqlId, { nodes: [link.from.nodeId, link.to.nodeId], edges: [link.edgeId!] }) : null,
        ));
      });
      const empty = view.directKeys.length
        ? null
        : h("p", { class: "bd-empty", text: `No key joins them directly${view.routes.length ? "; see the routes below" : ""}.` });
      panel.append(section("Keys joining the pins", view.directKeys.length, empty, view.directKeys.length ? list : null));
    }

    if (pair) {
      const shown = shownRouteIndices(view.routes.length, state.routesExpanded, state.stickyRoute);
      const list = h("ol", { class: "bd-list" });
      for (const i of shown) {
        const route = view.routes[i]!;
        const row = button(`bd-item bd-route${state.stickyRoute === i ? " bd-item--sticky" : ""}`, "", () => pickRoute(i), {
          "aria-pressed": String(state.stickyRoute === i),
          title: "Click to keep this route lit and frame it",
          "data-route-row": String(i),
        });
        const swatch = h("span", { class: "bd-swatch2", "aria-hidden": "true" });
        swatch.style.setProperty("--bd-c", hex(route.color));
        const keys = h("span", { class: "bd-route__keys", title: "The key carrying each hop" });
        route.keys.forEach((key, k) => keys.append(h("span", { text: `${k > 0 ? "▸ " : ""}${key}` })));
        row.append(
          swatch,
          h("span", { class: "bd-route__body" }, h("span", { class: "bd-route__title", text: route.title }), keys),
          h("span", { class: "bd-item__detail", text: `${route.hops} hop${route.hops === 1 ? "" : "s"}` }),
        );
        hoverable(row, () => setHover("route", i), () => setHover("route", null));
        list.append(h("li", {}, h("div", { class: "bd-routeitem" }, row, sqlToggle(`route:${i}`, `route ${i + 1}`)), sqlBlock(`route:${i}`, route.walk)));
      }
      const body: Array<Node | null> = [
        view.routes.length
          ? list
          : h("p", { class: "bd-empty", text: `No route between these fields within 10 hops${state.undirected ? "" : " in the arrows' direction"}.` }),
      ];
      if (view.routes.length > ROUTE_CAP) {
        body.push(button("bd-btn bd-expand", state.routesExpanded ? "Show fewer" : `Show all ${view.routes.length} routes`, () => {
          state.routesExpanded = !state.routesExpanded;
          renderAll();
        }, { "aria-expanded": String(state.routesExpanded) }));
      }
      if (state.hoverRoute === null && state.stickyRoute === null && state.hoverKey === null && state.stickyKey === null && shown.length > 1) {
        body.push(h("p", { class: "bd-hint", text: `${shown.length < view.routes.length ? "The shown routes are lit" : "All routes are lit"}; hover one to see it alone.` }));
      }
      panel.append(section("Routes", view.routes.length, ...body));
    }

    // A ranking needs something to rank: when no key is on more than one
    // route, every key reads "1 of N" and the list only repeats the keys
    // above and the routes' hop strips.
    if (pair && view.routes.length > 1 && view.keyUse?.keys.some((use) => use.routes > 1)) {
      const list = h("ul", { class: "bd-list" });
      for (const use of view.keyUse.keys.slice(0, LIST_CAP)) {
        const b = keyButton(fieldKey(use.ref), "Hover to light every route through this key; click to keep them lit");
        const bar = h("span", {});
        bar.style.width = `${Math.round(use.share * 100)}%`;
        b.append(
          h("span", { class: "bd-item__label", text: pinLabel(use.ref) }),
          h("span", { class: "bd-share", "aria-hidden": "true" }, bar),
          h("span", { class: "bd-item__detail", text: `${use.routes} of ${view.keyUse.routes}` }),
        );
        list.append(h("li", {}, b));
      }
      panel.append(section("Keys most routes use", view.keyUse.keys.length, list));
    }

    panel.append(section(pair ? "Tables between" : "Between the pins", view.betweenNodes.length, nodeList(view.betweenNodes, "None — the pins touch directly, or nothing joins them.")));
    if (!pair) {
      const others = [...view.reachable.keys()].filter((id) => !pins.some((p) => p.nodeId === id));
      panel.append(section("Reachable from the pins", others.length, nodeList(others, "Nothing beyond the pins themselves.", (id) => {
        const d = view.reachable.get(id);
        return d === undefined ? "" : `${d} hop${d === 1 ? "" : "s"}`;
      })));
    }
    if (view.corridorExtra.length) {
      const details = h("details", { class: "bd-section" },
        h("summary", { class: "bd-pcap" }, "Also within reach of both ends", h("span", { class: "bd-pcount", text: String(view.corridorExtra.length) })),
        h("p", { class: "bd-hint", text: "Close to both pins by shortest distance, but on no route the search enumerated." }),
        nodeList(view.corridorExtra, null),
      );
      panel.append(details);
    }
  }

  // ── Key usage: which tables carry a field, by name ──────────────────────

  /** The document never changes in the page, so the index is built once, on first use. */
  const usage = () => (usageIndex ??= fieldUsage(model));
  const usageOpts = () => ({ match: state.usageMatch, includeTargets: state.usageTargets });
  const usageSearchOpts = () => ({ keysOnly: state.usageKeysOnly, inconsistentOnly: state.usageInconsistentOnly });

  /**
   * With names picked (or one hovered) the picture dims to the tables using
   * them: a hovered name not yet picked previews the set with it added, a
   * picked one shows its own share — the editor's rule.
   */
  function usageMask(): Set<string> | null {
    if (state.panel !== "usage") return null;
    // A focused variant of a picked name: the tables storing it that way.
    const v = state.usageVariant;
    const variant = v && state.usageKeys.includes(v.id) ? usage().byId.get(v.id)?.variants.find((x) => x.family === v.family) : undefined;
    if (variant && !state.usageHover) return new Set(variant.tables.map((t) => t.nodeId));
    if (!state.usageKeys.length && !state.usageHover) return null;
    const hover = state.usageHover;
    const keys = !hover ? state.usageKeys : state.usageKeys.includes(hover) ? [hover] : [...state.usageKeys, hover];
    return new Set(usageCoverage(usage(), keys, usageOpts()).covered.map((c) => c.nodeId));
  }
  function refreshUsage(): void {
    if (usageBody) fillUsage(usageBody);
    paint();
  }
  function toggleUsageKey(id: string): void {
    state.usageKeys = state.usageKeys.includes(id) ? state.usageKeys.filter((k) => k !== id) : [...state.usageKeys, id];
    refreshUsage();
  }
  function toggleUsagePanel(): void {
    const open = state.panel !== "usage";
    // The sidebar holds one panel: key usage takes it from paths or references.
    state.panel = open ? "usage" : null;
    if (open) state.refPin = null;
    state.usageHover = null;
    renderAll();
    if (open) (panel.querySelector(".bd-usage__search") as HTMLInputElement | null)?.focus();
  }
  function closeUsage(): void {
    state.panel = null;
    state.usageHover = null;
    renderAll();
  }

  function renderUsage(): void {
    panel.setAttribute("aria-label", "Key usage");
    const input = h("input", {
      class: "bd-usage__search",
      type: "search",
      placeholder: "Search field names or keys…",
      "aria-label": "Search field names or keys",
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;
    input.value = state.usageQuery;
    input.addEventListener("input", () => {
      state.usageQuery = input.value;
      refreshUsage();
    });
    input.addEventListener("keydown", (event) => {
      // Enter picks the top match; Escape clears the box, then closes the panel.
      if (event.key === "Enter") {
        event.preventDefault();
        const top = searchFieldUsage(usage(), state.usageQuery, usageSearchOpts())[0];
        if (top && !state.usageKeys.includes(top.id)) toggleUsageKey(top.id);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (state.usageQuery) {
          input.value = state.usageQuery = "";
          refreshUsage();
        } else closeUsage();
      }
      event.stopPropagation();
    });
    const keysOnly = h("input", { type: "checkbox", checked: state.usageKeysOnly }) as HTMLInputElement;
    keysOnly.addEventListener("change", () => {
      state.usageKeysOnly = keysOnly.checked;
      refreshUsage();
    });
    const inconsistent = h("input", { type: "checkbox", checked: state.usageInconsistentOnly }) as HTMLInputElement;
    inconsistent.addEventListener("change", () => {
      state.usageInconsistentOnly = inconsistent.checked;
      refreshUsage();
    });
    usageBody = h("div", { class: "bd-usage__body" });
    panel.append(
      panelHead("Key usage", closeUsage, "Close key usage panel"),
      h("p", { class: "bd-hint", text: "Which tables carry a field. Pick one or more to see the share of the model that has them." }),
      h("div", { class: "bd-usage__searchbox" }, input,
        h("div", { class: "bd-usage__filters" },
          h("label", { class: "bd-check" }, keysOnly, "Keys only"),
          h("label", { class: "bd-check", title: "Names stored as more than one type, or nullable in some tables and not others" }, inconsistent, "Inconsistent only"),
        ),
      ),
      usageBody,
    );
    fillUsage(usageBody);
  }

  function fillUsage(body: HTMLElement): void {
    body.textContent = "";
    const index = usage();
    const total = index.tables.length;
    const q = state.usageQuery.trim();
    const results = searchFieldUsage(index, q, usageSearchOpts());
    const coverage = usageCoverage(index, state.usageKeys, usageOpts());
    const picked = state.usageKeys.map((id) => index.byId.get(id)).filter((f): f is FieldUsage => !!f);
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;

    const bar = (field: FieldUsage, on: boolean) => {
      const used = on ? (coverage.perKey.get(field.id) ?? field.tables.length) : field.tables.length;
      const tables = field.tables.map((t) => nodeLabel(t.nodeId));
      const badge = field.tables.some((t) => t.key === "pk" || t.key === "pfk") ? "PK" : field.isKey ? "FK" : null;
      const b = button(`bd-ubar${on ? " bd-ubar--on" : ""}`, "", () => toggleUsageKey(field.id), {
        "aria-pressed": String(on),
        title: `${on ? "Drop" : "Pick"} ${field.name} — in ${tables.slice(0, 8).join(", ")}${tables.length > 8 ? "…" : ""}${
          field.targets.length ? `; points at ${field.targets.map(nodeLabel).join(", ")}` : ""
        }`,
      });
      const label = h("span", { class: "bd-ubar__label" }, h("span", { class: "bd-ubar__name", text: field.name }));
      if (badge) label.append(h("span", { class: "bd-ubar__badge", text: badge }));
      if (!field.consistent) label.append(h("span", { class: "bd-ubar__badge bd-ubar__badge--mixed", text: "mixed", title: inconsistencySummary(field) }));
      if (field.targets.length) label.append(h("span", { class: "bd-ubar__target", text: ` → ${field.targets.map(nodeLabel).join(" | ")}` }));
      const fill = h("span", { class: `bd-ubar__fill${on ? "" : " bd-ubar__fill--gain"}` });
      fill.style.width = pct(total ? used / total : 0);
      b.append(label, h("span", { class: "bd-ubar__track", "aria-hidden": "true" }, fill), h("span", { class: "bd-ubar__value", text: plural(used, "table") }));
      // Hover previews on the picture without rebuilding the list under the pointer.
      hoverable(b, () => { state.usageHover = field.id; paint(); }, () => { state.usageHover = null; paint(); });
      return h("li", {}, b);
    };

    if (index.truncated.length) {
      body.append(h("p", { class: "bd-note", text: `${index.truncated.length} table${index.truncated.length === 1 ? " lists" : "s list"} only its first fields — every count is “at least”.` }));
    }
    const list = h("ul", { class: "bd-ubars bd-ubars--results" });
    for (const f of results.slice(0, LIST_CAP)) list.append(bar(f, state.usageKeys.includes(f.id)));
    if (results.length > LIST_CAP) list.append(h("li", { class: "bd-more", text: `… and ${results.length - LIST_CAP} more` }));
    body.append(section(q ? "Matches" : state.usageInconsistentOnly ? "Inconsistent" : "Shared by several tables", results.length, results.length
      ? list
      : h("p", {
          class: "bd-empty",
          text: q
            ? `No ${state.usageKeysOnly ? "key" : "field"} name contains “${q}”.`
            : state.usageInconsistentOnly
              ? "Every name is stored one way."
              : total ? "No field name is shared by two tables — search for one." : "Nothing to search: no node here stores fields.",
        })));

    if (!picked.length) {
      body.append(h("p", { class: "bd-empty", text: `Pick a field above to see which tables carry it${total ? ` — of ${plural(total, "table")}` : ""}.` }));
      return;
    }

    const pickedList = h("ul", { class: "bd-ubars" });
    for (const f of picked) {
      pickedList.append(bar(f, true));
      if (f.consistent) continue;
      // How an inconsistent pick is stored, a line per way — a line focuses
      // the list and the picture on the tables storing it that way.
      const variants = h("ul", { class: "bd-usage__variants", "aria-label": `How ${f.name} is stored` });
      for (const v of f.variants) {
        const on = state.usageVariant?.id === f.id && state.usageVariant.family === v.family;
        const b = button(`bd-item${on ? " bd-item--sticky" : ""}`, "", () => {
          state.usageVariant = on ? null : { id: f.id, family: v.family };
          refreshUsage();
        }, { "aria-pressed": String(on), title: on ? "Show every table again" : `Show only the tables storing ${f.name} this way` });
        b.append(h("span", { class: "bd-item__label", text: variantSummary(v) }));
        variants.append(h("li", {}, b));
      }
      pickedList.append(h("li", {}, variants));
    }
    body.append(h("section", { class: "bd-section", "aria-label": "Picked fields" },
      h("div", { class: "bd-usage__pickedhead" },
        h("h3", { class: "bd-pcap" }, "Picked", h("span", { class: "bd-pcount", text: String(picked.length) })),
        button("bd-btn", "Clear", () => { state.usageKeys = []; refreshUsage(); }),
      ),
      pickedList,
    ));

    const seg = h("div", { class: "bd-seg", role: "group", "aria-label": "Count a table that has" }, h("span", { class: "bd-seg__caption", text: "Tables with" }));
    for (const [match, label] of [["any", "Any"], ["all", "All"]] as const) {
      seg.append(button(`bd-btn${state.usageMatch === match ? " bd-btn--on" : ""}`, label, () => { state.usageMatch = match; refreshUsage(); }, { "aria-pressed": String(state.usageMatch === match) }));
    }
    const targets = h("input", { type: "checkbox", checked: state.usageTargets }) as HTMLInputElement;
    targets.addEventListener("change", () => { state.usageTargets = targets.checked; refreshUsage(); });
    body.append(h("div", { class: "bd-panel__controls bd-usage__controls" }, seg, h("label", { class: "bd-check", title: "A foreign key also counts for the table it points at" }, targets, "Count the tables they point at")));

    const meter = h("span", {});
    meter.style.width = pct(coverage.fraction);
    body.append(h("div", { class: "bd-stat", role: "status" },
      h("span", { class: "bd-stat__pct", text: pct(coverage.fraction) }),
      h("span", { class: "bd-stat__detail", text: usageHeadline(coverage, state.usageMatch, picked.length) }),
      h("span", { class: "bd-stat__meter", "aria-hidden": "true" }, meter),
    ));

    const nameOf = (id: string) => index.byId.get(id)?.name ?? id;
    const v = state.usageVariant;
    const focused = v && state.usageKeys.includes(v.id) ? index.byId.get(v.id)?.variants.find((x) => x.family === v.family) : undefined;
    const focusedTables = focused ? new Set(focused.tables.map((t) => t.nodeId)) : null;
    const using = focusedTables ? coverage.covered.filter((c) => focusedTables.has(c.nodeId)) : coverage.covered;
    const usingList = h("ul", { class: "bd-list" });
    for (const c of using.slice(0, LIST_CAP)) {
      const fields = [
        ...c.carries.map((r) => r.fieldId),
        ...c.pointedAtBy.filter((id) => !c.carries.some((r) => r.fieldId.toLowerCase() === id)).map((id) => `← ${nameOf(id)}`),
      ].join(", ");
      const b = button("bd-item", "", () => {
        // Go to the table with the picked fields it carries marked.
        navigate(c.nodeId);
        setMarks(c.carries.map(fieldKey));
        paint();
      }, { title: `Go to ${nodeLabel(c.nodeId)}` });
      b.append(h("span", { class: "bd-item__label", text: nodeLabel(c.nodeId) }), h("span", { class: "bd-item__detail bd-usage__fields", text: fields }));
      usingList.append(h("li", {}, b));
    }
    if (using.length > LIST_CAP) usingList.append(h("li", { class: "bd-more", text: `… and ${using.length - LIST_CAP} more` }));
    // The section keeps its name; its heading says when a variant narrows it.
    body.append(h("section", { class: "bd-section", "aria-label": "Tables using them" },
      h("h3", { class: "bd-pcap" }, focused && v ? `Storing ${nameOf(v.id)} as ${focused.family}` : "Tables using them", h("span", { class: "bd-pcount", text: String(using.length) })),
      using.length ? usingList : h("p", { class: "bd-empty", text: `No table ${state.usageMatch === "all" ? "has all of them" : "uses them"}.` }),
    ));

    if (coverage.missing.length) {
      body.append(h("details", { class: "bd-section" },
        h("summary", { class: "bd-pcap" }, "Tables without them", h("span", { class: "bd-pcount", text: String(coverage.missing.length) })),
        nodeList(coverage.missing, null),
      ));
    }
  }

  /** The SQL toggle beside a route or key row. */
  function sqlToggle(id: string, what: string): HTMLButtonElement {
    return button(`bd-btn bd-sqlbtn${state.sqlOpen === id ? " bd-btn--on" : ""}`, "SQL", () => {
      state.sqlOpen = state.sqlOpen === id ? null : id;
      renderPanel();
    }, { "aria-expanded": String(state.sqlOpen === id), "aria-label": `SQL for ${what}`, title: "The SQL that walks this route" });
  }
  /** A route as SQL — `routeSql`'s text, the editor's too — with the reader's dialect, joins and select list. */
  function sqlBlock(id: string, walk: GraphWalk): HTMLElement | null {
    if (state.sqlOpen !== id) return null;
    const out = routeSql(model, walk, state.sql);
    const select = <K extends keyof State["sql"]>(key: K, label: string, options: ReadonlyArray<{ id: State["sql"][K]; label: string }>) => {
      const el = h("select", { class: "bd-sql__select", "aria-label": label }) as HTMLSelectElement;
      for (const o of options) {
        const opt = h("option", { value: String(o.id), text: o.label }) as HTMLOptionElement;
        opt.selected = o.id === state.sql[key];
        el.append(opt);
      }
      el.addEventListener("change", () => {
        state.sql = { ...state.sql, [key]: el.value };
        if (key === "dialect") {
          try {
            globalThis.localStorage?.setItem(DIALECT_KEY, el.value);
          } catch {
            // Storage off (a private window, a locked-down file): the choice lasts the page.
          }
        }
        renderPanel();
      });
      return el;
    };
    const warnings = out.warnings.length ? h("ul", { class: "bd-sql__warnings" }) : null;
    for (const w of out.warnings) warnings!.append(h("li", { class: `bd-sql__warning--${w.kind}`, text: w.message }));
    return h("div", { class: "bd-sql", role: "group", "aria-label": "SQL for this route" },
      h("div", { class: "bd-sql__controls" },
        select("dialect", "SQL dialect", SQL_DIALECTS),
        select("join", "Join style", [{ id: "auto", label: "Joins: auto" }, { id: "inner", label: "Joins: inner" }, { id: "left", label: "Joins: left" }]),
        select("select", "Select list", [{ id: "star", label: "SELECT *" }, { id: "keys", label: "Keys" }]),
        button("bd-btn", "Copy", () => copy(out.sql, "SQL")),
      ),
      h("pre", { class: "bd-sql__code", text: out.sql }),
      warnings,
    );
  }

  function keyButton(key: string, title: string): HTMLButtonElement {
    const b = button(`bd-item${state.stickyKey === key ? " bd-item--sticky" : ""}`, "", () => pickKey(key), {
      "aria-pressed": String(state.stickyKey === key),
      title,
      "data-key-row": key,
    });
    hoverable(b, () => setHover("key", key), () => setHover("key", null));
    return b;
  }
  function hoverable(el: HTMLElement, enter: () => void, leave: () => void): void {
    el.addEventListener("mouseenter", enter);
    el.addEventListener("mouseleave", leave);
    el.addEventListener("focus", enter);
    el.addEventListener("blur", leave);
  }
  /** Hover lights one route or key without rebuilding the panel under the pointer. */
  function setHover(kind: "route" | "key", value: number | string | null): void {
    if (kind === "route") state.hoverRoute = value as number | null;
    else state.hoverKey = value as string | null;
    for (const row of Array.from(panel.querySelectorAll("[data-route-row]"))) {
      row.classList.toggle("bd-item--hover", state.hoverRoute !== null && row.getAttribute("data-route-row") === String(state.hoverRoute));
    }
    for (const row of Array.from(panel.querySelectorAll("[data-key-row]"))) {
      row.classList.toggle("bd-item--hover", state.hoverKey !== null && row.getAttribute("data-key-row") === state.hoverKey);
    }
    paint();
  }
  function pickKey(key: string): void {
    state.stickyKey = state.stickyKey === key ? null : key;
    state.stickyRoute = null;
    renderAll();
  }
  /**
   * Keep a route lit alone and frame it: around whatever stands for each hop
   * on this level, or — when some hop has nothing standing for it here — on
   * the deepest level every hop is under.
   */
  function pickRoute(index: number): void {
    state.stickyRoute = state.stickyRoute === index ? null : index;
    state.stickyKey = null;
    renderAll();
    const route = currentRouteView()?.routes[index];
    if (!route || state.stickyRoute === null) return;
    const standIns = () => route.walk.nodes.map((id) => level(state.view).reps.get(id));
    const frame = () => {
      const lvl = level(state.view);
      reveal([...new Set(standIns())].flatMap((id) => (id === undefined ? [] : (lvl.groups.get(`node:${id}`) ?? []))), false);
    };
    if (standIns().every((id) => id !== undefined)) return frame();
    const chains = route.walk.nodes.map((id) => data.homes[id] ?? []);
    let depth = 0;
    while (chains[0]?.[depth] !== undefined && chains.every((c) => c[depth] === chains[0]![depth])) depth++;
    const moved = showLevel(depth ? chains[0]![depth - 1]! : "");
    setTimeout(frame, moved ? 220 : 0);
  }

  // ── Menus ────────────────────────────────────────────────────────────────

  function closeContext(): void {
    context.hidden = true;
    context.textContent = "";
  }
  function openContext(x: number, y: number, caption: string, items: Array<{ label: string; hint?: string; pick: () => void } | "rule">): void {
    context.textContent = "";
    context.append(h("div", { class: "bd-context__caption", text: caption, title: caption }));
    for (const item of items) {
      if (item === "rule") {
        context.append(h("hr", { class: "bd-context__rule" }));
        continue;
      }
      const b = button("bd-context__item", "", () => {
        closeContext();
        item.pick();
      }, { role: "menuitem" });
      b.append(h("span", { text: item.label }));
      if (item.hint) b.append(h("span", { class: "bd-context__hint", text: item.hint }));
      context.append(b);
    }
    context.hidden = false;
    // Kept on screen: a menu near the bottom edge would hang below it.
    const w = context.offsetWidth || 240;
    const hgt = context.offsetHeight || 200;
    const view = doc.defaultView;
    context.style.left = `${Math.max(8, Math.min(x, (view?.innerWidth ?? x + w) - w - 8))}px`;
    context.style.top = `${Math.max(8, Math.min(y, (view?.innerHeight ?? y + hgt) - hgt - 8))}px`;
    (context.querySelector("button") as HTMLButtonElement | null)?.focus();
  }

  function fieldMenu(ref: FieldRef, x: number, y: number): void {
    const record = records(ref.nodeId).find((f) => f.id === ref.fieldId);
    const pinned = isPinned(ref);
    const targets = (record?.fk ?? []).filter((t) => t.nodeId);
    const referencers = referencesTo(model, ref);
    const tables = [...new Set(referencers.map((r) => r.nodeId))].map(nodeLabel);
    openContext(x, y, pinLabel(ref), [
      { label: pinned ? "Unpin" : "Pin for search", hint: pinned ? undefined : "Paths between pins", pick: () => togglePin(ref) },
      { label: "View all fields", pick: () => openGrid(ref.nodeId, ref.fieldId) },
      ...targets.map((t) => ({
        label: targets.length > 1 ? `Follow reference → ${t.label}` : "Follow reference",
        hint: targets.length > 1 ? undefined : t.label,
        pick: () => followReference(ref, t),
      })),
      ...(referencers.length
        ? [{ label: `Show references (${referencers.length})`, hint: `${tables.slice(0, 3).join(", ")}${tables.length > 3 ? "…" : ""}`, pick: () => showReferences(ref) }]
        : []),
      { label: "Show impact", hint: "What depends on it", pick: () => openAnalysis(impactPanel(kit, { nodeId: ref.nodeId, fieldId: ref.fieldId })) },
      ...(lineageKeys.has(fieldKey(ref))
        ? [{ label: "Trace lineage", hint: "Where its values come from, and where they go", pick: () => openAnalysis(lineagePanel(kit, { nodeId: ref.nodeId, fieldId: ref.fieldId })) }]
        : []),
      "rule" as const,
      { label: "Copy name", pick: () => copy(record?.name ?? ref.fieldId) },
    ]);
  }

  function nodeMenu(x: number, y: number): void {
    const ids = state.selection;
    if (!ids.length) return;
    const first = ids[0]!;
    // Leaf tables only: a node with a level of its own is not one table.
    const tables = ids.length >= 2 ? ids.filter((id) => !childCount.get(id)) : [];
    const items: Array<{ label: string; hint?: string; pick: () => void }> = [];
    if (ids.length === 1) {
      const pinned = state.pins.some((p) => !p.fieldId && p.nodeId === first);
      items.push({ label: pinned ? "Unpin table" : "Pin table for search", hint: "Paths to and from it", pick: () => togglePin({ nodeId: first }) });
    }
    if (tables.length >= 2) {
      const all = tables.every((id) => state.pins.some((p) => !p.fieldId && p.nodeId === id));
      items.push(
        { label: all ? `Unpin ${tables.length} tables` : `Pin ${tables.length} tables for search`, hint: "Paths between them", pick: () => toggleTablePins(tables) },
        {
          label: `Show paths between ${tables.length} tables`,
          hint: "Pins just these and opens the panel",
          pick: () => {
            // Say what the replace let go of, so the reader knows what to pin again.
            const dropped = state.pins.filter((p) => p.fieldId || !tables.includes(p.nodeId)).length;
            if (dropped) toast(`Paths between ${tables.length} tables · ${dropped} earlier pin${dropped === 1 ? "" : "s"} replaced`);
            state.pins = tables.map((nodeId) => ({ nodeId }));
            state.hoverRoute = state.stickyRoute = null;
            state.hoverKey = state.stickyKey = null;
            openPaths();
          },
        },
      );
    }
    items.push({ label: "Focus neighbourhood", hint: "What is within a join or two", pick: () => openAnalysis(neighbourhoodPanel(kit, [...ids])) });
    if (ids.length === 1) {
      items.push({ label: "Show impact", hint: "What depends on it, and what a delete reaches", pick: () => openAnalysis(impactPanel(kit, { nodeId: first })) });
    }
    const fieldCount = ids.length === 1 ? records(first).length : 0;
    if (fieldCount) {
      items.push({ label: "View all fields", hint: String(fieldCount), pick: () => openGrid(first) });
      // The count is every row the panel will list; the hint says which way
      // they run, so "(0)" never opens a full panel.
      const refs = keyReferences(model, { nodeId: first });
      const pointing = refs.referencedBy.length;
      const own = refs.carries.length;
      const count = pointing + own;
      if (count) {
        items.push({
          label: `Show references (${count})`,
          hint: [pointing ? `${pointing} point${pointing === 1 ? "s" : ""} here` : "", own ? `${own} of its own` : ""].filter(Boolean).join(" · "),
          pick: () => showReferences({ nodeId: first }),
        });
      }
    }
    if (!items.length) return;
    openContext(x, y, ids.length === 1 ? nodeLabel(first) : `${ids.length} selected`, items);
  }

  function copy(text: string, what?: string): void {
    const done = () => toast(what ? `${what} copied` : `Copied “${text}”`);
    const clip = doc.defaultView?.navigator.clipboard;
    if (clip?.writeText) {
      clip.writeText(text).then(done, () => fallbackCopy(text) && done());
    } else if (fallbackCopy(text)) done();
  }
  function fallbackCopy(text: string): boolean {
    const area = h("textarea", {});
    area.value = text;
    doc.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = doc.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }

  /** Save text as a file — a Blob and a download link, which works from `file://`. */
  function downloadText(filename: string, text: string, type: string): void {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = h("a", { href: url, download: filename });
    doc.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ── Analysis panels (html-explorer-panels.ts) ────────────────────────────

  const kit: PanelKit = {
    doc,
    model,
    data,
    panel,
    h,
    button,
    panelHead,
    section,
    nodeList,
    hoverable,
    nodeLabel,
    navigate: (id) => navigate(id),
    mark: (keys) => {
      setMarks(keys);
      paint();
    },
    refresh: () => renderAll(),
    paint: () => paint(),
    close: () => closeAnalysis(),
    toast: (text) => toast(text),
    copy: (text) => copy(text, "Copied"),
    download: downloadText,
  };
  /** Open an analysis panel in the sidebar, which it takes from any other. */
  function openAnalysis(next: PagePanel): void {
    state.panel = "analysis";
    state.analysis = next;
    state.refPin = null;
    state.usageHover = null;
    renderAll();
  }
  function closeAnalysis(): void {
    state.panel = null;
    state.analysis = null;
    renderAll();
  }

  // ── The field grid ───────────────────────────────────────────────────────

  function openGrid(nodeId: string, fieldId?: string): void {
    closeContext();
    const all = records(nodeId);
    const columns = gridColumnsFor(all);
    let query = "";
    let sort: { col: GridColumn; dir: "asc" | "desc" } | null = null;
    const filter = h("input", { class: "bd-grid__filter", type: "search", placeholder: "Filter fields… ( / )", "aria-label": "Filter fields" }) as HTMLInputElement;
    const body = h("div", { class: "bd-grid__body" });
    const title = `${nodeLabel(nodeId)} — ${all.length} field${all.length === 1 ? "" : "s"}`;
    const download = button("bd-btn", "Download CSV", () => downloadText(`${fileSlug(nodeLabel(nodeId))}-fields.csv`, toCsv(shown(), columns), "text/csv"));
    const shown = () => {
      const filtered = filterRecords(all, query);
      return sort ? sortRecords(filtered, sort.col, sort.dir) : filtered;
    };
    const draw = () => {
      body.textContent = "";
      const list = shown();
      if (!list.length) {
        body.append(h("p", { class: "bd-grid__empty", text: all.length ? "No field matches the filter." : "This node has no fields." }));
        return;
      }
      const head = h("tr", {}, h("th", { title: "Pinned for path search" }, "Pin"));
      for (const col of columns) {
        const arrow = sort?.col === col.id ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
        const th = h("th", { title: "Sort", "aria-sort": sort?.col === col.id ? (sort.dir === "asc" ? "ascending" : "descending") : undefined }, `${col.title}${arrow}`);
        th.style.minWidth = `${col.width}px`;
        th.addEventListener("click", () => {
          // Ascending, descending, then back to document order.
          sort = sort?.col !== col.id ? { col: col.id, dir: "asc" } : sort.dir === "asc" ? { col: col.id, dir: "desc" } : null;
          draw();
        });
        head.append(th);
      }
      const tbody = h("tbody", {});
      let hitRow: HTMLElement | null = null;
      for (const record of list) {
        const ref = { nodeId, fieldId: record.id };
        const pinned = isPinned(ref);
        const tr = h("tr", { class: [record.id === fieldId ? "bd-grid__hit" : "", pinned ? "bd-grid__pinned" : ""].filter(Boolean).join(" ") || undefined });
        if (record.id === fieldId) hitRow = tr;
        tr.append(h("td", { class: "bd-center" }, button("bd-link", pinned ? "Unpin" : "Pin", () => {
          togglePin(ref);
          draw();
        }, { title: pinned ? "Unpin" : "Pin for path search" })));
        for (const col of columns) {
          const td = h("td", { class: [col.mono ? "bd-mono" : "", col.align === "center" ? "bd-center" : ""].filter(Boolean).join(" ") || undefined });
          if (col.id === "fk" && record.fk.some((t) => t.nodeId)) {
            td.append("→ ");
            record.fk.forEach((t, i) => {
              if (i) td.append(" | ");
              if (t.nodeId) {
                td.append(button("bd-link", t.label, () => {
                  closeGrid();
                  followReference({ nodeId, fieldId: record.id }, t);
                }, { title: `Follow to ${t.label}` }));
              } else td.append(t.label);
            });
          } else {
            const text = cellText(record, col.id);
            td.textContent = text;
            if (text) td.title = text;
          }
          tr.append(td);
        }
        tbody.append(tr);
      }
      body.append(h("table", {}, h("thead", {}, head), tbody));
      (hitRow as HTMLElement | null)?.scrollIntoView?.({ block: "center" });
    };
    filter.addEventListener("input", () => {
      query = filter.value;
      draw();
    });
    gridModal.textContent = "";
    const dialog = h("div", { class: "bd-grid", role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div", { class: "bd-grid__head" }, h("h2", { class: "bd-grid__title", text: title }), filter, download, button("bd-btn bd-btn--icon", "×", closeGrid, { "aria-label": "Close field grid" })),
      body,
    );
    gridModal.append(dialog);
    gridModal.hidden = false;
    draw();
    filter.focus();
  }
  function closeGrid(): void {
    gridModal.hidden = true;
    gridModal.textContent = "";
  }
  gridModal.addEventListener("click", (event) => {
    if (event.target === gridModal) closeGrid();
  });
  gridModal.addEventListener("keydown", (event) => {
    if (event.key === "/" && (event.target as Element).tagName !== "INPUT") {
      event.preventDefault();
      (gridModal.querySelector(".bd-grid__filter") as HTMLInputElement | null)?.focus();
    }
  });

  // ── Search ───────────────────────────────────────────────────────────────

  let fieldIndex: FieldIndex | null = null;
  let matchesFor: { query: string; matches: SearchMatch[] } | null = null;
  /** Every DOCUMENT node matching, on any level, then fields — the editor's search. */
  function matches(): SearchMatch[] {
    const q = state.query.trim().toLowerCase();
    if (!q) return [];
    if (matchesFor?.query === q) return matchesFor.matches;
    const nodes: SearchMatch[] = model.nodes
      .filter(
        (n) =>
          n.id.toLowerCase().includes(q) ||
          n.label?.toLowerCase().includes(q) ||
          n.description?.toLowerCase().includes(q) ||
          (n.kind ?? "").toLowerCase().includes(q) ||
          n.tags?.some((t) => t.toLowerCase().includes(q)),
      )
      .map((n) => ({ kind: "node", id: n.id }));
    fieldIndex ??= buildFieldIndex(model);
    const fields: SearchMatch[] = searchFields(fieldIndex, q, { limit: 200 }).map((hit) => ({
      kind: "field",
      id: hit.nodeId,
      fieldId: hit.fieldId,
      name: hit.name,
      row: hit.row,
      nodeLabel: hit.nodeLabel,
    }));
    matchesFor = { query: q, matches: [...nodes, ...fields] };
    return matchesFor.matches;
  }
  function renderSearch(): void {
    const list = matches();
    const n = list.length;
    searchCount.hidden = !state.query;
    searchCount.textContent = n ? `${(state.matchIndex < 0 ? 0 : state.matchIndex % n) + 1}/${n}` : "0 matches";
    const current = n ? list[(state.matchIndex < 0 ? 0 : state.matchIndex) % n] : undefined;
    const field = state.query && current?.kind === "field" ? current : null;
    searchHit.hidden = !field;
    if (field) {
      searchHit.textContent = `${field.nodeLabel} · ${field.name}${field.row ? "" : " (not a row)"}`;
      searchHit.title = `${field.nodeLabel} · ${field.name}${field.row ? "" : " — not drawn on the node; Enter opens the field grid"}`;
    }
  }
  function jumpToMatch(index: number): void {
    const list = matches();
    const match = list[((index % list.length) + list.length) % list.length];
    if (!match) return;
    navigate(match.id);
    if (match.kind !== "field") return;
    // A field hit marks its row; one the node doesn't draw opens the grid on it.
    setMarks([fieldKey({ nodeId: match.id, fieldId: match.fieldId })]);
    paint();
    if (!match.row) setTimeout(() => openGrid(match.id, match.fieldId), 80);
  }
  const mod = /Mac|iPhone|iPad/.test(doc.defaultView?.navigator.platform ?? "") ? "⌘" : "Ctrl+";
  search.placeholder = `Search… (${mod}K)`;
  search.addEventListener("input", () => {
    state.query = search.value;
    state.matchIndex = -1;
    // A new search starts from a clean canvas.
    if (state.marks.size) {
      state.marks = new Set();
      paint();
    }
    renderSearch();
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const n = matches().length;
      if (n) {
        // The index is the match the page is ON; the first Enter lands on 1.
        const next = state.matchIndex < 0 ? (event.shiftKey ? n - 1 : 0) : (state.matchIndex + (event.shiftKey ? -1 : 1) + n) % n;
        state.matchIndex = next;
        renderSearch();
        jumpToMatch(next);
      }
      event.preventDefault();
    }
    if (event.key === "Escape") {
      search.value = "";
      state.query = "";
      state.matchIndex = -1;
      renderSearch();
      search.blur();
      event.preventDefault();
    }
    event.stopPropagation();
  });

  // ── Pointer and keyboard ─────────────────────────────────────────────────

  /** The element group and, if any, the row under an event. */
  function hitOf(target: EventTarget | null): { canvasId: string; docId: string; row: Element | null; drill: boolean } | null {
    const el = target instanceof Element ? target : null;
    const row = el?.closest("rect.bd-row") ?? null;
    const g = el?.closest(".bd-el[data-el]");
    const tag = g?.getAttribute("data-el");
    if (!g || !tag?.startsWith("node:")) return null;
    const canvasId = tag.slice(5);
    const docId = documentNodeId(canvasId);
    if (docId === null || !nodeById.has(docId)) return null;
    return { canvasId, docId, row, drill: g.hasAttribute("data-drill") };
  }
  // Capture, so a row or a modifier-click is settled before the navigator's
  // drill handler on the group sees the click.
  stage.addEventListener("click", (event) => {
    const e = event as MouseEvent;
    closeContext();
    const hit = hitOf(e.target);
    if (!hit) {
      // Empty canvas — the stage or the picture, not a key laid over them:
      // the selection and the marks go, as in the editor.
      const target = e.target as Element | null;
      if (target === stage || target?.matches?.(".bd-view") || target?.closest?.("svg")) {
        state.selection = [];
        state.marks = new Set();
        paint();
      }
      return;
    }
    if (hit.row) {
      e.stopPropagation();
      fieldMenu({ nodeId: hit.docId, fieldId: hit.row.getAttribute("data-field")! }, e.clientX, e.clientY);
      return;
    }
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      e.stopPropagation();
      e.preventDefault();
      setSelection(state.selection.includes(hit.docId) ? state.selection.filter((id) => id !== hit.docId) : [...state.selection, hit.docId]);
      return;
    }
    if (hit.drill) return; // the navigator drills
    setSelection([hit.docId]);
  }, true);
  stage.addEventListener("contextmenu", (event) => {
    const e = event as MouseEvent;
    const hit = hitOf(e.target);
    if (!hit) return;
    e.preventDefault();
    if (hit.row) {
      fieldMenu({ nodeId: hit.docId, fieldId: hit.row.getAttribute("data-field")! }, e.clientX, e.clientY);
      return;
    }
    if (!state.selection.includes(hit.docId)) setSelection([hit.docId]);
    nodeMenu(e.clientX, e.clientY);
  });
  doc.addEventListener("pointerdown", (event) => {
    if (!context.hidden && !context.contains(event.target as Node)) closeContext();
  });
  // Capture on the window, so Escape is settled here before the navigator
  // reads it as "drill out" — outermost first, the editor's order.
  doc.defaultView?.addEventListener("keydown", (event) => {
    const target = event.target as Element | null;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      search.focus();
      search.select();
      return;
    }
    if (event.key !== "Escape" || target === search) return;
    const consume = () => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    if (!context.hidden) {
      consume();
      closeContext();
    } else if (!gridModal.hidden) {
      consume();
      closeGrid();
    } else if (target && /INPUT|SELECT|TEXTAREA/.test(target.tagName)) {
      // A field of its own: Escape is the field's.
    } else if (state.panel === "usage") {
      consume();
      closeUsage();
    } else if (state.panel === "analysis") {
      consume();
      closeAnalysis();
    } else if (state.panel === "refs") {
      // The panel and the marks it came with are one thing.
      consume();
      closeRefPanel();
    } else if (state.panel === "paths") {
      consume();
      state.panel = null;
      renderAll();
    } else if (state.marks.size) {
      consume();
      state.marks = new Set();
      paint();
    } else if (state.selection.length) {
      consume();
      state.selection = [];
      paint();
    }
  }, true);

  // ── Saved analyses, and links to one ────────────────────────────────────
  // The page cannot write the file, so a reader's own analysis travels in
  // the address: "#/<level>?a=<base64url(JSON)>", written with
  // replaceState (no hashchange) and read on load or when pasted.

  /** The question on show, as a saved analysis keeps it — null when nothing is. */
  function currentAnalysis(): SavedAnalysisBody | null {
    if (state.panel === "paths" && state.pins.length >= 2) return { kind: "paths", pins: state.pins, undirected: state.undirected, mode: state.mode };
    if (state.panel === "usage" && state.usageKeys.length) {
      return { kind: "usage", names: state.usageKeys, match: state.usageMatch, includeTargets: state.usageTargets };
    }
    if (state.panel === "analysis") return state.analysis?.save?.() ?? null;
    return null;
  }
  /** Open an analysis: set the state its panel reads, and show the panel. */
  function openSaved(a: SavedAnalysisBody): void {
    switch (a.kind) {
      case "paths":
        state.undirected = a.undirected;
        state.mode = a.mode;
        setPins(a.pins.map((p) => ({ ...p })));
        openPaths();
        break;
      case "usage":
        state.usageKeys = [...a.names];
        state.usageMatch = a.match;
        state.usageTargets = a.includeTargets;
        state.usageVariant = null;
        state.usageHover = null;
        state.refPin = null;
        state.analysis = null;
        state.panel = "usage";
        renderAll();
        break;
      case "coverage":
        openAnalysis(coveragePanel(kit, a.keys, a.scope));
        break;
      case "impact":
        openAnalysis(impactPanel(kit, a.subject, { direction: a.direction, maxDepth: a.maxDepth ?? null, keysOnly: a.via === "keys" }));
        break;
      case "neighbourhood":
        openAnalysis(neighbourhoodPanel(kit, a.from, { depth: a.depth, direction: a.direction, keysOnly: a.keysOnly }));
        break;
    }
  }
  const utf8 = (text: string) => encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const fromUtf8 = (bin: string) => decodeURIComponent(Array.from(bin, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""));
  const encodeLink = (body: SavedAnalysisBody) => btoa(utf8(JSON.stringify(body))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  function decodeLink(param: string): SavedAnalysisBody | null {
    try {
      const b64 = param.replace(/-/g, "+").replace(/_/g, "/");
      const raw = JSON.parse(fromUtf8(atob(b64 + "===".slice((b64.length + 3) % 4)))) as Record<string, unknown>;
      const [valid] = validateAnalyses([{ ...raw, id: "link", title: "link" }], { nodeIds: new Set(model.nodes.map((n) => n.id)) });
      if (!valid) return null;
      const { id: _id, title: _title, ...body } = valid;
      return body as SavedAnalysisBody;
    } catch {
      return null;
    }
  }
  const win = doc.defaultView;
  /** The last link this page wrote, so reading it back does not reopen what is on show. */
  let linkParam: string | null = null;
  function linkFromHash(): string | null {
    const hash = win?.location.hash ?? "";
    const q = hash.indexOf("?");
    if (q < 0) return null;
    return new URLSearchParams(hash.slice(q + 1)).get("a");
  }
  function openLinked(): void {
    const param = linkFromHash();
    if (!param || param === linkParam) return;
    linkParam = param;
    const body = decodeLink(param);
    if (body) openSaved(body);
    else toast("The link's analysis doesn't match this model");
  }
  win?.addEventListener("hashchange", openLinked);
  const linkButton = $("bd-linkbtn") as HTMLButtonElement | null;
  linkButton?.addEventListener("click", () => {
    $("bd-dropdown")!.hidden = true;
    const body = currentAnalysis();
    if (!body || !win) {
      toast("Open routes, key usage, impact or a neighbourhood first");
      return;
    }
    linkParam = encodeLink(body);
    const level = (win.location.hash.split("?")[0] || "#/").replace(/^#?$/, "#/");
    const next = `${level}?a=${linkParam}`;
    try {
      win.history.replaceState(win.history.state, "", next);
    } catch {
      win.location.hash = next;
    }
    copy(win.location.href, "Link");
  });
  if (analysesButton && data.analyses?.length) {
    const saved = data.analyses;
    analysesButton.textContent = `Analyses (${saved.length})`;
    analysesButton.hidden = false;
    analysesButton.addEventListener("click", () => {
      if (state.panel === "analysis" && state.analysis?.label === "Analyses") closeAnalysis();
      else openAnalysis(analysesPanel(kit, saved, (a) => openSaved(a)));
    });
  }

  // Governance and the dictionary are offered for a model with tables.
  const govButton = $("bd-govbtn") as HTMLButtonElement | null;
  const dictButton = $("bd-dictbtn") as HTMLButtonElement | null;
  const structButton = $("bd-structbtn") as HTMLButtonElement | null;
  if (structButton && data.structure) {
    const summary = data.structure;
    structButton.hidden = false;
    structButton.addEventListener("click", () => {
      $("bd-dropdown")!.hidden = true;
      openAnalysis(structurePanel(kit, summary));
    });
  }
  if (govButton && data.governance) {
    const report = data.governance;
    govButton.hidden = false;
    govButton.addEventListener("click", () => {
      $("bd-dropdown")!.hidden = true;
      openAnalysis(governancePanel(kit, report));
    });
  }
  if (dictButton && usage().tables.length) {
    dictButton.hidden = false;
    dictButton.addEventListener("click", () => {
      $("bd-dropdown")!.hidden = true;
      const title = (doc.title || "model").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "model";
      downloadText(`${title}-dictionary.csv`, dictionaryCsv(dataDictionary(model)), "text/csv");
    });
  }

  // Checks are offered where the export found something.
  if (checksButton && data.findings?.length) {
    const total = data.findings.length + (data.findingsTruncated ?? 0);
    checksButton.textContent = `Checks (${total})`;
    checksButton.hidden = false;
    checksButton.addEventListener("click", () => {
      if (state.panel === "analysis" && state.analysis?.label === "Checks") closeAnalysis();
      else openAnalysis(checksPanel(kit, data.findings ?? []));
    });
  }

  // Key usage is offered where there is something to count.
  if (usageButton && usage().tables.length) {
    usageButton.hidden = false;
    usageButton.addEventListener("click", toggleUsagePanel);
  }

  renderAll();
  renderSearch();
  openLinked();
}

/**
 * html-pipeline.ts — the interactive HTML export: the page's path list, its
 * search and relationship data, one pre-rendered view per drill level, and
 * the page itself.
 *
 * Kept out of exporters.ts so the editor bundle doesn't carry the page's
 * runtime: the HTML exporter imports this when it runs.
 */
import {
  EDGE_COLOR_HEX,
  ghostSourceId,
  hiddenInline,
  isBoundaryNodeId,
  isGhostNodeId,
  type DiagramTemplate,
} from "../contract/schema";
import { templateTimeline } from "../contract/timeline";
import { drillableIds, focusPath, scopedView } from "../contract/scope";
// Imports `./registry-types`, not `./registry` — registry.ts imports
// BUILTIN_EXPORTERS from here, so depending on it directly would be a cycle.
import type { ExportContext, ExportResult, ResolvedRegistry } from "./registry-types";
import { renderTemplateToSvg } from "./exporters";
import { DARK_EXPORT_PALETTE, drawnElements, paletteRecord, type ExportPalette, type PictureOptions } from "./draw";
import { levelLabel } from "./chrome";
import {
  buildMultiViewHtml,
  buildTimelineHtml,
  isLightHex,
  type HtmlPathEntry,
  type ViewEntry,
} from "./html-export";
import { explorerDocument, explorerLevel, FINDINGS_CAP, type ExplorerLevel, type HtmlExplorerData } from "./html-explorer";
import { hasTasks, htmlTaskData } from "./html-tasks";
import { lintTemplate } from "../contract/lint";
import { storesFields } from "../contract/coverage";
import { governanceReport } from "../contract/dictionary";
import { modelStructure, summarizeStructure } from "../contract/structure";
import { transientPathColors } from "./path-view";
import { DARK_THEME, LIGHT_THEME } from "./theme";
import { pathColor, resolvePath } from "../contract/paths";

// ─── Interactive HTML: paths ─────────────────────────────────────────────────

/**
 * The document's paths, resolved for the HTML player: members by the tag the
 * SVG backend stamps on their group, colours as hex from the export palette
 * so a light export glows in its light-theme hues.
 */
function htmlPathEntries(
  template: DiagramTemplate,
  palette: Partial<ExportPalette> | undefined,
): HtmlPathEntry[] {
  const edgeHex: Record<string, string> = { ...EDGE_COLOR_HEX, ...paletteRecord(palette?.edgeColors) };
  return (template.paths ?? []).map((path, i) => {
    const resolved = resolvePath(template, path);
    return {
      id: path.id,
      title: path.title,
      color: edgeHex[pathColor(path, i)] ?? EDGE_COLOR_HEX.slate,
      members: resolved.steps.map((step) => ({
        el: `${step.kind}:${step.id}`,
        step: step.index,
        steps: resolved.steps.length,
        ...(step.reversed ? { reversed: true } : {}),
      })),
    };
  });
}

// ─── Interactive HTML: search and relationship analysis ──────────────────────

/**
 * What the interactive HTML page's search and relationship analysis read
 * (see html-explorer.ts): the document's structural slice, what each level's
 * SVG draws — the root, and one level per drillable node, exactly the levels
 * the page pre-renders — the drill stack that shows each nested node, and
 * the route colours in the export palette's hues.
 */
export function htmlExplorerData(
  template: DiagramTemplate,
  registry: ResolvedRegistry,
  palette: Partial<ExportPalette> = {},
): HtmlExplorerData {
  const { containerKinds } = registry;
  const levels: Record<string, ExplorerLevel> = { "": explorerLevel(drawnElements(template, containerKinds)) };
  for (const focusId of drillableIds(template)) {
    levels[focusId] = explorerLevel(drawnElements(scopedView(template, focusId, { containerKinds }), containerKinds));
  }
  const homes: Record<string, string[]> = {};
  for (const n of template.nodes) {
    const stack = focusPath(template, n.id);
    if (stack.length) homes[n.id] = stack;
  }
  const light = isLightHex(palette.bg ?? DARK_EXPORT_PALETTE.bg);
  // Checks run here, not in the page: a host's rules are functions.
  const findings = lintTemplate(template, registry.lintRules);
  const rules: NonNullable<HtmlExplorerData["rules"]> = {};
  for (const f of findings) {
    const def = registry.lintRules[f.rule];
    rules[f.rule] ??= { label: def?.label ?? f.rule, ...(def?.description ? { description: def.description } : {}) };
  }
  return {
    doc: explorerDocument(template),
    levels,
    homes,
    // Where the editor starts them with nothing lit: past the document's own
    // paths, so a route never wears a path's colour.
    routeColors: transientPathColors(10, [], (template.paths ?? []).length),
    edgeHex: { ...EDGE_COLOR_HEX, ...paletteRecord(palette.edgeColors) },
    routeColor: palette.routeColor ?? ((light ? LIGHT_THEME.routeColor : DARK_THEME.routeColor) as string),
    ...(template.nodes.some(storesFields) ? { governance: governanceReport(template) } : {}),
    ...(template.nodes.filter(storesFields).length >= 2 ? { structure: summarizeStructure(template, modelStructure(template)) } : {}),
    ...(template.analyses?.length ? { analyses: template.analyses } : {}),
    ...(findings.length
      ? {
          // A fix acts on the document; the page cannot, so findings travel without one.
          findings: findings.slice(0, FINDINGS_CAP).map(({ fix: _fix, ...f }) => f),
          ...(findings.length > FINDINGS_CAP ? { findingsTruncated: findings.length - FINDINGS_CAP } : {}),
          rules,
        }
      : {}),
  };
}

/**
 * One `ViewEntry` per drill level: the root plus every node with children,
 * each pre-rendered through the SAME pipeline as the canvas. Click targets:
 * a drillable node opens its level, a ghost visits its home level, and the
 * boundary frame steps out one level.
 */
function buildDrillViews(
  template: DiagramTemplate,
  registry: ResolvedRegistry,
  palette: Partial<ExportPalette> = {},
  dress: PictureOptions = {},
): ViewEntry[] {
  const parents = drillableIds(template);
  const parentSet = new Set(parents);
  const byId = new Map(template.nodes.map((n) => [n.id, n]));
  const drillHidden = hiddenInline(template, registry.containerKinds);
  const rootLabel = String(template.meta?.title ?? "Overview");
  const labelOf = (id: string) => byId.get(id)?.label ?? id;
  /** The view that SHOWS a node — its parent's level, or the root. */
  const homeViewOf = (id: string) => focusPath(template, id).at(-1) ?? "";

  const crumbFor = (id: string) => [
    { key: "", label: rootLabel },
    ...[...focusPath(template, id), id].map((step) => ({ key: step, label: labelOf(step) })),
  ];

  const rootDrills: Record<string, string> = {};
  for (const p of parents) {
    // Drill-hidden parents have no box on the root canvas; everything else
    // (cards, frames, chips) is stamped `node:<id>` and clickable.
    if (!drillHidden.has(p)) rootDrills[`node:${p}`] = p;
  }

  const views: ViewEntry[] = [
    {
      key: "",
      crumb: [{ key: "", label: rootLabel }],
      levelLabel: levelLabel(0),
      parent: null,
      svg: renderTemplateToSvg(template, registry, palette, { ...dress, gridId: "as-grid-v0" }),
      drills: rootDrills,
    },
  ];

  parents.forEach((focusId, i) => {
    const view = scopedView(template, focusId, { containerKinds: registry.containerKinds });
    const drills: Record<string, string> = {};
    for (const n of view.nodes) {
      if (isBoundaryNodeId(n.id)) {
        drills[`node:${n.id}`] = homeViewOf(focusId);
      } else if (isGhostNodeId(n.id)) {
        drills[`node:${n.id}`] = homeViewOf(ghostSourceId(n.id));
      } else if (parentSet.has(n.id)) {
        drills[`node:${n.id}`] = n.id;
      }
    }
    views.push({
      key: focusId,
      crumb: crumbFor(focusId),
      levelLabel: levelLabel(focusPath(template, focusId).length + 1),
      parent: homeViewOf(focusId),
      svg: renderTemplateToSvg(view, registry, palette, { ...dress, gridId: `as-grid-v${i + 1}` }),
      drills,
    });
  });
  return views;
}

/** The interactive HTML page for a document — what the "Interactive HTML" exporter downloads. */
export function exportHtmlPage({ template, registry, filename, palette, mode, gradients }: ExportContext): ExportResult {
  const title = String(template.meta?.title ?? filename);
  const stops = templateTimeline(template).stops;
  const paths = htmlPathEntries(template, palette);
  const explorer = htmlExplorerData(template, registry, palette);
  // A task graph comes alive in the page: checks toggle, the People legend
  // previews and focuses, and checks can be saved back into the file.
  const tasks = hasTasks(template)
    ? htmlTaskData(template, explorer.levels, {
        fileName: `${filename}.html`,
        containerKinds: registry.containerKinds,
        inks: {
          faint: palette?.textFaint ?? DARK_EXPORT_PALETTE.textFaint,
          warn: palette?.warn ?? DARK_EXPORT_PALETTE.warn ?? "#fa8072",
        },
      })
    : undefined;
  // Rows are drawn as targets too, so the page can pin, mark and open
  // them — and a task's states as parts, so the page can change them.
  const dress = { mode, gradients, fieldHits: true, ...(tasks ? { taskHits: true } : {}) };
  // Any nesting makes the page multi-view: one pre-rendered SVG per
  // drillable level, clickable in place. A flat document keeps the
  // single-view page.
  const page = drillableIds(template).length
    ? buildMultiViewHtml({ views: buildDrillViews(template, registry, palette, dress), title, stops, palette, paths, explorer, tasks })
    : buildTimelineHtml({
        svg: renderTemplateToSvg(template, registry, palette, dress),
        title,
        stops,
        palette,
        paths,
        explorer,
        tasks,
      });
  return { blob: new Blob([page], { type: "text/html" }), filename: `${filename}.html` };
}

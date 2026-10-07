/**
 * saved-analyses.ts — running a saved analysis: what it says now, in the
 * words its panel uses, and the one number a re-run compares with the
 * snapshot taken when it was saved.
 *
 * Pure (no DOM, no React), so the editor and the interactive HTML export
 * run the same code: the page bundles it, over the document slice it
 * carries, and a saved analysis says the same thing in both.
 */
import type { FieldDocument } from "../contract/fields";
import type { EdgeColor } from "../contract/schema";
import type { SavedAnalysisBody } from "../contract/analyses";
import { fieldUsage, usageCoverage, usageHeadline } from "../contract/key-usage";
import { keyCoverage } from "../contract/coverage";
import { impactHeadline, impactOf } from "../contract/impact";
import { edgeFieldIds } from "../contract/fields";
import { neighbourhood } from "../contract/graph";
import { computeRouteView } from "./field-routes";
import { neighbourhoodHeadline, plural } from "./analysis-text";

export interface AnalysisReading {
  /** What the analysis says, as its panel says it. */
  headline: string;
  /** The number a re-run compares: a share (0..1) for usage and coverage, a count otherwise. */
  value?: number;
}

const ROUTE_COLORS: readonly EdgeColor[] = ["sky"];

/** Run a saved analysis against a document. */
export function readAnalysis(doc: FieldDocument, a: SavedAnalysisBody, nodeLabel: (id: string) => string): AnalysisReading {
  switch (a.kind) {
    case "usage": {
      const cov = usageCoverage(fieldUsage(doc), a.names, { match: a.match, includeTargets: a.includeTargets });
      return { headline: `${usageHeadline(cov, a.match, a.names.length)} (${Math.round(cov.fraction * 100)}%)`, value: cov.fraction };
    }
    case "coverage": {
      const r = keyCoverage(doc, a.keys, { scope: a.scope });
      return { headline: `${r.reached.size} of ${plural(r.total, "table")} reached (${Math.round(r.fraction * 100)}%)`, value: r.fraction };
    }
    case "impact": {
      const r = impactOf(doc, a.subject, { direction: a.direction, via: a.via, ...(a.maxDepth !== undefined ? { maxDepth: a.maxDepth } : {}) });
      const label = a.subject.fieldId ? `${nodeLabel(a.subject.nodeId)} · ${a.subject.fieldId}` : nodeLabel(a.subject.nodeId);
      return { headline: impactHeadline(r, label), value: r.nodes.length };
    }
    case "neighbourhood": {
      const r = neighbourhood(doc, a.from, a.depth, {
        direction: a.direction,
        ...(a.keysOnly ? { edgeFilter: (e: FieldDocument["edges"][number]) => edgeFieldIds(e).start !== undefined } : {}),
      });
      const others = [...r.nodes.values()].filter((d) => d > 0).length;
      return { headline: neighbourhoodHeadline(others, a.depth), value: others };
    }
    case "paths": {
      const view = computeRouteView(doc, { pins: a.pins, undirected: a.undirected, mode: a.mode }, ROUTE_COLORS);
      if (view.kind === "pair") {
        const [x, y] = a.pins;
        return { headline: `${plural(view.routes.length, "route")} between ${nodeLabel(x!.nodeId)} and ${nodeLabel(y!.nodeId)}`, value: view.routes.length };
      }
      const n = view.keep?.size ?? view.reachable.size;
      return { headline: `${plural(n, "table")} ${a.mode === "between" ? "between the pins" : "within reach of the pins"}`, value: n };
    }
  }
}

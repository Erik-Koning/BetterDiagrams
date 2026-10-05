/**
 * analysis-sidebar.tsx — the data-model analyses that take the left
 * sidebar: neighbourhood, impact, checks, model structure, governance,
 * schema changes and lineage.
 *
 * One hook owns their view state, runs the contract analysis the open one
 * needs (memoised, and only while open), and returns what the studio places:
 * the panel element, the canvas mask (what stays bright), any walks to light
 * as transient paths, and row marks. The studio keeps the sidebar to one
 * panel at a time — opening one of these closes the paths, references,
 * Generate and key-usage panels, and they close this.
 *
 * Nothing here enters the document except what a panel's own action does
 * through the studio (ignoring a finding, applying a fix) — one undoable
 * edit each.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { DiagramTemplate } from "../contract/schema";
import { neighbourhood, walkToPath, type GraphDocument } from "../contract/graph";
import { cachedFieldRecords, edgeFieldIds, fieldKey as keyOfField, type FieldRef, type Pin } from "../contract/fields";
import type { DiagramPath } from "../contract/paths";
import type { LintFinding } from "../contract/lint";
import { impactChain, impactOf } from "../contract/impact";
import { NeighbourhoodPanel, type NeighbourhoodState } from "./NeighbourhoodPanel";
import { ChecksPanel, type ChecksState } from "./ChecksPanel";
import { ImpactPanel, type ImpactState } from "./ImpactPanel";
import { dataDictionary, dictionaryCsv, dictionaryMarkdown, governanceReport } from "../contract/dictionary";
import { schemaDiff, schemaDiffMarkdown } from "../contract/schema-diff";
import { GovernancePanel, type GovernanceState } from "./GovernancePanel";
import { SchemaChangesPanel, type SchemaChangesState } from "./SchemaChangesPanel";
import { modelStructure, summarizeStructure } from "../contract/structure";
import { EDGE_COLOR_HEX } from "../contract/schema";
import { StructurePanel, type StructureState } from "./StructurePanel";
import { domainColor } from "./analysis-text";
import { lineageChain, sensitiveLineage, traceLineage } from "../contract/lineage";
import { LineagePanel, type LineageState } from "./LineagePanel";
import type { OverlayLink } from "./LineageOverlay";

export type { NeighbourhoodState, ChecksState, ImpactState, GovernanceState, SchemaChangesState, StructureState, LineageState };
export type AnalysisState = NeighbourhoodState | ChecksState | ImpactState | GovernanceState | SchemaChangesState | StructureState | LineageState;

/** What stays bright on the canvas while an analysis shows something. */
export interface AnalysisMask {
  keep: ReadonlySet<string>;
  keepEdges: ReadonlySet<string> | null;
}

export interface AnalysisSidebarArgs {
  template: DiagramTemplate;
  nodeLabel: (id: string) => string;
  navigateToNode: (id: string) => void;
  /** Every current finding (lintTemplate over the registry's rules). */
  findings: readonly LintFinding[];
  ruleInfo: (rule: string) => { label: string; description?: string };
  /** Whether findings may be ignored and fixed (a hand-authored, editable document). */
  canEdit: boolean;
  onJumpFinding: (finding: LintFinding) => void;
  onIgnoreFinding: (finding: LintFinding) => void;
  onFixFinding: (finding: LintFinding) => void;
  download: (blob: Blob, filename: string) => void;
  navigateToField: (ref: FieldRef) => void;
  /** The compare baseline, while Compare is open — what schema changes are against. */
  diffBase: DiagramTemplate | null;
  /** The document's title, for the files it writes. */
  title: string;
  /** Select these nodes on the canvas (a domain's tables). Absent, not offered. */
  selectNodes?: (ids: readonly string[]) => void;
  /** Save the open impact or neighbourhood analysis. Absent, no Save button. */
  onSave?: () => void;
}

export interface AnalysisSidebar {
  state: AnalysisState | null;
  open: (state: AnalysisState) => void;
  close: () => void;
  mask: AnalysisMask | null;
  /** Walks to light as transient paths (an impact chain under the pointer). */
  paths: DiagramPath[];
  element: ReactNode;
  /** A colour per table — Model structure's "Colour tables by domain" — or null. */
  tint: ReadonlyMap<string, string> | null;
  /** `fieldKey`s of rows to mark (a lineage trace's columns), or null. */
  rowMarks: ReadonlySet<string> | null;
  /** Lineage lines to draw over the canvas, row to row. */
  lineageLinks: OverlayLink[];
}

/** A line that carries a key — what "Keys only" walks. */
const carriesKey = (e: GraphDocument["edges"][number]) => edgeFieldIds(e).start !== undefined;

/** "Account · AccountId" — a table subject is its label alone. */
const pinText = (pin: Pin, nodeLabel: (id: string) => string) => (pin.fieldId ? `${nodeLabel(pin.nodeId)} · ${pin.fieldId}` : nodeLabel(pin.nodeId));

export function useAnalysisSidebar(args: AnalysisSidebarArgs): AnalysisSidebar {
  const { template, nodeLabel, navigateToNode } = args;
  const [state, setState] = useState<AnalysisState | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const open = useCallback((next: AnalysisState) => {
    setHover(null);
    setState(next);
  }, []);
  const close = useCallback(() => setState(null), []);
  const patch = useCallback(
    (p: Partial<AnalysisState>) => setState((current) => (current ? ({ ...current, ...p } as AnalysisState) : current)),
    [],
  );
  const csv = (text: string, name: string) => args.download(new Blob([text], { type: "text/csv" }), name);

  const reach = useMemo(() => {
    if (state?.kind !== "neighbourhood") return null;
    return neighbourhood(template, state.from, state.depth, {
      direction: state.direction,
      ...(state.keysOnly ? { edgeFilter: carriesKey } : {}),
    });
  }, [state, template]);

  const impact = useMemo(() => {
    if (state?.kind !== "impact") return null;
    return impactOf(template, state.subject, {
      direction: state.direction,
      via: state.via,
      ...(state.maxDepth !== null ? { maxDepth: state.maxDepth } : {}),
    });
  }, [state, template]);

  const structure = useMemo(
    () => (state?.kind === "structure" ? summarizeStructure(template, modelStructure(template), { hubs: 300 }) : null),
    // Recomputed when the document changes, not when a tab does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state?.kind, template],
  );
  const tint = useMemo(() => {
    if (state?.kind !== "structure" || !state.tint || !structure) return null;
    const out = new Map<string, string>();
    structure.domains.forEach((d, i) => {
      for (const id of d.tables) out.set(id, EDGE_COLOR_HEX[domainColor(i)]);
    });
    return out;
  }, [state, structure]);

  const [lineageHover, setLineageHover] = useState<FieldRef | null>(null);
  const lineage = template.lineage;
  const trace = useMemo(() => {
    if (state?.kind !== "lineage" || !lineage?.length) return null;
    return traceLineage(lineage, state.subject, { direction: state.direction, ...(state.maxDepth !== null ? { maxDepth: state.maxDepth } : {}) });
  }, [state, lineage]);
  const lineageById = useMemo(() => new Map((lineage ?? []).map((l) => [l.id, l])), [lineage]);
  const untagged = useMemo(
    () => (state?.kind === "lineage" ? new Set(sensitiveLineage(template).map((x) => keyOfField(x.ref))) : new Set<string>()),
    [state?.kind, template],
  );
  /** Traced columns the model doesn't list — a lineage link outliving its column. A cut-short table may just not list it. */
  const missing = useMemo(() => {
    const out = new Set<string>();
    if (!trace) return out;
    const records = cachedFieldRecords(template);
    for (const ref of [trace.subject, ...trace.columns.map((c) => c.ref)]) {
      const node = template.nodes.find((n) => n.id === ref.nodeId);
      const model = node?.data?.model as { fieldsTruncated?: boolean } | undefined;
      if (node && model?.fieldsTruncated) continue;
      if (!records.get(ref.nodeId)?.some((r) => r.id === ref.fieldId)) out.add(keyOfField(ref));
    }
    return out;
  }, [trace, template]);
  const rowMarks = useMemo(
    () => (trace ? new Set([keyOfField(trace.subject), ...trace.columns.map((c) => keyOfField(c.ref))]) : null),
    [trace],
  );
  const lineageLinks = useMemo<OverlayLink[]>(() => {
    if (!trace || !lineage) return [];
    const chain = lineageHover ? new Set((lineageChain(lineage, trace, lineageHover) ?? []).map((l) => l.id)) : null;
    return trace.links.map((id) => lineageById.get(id)!).filter(Boolean).map((l) => ({ id: l.id, from: l.from, to: l.to, emphasis: chain?.has(l.id) ?? false }));
  }, [trace, lineage, lineageById, lineageHover]);

  const governance = useMemo(() => (state?.kind === "governance" ? governanceReport(template) : null), [state, template]);
  const changes = useMemo(
    () => (state?.kind === "changes" && args.diffBase ? schemaDiff(args.diffBase, template) : null),
    [state, template, args.diffBase],
  );
  /** A label from either side of a compare: a removed table is only in the baseline. */
  const changeLabel = useCallback(
    (id: string) => template.nodes.find((n) => n.id === id)?.label ?? args.diffBase?.nodes.find((n) => n.id === id)?.label ?? id,
    [template, args.diffBase],
  );
  const slug = (args.title || "model").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "model";

  const mask = useMemo<AnalysisMask | null>(() => {
    if (state?.kind === "neighbourhood" && reach) return { keep: new Set(reach.nodes.keys()), keepEdges: new Set(reach.edges) };
    if (state?.kind === "impact" && impact) {
      return { keep: new Set([state.subject.nodeId, ...impact.nodes.map((n) => n.id)]), keepEdges: new Set(impact.edges) };
    }
    if (state?.kind === "lineage" && trace) {
      // The tables the trace touches stay bright; no key line is part of it.
      return { keep: new Set([trace.subject.nodeId, ...trace.columns.map((c) => c.ref.nodeId)]), keepEdges: new Set<string>() };
    }
    if (state?.kind === "structure" && structure) {
      // Pointing at a table: it and its direct neighbours over keys (F7's walk).
      if (hover) {
        const near = neighbourhood(template, [hover], 1, { direction: "both", edgeFilter: carriesKey });
        return { keep: new Set(near.nodes.keys()), keepEdges: new Set(near.edges) };
      }
      const domain = state.domain ? structure.domains.find((d) => d.id === state.domain) : null;
      if (domain) {
        const keep = new Set(domain.tables);
        return { keep, keepEdges: new Set(template.edges.filter((e) => keep.has(e.source) && keep.has(e.target)).map((e) => e.id)) };
      }
    }
    return null;
  }, [state, reach, impact, structure, hover, template, trace]);

  const paths = useMemo<DiagramPath[]>(() => {
    if (state?.kind !== "impact" || !impact || !hover) return [];
    const walk = impactChain(impact, hover);
    return walk ? [walkToPath(template, walk, { id: "~impact", title: `${nodeLabel(state.subject.nodeId)} → ${nodeLabel(hover)}`, color: "rose" })] : [];
  }, [state, impact, hover, template, nodeLabel]);

  let element: ReactNode = null;
  if (state?.kind === "neighbourhood" && reach) {
    element = (
      <NeighbourhoodPanel
        state={state}
        reached={reach.nodes}
        nodeLabel={nodeLabel}
        onChange={patch}
        onNavigate={navigateToNode}
        onClose={close}
        {...(args.onSave ? { onSave: args.onSave } : {})}
      />
    );
  } else if (state?.kind === "checks") {
    element = (
      <ChecksPanel
        state={state}
        findings={args.findings}
        ruleInfo={args.ruleInfo}
        nodeLabel={nodeLabel}
        canEdit={args.canEdit}
        onChange={patch}
        onJump={args.onJumpFinding}
        onIgnore={args.onIgnoreFinding}
        onFix={args.onFixFinding}
        onDownload={(text) => csv(text, "checks.csv")}
        onClose={close}
      />
    );
  } else if (state?.kind === "governance" && governance) {
    element = (
      <GovernancePanel
        report={governance}
        nodeLabel={nodeLabel}
        onNavigate={navigateToNode}
        onNavigateField={args.navigateToField}
        onDownload={(format) => {
          const tables = dataDictionary(template);
          if (format === "md") args.download(new Blob([dictionaryMarkdown(tables, `${args.title || "Data"} dictionary`)], { type: "text/markdown" }), `${slug}-dictionary.md`);
          else csv(dictionaryCsv(tables), `${slug}-dictionary.csv`);
        }}
        onClose={close}
      />
    );
  } else if (state?.kind === "changes" && changes) {
    element = (
      <SchemaChangesPanel
        state={state}
        diff={changes}
        nodeLabel={changeLabel}
        onChange={patch}
        onDownload={() =>
          args.download(new Blob([schemaDiffMarkdown(changes, changeLabel, `${args.title || "Schema"} changes`)], { type: "text/markdown" }), `${slug}-schema-changes.md`)
        }
        onClose={close}
      />
    );
  } else if (state?.kind === "lineage" && trace) {
    element = (
      <LineagePanel
        state={state}
        trace={trace}
        links={lineageById}
        untagged={untagged}
        missing={missing}
        nodeLabel={nodeLabel}
        onChange={patch}
        onNavigateField={args.navigateToField}
        onHover={setLineageHover}
        onClose={close}
      />
    );
  } else if (state?.kind === "structure" && structure) {
    element = (
      <StructurePanel
        state={state}
        summary={structure}
        nodeLabel={nodeLabel}
        onChange={patch}
        onNavigate={navigateToNode}
        onHover={setHover}
        {...(args.selectNodes ? { onSelect: args.selectNodes } : {})}
        onClose={close}
      />
    );
  } else if (state?.kind === "impact" && impact) {
    element = (
      <ImpactPanel
        state={state}
        result={impact}
        subjectLabel={pinText(state.subject, nodeLabel)}
        nodeLabel={nodeLabel}
        onChange={patch}
        onNavigate={navigateToNode}
        onHover={setHover}
        onDownload={(text) => csv(text, "impact.csv")}
        onClose={close}
        {...(args.onSave ? { onSave: args.onSave } : {})}
      />
    );
  }
  return { state, open, close, mask, paths, element, tint, rowMarks, lineageLinks };
}

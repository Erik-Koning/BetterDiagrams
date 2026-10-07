/**
 * analyses.ts — saved analyses: a question kept with the model, to open
 * again and re-run after it changes.
 *
 * "Which tables use tenant_id, and what share of the model is that?" is
 * worth asking again next quarter. A saved analysis is the question — the
 * pins of a route search, the field names of a key-usage count, the keys of
 * a coverage score, the subject of an impact walk, the focus of a
 * neighbourhood — with a title, a note, and what it said when saved
 * (`snapshot`), so a re-run can say how far the answer drifted.
 *
 * They live in the document's validated `analyses` list (not `meta`, which
 * is free-form), repaired like everything else here: an unknown kind is
 * dropped, a node reference the document no longer has is pruned, and an
 * analysis left asking about nothing goes with it. Saving one is a document
 * edit (undoable, reported through `onChange`); opening one only sets view
 * state. Compare ignores them — they are not architecture.
 *
 * Zero dependencies, like every contract module.
 */
import type { FieldRef, Pin } from "./fields";
import type { CoverageScope } from "./coverage";

export type SavedAnalysisBody =
  | { kind: "paths"; pins: Pin[]; undirected: boolean; mode: "between" | "reachable" }
  | { kind: "usage"; names: string[]; match: "any" | "all"; includeTargets: boolean }
  | { kind: "coverage"; keys: FieldRef[]; scope: CoverageScope }
  | { kind: "impact"; subject: Pin; direction: "dependents" | "dependencies"; maxDepth?: number; via: "keys" | "all" }
  | { kind: "neighbourhood"; from: string[]; depth: number; direction: "out" | "in" | "both"; keysOnly: boolean };

export type SavedAnalysisKind = SavedAnalysisBody["kind"];

export interface SavedAnalysisMeta {
  id: string;
  title: string;
  note?: string;
  /** When it was saved, ISO date (YYYY-MM-DD). */
  created?: string;
  /** What it said when saved — "44 of 120 tables use them", 0.37 — to show drift on a re-run. */
  snapshot?: { headline: string; value?: number };
}

export type SavedAnalysis = SavedAnalysisMeta & SavedAnalysisBody;

export const ANALYSIS_KINDS: readonly SavedAnalysisKind[] = ["paths", "usage", "coverage", "impact", "neighbourhood"];
export const MAX_ANALYSES = 200;
export const MAX_ANALYSIS_TITLE = 200;
export const MAX_ANALYSIS_NOTE = 2000;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);

function pinOf(v: unknown, nodeIds: ReadonlySet<string> | null): Pin | null {
  if (!isRecord(v) || typeof v.nodeId !== "string" || !v.nodeId) return null;
  if (nodeIds && !nodeIds.has(v.nodeId)) return null;
  return typeof v.fieldId === "string" && v.fieldId ? { nodeId: v.nodeId, fieldId: v.fieldId } : { nodeId: v.nodeId };
}

/** The body, repaired; null when nothing it asks about survives. */
function bodyOf(r: Record<string, unknown>, nodeIds: ReadonlySet<string> | null): SavedAnalysisBody | null {
  const pins = (list: unknown) => (Array.isArray(list) ? list.map((p) => pinOf(p, nodeIds)).filter((p): p is Pin => p !== null) : []);
  switch (r.kind) {
    case "paths": {
      const kept = pins(r.pins);
      return kept.length ? { kind: "paths", pins: kept, undirected: r.undirected !== false, mode: oneOf(r.mode, ["between", "reachable"] as const, "between") } : null;
    }
    case "usage": {
      const names = Array.isArray(r.names)
        ? [...new Set(r.names.filter((n): n is string => typeof n === "string" && !!n.trim()).map((n) => n.trim().toLowerCase()))]
        : [];
      return names.length ? { kind: "usage", names, match: oneOf(r.match, ["any", "all"] as const, "any"), includeTargets: r.includeTargets === true } : null;
    }
    case "coverage": {
      const keys = pins(r.keys).filter((k): k is FieldRef => k.fieldId !== undefined);
      if (!keys.length) return null;
      const s = isRecord(r.scope) ? r.scope : {};
      // A scope rooted at a table that left falls back to the whole model.
      const scope: CoverageScope =
        s.kind === "from" && typeof s.nodeId === "string" && (!nodeIds || nodeIds.has(s.nodeId)) ? { kind: "from", nodeId: s.nodeId } : { kind: "all" };
      return { kind: "coverage", keys, scope };
    }
    case "impact": {
      const subject = pinOf(r.subject, nodeIds);
      if (!subject) return null;
      const depth = typeof r.maxDepth === "number" && Number.isFinite(r.maxDepth) && r.maxDepth >= 1 ? Math.min(Math.floor(r.maxDepth), 50) : undefined;
      return {
        kind: "impact",
        subject,
        direction: oneOf(r.direction, ["dependents", "dependencies"] as const, "dependents"),
        ...(depth !== undefined ? { maxDepth: depth } : {}),
        via: oneOf(r.via, ["keys", "all"] as const, "keys"),
      };
    }
    case "neighbourhood": {
      const from = Array.isArray(r.from) ? [...new Set(r.from.filter((id): id is string => typeof id === "string" && (!nodeIds || nodeIds.has(id))))] : [];
      if (!from.length) return null;
      const depth = typeof r.depth === "number" && Number.isFinite(r.depth) ? Math.min(Math.max(Math.floor(r.depth), 1), 6) : 1;
      return { kind: "neighbourhood", from, depth, direction: oneOf(r.direction, ["out", "in", "both"] as const, "both"), keysOnly: r.keysOnly === true };
    }
    default:
      return null;
  }
}

/**
 * Repair a document's `analyses`: drop what is not one (an unknown kind, no
 * id), prune node references `nodeIds` does not hold (omit it to keep them
 * all), drop an analysis left asking about nothing, and de-duplicate ids.
 */
export function validateAnalyses(raw: unknown, ctx: { nodeIds?: ReadonlySet<string> } = {}): SavedAnalysis[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedAnalysis[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_ANALYSES) break;
    if (!isRecord(item)) continue;
    const id = str(item.id, 120);
    if (!id || seen.has(id)) continue;
    const body = bodyOf(item, ctx.nodeIds ?? null);
    if (!body) continue;
    seen.add(id);
    const note = str(item.note, MAX_ANALYSIS_NOTE);
    const created = typeof item.created === "string" && /^\d{4}-\d{2}-\d{2}/.test(item.created) ? item.created.slice(0, 10) : undefined;
    const snap = isRecord(item.snapshot) ? item.snapshot : null;
    const headline = snap ? str(snap.headline, 300) : undefined;
    out.push({
      id,
      title: str(item.title, MAX_ANALYSIS_TITLE) ?? id,
      ...(note ? { note } : {}),
      ...(created ? { created } : {}),
      ...(headline
        ? { snapshot: { headline, ...(typeof snap!.value === "number" && Number.isFinite(snap!.value) ? { value: snap!.value } : {}) } }
        : {}),
      ...body,
    });
  }
  return out;
}

/** An id for a new analysis that the list does not hold yet: the title's slug, numbered when taken. */
export function analysisId(title: string, existing: readonly Pick<SavedAnalysis, "id">[]): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "analysis";
  const taken = new Set(existing.map((a) => a.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** What each kind is called in a list. */
export const ANALYSIS_KIND_LABEL: Record<SavedAnalysisKind, string> = {
  paths: "Routes",
  usage: "Key usage",
  coverage: "Key coverage",
  impact: "Impact",
  neighbourhood: "Neighbourhood",
};

/**
 * How far a re-run drifted from the snapshot — "was 44%, now 51%" for a
 * share, "was 12, now 15" for a count — or null when it did not (or there
 * is nothing to compare).
 */
export function analysisDrift(
  kind: SavedAnalysisKind,
  snapshot: SavedAnalysis["snapshot"] | undefined,
  now: { value?: number },
): string | null {
  if (snapshot?.value === undefined || now.value === undefined) return null;
  const share = kind === "usage" || kind === "coverage";
  const fmt = (v: number) => (share ? `${Math.round(v * 100)}%` : String(v));
  if (fmt(snapshot.value) === fmt(now.value)) return null;
  return `was ${fmt(snapshot.value)}, now ${fmt(now.value)}`;
}

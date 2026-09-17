/**
 * folder/sidecar.ts — `.better-diagrams/`, the diagram's own files beside a
 * source tree it must not rewrite.
 *
 *   layout.json     the presentation half of the split document: positions,
 *                   routes, per-view overrides (`contract/presentation.ts`)
 *   overrides.json  what a curator changed that the source doesn't own —
 *                   labels, descriptions, tags, notes — plus the paths drawn
 *   manifest.json   full-mode only: format marker, meta, zones, settings
 *
 * Paths ride with the overrides rather than the layout on purpose: a path
 * names ids, not geometry, and extending the presentation format would change
 * what `splitTemplate` strips for every caller that never saw a folder.
 */
import type { DiagramNode, DiagramTemplate, ValidateOptions } from "../schema";
import { validateTemplate } from "../schema";
import { validatePresentation, type DiagramPresentation } from "../presentation";
import type { DiagramPath } from "../paths";
import {
  OVERRIDES_FORMAT,
  type FolderOverrides,
  type ImportWarning,
  type NodeBaseline,
  type NodeOverride,
} from "./types";

export const SIDECAR_DIR = ".better-diagrams";
export const LAYOUT_FILE = `${SIDECAR_DIR}/layout.json`;
export const OVERRIDES_FILE = `${SIDECAR_DIR}/overrides.json`;
export const MANIFEST_FILE = `${SIDECAR_DIR}/manifest.json`;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const stringList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined;

/** Repair rather than reject, like every other reader in the contract. */
export function validateOverrides(raw: unknown): FolderOverrides {
  const out: FolderOverrides = { version: 1, format: OVERRIDES_FORMAT };
  if (!isRecord(raw)) return out;
  if (isRecord(raw.nodes)) {
    const nodes: Record<string, NodeOverride> = {};
    for (const [id, entry] of Object.entries(raw.nodes)) {
      if (!isRecord(entry)) continue;
      const o: NodeOverride = {};
      if (typeof entry.label === "string") o.label = entry.label;
      if (typeof entry.description === "string") o.description = entry.description;
      const tags = stringList(entry.tags);
      if (tags) o.tags = tags;
      const notes = stringList(entry.notes);
      if (notes) o.notes = notes;
      if (Object.keys(o).length) nodes[id] = o;
    }
    if (Object.keys(nodes).length) out.nodes = nodes;
  }
  if (Array.isArray(raw.paths) && raw.paths.length) out.paths = raw.paths as DiagramPath[];
  return out;
}

/** Read the two sidecar files from a file map, if present. */
export function readSidecar(
  files: ReadonlyMap<string, string>,
  warn: (w: ImportWarning) => void,
): { layout?: DiagramPresentation; overrides?: FolderOverrides } {
  const out: { layout?: DiagramPresentation; overrides?: FolderOverrides } = {};
  const layoutText = files.get(LAYOUT_FILE);
  if (layoutText !== undefined) {
    try {
      out.layout = validatePresentation(JSON.parse(layoutText));
    } catch {
      warn({ code: "unreadable-file", path: LAYOUT_FILE, message: "layout.json is not valid JSON" });
    }
  }
  const overridesText = files.get(OVERRIDES_FILE);
  if (overridesText !== undefined) {
    try {
      out.overrides = validateOverrides(JSON.parse(overridesText));
    } catch {
      warn({ code: "unreadable-file", path: OVERRIDES_FILE, message: "overrides.json is not valid JSON" });
    }
  }
  return out;
}

/** Layout records naming elements the document no longer has. */
export function sidecarOrphans(
  template: DiagramTemplate,
  layout: DiagramPresentation | undefined,
): string[] {
  if (!layout) return [];
  const nodeIds = new Set(template.nodes.map((n) => n.id));
  const edgeIds = new Set(template.edges.map((e) => e.id));
  return [
    ...Object.keys(layout.nodes ?? {}).filter((id) => !nodeIds.has(id)),
    ...Object.keys(layout.edges ?? {}).filter((id) => !edgeIds.has(id)),
  ];
}

/**
 * Apply overrides as the LAST import step: a curated label replaces the
 * generated one, notes land in `data.notes`, paths are appended (by id, an
 * override path replaces a generated one). Re-validated, since paths must
 * be checked against the final ids — with the same options the import
 * validated under, or a dialect's kinds would be coerced away here.
 */
export function applyOverrides(
  template: DiagramTemplate,
  overrides: FolderOverrides | undefined,
  warn: (w: ImportWarning) => void,
  validate?: ValidateOptions,
): DiagramTemplate {
  if (!overrides || (!overrides.nodes && !overrides.paths)) return template;
  const byId = new Set(template.nodes.map((n) => n.id));
  const nodes = template.nodes.map((n) => {
    const o = overrides.nodes?.[n.id];
    if (!o) return n;
    const next: DiagramNode = { ...n };
    if (o.label !== undefined) next.label = o.label;
    if (o.description !== undefined) next.description = o.description;
    if (o.tags) next.tags = [...o.tags];
    if (o.notes) next.data = { ...(n.data ?? {}), notes: [...o.notes] };
    return next;
  });
  for (const id of Object.keys(overrides.nodes ?? {})) {
    if (!byId.has(id)) {
      warn({ code: "override-orphan", path: id, message: `overrides.json names a node that no longer exists: ${id}` });
    }
  }
  let paths = template.paths ?? [];
  if (overrides.paths?.length) {
    const override = new Map(overrides.paths.map((p) => [p.id, p]));
    paths = [...paths.filter((p) => !override.has(p.id)), ...overrides.paths];
  }
  return validateTemplate({ ...template, nodes, ...(paths.length ? { paths } : {}) }, validate);
}

/**
 * The overrides an export writes: for every node, the curated fields that
 * differ from `baseline` — a fresh import's node when the source tree is
 * at hand, else the dialect's reading of the node's own `data`.
 */
export function collectOverrides(
  template: DiagramTemplate,
  baselineOf: (node: DiagramNode) => NodeBaseline | null,
): FolderOverrides {
  const out: FolderOverrides = { version: 1, format: OVERRIDES_FORMAT };
  const nodes: Record<string, NodeOverride> = {};
  for (const n of template.nodes) {
    const base = baselineOf(n);
    if (!base) continue;
    const o: NodeOverride = {};
    if (n.label !== base.label) o.label = n.label;
    if ((n.description ?? "") !== (base.description ?? "")) o.description = n.description ?? "";
    const tags = n.tags ?? [];
    const baseTags = base.tags ?? [];
    if (tags.length !== baseTags.length || tags.some((t, i) => t !== baseTags[i])) o.tags = [...tags];
    const notes = Array.isArray(n.data?.notes)
      ? (n.data!.notes as unknown[]).filter((s): s is string => typeof s === "string")
      : [];
    if (notes.length) o.notes = notes;
    if (Object.keys(o).length) nodes[n.id] = o;
  }
  if (Object.keys(nodes).length) out.nodes = nodes;
  if (template.paths?.length) out.paths = template.paths.map((p) => ({ ...p }));
  return out;
}

export const stringify = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

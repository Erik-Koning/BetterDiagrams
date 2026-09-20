/**
 * dialects/generic.ts — any tree of folders, with an optional `node.json`.
 *
 * The dialect `exportFolder` writes in full mode, and the fallback import
 * reads with when no other dialect claims the tree:
 *
 *   <folder>/node.json     the node minus what the tree already says
 *                          (`parentId` is the enclosing folder) and minus
 *                          placement (that is the layout sidecar's)
 *   <folder>/edges.json    the edges this node originates, whole
 *   .better-diagrams/manifest.json
 *                          format marker, meta, zones, settings, and the
 *                          document order of nodes and edges — a folder tree
 *                          has no order of its own, and a round trip must
 *                          give back the document it was handed
 *
 * A folder with no `node.json` is still a node: a group when it has
 * children, a plain box otherwise, named after the folder. That is what
 * makes a bare directory tree importable at all.
 */
import type { DiagramEdge, DiagramTemplate } from "../../schema";
import type { DiagramZone } from "../../zones";
import type { DiagramPath } from "../../paths";
import { readJson } from "../tree";
import { MANIFEST_FILE, SIDECAR_DIR } from "../sidecar";
import type { Dialect, FolderNode, FolderTree } from "../types";

export const GENERIC_DIALECT_ID = "generic";
export const FOLDER_FORMAT = "better-diagrams/folder";

export interface FolderManifest {
  format: typeof FOLDER_FORMAT;
  version: 1;
  dialect?: string;
  title?: string;
  meta?: DiagramTemplate["meta"];
  zones?: DiagramZone[];
  paths?: DiagramPath[];
  settings?: DiagramTemplate["settings"];
  /** Node ids in document order; ids the tree lacks are ignored. */
  order?: string[];
  edgeOrder?: string[];
  /** Every node kind the document used, so non-builtin ones survive a re-import. */
  kinds?: string[];
}

export interface GenericCtx {
  manifest: FolderManifest | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** "loyalty-members" → "Loyalty members". */
export function humanise(segment: string): string {
  const words = segment.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : segment;
}

function readManifest(tree: FolderTree): FolderManifest | null {
  const dir = tree.byPath.get(SIDECAR_DIR);
  const raw = dir ? readJson<unknown>(dir, MANIFEST_FILE.slice(SIDECAR_DIR.length + 1)) : undefined;
  return isRecord(raw) && raw.format === FOLDER_FORMAT ? (raw as unknown as FolderManifest) : null;
}

export const genericDialect: Dialect<GenericCtx> = {
  id: GENERIC_DIALECT_ID,

  detect(tree) {
    return readManifest(tree) !== null;
  },

  prepare(tree) {
    return { manifest: readManifest(tree) };
  },

  isNode(entry) {
    return entry.path !== SIDECAR_DIR && !entry.path.startsWith(`${SIDECAR_DIR}/`);
  },

  toNode(entry, parentId, _ctx, _opts, warn) {
    const raw = entry.files["node.json"] !== undefined ? readJson<unknown>(entry, "node.json") : undefined;
    if (entry.files["node.json"] !== undefined && !isRecord(raw)) {
      warn({ code: "unreadable-file", path: `${entry.path}/node.json`, message: "node.json is not a JSON object" });
    }
    const base = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    const fromFile = isRecord(raw) ? raw : {};
    const { x: _x, y: _y, w: _w, h: _h, parentId: _p, ...rest } = fromFile as Record<string, unknown>;
    return {
      kind: entry.children.length ? "group" : "service",
      icon: "none",
      description: "",
      label: humanise(base),
      ...(rest as Partial<FolderNode>),
      id: typeof fromFile.id === "string" && fromFile.id.trim() ? fromFile.id.trim() : entry.path,
      parentId,
      ...(isRecord(fromFile.data) && Object.keys(fromFile.data).length ? { data: fromFile.data } : {}),
    } as FolderNode;
  },

  toEdges(entry, _ctx, _opts, warn) {
    if (entry.files["edges.json"] === undefined) return [];
    const raw = readJson<unknown>(entry, "edges.json");
    if (!Array.isArray(raw)) {
      warn({ code: "unreadable-file", path: `${entry.path}/edges.json`, message: "edges.json is not a JSON array" });
      return [];
    }
    return raw.filter(isRecord) as unknown as DiagramEdge[];
  },

  meta(_tree, ctx) {
    const m = ctx.manifest;
    if (!m) return undefined;
    const meta = { ...(m.meta ?? {}) };
    if (m.title && !meta.title) meta.title = m.title;
    return Object.keys(meta).length ? meta : undefined;
  },

  extras(_tree, ctx) {
    const m = ctx.manifest;
    if (!m) return {};
    return {
      ...(m.zones?.length ? { zones: m.zones } : {}),
      ...(m.paths?.length ? { paths: m.paths } : {}),
      ...(m.settings ? { settings: m.settings } : {}),
    };
  },
};

/** The document order a manifest remembers, applied to what the walk found. */
export function applyManifestOrder<T extends { id: string }>(
  items: T[],
  order: string[] | undefined,
): T[] {
  if (!order?.length) return items;
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...items].sort((a, b) => {
    const ra = rank.get(a.id) ?? Number.POSITIVE_INFINITY;
    const rb = rank.get(b.id) ?? Number.POSITIVE_INFINITY;
    return ra - rb;
  });
}

/** A folder name for a node id: lower-kebab, never empty, never `.`-prefixed. */
export function slugFolder(id: string): string {
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return slug || "node";
}


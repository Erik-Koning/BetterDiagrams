/**
 * folder/export.ts — a `DiagramTemplate` out to a folder tree.
 *
 * Two modes, by contract partial and additive:
 *
 *   full     a complete generic tree — one folder per node, `node.json` and
 *            `edges.json` inside, the layout in the sidecar, everything else
 *            (meta, zones, settings, document order) in the manifest. Reads
 *            back through the generic dialect to the same document.
 *
 *   sidecar  ONLY `.better-diagrams/` — the layout and the curator's
 *            overrides — beside a source tree some other tool generates.
 *            Nothing the source owns is written; the diagram never becomes a
 *            second writer of an org's fields. A dialect may add files of
 *            its own (`sidecarFiles`), which is how the Salesforce dialect
 *            patches the two curated keys of an `object.yaml` when asked.
 *
 * Output is a file map plus a deletions list; the caller does the I/O.
 */
import type { DiagramNode, DiagramTemplate } from "../schema";
import { validateTemplate } from "../schema";
import { splitTemplate } from "../presentation";
import {
  LAYOUT_FILE,
  MANIFEST_FILE,
  OVERRIDES_FILE,
  collectOverrides,
  stringify,
} from "./sidecar";
import {
  FOLDER_FORMAT,
  genericDialect,
  slugFolder,
  type FolderManifest,
} from "./dialects/generic";
import { dialectById, importFolder, validateOptionsFor } from "./import";
import type {
  Dialect,
  FolderExportOptions,
  FolderExportResult,
  FileMap,
  FolderTree,
  ImportWarning,
  NodeBaseline,
} from "./types";

/** The file map a tree was built from — what a re-import needs. */
export function treeFiles(tree: FolderTree): FileMap {
  const files = new Map<string, string>();
  for (const entry of tree.byPath.values()) {
    for (const [base, content] of Object.entries(entry.files)) {
      files.set(entry.path ? `${entry.path}/${base}` : base, content);
    }
  }
  return files;
}

function resolveDialect(template: DiagramTemplate, requested: FolderExportOptions["dialect"]): Dialect<unknown> {
  if (requested && typeof requested === "object") return requested as Dialect<unknown>;
  const id =
    typeof requested === "string"
      ? requested
      : ((template.meta?.folderFormat as { dialect?: string } | undefined)?.dialect ?? genericDialect.id);
  const d = dialectById(id);
  if (!d) throw new Error(`Unknown folder dialect: ${id}`);
  return d;
}

/** Mode A: the whole document as a generic tree. */
function writeFull(t: DiagramTemplate, opts: FolderExportOptions): Map<string, string> {
  const files = new Map<string, string>();
  const { content, presentation } = splitTemplate(t, opts.validate);

  // Folder per node: parent's folder, then a slug of the id, de-duplicated
  // among siblings so two ids that slug alike never share a folder.
  const folderOf = new Map<string, string>();
  const taken = new Set<string>();
  const byId = new Map(content.nodes.map((n) => [n.id, n]));
  const place = (id: string): string => {
    const known = folderOf.get(id);
    if (known) return known;
    const n = byId.get(id)!;
    const parent = n.parentId && byId.has(n.parentId) ? place(n.parentId) : "";
    let folder = parent ? `${parent}/${slugFolder(id)}` : slugFolder(id);
    let bump = 2;
    while (taken.has(folder)) folder = `${parent ? `${parent}/` : ""}${slugFolder(id)}-${bump++}`;
    taken.add(folder);
    folderOf.set(id, folder);
    return folder;
  };
  for (const n of content.nodes) place(n.id);

  for (const n of content.nodes) {
    const folder = folderOf.get(n.id)!;
    const { parentId: _p, x: _x, y: _y, w: _w, h: _h, ...rest } = n;
    files.set(`${folder}/node.json`, stringify(rest));
  }
  const bySource = new Map<string, typeof content.edges>();
  for (const e of content.edges) {
    const list = bySource.get(e.source);
    if (list) list.push(e);
    else bySource.set(e.source, [e]);
  }
  for (const [source, edges] of bySource) {
    const folder = folderOf.get(source);
    if (folder) files.set(`${folder}/edges.json`, stringify(edges));
  }

  const { folderFormat: _ff, ...meta } = (content.meta ?? {}) as Record<string, unknown>;
  const manifest: FolderManifest = {
    format: FOLDER_FORMAT,
    version: 1,
    dialect: genericDialect.id,
    ...(typeof meta.title === "string" ? { title: meta.title } : {}),
    ...(Object.keys(meta).length ? { meta: meta as DiagramTemplate["meta"] } : {}),
    ...(content.zones?.length ? { zones: content.zones } : {}),
    ...(content.paths?.length ? { paths: content.paths } : {}),
    ...(content.settings ? { settings: content.settings } : {}),
    order: content.nodes.map((n) => n.id),
    edgeOrder: content.edges.map((e) => e.id),
    kinds: [...new Set(content.nodes.map((n) => n.kind))],
  };
  files.set(MANIFEST_FILE, stringify(manifest));
  files.set(LAYOUT_FILE, stringify(presentation));
  return files;
}

export function exportFolder(template: DiagramTemplate, opts: FolderExportOptions = {}): FolderExportResult {
  const warnings: ImportWarning[] = [];
  const warn = (w: ImportWarning) => warnings.push(w);
  const dialect = resolveDialect(template, opts.dialect);
  const validate = validateOptionsFor(dialect, opts.validate);
  const t = validateTemplate(template, validate);
  const mode: "full" | "sidecar" = opts.mode ?? (dialect.id === genericDialect.id ? "full" : "sidecar");

  if (mode === "full") {
    return { files: writeFull(t, { ...opts, validate }), deletions: [], warnings, dialect: genericDialect.id, mode };
  }

  // Mode B. The baseline is a fresh import when the tree is at hand (exact),
  // else the dialect's reading of each node's own data.
  let baselineOf: (node: DiagramNode) => NodeBaseline | null;
  if (opts.tree) {
    const recorded = (t.meta?.folderFormat as { importOptions?: Record<string, unknown> } | undefined)
      ?.importOptions;
    const fresh = importFolder(treeFiles(opts.tree), {
      dialect,
      fields: typeof recorded?.fields === "string" && recorded.fields !== "custom" ? (recorded.fields as "keys") : undefined,
      edges: recorded?.edges as "business" | undefined,
      polymorphic: recorded?.polymorphic as "collapse" | undefined,
      externalStubs: recorded?.externalStubs as boolean | undefined,
      layoutSidecar: null,
      overrides: null,
      validate: opts.validate,
    });
    const freshById = new Map(fresh.template.nodes.map((n) => [n.id, n]));
    baselineOf = (n) => {
      const f = freshById.get(n.id);
      return f ? { label: f.label, description: f.description, tags: f.tags } : null;
    };
  } else if (dialect.baseline) {
    const base = dialect.baseline.bind(dialect);
    baselineOf = (n) => base(n);
  } else {
    warn({
      code: "no-source-tree",
      message: "No source tree and the dialect has no baseline; overrides.json records only paths and notes",
    });
    baselineOf = (n) => ({ label: n.label, description: n.description, tags: n.tags });
  }

  // A node with no baseline has no source folder — it was added on the
  // canvas. Sidecar mode has nowhere to put it: the source tree is the only
  // content store, by design. Say so rather than lose it quietly.
  const added = t.nodes.filter((n) => !baselineOf(n)).map((n) => n.id);
  if (added.length) {
    warn({
      code: "no-source-folder",
      path: added.join(", "),
      message: `${added.length} node${added.length === 1 ? " has" : "s have"} no source folder and ${
        added.length === 1 ? "was" : "were"
      } not written (${added.join(", ")}) — add ${added.length === 1 ? "it" : "them"} upstream, or export in full mode`,
    });
  }
  const files = new Map<string, string>();
  files.set(LAYOUT_FILE, stringify(splitTemplate(t, validate).presentation));
  files.set(OVERRIDES_FILE, stringify(collectOverrides(t, baselineOf)));
  for (const [path, content] of dialect.sidecarFiles?.(t, opts.tree ?? null, opts, warn) ?? []) {
    files.set(path, content);
  }
  return { files, deletions: [], warnings, dialect: dialect.id, mode };
}

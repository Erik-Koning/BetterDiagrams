/**
 * folder/import.ts — a folder tree in, a `DiagramTemplate` out.
 *
 * The engine is dialect-agnostic: it walks the tree parents-first, asks the
 * dialect for a node per folder and the edges each node originates, drops
 * what dangles, validates, lays out (or merges the layout sidecar), and
 * applies the overrides sidecar last. Everything format-specific — which
 * files mean what — is the dialect's.
 *
 * Order of operations, which the tests pin:
 *
 *   1. detect / prepare        (re-rooting a wrapped tree first, see below)
 *   2. walk → toNode           parents before children, siblings by name
 *   3. toEdges                 after every node exists
 *   4. extraNodes              stubs and collapse points
 *   5. drop dangling edges     with a warning each
 *   6. mergeTemplate           validates; lays out what has no position
 *   7. sidecar orphans         layout records for ids that are gone
 *   8. applyOverrides          curated labels, notes, paths — then re-validate
 */
import type { DiagramEdge, DiagramTemplate, ValidateOptions } from "../schema";
import { CONTAINER_KINDS } from "../schema";
import { mergeTemplate, type DiagramContent } from "../presentation";
import { autoLayout } from "../layout";
import { validateTemplate } from "../schema";
import { buildFolderTree, rerootTree } from "./tree";
import { applyOverrides, readSidecar, sidecarOrphans } from "./sidecar";
import { genericDialect, applyManifestOrder, type GenericCtx } from "./dialects/generic";
import { dataModelDialect } from "./dialects/datamodel";
import type {
  Dialect,
  FileMap,
  FolderEntry,
  FolderNode,
  FolderTree,
  FolderImportOptions,
  FolderImportResult,
  ImportWarning,
} from "./types";

/**
 * A tree bigger than this opens folded (see `FolderImportOptions.foldGroups`).
 * Forty is about where a root canvas stops being readable at fit-zoom: the
 * example models are far under it, a real system's model far over.
 */
export const AUTO_FOLD_NODES = 40;

/** Every dialect this build knows, most specific first. */
export const DIALECTS: readonly Dialect<unknown>[] = [
  dataModelDialect as Dialect<unknown>,
  genericDialect as Dialect<unknown>,
];

export function dialectById(id: string): Dialect<unknown> | undefined {
  return DIALECTS.find((d) => d.id === id);
}

/**
 * Which dialect claims a tree, if any. A dropped directory usually carries
 * its own name as the first segment of every path; when nothing claims the
 * root and the root is exactly one empty wrapper around a single child, the
 * child is tried as the root and, when claimed, becomes it.
 */
export function detectDialect(tree: FolderTree): { dialect: Dialect<unknown>; tree: FolderTree } | null {
  for (const d of DIALECTS) if (d.detect(tree)) return { dialect: d, tree };
  const { root } = tree;
  if (!Object.keys(root.files).length && root.children.length === 1) {
    const inner = rerootTree(tree, root.children[0]);
    for (const d of DIALECTS) if (d.detect(inner)) return { dialect: d, tree: inner };
  }
  return null;
}

function resolveDialect(
  requested: FolderImportOptions["dialect"],
  tree: FolderTree,
): { dialect: Dialect<unknown>; tree: FolderTree } {
  if (requested && typeof requested === "object") return { dialect: requested as Dialect<unknown>, tree };
  if (typeof requested === "string") {
    const d = dialectById(requested);
    if (!d) throw new Error(`Unknown folder dialect: ${requested}`);
    // A named dialect still gets the wrapper treatment.
    if (!d.detect(tree) && !Object.keys(tree.root.files).length && tree.root.children.length === 1) {
      const inner = rerootTree(tree, tree.root.children[0]);
      if (d.detect(inner)) return { dialect: d, tree: inner };
    }
    return { dialect: d, tree };
  }
  return detectDialect(tree) ?? { dialect: genericDialect as Dialect<unknown>, tree };
}

/** The validator options a dialect's kinds need to survive `validateTemplate`. */
export function validateOptionsFor(dialect: Dialect<unknown>, base?: ValidateOptions): ValidateOptions {
  const kinds = dialect.registry?.nodeKinds ?? {};
  const containers = Object.entries(kinds)
    .filter(([, def]) => def.container)
    .map(([id]) => id);
  const annotations = Object.entries(kinds)
    .filter(([, def]) => def.annotation)
    .map(([id]) => id);
  return {
    ...base,
    knownKinds: [...(base?.knownKinds ?? []), ...Object.keys(kinds)],
    knownIcons: [...(base?.knownIcons ?? []), ...Object.keys(dialect.registry?.icons ?? {})],
    containerKinds: [...(base?.containerKinds ?? CONTAINER_KINDS), ...containers],
    ...(annotations.length
      ? { annotationKinds: [...(base?.annotationKinds ?? []), ...annotations] }
      : {}),
  };
}

export function importFolder(files: FileMap, opts: FolderImportOptions = {}): FolderImportResult {
  const warnings: ImportWarning[] = [];
  const warn = (w: ImportWarning) => warnings.push(w);

  const resolved = resolveDialect(opts.dialect, buildFolderTree(files));
  const { dialect } = resolved;
  const tree = resolved.tree;
  const ctx = dialect.prepare(tree, warn);

  // 2. Walk. A folder the dialect skips still has its children walked,
  // parented to the nearest ancestor that IS a node; a folder the dialect
  // says is not a node at all (cross-cutting metadata) takes its subtree
  // with it.
  const nodes: FolderNode[] = [];
  const seen = new Set<string>();
  const produced: Array<{ entry: FolderEntry }> = [];
  const visit = (entry: FolderEntry, parentId: string | null) => {
    for (const child of entry.children) {
      if (!dialect.isNode(child, ctx)) continue;
      const node = dialect.toNode(child, parentId, ctx, opts, warn);
      let id = parentId;
      if (node) {
        if (seen.has(node.id)) {
          warn({
            code: "duplicate-node-id",
            path: child.path,
            message: `Two folders produced the node id "${node.id}"; the second is skipped`,
          });
        } else {
          seen.add(node.id);
          nodes.push(node);
          produced.push({ entry: child });
          id = node.id;
        }
      }
      visit(child, id);
    }
  };
  visit(tree.root, null);

  // 3. Edges, 4. extras.
  let edges: DiagramEdge[] = [];
  for (const { entry } of produced) edges.push(...dialect.toEdges(entry, ctx, opts, warn));
  for (const extra of dialect.extraNodes?.(ctx, opts) ?? []) {
    if (seen.has(extra.id)) continue;
    seen.add(extra.id);
    nodes.push(extra);
  }

  // 5. Dangling edges — a warning each, never a throw.
  edges = edges.filter((e) => {
    const ok = seen.has(e.source) && seen.has(e.target);
    if (!ok) {
      warn({
        code: "edge-target-missing",
        path: e.id,
        message: `Edge ${e.id} joins ${seen.has(e.source) ? "" : `missing ${e.source}`}${
          !seen.has(e.source) && !seen.has(e.target) ? " and " : ""
        }${seen.has(e.target) ? "" : `missing ${e.target}`}; dropped`,
      });
    }
    return ok;
  });
  // Deterministic edge order, whatever order the dialect found them in.
  edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // The manifest of a generic tree remembers the document order.
  const manifest = dialect.id === genericDialect.id ? (ctx as GenericCtx).manifest : null;
  const orderedNodes = applyManifestOrder(nodes, manifest?.order ?? undefined);
  const orderedEdges = applyManifestOrder(edges, manifest?.edgeOrder ?? undefined);

  // 6. Validate + layout. The sidecar in the files is read unless the
  // caller supplied one (or explicitly passed null to ignore it).
  const sidecar = readSidecar(files, warn);
  const layout = opts.layoutSidecar === undefined ? sidecar.layout : (opts.layoutSidecar ?? undefined);
  const overrides = opts.overrides === undefined ? sidecar.overrides : (opts.overrides ?? undefined);

  const dialectMeta = dialect.meta?.(tree, ctx, opts) ?? {};
  const { folderFormat: dialectFormat, ...restMeta } = dialectMeta as Record<string, unknown>;
  const meta: NonNullable<DiagramTemplate["meta"]> = {
    ...restMeta,
    folderFormat: {
      dialect: dialect.id,
      version: 1,
      ...((dialectFormat as Record<string, unknown> | undefined) ?? {}),
      importOptions: {
        fields: typeof opts.fields === "function" ? "custom" : (opts.fields ?? "keys"),
        edges: opts.edges ?? "business",
        polymorphic: opts.polymorphic ?? "collapse",
        externalStubs: opts.externalStubs !== false,
      },
    },
  };
  const extras = dialect.extras?.(tree, ctx) ?? {};
  const content: DiagramContent = {
    version: 1,
    meta,
    ...(extras.zones?.length ? { zones: extras.zones } : {}),
    nodes: orderedNodes,
    edges: orderedEdges,
    ...(extras.paths?.length ? { paths: extras.paths } : {}),
    ...(extras.settings ? { settings: extras.settings } : {}),
  };
  // A generic manifest remembers the kinds its document used — a tree
  // written from a dialect's document reads back with those kinds intact.
  const validate = validateOptionsFor(dialect, {
    ...opts.validate,
    ...(manifest?.kinds?.length
      ? { knownKinds: [...(opts.validate?.knownKinds ?? []), ...manifest.kinds] }
      : {}),
  });
  let template = mergeTemplate(content, layout, validate);

  // A big tree laid out flat is unreadable — 137 entities fit-zoom to about 3%.
  // Collapse its TOP-LEVEL containers so it opens as a map of chips to drill
  // into, and lay it out again: `collapsed` is the flag the layout sizes a
  // chip by (`settings.groupContents` is a render-time fold the layout never
  // sees, so folding without re-laying-out leaves chips scattered across a
  // canvas measured for expanded bands).
  //
  // Never automatic for the generic dialect: its trees round-trip a document
  // that already said what it wanted. An explicit `foldGroups` always wins.
  const containers = new Set(validate.containerKinds ?? []);
  const parents = new Set(template.nodes.map((n) => n.parentId).filter((p): p is string => !!p));
  const foldable = template.nodes.filter((n) => !n.parentId && containers.has(n.kind) && parents.has(n.id));
  const folds =
    opts.foldGroups ?? (dialect.id !== genericDialect.id && template.nodes.length > AUTO_FOLD_NODES);
  if (folds && foldable.length) {
    const ids = new Set(foldable.map((n) => n.id));
    const collapsed = validateTemplate(
      { ...template, nodes: template.nodes.map((n) => (ids.has(n.id) ? { ...n, collapsed: true } : n)) },
      validate,
    );
    // Collapsing is a view the tree asked for; re-laying-out is only ours to
    // do when we placed everything ourselves. A sidecar is the reader's own
    // arrangement — running the layout over it would throw their work away.
    template = layout
      ? collapsed
      : autoLayout(collapsed, { containerKinds: validate.containerKinds, frames: "all" });
  }

  // 7. Orphans are reported, never fatal — the layout simply has stale rows.
  for (const id of sidecarOrphans(template, layout)) {
    warn({ code: "sidecar-orphan", path: id, message: `layout.json has a record for "${id}", which no longer exists` });
  }

  // 8. Curated overrides win over everything generated.
  template = applyOverrides(template, overrides, warn, validate);

  return {
    template,
    dialect: dialect.id,
    warnings,
    stats: {
      nodes: template.nodes.length,
      edges: template.edges.length,
      fields: template.nodes.reduce((n, node) => n + (node.fields?.length ?? 0), 0),
    },
    registry: dialect.registry ?? {},
  };
}

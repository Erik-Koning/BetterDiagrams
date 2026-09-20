/**
 * folder/types.ts — the folder format's vocabulary.
 *
 * A FOLDER FORMAT is a directory tree where each folder is a node, nesting is
 * arbitrary depth, and the files inside a folder carry the node's content.
 * What those files are called and what they mean is a DIALECT's business:
 * the generic dialect reads `node.json` / `edges.json`, the data-model
 * dialect reads the `schema.json` / `entity.yaml` a database or object-model
 * exporter writes. The tree walk, the id scheme, the layout sidecar and the
 * validation are shared.
 *
 * Nothing here touches a filesystem: a {@link FileMap} is the whole input,
 * and a browser (a dropped directory, the File System Access API) produces
 * one as readily as Node does — see `node.ts` for the Node adapter.
 */
import type { DiagramEdge, DiagramNode, DiagramTemplate, ValidateOptions } from "../schema";
import type { DiagramPresentation } from "../presentation";
import type { DiagramPath } from "../paths";

/** Path (forward slashes, relative to the root, no leading `./`) → UTF-8 text. */
export type FileMap = ReadonlyMap<string, string>;

export interface FolderEntry {
  /** "core/account/person-account"; "" for the root. */
  path: string;
  parentPath: string | null;
  /** 0 for the root, 1 for its children. */
  depth: number;
  /** basename → content, for the files directly inside this folder. */
  files: Record<string, string>;
  /** Sorted by folder name, so every walk is deterministic. */
  children: FolderEntry[];
}

export interface FolderTree {
  root: FolderEntry;
  byPath: Map<string, FolderEntry>;
}

export type ImportWarningCode =
  | "unknown-shape"
  | "folder-mismatch"
  | "edge-target-missing"
  | "poly-capped"
  | "too-many-fields"
  | "fields-truncated"
  | "duplicate-node-id"
  | "duplicate-name"
  | "yaml-fallback-used"
  | "sidecar-orphan"
  | "override-orphan"
  | "unreadable-file"
  | "no-source-tree"
  | "no-source-folder";

/** Typed, returned, never thrown. `path` is the folder or file it concerns. */
export interface ImportWarning {
  code: ImportWarningCode;
  message: string;
  path?: string;
}

/**
 * The registry additions a dialect wants the editor to know about. The same
 * shape as the react half's `RegistryExtensions`, declared structurally so
 * the contract never imports React.
 */
export interface DialectRegistry {
  nodeKinds?: Record<
    string,
    {
      label: string;
      fill?: string;
      accent?: string;
      text?: string;
      icon?: string;
      shape?: string;
      container?: boolean;
      annotation?: boolean;
      record?: boolean;
      point?: boolean;
    }
  >;
  icons?: Record<string, string[]>;
  /**
   * The dialect's names for the relationship kinds (see
   * `contract/relations.ts`) — a partial over the built-in of the same key,
   * so a dialect relabels "composition" as what its world calls it and
   * keeps the line it draws with.
   */
  relationKinds?: Record<
    string,
    {
      label?: string;
      description?: string;
      style?: string;
      color?: string;
      startHead?: string;
      endHead?: string;
      startLabel?: string;
      endLabel?: string;
    }
  >;
}

/**
 * A node as a dialect emits it: placement is optional, because a folder tree
 * carries no geometry — the layout sidecar or the auto-layout supplies it.
 */
export type FolderNode = Omit<DiagramNode, "x" | "y" | "w" | "h"> &
  Partial<Pick<DiagramNode, "x" | "y" | "w" | "h">>;

export interface FolderImportOptions {
  /** Which dialect to read with. Auto-detected when omitted. */
  dialect?: string | Dialect;
  /**
   * Which of an entity's fields become `NodeField` rows. Dialect-defined;
   * the data-model dialect reads `"keys"` (default), `"visible"`, `"all"`,
   * or a predicate over its own field shape.
   */
  fields?: "keys" | "visible" | "all" | ((field: unknown, node: FolderNode) => boolean);
  /** Which relationships become edges. `"business"` (default) hides audit noise. */
  edges?: "business" | "all";
  /** How a polymorphic reference is drawn. Default `"collapse"`. */
  polymorphic?: "collapse" | "in-model" | "none";
  /** Stand-in nodes for references that leave the model. Default true. */
  externalStubs?: boolean;
   /**
   * Open with the top-level containers COLLAPSED — a map of chips to drill
   * into rather than a wall of cards. Unset means AUTO: a dialect-generated
   * tree past {@link AUTO_FOLD_NODES} nodes collapses; a generic tree never
   * does on its own, because it round-trips a document that already said
   * what it wanted. Setting it either way always wins.
   */
  foldGroups?: boolean;
  /** A previously exported layout sidecar, merged over the fresh import. */
  layoutSidecar?: DiagramPresentation | null;
  /** A previously exported overrides sidecar, applied last. */
  overrides?: FolderOverrides | null;
  /** Passed through to `validateTemplate`; the dialect's own kinds are added. */
  validate?: ValidateOptions;
}

export interface ImportStats {
  nodes: number;
  edges: number;
  /** `NodeField` rows across every node. */
  fields: number;
}

export interface FolderImportResult {
  template: DiagramTemplate;
  dialect: string;
  warnings: ImportWarning[];
  stats: ImportStats;
  /** What the editor must be handed for the dialect's kinds to render. */
  registry: DialectRegistry;
}

export interface FolderExportOptions {
  /**
   * `"full"` writes a complete generic folder tree (one folder per node);
   * `"sidecar"` writes only `.better-diagrams/` beside an existing source
   * tree. Default: sidecar when the template records a non-generic dialect
   * in `meta.folderFormat`, full otherwise.
   */
  mode?: "full" | "sidecar";
  /** The dialect whose sidecar rules apply. Defaults from `meta.folderFormat.dialect`. */
  dialect?: string | Dialect;
  /**
   * The source tree the template was imported from. Lets the sidecar diff
   * against a fresh import (exact overrides) and lets a dialect patch its
   * own curated files. Without it, overrides are diffed against the
   * dialect's baseline reading of each node's `data`.
   */
  tree?: FolderTree | null;
  /**
   * Sidecar mode, data model: also patch `diagramName` / `diagramType` in
   * existing `entity.yaml` files. Off by default.
   */
  writeEntityYaml?: boolean;
  validate?: ValidateOptions;
}

export interface FolderExportResult {
  files: Map<string, string>;
  /** Paths the caller should remove. Always empty in sidecar mode. */
  deletions: string[];
  warnings: ImportWarning[];
  dialect: string;
  mode: "full" | "sidecar";
}

export const OVERRIDES_FORMAT = "better-diagrams/overrides";

/** What a curator changed on the diagram that the source folder doesn't own. */
export interface NodeOverride {
  label?: string;
  description?: string;
  tags?: string[];
  /** Free text, stored on the node as `data.notes`. */
  notes?: string[];
}

export interface FolderOverrides {
  version: 1;
  format: typeof OVERRIDES_FORMAT;
  nodes?: Record<string, NodeOverride>;
  /** Named flows the curator drew — they reference ids, so they live with the overrides. */
  paths?: DiagramPath[];
}

/** What a dialect can recompute about a node from its `data` alone. */
export interface NodeBaseline {
  label: string;
  description: string;
  tags?: string[];
}

export interface Dialect<TCtx = unknown> {
  id: string;
  /** Whether this tree is one of ours. The root entry is what to sniff. */
  detect(tree: FolderTree): boolean;
  /** One pass over the tree before any node is built: parse manifests, index ids. */
  prepare(tree: FolderTree, warn: (w: ImportWarning) => void): TCtx;
  /** False for cross-cutting folders that are never nodes (`.better-diagrams`, metadata). */
  isNode(entry: FolderEntry, ctx: TCtx): boolean;
  /**
   * The node for a folder, or null to skip it (children still walk, parented
   * to the nearest ancestor that IS a node).
   */
  toNode(
    entry: FolderEntry,
    parentId: string | null,
    ctx: TCtx,
    opts: FolderImportOptions,
    warn: (w: ImportWarning) => void,
  ): FolderNode | null;
  /** The edges this folder's node originates. Called after every node exists. */
  toEdges(
    entry: FolderEntry,
    ctx: TCtx,
    opts: FolderImportOptions,
    warn: (w: ImportWarning) => void,
  ): DiagramEdge[];
  /** Nodes with no folder of their own — external stubs, collapse points. */
  extraNodes?(ctx: TCtx, opts: FolderImportOptions): FolderNode[];
  /** The document's `meta`, from the root manifest. */
  meta?(tree: FolderTree, ctx: TCtx, opts: FolderImportOptions): DiagramTemplate["meta"];
  /** Zones, paths and settings a dialect's manifest may carry. */
  extras?(tree: FolderTree, ctx: TCtx): Pick<DiagramTemplate, "zones" | "paths" | "settings">;
  registry?: DialectRegistry;
  /** What import would have produced for this node's curated fields, read back from `data`. */
  baseline?(node: DiagramNode): NodeBaseline | null;
  /**
   * Sidecar mode: files the dialect itself wants to write beside
   * `.better-diagrams/` — e.g. patched `entity.yaml`s. Optional; most
   * dialects write nothing of their own.
   */
  sidecarFiles?(
    template: DiagramTemplate,
    tree: FolderTree | null,
    opts: FolderExportOptions,
    warn: (w: ImportWarning) => void,
  ): Map<string, string>;
}

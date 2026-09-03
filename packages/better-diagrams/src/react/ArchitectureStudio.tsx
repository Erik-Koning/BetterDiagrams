/**
 * ArchitectureStudio.tsx — the editor component.
 *
 * Integration contract:
 *   - Controlled with `value` + `onChange`, or uncontrolled with `defaultValue`.
 *   - Sizes to its parent box. The host decides whether it is a full page or a
 *     panel; the component never assumes the viewport.
 *   - Every visual is registry- and token-driven, so extending it does not
 *     require forking it.
 *   - No network calls unless the host supplies `generate`.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  SelectionMode,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type OnConnectEnd,
  type OnSelectionChangeParams,
} from "@xyflow/react";

import {
  BOUNDARY_NODE_PREFIX,
  COLLAPSED_EDGE_PREFIX,
  DEFAULT_ZONE_OPACITY,
  EDGE_COLORS,
  EDGE_Z_INDEX,
  LEAF_Z_INDEX,
  EDGE_ANCHOR_SIDES,
  EDGE_COLOR_HEX,
  EDGE_DASH,
  EDGE_HEADS,
  EDGE_ROUTINGS,
  EDGE_STYLES,
  EMPTY_TEMPLATE,
  FIELD_KEYS,
  MAX_NODE_FIELDS,
  NODE_OUTLINES,
  NODE_STATUSES,
  NODE_TEXT_ALIGNS,
  NODE_TEXT_VALIGNS,
  DEFAULT_CONTAINER_OPACITY,
  DEFAULT_FONT_SIZE,
  type NodeOutline,
  type NodeTextAlign,
  type NodeTextVAlign,
  NODE_MIN_SIZE,
  wrappedTitleHeight,
  fieldsBoxHeight,
  KIND_DEFAULT_SIZE,
  activeScenario,
  assignZonesByGeometry,
  snapNodesIntoZones,
  fromReactFlow,
  fromZoneNodeId,
  ghostSourceId,
  isBoundaryNodeId,
  isCollapsedEdgeId,
  isGhostEdgeId,
  isGhostNodeId,
  isZoneNodeId,
  resolveRouting,
  scaleZoneMembers,
  setAllZoneProviders,
  templateProviders,
  toReactFlow,
  toZoneNodeId,
  validateTemplate,
  visibleElements,
  type DiagramEdgeData,
  type DiagramNodeData,
  type DiagramTemplate,
  type EdgeColor,
  type EdgeAnchorSide,
  type EdgeDirection,
  type EdgeHead,
  type EdgeRouting,
  type EdgeStyle,
  type FieldKey,
  type NodeField,
  type NodeStatus,
  type VersionTagPosition,
  type ZoneBox,
  type ZoneNodeData,
} from "../contract/schema";
import {
  DEFAULT_POLYGON_POINTS,
  ZONE_OUTLINES,
  ZONE_SHAPES,
  zoneAt,
  type DiagramZone,
  type ZoneOutline,
  type ZoneShape,
} from "../contract/zones";
import { lintTemplate, type LintFinding } from "../contract/lint";
import { diffTemplates } from "../contract/diff";
import {
  openingCursor,
  templateTimeline,
  timelineView,
  type DiagramDate,
  type TimelineFuture,
  type TimelineFutureMode,
  type TimelineView,
} from "../contract/timeline";
import {
  countStateCombos,
  materializeCombo,
  templateStateAxes,
} from "../contract/states";
import { focusPath, liftScopedReactFlow, scopedView } from "../contract/scope";
import { DiffCanvas } from "./DiffCanvas";
import { isMac, isTypingTarget } from "./keys";
import {
  FileMenu,
  Breadcrumbs,
  ShortcutsModal,
  InspectorSection,
  TimelineScrubber,
  levelLabel,
  ToolbarMenu,
  VersionTagChip,
  type StudioFile,
  type StudioFileInit,
} from "./chrome";
import {
  WelcomeModal,
  clearWelcomeSuppression,
  suppressNextWelcome,
  welcomeSuppressed,
} from "./WelcomeModal";
import { buildArchitectureLint } from "./schema-lint";
import { NestingModal } from "./NestingModal";
import { inlineContents, nestContents } from "../contract/nesting";
import { KindSelect } from "./KindSelect";
import { CLOUD_PROVIDER_IDS } from "../contract/cloud";
import {
  cloudOptionsFor,
  cloudResourceOptions,
  promptForCloudSelection,
  referencedProviders,
  usedCloudResources,
  type PromptScopeOptions,
} from "./template-prompt";
import { autoLayout, hasOverlaps } from "../contract/layout";
import {
  PRESENTATION_FORMAT,
  mergeTemplate,
  splitTemplate,
  validatePresentation,
} from "../contract/presentation";
import { buildSequencePrompt, parseLlmSequence } from "../contract/sequence";
import { layoutIfUnpositioned, parseArchitectureText } from "./welcome-parse";
import {
  copyFragment,
  duplicateWithConnections,
  parseFragment,
  pasteFragment,
} from "../contract/clipboard";
import { createRegistry } from "./create-registry";
import { BUILTIN_EXPORTERS, renderTemplateToCanvas, renderTemplateToSvg } from "./exporters";
import { ExportStatesModal, type ExportStatesChoice } from "./ExportStatesModal";
import { runStateExport, type StateExportFormat } from "./state-export";
import type { RegistryExtensions, ResolvedRegistry } from "./registry-types";
import { kindDef, providerDef, zoneInk } from "./registry-types";
import { NODE_TYPES } from "./nodes";
import { EDGE_TYPES } from "./edges";
import { topDropTarget } from "./dangling";
import { StudioContext } from "./context";
import { paletteFromTheme, themeToStyle, type Theme } from "./theme";
import { useHistory, type Snapshot } from "./history";
import {
  buildRefineMessage,
  coerceGeneratorResult,
  type DiagramGenerator,
} from "../contract/llm";

// Module-level so the object identity is stable across renders — React Flow
// stores it and would churn on a fresh literal every pass. See EDGE_Z_INDEX
// for the layering bands this pins edges into.
const DEFAULT_EDGE_OPTIONS = { zIndex: EDGE_Z_INDEX };

/**
 * How far a selected node floats above the rest. Bigger than every stacking
 * band put together, so the node under the pointer is always the visible one
 * — a lift of one band would only reach the things nested on top of it.
 */
const SELECT_ELEVATION = 100_000;

/**
 * How far a SELECTED edge floats — above a selected node, so its endpoint and
 * waypoint handles are the topmost thing under the pointer while it is the
 * element being worked on.
 */
const SELECTED_EDGE_ELEVATION = SELECT_ELEVATION * 2;

/** How close an edge has to come to a neighbour's before the guide catches. */
const ALIGN_TOL = 6;

// ─── Props ───────────────────────────────────────────────────────────────────

export interface StudioSlotContext {
  /** The diagram as it stands, ready to persist. */
  template: DiagramTemplate;
  registry: ResolvedRegistry;
  /** Replace the whole document (adds an undo point). */
  setTemplate: (next: DiagramTemplate) => void;
}

/**
 * The canvas selection in DOCUMENT terms — ids bucketed by the template
 * section they live in, so a host can point straight at `template.nodes`,
 * `.edges`, or `.zones` (e.g. to highlight those entries in a JSON view).
 * Canvas-only artifacts (zone-node prefixes, collapse-rerouted edge ids)
 * never leak through.
 */
export interface StudioSelection {
  nodes: string[];
  edges: string[];
  zones: string[];
}

export interface ArchitectureStudioProps {
  /** Controlled document. Provide with `onChange`. */
  value?: DiagramTemplate;
  /** Initial document for uncontrolled use. Defaults to an empty diagram. */
  defaultValue?: DiagramTemplate;
  /** Fires on every committed edit with the full, validated template. */
  onChange?: (template: DiagramTemplate) => void;
  /** Shows a Save button in the toolbar when provided. */
  onSave?: (template: DiagramTemplate) => void | Promise<void>;
  /** Disable all editing; the canvas stays pannable and exportable. */
  readOnly?: boolean;
  /** Add or override node kinds, icons, and exporters. */
  registry?: RegistryExtensions;
  /** Override design tokens. */
  theme?: Theme;
  /** Supply to enable the AI panel. Omit and no network code runs. */
  generate?: DiagramGenerator;
  /** Base name for exported files. Defaults to "architecture". */
  filename?: string;
  /** Show the React Flow minimap. Defaults to true. */
  minimap?: boolean;
  /**
   * Show the welcome/import modal over a brand-new document (or an empty
   * workspace): brand mark, "Insert Node Manually", "Copy Schema & System
   * Prompt", and a paste-JSON editor. Defaults to true; suppressed while
   * `readOnly` or `diffBase` is set.
   */
  welcome?: boolean;
  /** Show the infra legend in the corner. Defaults to true; only renders when zones exist. */
  legend?: boolean;
  /** Start with provider-hidden nodes ghosted rather than omitted. Defaults to false. */
  defaultShowHidden?: boolean;
  /**
   * Baseline to compare against. While set, the canvas becomes a read-only
   * diff view — added / removed / changed vs this template — and the document
   * itself is untouched. The toolbar's Compare button offers the same via a
   * file picker; this prop wins when both are present.
   */
  diffBase?: DiagramTemplate;
  /**
   * The host's workspace files. When provided, the brand in the toolbar
   * becomes a file selector; every operation calls back — the editor stores
   * nothing. `onNavigateFile` fires when a node's `url` uses the `file:`
   * prefix and its ↗ affix is clicked.
   */
  files?: StudioFile[];
  activeFileId?: string;
  onFileSelect?: (id: string) => void;
  /**
   * Create a file. Called with no argument from the file menu's "＋ New file";
   * the welcome modal passes a {@link StudioFileInit} so the host can seed the
   * name and (when JSON was inserted) the document.
   */
  onFileCreate?: (init?: StudioFileInit) => void;
  onFileRename?: (id: string, name: string) => void;
  onFileDelete?: (id: string) => void;
  /** Deleted documents the host still holds, offered for recovery. */
  removedFiles?: StudioFile[];
  onFileRestore?: (id: string) => void;
  onNavigateFile?: (ref: string) => void;
  /**
   * Fires with the {@link StudioSelection} on mount (empty) and whenever it
   * changes — so a host that remounts the editor per file never holds a
   * selection from the previous document.
   */
  onSelectionChange?: (selection: StudioSelection) => void;
  /** Extra toolbar content, rendered after the built-in buttons. */
  toolbarExtras?: ReactNode | ((ctx: StudioSlotContext) => ReactNode);
  /** Extra inspector content, rendered when something is selected. */
  inspectorExtras?: ReactNode | ((ctx: StudioSlotContext) => ReactNode);
  className?: string;
  style?: CSSProperties;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** First usable number among React Flow's three places a size can live. */
function firstNumber(...values: unknown[]): number | undefined {
  for (const v of values) if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  return undefined;
}

/**
 * How far a pasted or duplicated copy lands from its source.
 *
 * Larger than the contract's 28px default on purpose: the smallest node is
 * 110×52 and the default is 170×76, so 28px left a copy almost exactly on top
 * of the original. 60 clears it in both axes while keeping the copy inside the
 * same glance.
 */
const PASTE_OFFSET = 60;

let idCounter = 0;
/** Collision-resistant without pulling in a uuid dependency. */
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick — revoking synchronously can cancel the download
  // in some browsers before it has started reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}


// ─── Component ───────────────────────────────────────────────────────────────

/**
 * Fields a person edits by TYPING, where the inspector commits on every
 * keystroke so a controlled host stays live.
 *
 * A run of commits into one of these collapses into a single undo entry (see
 * CommitOptions in history.ts); everything else — a kind, a status, a colour —
 * is one deliberate action per commit and undoes on its own.
 */
/**
 * The editor the keyboard belongs to while nothing has DOM focus.
 *
 * Clicking a canvas leaves focus on <body>, so focus alone cannot tell two
 * mounted studios apart — or tell either of them from the host's own page.
 * The most recently pointed-at editor holds the claim; the first to mount
 * takes it so a lone editor works before anyone has touched it.
 */
let activeStudio: symbol | null = null;

/**
 * Whether a canvas node is pinned.
 *
 * Zone nodes carry their document under `data.zone`, every other kind spreads
 * its fields onto `data` directly — so a bare `data.locked` reads `undefined`
 * for every zone, and a locked region could still be nudged with the arrows
 * while ⌘⇧L could only ever re-lock it.
 */
function isNodeLocked(node: { data?: unknown } | undefined | null): boolean {
  const data = node?.data as { locked?: boolean; zone?: { locked?: boolean } } | undefined;
  return !!(data?.zone ? data.zone.locked : data?.locked);
}

const TYPED_FIELDS = new Set([
  "label",
  "description",
  "tech",
  "team",
  "url",
  "startLabel",
  "endLabel",
  "fields",
]);

/** The coalescing key for a patch, or nothing when it is not a typing run. */
function typingRunKey(scope: string, id: string, patch: object): string | undefined {
  const keys = Object.keys(patch);
  return keys.length === 1 && TYPED_FIELDS.has(keys[0]!) ? `${scope}:${id}:${keys[0]}` : undefined;
}


export function ArchitectureStudio(props: ArchitectureStudioProps) {
  // React Flow hooks require the provider to be an ancestor, so the real
  // implementation lives one level down.
  return (
    <ReactFlowProvider>
      <StudioInner {...props} />
    </ReactFlowProvider>
  );
}

function StudioInner({
  value,
  defaultValue,
  onChange,
  onSave,
  readOnly = false,
  registry: registryExtensions,
  theme,
  generate,
  filename = "architecture",
  minimap = true,
  welcome = true,
  legend = true,
  defaultShowHidden = false,
  diffBase,
  files,
  activeFileId,
  onFileSelect,
  onFileCreate,
  onFileRename,
  onFileDelete,
  removedFiles,
  onFileRestore,
  onNavigateFile,
  onSelectionChange: onHostSelectionChange,
  toolbarExtras,
  inspectorExtras,
  className,
  style,
}: ArchitectureStudioProps) {
  const registry = useMemo(() => createRegistry(registryExtensions), [registryExtensions]);
  const flow = useReactFlow();

  const initialTemplate = useMemo(
    // layoutIfUnpositioned keeps the split contract at the host door too: a
    // CONTENT doc handed as value/defaultValue lays itself out instead of
    // piling every node at the origin. No-op for placed documents.
    () =>
      layoutIfUnpositioned(
        validateTemplate(value ?? defaultValue ?? EMPTY_TEMPLATE, registryOpts(registry)),
      ),
    // Only for first mount; `value` changes are handled by the sync effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const initialFlow = useMemo(
    () => toReactFlow(initialTemplate, registryKinds(registry, defaultShowHidden)),
    [initialTemplate, registry, defaultShowHidden],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(initialFlow.nodes as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialFlow.edges as Edge[]);
  const history = useHistory({
    nodes: initialFlow.nodes as Node[],
    edges: initialFlow.edges as Edge[],
    meta: initialTemplate.meta,
    template: initialTemplate,
  });
  // `history` is a fresh object each render (canUndo/canRedo change), so it must
  // never appear in an effect's dependency array — the effect would re-run every
  // render, and any reset() inside it would re-render again, forever. The
  // individual callbacks are stable, so depend on those instead.
  const {
    commit: commitHistory,
    reset: resetHistory,
    undo: undoHistory,
    redo: redoHistory,
    endRun: endHistoryRun,
  } = history;

  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  /** The same selection, readable from callbacks that run outside render. */
  const selectionRef = useRef<{ nodes: string[]; edges: string[] }>({ nodes: [], edges: [] });

  /**
   * What a bulk edit applies to, with the derived view elements taken out —
   * a ghost belongs to another level and a boundary frame is not an element.
   */
  const selectedDocNodeIds = selectedNodeIds.filter(
    (id) => !isZoneNodeId(id) && !isGhostNodeId(id) && !isBoundaryNodeId(id),
  );
  const selectedZoneIds = selectedNodeIds.filter(isZoneNodeId).map(fromZoneNodeId);
  const multiSelected =
    selectedDocNodeIds.length + selectedZoneIds.length + selectedEdgeIds.length > 1;
  /**
   * Which toolbar dropdown is open. One slot for all of them, so opening a
   * menu closes whichever other menu was open — no two-menus-at-once states.
   */
  const [openMenu, setOpenMenu] = useState<
    "files" | "insert" | "arrange" | "view" | "checks" | "export" | null
  >(null);
  const [panelOpen, setPanelOpen] = useState(false);
  /** The `?` shortcuts sheet. */
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [toast, setToast] = useState<{ message: string; color?: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [createInput, setCreateInput] = useState("");
  const [refineInput, setRefineInput] = useState("");
  const [zoom, setZoom] = useState(1);
  const [showHidden, setShowHidden] = useState(defaultShowHidden);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [showTeams, setShowTeams] = useState(true);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  /** The match the canvas is centred on. -1 = a query typed but not yet jumped to. */
  const [searchIndex, setSearchIndex] = useState(-1);
  /** Set by "Set version tag…" so the chip it just created opens for typing. */
  const [editVersionTag, setEditVersionTag] = useState(false);
  /**
   * The right-click menu: where it is, and what it was opened on.
   *
   * Duplicate, lock, nest, align and delete lived only in toolbar menus, the
   * bottom bar and the shortcut sheet — so the gesture every canvas editor
   * answers with "here is what you can do to this" answered with the
   * browser's own menu instead.
   */
  /** The alignment snap the guide is promising, applied when the drag ends. */
  const pendingSnap = useRef<{ id: string; moving: ReadonlySet<string> } | null>(null);

  /** The alignment guide showing while a node is being dragged. */
  const [dragGuides, setDragGuides] = useState<
    { axis: "x" | "y"; at: number; from: number; to: number } | null
  >(null);
  /** The container the dragged node would land in, highlighted while it moves. */
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  /** Narrow picture exports to the selection. See `runDirectExport`. */
  const [exportSelectionOnly, setExportSelectionOnly] = useState(false);
  const [contextMenu, setContextMenu] = useState<
    { x: number; y: number; kind: "node" | "edge" | "zone" | "pane" } | null
  >(null);
  /**
   * The element whose name is open for editing on the canvas.
   *
   * F2 (and Enter on a single selection) opens it. Double-click is spoken for
   * — it drills into a node's next level, including the empty one you start a
   * decomposition from — so renaming needed a gesture that collides with
   * nothing, and F2 is what every file manager and IDE already uses.
   */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  /**
   * Which timeline stop is being shown, or null when the scrubber is off.
   * Pure view state: it never reaches the document, and the scrubbed canvas is
   * a separate read-only React Flow instance, so nothing here can edit.
   */
  const [timelineCursor, setTimelineCursor] = useState<DiagramDate | null>(null);
  const [timelineFuture, setTimelineFuture] = useState<TimelineFutureMode>("dim");
  /** A PNG/SVG/PDF export waiting on the states modal. Null = no modal open. */
  const [pendingExport, setPendingExport] = useState<StateExportFormat | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const compareInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  /** The inspector's Link field, so ⌘⇧K can put the cursor in it. */
  const linkInputRef = useRef<HTMLInputElement>(null);
  /** The component's outermost element — how it tells its own keys from the host's. */
  const rootRef = useRef<HTMLDivElement>(null);
  /** Identity for the keyboard claim. See `activeStudio`. */
  const studioId = useMemo(() => Symbol("studio"), []);
  // The first editor on the page claims the keyboard, so a lone one works
  // before it has been touched.
  useEffect(() => {
    if (activeStudio === null) activeStudio = studioId;
    return () => {
      if (activeStudio === studioId) activeStudio = null;
    };
  }, [studioId]);
  const abortRef = useRef<AbortController | null>(null);
  /** JSON of the last template this component emitted, so echoes don't re-sync. */
  // Seeded with the initial document so a controlled mount doesn't re-sync
  // from its own `value` prop before the user has touched anything.
  const lastEmitted = useRef<string | null>(JSON.stringify(initialTemplate));
  const meta = useRef<DiagramTemplate["meta"]>(initialTemplate.meta);
  /** Which provider each zone is on; a change here means the canvas must rebuild. */
  const zoneSignatureRef = useRef<string>(viewSignatureOf(initialTemplate, defaultShowHidden));
  /**
   * Whether the React Flow state currently includes provider-hidden nodes.
   *
   * NOT the same as `showHidden`. The toggle flips a render before the canvas
   * is rebuilt, so between those two moments React Flow still holds the old
   * set. Deriving with the *intent* rather than the *fact* would skip the
   * hidden-node carry-through while those nodes were still missing — and
   * delete them a frame before they were due to appear.
   */
  const rfIncludesHiddenRef = useRef(defaultShowHidden);

  /**
   * The drill-in stack: [] = the root level (C1), each entry one level
   * deeper. Pure view state, like the timeline cursor — drilling never enters
   * undo and never reaches the host. The INTENT ref feeds event handlers; the
   * FACT ref (`rfFocusRef`) records which focus the React Flow state was
   * actually materialized under, following the `rfIncludesHiddenRef` doctrine:
   * between a drill and the rebuild, deriving with the intent would judge the
   * previous canvas against the wrong view and corrupt the document.
   */
  const [focusStack, setFocusStack] = useState<string[]>([]);
  const focusId = focusStack.at(-1) ?? null;
  const focusStackRef = useRef<string[]>([]);
  const rfFocusRef = useRef<string | null>(null);

  /**
   * `color` tints the toast like its subject — e.g. the zone a node moved into.
   *
   * The timer is tracked by identity rather than by message text: an earlier
   * version cleared "whatever is showing if it still reads the same", so a
   * second "Moved into Payments" two seconds after the first was dismissed
   * almost instantly by the FIRST one's timer. Repeating an action is exactly
   * when the confirmation matters most.
   */
  const toastTimer = useRef<number | null>(null);
  const showToast = useCallback((message: string, color?: string) => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast({ message, color });
    toastTimer.current = window.setTimeout(() => {
      toastTimer.current = null;
      setToast(null);
    }, 2200);
  }, []);
  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  // ── Derived template ──────────────────────────────────────────────────────

  /**
   * The document the current React Flow state was MATERIALIZED from — the
   * frame every derivation is judged against. It advances only at
   * materialization points: mount, a document import, the controlled sync,
   * the zone-rebuild effect, and undo/redo.
   *
   * It must NEVER advance during render. An earlier version updated it inside
   * the `template` useMemo, and StrictMode's double render made the second
   * pass judge the (not yet rebuilt) canvas against the already-advanced
   * frame: a node hidden under the old provider but visible under the new one
   * read as "absent but should be visible" — i.e. user-deleted — and was
   * destroyed. That is why provider toggles ate nodes in the example app
   * while passing every non-StrictMode test.
   */
  const baseRef = useRef<DiagramTemplate>(initialTemplate);

  /**
   * The latest derived document, for event handlers (copy, tidy, export…).
   * Synced from the pure memo in an effect — after render, so StrictMode's
   * double render writes the same settled value twice, harmlessly.
   */
  const templateRef = useRef<DiagramTemplate>(initialTemplate);

  /**
   * The scrub cursor, for the insert handlers.
   *
   * They are declared above the timeline block and only ever fire from user
   * events, so a ref keeps them out of the dependency chain — reading the
   * state directly would rebuild every insert callback on every day of a drag.
   */
  const timelineAtRef = useRef<DiagramDate | null>(null);

  const deriveTemplate = useCallback(
    (n: Node[], e: Edge[]): DiagramTemplate => {
      // A focused canvas is a scoped view: lift it back into the FULL
      // document (derived elements dropped, everything off-level carried from
      // the base). Branches on the FACT ref — what the RF state actually is.
      const focus = rfFocusRef.current;
      const lifted = focus
        ? liftScopedReactFlow(n, e, focus, {
            ...registryOpts(registry),
            meta: meta.current,
            base: baseRef.current,
          })
        : fromReactFlow(n, e, {
            ...registryOpts(registry),
            meta: meta.current,
            base: baseRef.current,
            allNodesPresent: rfIncludesHiddenRef.current,
          });
      // Geometry is truth in the editor: the user just dragged something, so a
      // node's zone is whichever zone it now sits in. This is what makes
      // dragging a *zone* over some nodes actually enrol them. (Drill-hidden
      // nodes keep their declared membership — their coords aren't root-space.)
      return assignZonesByGeometry(lifted, { containerKinds: registry.containerKinds });
    },
    [registry],
  );

  // Pure — same inputs, same output, no writes. Safe to double-invoke.
  const template = useMemo(() => deriveTemplate(nodes, edges), [deriveTemplate, nodes, edges]);

  useEffect(() => {
    templateRef.current = template;
  }, [template]);

  const visibility = useMemo(() => visibleElements(template), [template]);
  const hiddenCount = template.nodes.length - visibility.nodes.size;

  // ── Commit: snapshot for undo, then notify the host ───────────────────────

  const commit = useCallback(
    (n: Node[], e: Edge[], derived?: DiagramTemplate, coalesce?: string) => {
      const next = derived ?? deriveTemplate(n, e);
      // The snapshot carries the full document so undo can re-materialize it
      // instead of re-deriving against whatever frame is current by then —
      // undoing across a provider toggle must not re-judge (and lose) nodes.
      // `coalesce` folds a run of keystrokes in one field into one entry; see
      // CommitOptions in history.ts.
      commitHistory({ nodes: n, edges: e, meta: meta.current, template: next }, { coalesce });
      if (!onChange) return;
      const json = JSON.stringify(next);
      if (json === lastEmitted.current) return;
      lastEmitted.current = json;
      onChange(next);
    },
    [commitHistory, onChange, deriveTemplate],
  );

  /**
   * Commit whatever is in state right now — for changes applied via setNodes.
   *
   * `coalesce` names the field being edited, so a run of typing in one
   * inspector input undoes as the one edit it was rather than a character at
   * a time. Omit it for anything a person would call a single action.
   */
  const commitLater = useCallback(
    (coalesce?: string) => {
      // Read the freshest state from the store rather than the render closure.
      queueMicrotask(() => commit(flow.getNodes(), flow.getEdges(), undefined, coalesce));
    },
    [commit, flow],
  );

  // ── Materialization: the ONE way a document becomes a canvas ──────────────

  /**
   * Re-materialize the canvas from a document, advancing every ref that marks
   * a materialization point together — the controlled sync, the rebuild
   * effect, applyTemplate, undo, and any future document-level transform all
   * share this, because a canvas rebuilt against half-advanced refs re-judges
   * (and loses) hidden nodes. Focus-aware: while drilled in, the canvas shows
   * `scopedView(doc, focus)` and the FACT ref records that; a focus whose
   * node vanished (undo, AI edit, controlled swap) prunes automatically.
   */
  const materializeTemplate = useCallback(
    (doc: DiagramTemplate) => {
      const stack = pruneFocusStack(doc, focusStackRef.current);
      const top = stack.at(-1) ?? null;
      if (stack.length !== focusStackRef.current.length) {
        focusStackRef.current = stack;
        setFocusStack(stack);
      }
      meta.current = doc.meta;
      baseRef.current = doc; // materialization point
      templateRef.current = doc;
      zoneSignatureRef.current = viewSignatureOf(doc, showHidden, top);
      rfIncludesHiddenRef.current = showHidden;
      rfFocusRef.current = top;
      const viewDoc = top
        ? scopedView(doc, top, { containerKinds: registry.containerKinds })
        : doc;
      const rf = toReactFlow(viewDoc, registryKinds(registry, showHidden));
      const rfNodes = top ? decorateScopedNodes(rf.nodes as Node[]) : (rf.nodes as Node[]);

      // Carry the selection across the rebuild for everything that still
      // exists. `toReactFlow` produces a fresh, unselected canvas, so without
      // this every undo closes the inspector — and "edit a label, press ⌘Z"
      // becomes "edit a label, press ⌘Z, find the node again".
      const keepNodes = new Set(selectionRef.current.nodes);
      const keepEdges = new Set(selectionRef.current.edges);
      const selected = keepNodes.size || keepEdges.size;
      const outNodes = selected
        ? rfNodes.map((n) => (keepNodes.has(n.id) ? { ...n, selected: true } : n))
        : rfNodes;
      const outEdges = selected
        ? (rf.edges as Edge[]).map((e) => (keepEdges.has(e.id) ? { ...e, selected: true } : e))
        : (rf.edges as Edge[]);

      setNodes(outNodes);
      setEdges(outEdges);
      return { nodes: outNodes, edges: outEdges };
    },
    [registry, showHidden, setNodes, setEdges],
  );

  // ── Controlled mode: adopt external value changes ─────────────────────────

  useEffect(() => {
    if (!value) return;
    // Compare the VALIDATED form on both sides. Comparing the raw prop against
    // the validated JSON never matches — validation fills in defaults such as
    // `fontSize`, so the guard would fail and this effect would re-sync on
    // every render. layoutIfUnpositioned is a no-op on anything this editor
    // ever emitted (always placed), so the echo guard is unaffected; it only
    // fires when the host swaps in a CONTENT doc, which lays itself out.
    const validated = layoutIfUnpositioned(validateTemplate(value, registryOpts(registry)));
    const json = JSON.stringify(validated);
    if (json === lastEmitted.current) return; // the echo of our own onChange

    lastEmitted.current = json;
    const next = materializeTemplate(validated);
    resetHistory({
      nodes: next.nodes,
      edges: next.edges,
      meta: meta.current,
      template: validated,
    });
  }, [value, registry, materializeTemplate, resetHistory]);

  /**
   * Re-render the canvas when a zone's provider changes.
   *
   * Toggling a provider only mutates that zone node's `data`, which React Flow
   * happily re-renders — but the *set* of nodes on the canvas has to change
   * too, because a provider switch reveals and hides nodes. Rebuilding from
   * the full template is what actually makes the toggle do anything.
   */
  useEffect(() => {
    // Judged against the document this canvas was MATERIALIZED from, not the
    // render closure. On a host that swaps `value` and `activeFileId` in one
    // render without remounting, the closure still holds the previous file's
    // document — and with an inline `onChange` or `registry` this effect's
    // deps change every render, so it would run, rebuild from the OLD file
    // and commit it into the new one.
    const live = templateRef.current;
    if (live !== template) return;
    const signature = viewSignatureOf(template, showHidden, focusId);
    if (signature === zoneSignatureRef.current) return;
    // The document part alone decides whether this rebuild is an EDIT
    // (provider switch, collapse — belongs in undo, host must hear) or a pure
    // VIEW change (ghost toggle, drill in/out — committing it would put a
    // do-nothing entry in the undo stack and burn a ⌘Z press on it).
    const docChanged =
      signature.split("|hidden:")[0] !== zoneSignatureRef.current.split("|hidden:")[0];
    const next = materializeTemplate(template);
    if (docChanged) commit(next.nodes, next.edges, template);
  }, [template, focusId, materializeTemplate, showHidden, commit]);

  // ── Replace the whole document ────────────────────────────────────────────

  const applyTemplate = useCallback(
    (
      incoming: DiagramTemplate,
      { fit = true, coalesce }: { fit?: boolean; coalesce?: string } = {},
    ) => {
      // The declaration is truth on import: a generated document usually gets
      // membership right and coordinates approximately right, so move the node
      // to match its declared zone rather than dropping the membership.
      const validated = snapNodesIntoZones(validateTemplate(incoming, registryOpts(registry)), {
        containerKinds: registry.containerKinds,
      });
      const next = materializeTemplate(validated);
      commitHistory(
        { nodes: next.nodes, edges: next.edges, meta: meta.current, template: validated },
        { coalesce },
      );
      if (onChange) {
        const json = JSON.stringify(validated);
        lastEmitted.current = json;
        onChange(validated);
      }
      if (fit) window.setTimeout(() => flow.fitView({ padding: 0.15, duration: 300 }), 50);
    },
    [registry, materializeTemplate, commitHistory, onChange, flow],
  );

  // ── Node / edge mutations ─────────────────────────────────────────────────

  const addNode = useCallback(
    (kind: string) => {
      if (readOnly) return;
      const def = kindDef(registry, kind);
      const type = def.container ? "group" : def.annotation ? "annotation" : "shape";
      // A record node starts with its key row, so the box arrives as a table
      // rather than as an empty card the user has to discover the rows on.
      const fields = def.record
        ? [{ id: "id", name: "id", type: "uuid", key: "pk" as const, required: true }]
        : undefined;
      const size = def.container
        ? { w: 320, h: 240 }
        : def.annotation
          ? { w: 280, h: 56 }
          : def.record
            ? { w: 230, h: fieldsBoxHeight(fields!.length) }
            : // The kind's own default (a decision diamond is squarer than a
              // card), falling back to the ordinary box.
              KIND_DEFAULT_SIZE[kind] ?? { w: 170, h: 76 };

      // Drop the new node at the centre of the *canvas element*, not the
      // window — this component is often embedded in a panel, so the viewport
      // centre is usually somewhere else entirely.
      const rect = canvasRef.current?.getBoundingClientRect();
      const center = rect
        ? flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
        : { x: 0, y: 0 };
      const position = { x: center.x - size.w / 2, y: center.y - size.h / 2 };

      const node: Node = {
        id: nextId(kind),
        type,
        position,
        width: size.w,
        height: size.h,
        style: { width: size.w, height: size.h },
        zIndex: def.container ? 0 : LEAF_Z_INDEX,
        selected: true,
        data: {
          label: def.annotation ? "Double-click to edit this note." : `New ${def.label}`,
          kind,
          icon: def.icon,
          description: "",
          ...(fields ? { fields } : {}),
          fontSize: 13,
          // Inserted while scrubbing: the new box belongs to the moment being
          // looked at, or it would appear to have existed all along — and in
          // "Hide later" it would vanish the instant it was created.
          ...(timelineAtRef.current ? { date: timelineAtRef.current } : {}),
        } satisfies DiagramNodeData,
      };

      setNodes((current) => [...current.map((n) => ({ ...n, selected: false })), node]);
      commitLater();
    },
    [readOnly, registry, flow, setNodes, commitLater],
  );

  /**
   * An in-memory fallback for the system clipboard, which needs a permission
   * the user may not have granted (and which jsdom does not implement at all).
   */
  const localClipboard = useRef<DiagramTemplate | null>(null);

  /**
   * How far the next paste lands from what it was copied from.
   *
   * The contract's 28px default is smaller than any node, so a copy covered
   * ~84% of its original and — because a single-node fragment carries no lines
   * by design, and the pasted node is selected, which lifts it a z-band — read
   * as "pasting deleted my node's edges". They were drawn underneath. Clear
   * the original, and cascade so a run of ⌘V fans out instead of stacking.
   */
  const pasteStep = useRef(0);
  /** What the cascade is counting pastes OF, so a new fragment restarts it. */
  const lastPasted = useRef<string | null>(null);

  const copySelection = useCallback(async () => {
    const ids = selectedNodeIds.filter((id) => !isZoneNodeId(id));
    // A selected zone copies as a SUBJECT: the zone plus its member nodes.
    const zoneIds = selectedNodeIds.filter(isZoneNodeId).map(fromZoneNodeId);
    if (!ids.length && !zoneIds.length) return;
    const fragment = copyFragment(templateRef.current, ids, { zones: zoneIds });
    localClipboard.current = fragment;
    pasteStep.current = 0; // a fresh copy restarts the cascade
    try {
      await navigator.clipboard?.writeText(JSON.stringify(fragment, null, 2));
    } catch {
      // No clipboard permission — the in-memory copy still works in-app.
    }
    const parts = [
      fragment.nodes.length ? `${fragment.nodes.length} node${fragment.nodes.length === 1 ? "" : "s"}` : "",
      zoneIds.length ? `${zoneIds.length} zone${zoneIds.length === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    showToast(`Copied ${parts.join(" + ")}`);
    return fragment;
  }, [selectedNodeIds, showToast]);

  const pasteClipboard = useCallback(
    async (fragment?: DiagramTemplate | null) => {
      if (readOnly) return;
      let source = fragment ?? null;
      if (!source) {
        // Prefer the system clipboard so a fragment copied in another tab
        // pastes here; fall back to the in-memory copy ONLY when the system
        // clipboard could not be read at all.
        //
        // The distinction matters: clipboard text that simply isn't a fragment
        // means the user copied something else since, and re-pasting the last
        // in-app copy then looks like the editor inventing a node out of
        // nowhere. "Nothing to paste" is the honest answer.
        let reachable = false;
        let text: string | undefined;
        try {
          // A missing API is "unreachable", not "empty": jsdom and insecure
          // contexts have no clipboard at all, and there the in-memory copy is
          // the only clipboard the editor has.
          if (!navigator.clipboard?.readText) throw new Error("no clipboard");
          text = await navigator.clipboard.readText();
          reachable = true;
        } catch {
          // Permission denied or unsupported — the in-memory copy is all we have.
        }
        if (text) {
          // With the registry, or an extension kind pasted from another tab
          // is coerced back to a plain "service".
          source = parseFragment(text, registryOpts(registry));
          if (!source) {
            // Text on the clipboard, but not ours. A run of pastes from
            // elsewhere must not keep cascading either.
            pasteStep.current = 0;
            showToast("Nothing on the clipboard to paste here");
            return;
          }
        } else if (!reachable) {
          source = localClipboard.current;
        }
      }
      if (!source?.nodes.length && !source?.zones?.length) return;

      // The cascade is about repeat pastes of the SAME thing. A different
      // fragment — copied in another tab, or a second copy here — starts over,
      // or a long session of pasting walks the offset off the canvas.
      const signature = JSON.stringify(source);
      if (signature !== lastPasted.current) {
        pasteStep.current = 0;
        lastPasted.current = signature;
      }

      const { template: next, newNodeIds, newZoneIds } = pasteFragment(templateRef.current, source, {
        ...registryOpts(registry),
        offset: PASTE_OFFSET * ++pasteStep.current,
      });
      // Pasting while drilled in pastes INTO the level: fragment roots become
      // children of the focus (their nested structure comes along untouched).
      const focus = rfFocusRef.current;
      const rooted =
        focus && newNodeIds.length
          ? {
              ...next,
              nodes: next.nodes.map((n) =>
                newNodeIds.includes(n.id) && !n.parentId ? { ...n, parentId: focus } : n,
              ),
            }
          : next;
      applyTemplate(rooted, { fit: false });
      // Select the pasted copy, so it can be dragged away immediately.
      window.setTimeout(() => {
        setNodes((current) =>
          current.map((n) => ({ ...n, selected: newNodeIds.includes(n.id) })),
        );
      }, 0);
      const parts = [
        newNodeIds.length ? `${newNodeIds.length} node${newNodeIds.length === 1 ? "" : "s"}` : "",
        newZoneIds.length ? `${newZoneIds.length} zone${newZoneIds.length === 1 ? "" : "s"}` : "",
      ].filter(Boolean);
      showToast(`Pasted ${parts.join(" + ")}`);
    },
    [readOnly, registry, applyTemplate, setNodes, showToast],
  );

  const duplicateSelection = useCallback(() => {
    if (readOnly) return;
    const ids = selectedNodeIds.filter((id) => !isZoneNodeId(id));
    const zoneIds = selectedNodeIds.filter(isZoneNodeId).map(fromZoneNodeId);
    if (!ids.length && !zoneIds.length) return;
    // Duplicate happens in the same document, so it carries direct
    // connections too: internal edges clone between the copies, boundary
    // edges re-attach their cloned end to the clone and keep the original
    // neighbour. Copy/paste deliberately stays internal-edges-only — a
    // fragment can't assume the neighbours exist wherever it lands. A
    // selected zone duplicates as a subject: the region, its members, and
    // their connections.
    const { template: next, newNodeIds } = duplicateWithConnections(templateRef.current, ids, {
      ...registryOpts(registry),
      offset: PASTE_OFFSET,
      zones: zoneIds,
    });
    applyTemplate(next, { fit: false });
    // Select the copies, so they can be dragged away immediately.
    window.setTimeout(() => {
      setNodes((current) => current.map((n) => ({ ...n, selected: newNodeIds.includes(n.id) })));
    }, 0);
    const what = zoneIds.length
      ? `${zoneIds.length} zone${zoneIds.length === 1 ? "" : "s"} + ${newNodeIds.length} node${newNodeIds.length === 1 ? "" : "s"}`
      : `${newNodeIds.length} node${newNodeIds.length === 1 ? "" : "s"}`;
    showToast(`Duplicated ${what} with connections`);
  }, [readOnly, selectedNodeIds, registry, applyTemplate, setNodes, showToast]);

  // ── Search ────────────────────────────────────────────────────────────────

  /**
   * DOCUMENT nodes that match the query — not just the canvas's. While
   * drilled in, most of the architecture lives on other levels; a search that
   * couldn't see them would read as data loss.
   */
  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return template.nodes.filter(
      (n) =>
        n.id.toLowerCase().includes(q) ||
        n.label?.toLowerCase().includes(q) ||
        n.description?.toLowerCase().includes(q) ||
        String(n.kind).toLowerCase().includes(q) ||
        n.tags?.some((t) => t.toLowerCase().includes(q)),
    );
  }, [template, searchQuery]);

  /** Declared later (needs the drill machinery); the search jumps through it. */
  const navigateToNodeRef = useRef<(id: string) => void>(() => {});

  /** Select + centre one match. Enter cycles through them. */
  const jumpToMatch = useCallback(
    (index: number) => {
      const match = searchMatches[((index % searchMatches.length) + searchMatches.length) % searchMatches.length];
      if (!match) return;
      const internal = flow.getInternalNode(match.id);
      if (!internal) {
        // The match lives on another level (or is hidden) — drill to it.
        navigateToNodeRef.current(match.id);
        return;
      }
      const abs = internal.internals.positionAbsolute;
      const w = (internal.measured?.width as number) ?? match.w;
      const h = (internal.measured?.height as number) ?? match.h;
      setNodes((current) => current.map((n) => ({ ...n, selected: n.id === match.id })));
      void flow.setCenter(abs.x + w / 2, abs.y + h / 2, {
        zoom: Math.max(flow.getViewport().zoom, 0.9),
        duration: 300,
      });
    },
    [searchMatches, flow, setNodes],
  );

  // ── Align / distribute ────────────────────────────────────────────────────

  const selectedDiagramIds = useMemo(
    () => selectedNodeIds.filter((id) => !isZoneNodeId(id)),
    [selectedNodeIds],
  );

  /**
   * All maths in ABSOLUTE space (children store parent-relative positions), so
   * a mixed selection across groups aligns visually; the delta is applied to
   * each node's stored position, which keeps it in its own frame.
   */
  const transformSelection = useCallback(
    (compute: (boxes: Array<{ id: string; x: number; y: number; w: number; h: number }>) => Map<string, { x: number; y: number }>) => {
      const boxes = selectedDiagramIds
        .map((id) => {
          const internal = flow.getInternalNode(id);
          if (!internal) return null;
          return {
            id,
            x: internal.internals.positionAbsolute.x,
            y: internal.internals.positionAbsolute.y,
            w: (internal.measured?.width as number) ?? 170,
            h: (internal.measured?.height as number) ?? 76,
          };
        })
        .filter((b): b is NonNullable<typeof b> => b !== null);
      if (boxes.length < 2) return;

      const targets = compute(boxes);
      if (!targets.size) return;
      setNodes((current) =>
        current.map((n) => {
          const target = targets.get(n.id);
          if (!target) return n;
          const box = boxes.find((b) => b.id === n.id)!;
          // Absolute delta applied to the stored (possibly parent-relative) position.
          return {
            ...n,
            position: { x: n.position.x + (target.x - box.x), y: n.position.y + (target.y - box.y) },
          };
        }),
      );
      setOpenMenu(null);
      commitLater();
    },
    [selectedDiagramIds, flow, setNodes, commitLater],
  );

  const alignSelection = useCallback(
    (mode: "left" | "centerX" | "right" | "top" | "centerY" | "bottom") => {
      transformSelection((boxes) => {
        const minX = Math.min(...boxes.map((b) => b.x));
        const maxR = Math.max(...boxes.map((b) => b.x + b.w));
        const minY = Math.min(...boxes.map((b) => b.y));
        const maxB = Math.max(...boxes.map((b) => b.y + b.h));
        const midX = (minX + maxR) / 2;
        const midY = (minY + maxB) / 2;
        return new Map(
          boxes.map((b) => [
            b.id,
            {
              x:
                mode === "left" ? minX
                : mode === "centerX" ? midX - b.w / 2
                : mode === "right" ? maxR - b.w
                : b.x,
              y:
                mode === "top" ? minY
                : mode === "centerY" ? midY - b.h / 2
                : mode === "bottom" ? maxB - b.h
                : b.y,
            },
          ]),
        );
      });
    },
    [transformSelection],
  );

  const distributeSelection = useCallback(
    (axis: "x" | "y") => {
      transformSelection((boxes) => {
        if (boxes.length < 3) return new Map();
        const sorted = [...boxes].sort((a, b) => (axis === "x" ? a.x - b.x : a.y - b.y));
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        const span =
          axis === "x" ? last.x + last.w - first.x : last.y + last.h - first.y;
        const content = sorted.reduce((sum, b) => sum + (axis === "x" ? b.w : b.h), 0);
        const gap = (span - content) / (sorted.length - 1);
        const targets = new Map<string, { x: number; y: number }>();
        let cursor = axis === "x" ? first.x : first.y;
        for (const b of sorted) {
          targets.set(b.id, axis === "x" ? { x: cursor, y: b.y } : { x: b.x, y: cursor });
          cursor += (axis === "x" ? b.w : b.h) + gap;
        }
        return targets;
      });
    },
    [transformSelection],
  );

  // ── Tag filter + routing toggle ───────────────────────────────────────────

  /** Every tag any node carries, for the filter dropdown. */
  const allTags = useMemo(() => {
    const out: string[] = [];
    for (const n of template.nodes) for (const t of n.tags ?? []) if (!out.includes(t)) out.push(t);
    return out.sort();
  }, [template]);

  const anyTeams = useMemo(() => template.nodes.some((n) => n.team), [template]);

  // Architecture lint — pure over the document, so it re-runs per committed
  // edit and can never touch what persists.
  const findings = useMemo(
    () => lintTemplate(template, registry.lintRules),
    [template, registry],
  );

  const jumpToFinding = useCallback(
    (finding: LintFinding) => {
      const nodeIds = new Set(finding.nodeIds ?? []);
      const edgeIds = new Set(finding.edgeIds ?? []);
      setNodes((current) => current.map((n) => ({ ...n, selected: nodeIds.has(n.id) })));
      setEdges((current) => current.map((e) => ({ ...e, selected: edgeIds.has(e.id) })));
      const first = finding.nodeIds?.find((id) => flow.getInternalNode(id));
      if (first) {
        const internal = flow.getInternalNode(first)!;
        const abs = internal.internals.positionAbsolute;
        const w = (internal.measured?.width as number) ?? 170;
        const h = (internal.measured?.height as number) ?? 76;
        void flow.setCenter(abs.x + w / 2, abs.y + h / 2, {
          zoom: Math.max(flow.getViewport().zoom, 0.9),
          duration: 300,
        });
      }
    },
    [flow, setNodes, setEdges],
  );

  // ── Compare mode ──────────────────────────────────────────────────────────
  // The baseline can come controlled (the diffBase prop) or from the toolbar
  // file picker. While active, DiffCanvas replaces the editor's <ReactFlow>
  // JSX only — every editor hook and ref keeps running, so entering and
  // leaving compare mode cannot touch the document.
  const [compareTemplate, setCompareTemplate] = useState<DiagramTemplate | null>(null);
  const activeDiffBase = diffBase ?? compareTemplate;
  const diff = useMemo(
    () => (activeDiffBase ? diffTemplates(activeDiffBase, template) : null),
    [activeDiffBase, template],
  );

  const loadCompareFile = useCallback(
    async (file: File) => {
      try {
        const raw = JSON.parse(await file.text());
        // A content doc as the baseline lays itself out — its removed nodes
        // render in the diff overlay, and the origin pile-up is not a layout.
        setCompareTemplate(layoutIfUnpositioned(validateTemplate(raw, registryOpts(registry))));
        // Compare takes over the canvas; leaving the scrubber "on" underneath
        // would make the toolbar claim a mode the canvas is not in.
        setTimelineCursor(null);
        showToast(`Comparing against ${file.name}`);
      } catch (err) {
        setError(`Could not load ${file.name}: ${(err as Error).message}`);
        setPanelOpen(true);
      }
    },
    [registry, showToast],
  );

  // ── Timeline mode ─────────────────────────────────────────────────────────
  // The stops ARE the document's own dates, so the scrubber offers itself the
  // moment something is dated and withdraws when the last date is removed —
  // there is no separate timeline to keep in sync with the diagram.
  const timeline = useMemo(() => templateTimeline(template), [template]);
  // Compare and timeline are both views of the same canvas, and a host can
  // turn compare on via the `diffBase` prop at any moment. Deciding the
  // precedence once, here, is what keeps the toolbar, the bar, and the canvas
  // from ever disagreeing about which mode is on.
  const timelineActive = timelineCursor !== null && timeline.stops.length > 0 && !activeDiffBase;
  const timelineAt = timelineActive ? timelineCursor : null;

  /**
   * What is dated after the cursor. Asked in "dim" mode deliberately: the sets
   * are the same either way, and that mode returns the document as-is instead
   * of allocating a filtered copy on every day of a drag.
   */
  const timelineViewState: TimelineView | null = useMemo(
    () => (timelineAt ? timelineView(template, timelineAt, "dim") : null),
    [template, timelineAt],
  );
  const timelineFutureIds = timelineViewState?.future ?? null;
  // The view already counted — re-summing the sets here was a second copy of
  // the same formula that had to stay in agreement by luck.
  const timelineFutureCount = timelineViewState?.futureCount ?? 0;

  const enterTimeline = useCallback(() => {
    // Open on today, held inside the plan's own span — "what changes from
    // here" is the question, not "what did we start with".
    setTimelineCursor(openingCursor(timeline));
    setCompareTemplate(null);
    setOpenMenu(null);
  }, [timeline]);

  /** Jump to the next real dated point in a direction. */
  const stepTimelineStop = useCallback(
    (direction: 1 | -1) => {
      setTimelineCursor((current) => {
        if (current === null) return current;
        const next =
          direction === 1
            ? timeline.stops.find((s) => s > current)
            : [...timeline.stops].reverse().find((s) => s < current);
        return next ?? current;
      });
    },
    [timeline.stops],
  );

  /**
   * The timeline applied as a DISPLAY pass, over the canvas the editor is
   * already holding.
   *
   * Deliberately NOT a re-materialization. The editor derives its document
   * from its canvas, so a canvas rebuilt without the later elements would read
   * as "the user deleted them" — the exact failure the provider machinery
   * exists to prevent. Flagging a complete node array instead means `nodes`
   * stays whole, `fromReactFlow` is untouched, dragging and inserting behave
   * normally while scrubbing, and moving the cursor a day costs one map
   * instead of a full rebuild.
   */
  const { nodes: viewNodes, edges: viewEdges } = useMemo(() => {
    const view = applyTimelineView(nodes, edges, timelineFutureIds, timelineFuture);
    // Manual z-index mode (see the <ReactFlow> props) drops React Flow's
    // built-in elevate-on-select, so restore it here as a display pass: a
    // selected node floats above whatever it is dragged across. Containers
    // stay put — lifting one would put its translucent body over the edges
    // pinned below the leaf band, washing out its own children's wiring.
    // The lift clears every stacking band at once: one band's worth would
    // merely tie a selected node with whatever is nested on top of it.
    return {
      ...view,
      nodes: view.nodes.map((n) => {
        // The frame a dragged node is about to land in says so while the
        // drag is happening, rather than in a toast after the drop.
        const lifted =
          n.selected && n.type !== "group" && n.type !== "zone"
            ? { ...n, zIndex: (n.zIndex ?? 0) + SELECT_ELEVATION }
            : n;
        return n.id === dropTargetId
          ? { ...lifted, className: `${lifted.className ?? ""} as-node--droptarget`.trim() }
          : lifted;
      }),
      // A SELECTED edge is lifted above every node, and it has to be: its
      // endpoint handles sit exactly where the node's own (invisible, but
      // still clickable) connect handles are, and the node paints above the
      // edge layer. Pressing the handle started a new connection instead of
      // moving the endpoint — so the documented "drag an endpoint to pin
      // where the line attaches" gesture was unreachable on every fresh edge.
      // Unselected edges stay under the cards, which is the design.
      edges: view.edges.map((e) =>
        e.selected ? { ...e, zIndex: (e.zIndex ?? 0) + SELECTED_EDGE_ELEVATION } : e,
      ),
    };
  }, [nodes, edges, timelineFutureIds, timelineFuture, dropTargetId]);

  useEffect(() => {
    timelineAtRef.current = timelineAt;
  }, [timelineAt]);

  // Editing can remove the last dated element mid-scrub. The bar disappears
  // the moment the stops empty, so the cursor must go with it — a lingering
  // cursor would resurrect the scrubber, uninvited, the next time anything
  // acquires a date.
  useEffect(() => {
    if (timelineCursor !== null && !timeline.stops.length) setTimelineCursor(null);
  }, [timelineCursor, timeline.stops.length]);

  const versionTag = template.meta?.versionTag;
  const versionTagPosition: VersionTagPosition = template.meta?.versionTagPosition ?? "top-left";
  const patchVersionTag = useCallback(
    (patch: { versionTag?: string; versionTagPosition?: VersionTagPosition }) => {
      // Through applyTemplate (the setDefaultRouting pattern) so the change is
      // validated, committed, undoable, and emitted like any document edit.
      applyTemplate(
        { ...templateRef.current, meta: { ...templateRef.current.meta, ...patch } },
        { fit: false },
      );
    },
    [applyTemplate],
  );

  const routing: EdgeRouting = resolveRouting(template.meta?.routing);

  const setDefaultRouting = useCallback(
    (next: EdgeRouting) => {
      if (readOnly) return;
      // Through applyTemplate so every edge's resolved routing refreshes.
      applyTemplate(
        { ...templateRef.current, meta: { ...templateRef.current.meta, routing: next } },
        { fit: false },
      );
      showToast(
        next === "orthogonal"
          ? "Right-angle connectors"
          : next === "straight"
            ? "Straight connectors"
            : "Curved connectors",
      );
    },
    [readOnly, applyTemplate, showToast],
  );

  const tidy = useCallback(() => {
    if (readOnly) return;
    // Tidy arranges the level you are looking at — the focused component's
    // own canvas while drilled in, the root canvas otherwise. Either way the
    // levels you can't see are left exactly as you left them.
    const focus = rfFocusRef.current;
    applyTemplate(
      autoLayout(templateRef.current, {
        containerKinds: registry.containerKinds,
        ...(focus ? { frames: { drill: focus } } : {}),
      }),
      { fit: true },
    );
    showToast(focus ? "Tidied this level" : "Tidied");
  }, [readOnly, applyTemplate, showToast, registry]);

  const addZone = useCallback(() => {
    if (readOnly) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    const size = { w: 520, h: 360 };
    const center = rect
      ? flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      : { x: 0, y: 0 };

    // Offer every registered provider so the toggle is useful immediately.
    const providers = registry.providerOrder.length ? registry.providerOrder : ["onprem"];
    // Stack a new zone above existing ones, so drawing an island on top of a
    // region claims the nodes inside it rather than disappearing behind it.
    const topZ = Math.max(0, ...(templateRef.current.zones ?? []).map((z) => z.z ?? 0));

    const zone: DiagramZone = {
      id: nextId("zone"),
      label: "New Zone",
      shape: "rounded",
      x: center.x - size.w / 2,
      y: center.y - size.h / 2,
      w: size.w,
      h: size.h,
      providers: [...providers],
      provider: providers[0],
      opacity: DEFAULT_ZONE_OPACITY,
      z: topZ + 1,
      ...(timelineAtRef.current ? { date: timelineAtRef.current } : {}),
    };

    const node: Node = {
      id: toZoneNodeId(zone.id),
      type: "zone",
      position: { x: zone.x, y: zone.y },
      width: zone.w,
      height: zone.h,
      style: { width: zone.w, height: zone.h },
      zIndex: -1000 + (zone.z ?? 0),
      dragHandle: ".as-zone__header",
      selected: true,
      data: { zone } as unknown as Node["data"],
    };

    // Zones must precede real nodes in the array so they paint behind them.
    setNodes((current) => [node, ...current.map((n) => ({ ...n, selected: false }))]);
    commitLater();
  }, [readOnly, flow, registry.providerOrder, setNodes, commitLater]);

  const setScenario = useCallback(
    (provider: string) => {
      if (readOnly) return;
      applyTemplate(setAllZoneProviders(templateRef.current, provider), { fit: false });
      showToast(
        `Showing the ${providerDef(registry, provider).label} deployment`,
        providerDef(registry, provider).color,
      );
    },
    [readOnly, applyTemplate, registry, showToast],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (readOnly) return;
      // source === target is a SELF-LOOP — a retry arrow, drawn out one face
      // and back into an adjacent one. Legal since validation learned it.
      //
      // Appended directly rather than through React Flow's `addEdge`, which
      // refuses a connection whose (source, target, handles) tuple already
      // exists. Every body-drop passes null handles, so a SECOND line between
      // the same two boxes — "reads" and then "writes" — was silently dropped
      // with no edge and no explanation. Two connections between two systems
      // is an ordinary thing to draw, and the document has always allowed it.
      const edge: Edge = {
        ...connection,
        id: nextId("e"),
        type: "labeled",
        data: {
          label: "",
          labelT: 0.5,
          style: "solid",
          color: "slate",
          ...(timelineAtRef.current ? { date: timelineAtRef.current } : {}),
          // New edges inherit the diagram default (no own `routing`).
          routingResolved: resolveRouting(meta.current?.routing),
        } satisfies DiagramEdgeData,
        style: { stroke: EDGE_COLOR_HEX.slate, strokeWidth: 1.8 },
      };
      setEdges((current) => [...current, edge]);
      // A second line between the same pair lands exactly on the first, so it
      // reads as nothing happening — say what was drawn, and offset it so it
      // can be seen and grabbed.
      const twin = flow
        .getEdges()
        .some((e) => e.source === connection.source && e.target === connection.target);
      if (twin) showToast("Second connection added — drag it clear of the first");
      commitLater();
    },
    [readOnly, setEdges, commitLater, flow, showToast],
  );

  /**
   * A connection drag released with no handle under it. Two meanings:
   * over a node's BODY (handles are 8px dots — sloppy drops are the norm)
   * the user meant that node, so connect to it; over empty canvas they meant
   * a DANGLING arrow — an arrow to something that doesn't exist yet. A bare
   * "point" node is born under the pointer to hold the loose end, and the
   * edge attaches to it like any other, so the whole edge toolbox (bending,
   * labels, re-attachment, undo, exports) works on it unchanged.
   */
  /** Set by Escape mid-drag, read (and cleared) by `onConnectEnd`. */
  const connectCancelled = useRef(false);

  /**
   * Watch for Escape while a connection is being dragged.
   *
   * React Flow has no cancel API, so the drag runs to completion and the
   * decision is made at the end — which is the same place every other outcome
   * is decided, so nothing half-applies.
   */
  const onConnectStart = useCallback(() => {
    connectCancelled.current = false;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      connectCancelled.current = true;
    };
    window.addEventListener("keydown", onKey, true);
    const stop = () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }, []);

  const onConnectEnd = useCallback<OnConnectEnd>(
    (event, connectionState) => {
      const cancelled = connectCancelled.current;
      connectCancelled.current = false;
      if (readOnly) return;
      // Escape during the drag abandons it. Once the pointer has moved, EVERY
      // release used to produce something — a self-loop, a dangling dot, or an
      // edge — so a drag started by accident could only be taken back with
      // undo, after the fact.
      if (cancelled) return;
      // A drop that completed on a handle already went through onConnect.
      if (connectionState.isValid) return;
      const from = connectionState.fromNode;
      if (!from) return;
      if (isZoneNodeId(from.id) || isGhostNodeId(from.id) || isBoundaryNodeId(from.id)) return;
      // From the EVENT, not connectionState.to — `to` is container-relative
      // screen coordinates unless a handle resolved it, and this branch is
      // exactly the no-handle case.
      const touch = "changedTouches" in event ? event.changedTouches[0] : undefined;
      const clientX = touch?.clientX ?? (event as MouseEvent).clientX;
      const clientY = touch?.clientY ?? (event as MouseEvent).clientY;
      if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
      const at = flow.screenToFlowPosition({ x: clientX, y: clientY });

      const over = topDropTarget(flow, at);
      // Released back on its own node included: that's a SELF-LOOP, the
      // flow-chart retry arrow.
      if (over) {
        onConnect({ source: from.id, target: over, sourceHandle: null, targetHandle: null });
        return;
      }

      const size = KIND_DEFAULT_SIZE.point;
      const pointNode: Node = {
        id: nextId("point"),
        type: "point",
        position: { x: Math.round(at.x - size.w / 2), y: Math.round(at.y - size.h / 2) },
        width: size.w,
        height: size.h,
        style: { width: size.w, height: size.h },
        zIndex: LEAF_Z_INDEX,
        data: {
          label: "",
          kind: "point",
          icon: "none",
          description: "",
          fontSize: 13,
          ...(timelineAtRef.current ? { date: timelineAtRef.current } : {}),
        } satisfies DiagramNodeData,
      };
      setNodes((current) => [...current, pointNode]);
      // Through onConnect, so a dangling edge is styled, defaulted, and
      // committed exactly like a completed one.
      onConnect({ source: from.id, target: pointNode.id, sourceHandle: null, targetHandle: null });
    },
    [readOnly, flow, onConnect, setNodes],
  );

  const deleteSelection = useCallback(() => {
    if (readOnly) return;

    // Derived view elements are not deletable — a ghost is edited at its own
    // level, and its stand-in edges are just projections of real ones.
    // Zones live in the same canvas array but in a different document
    // collection, so they are separated here rather than left to a filter
    // that would silently match nothing.
    const nodeIds = selectedNodeIds.filter(
      (id) => !isGhostNodeId(id) && !isBoundaryNodeId(id) && !isZoneNodeId(id),
    );
    const zoneIds = selectedNodeIds.filter(isZoneNodeId).map(fromZoneNodeId);
    const edgeIds = selectedEdgeIds.filter((id) => !isGhostEdgeId(id));
    if (!nodeIds.length && !edgeIds.length && !zoneIds.length) {
      if (selectedNodeIds.length || selectedEdgeIds.length) {
        showToast("External elements are edited at their own level");
      }
      return;
    }

    {
      // ALWAYS route through the DOCUMENT. The canvas holds only what this
      // view draws, so a cascade over it cannot see a deleted box's hidden
      // contents — the children of a COLLAPSED group at root, or the drill-in
      // detail of a card one level down. Those survived the delete and came
      // back on the next derive with their parent gone: root nodes at
      // coordinates that only meant something inside the box that no longer
      // exists, sitting on top of whatever was there. The document knows the
      // whole tree, so it is the only place the cascade is correct.
      const doc = templateRef.current;
      const doomed = new Set(nodeIds);
      let grewDoc = true;
      while (grewDoc) {
        grewDoc = false;
        for (const n of doc.nodes) {
          if (n.parentId && doomed.has(n.parentId) && !doomed.has(n.id)) {
            doomed.add(n.id);
            grewDoc = true;
          }
        }
      }
      // Deleting a dangling arrow's edge (or its source) strands the dot at
      // its loose end — sweep exactly those, nothing else.
      const docPointIds = new Set(
        doc.nodes.filter((n) => registry.pointKinds.includes(n.kind as string)).map((n) => n.id),
      );
      const docRemovedEdge = (e: { id: string; source: string; target: string }) =>
        edgeIds.includes(e.id) || doomed.has(e.source) || doomed.has(e.target);
      const stranded = strandedPoints(docPointIds, doc.edges, docRemovedEdge);
      // A deleted zone takes only its BACKDROP. Its members stay — they are
      // referenced by `zoneId`, not contained — and validation would drop a
      // dangling reference anyway; clearing it here says so plainly.
      const goneZones = new Set(zoneIds);
      const next = validateTemplate(
        {
          ...doc,
          ...(goneZones.size
            ? { zones: (doc.zones ?? []).filter((z) => !goneZones.has(z.id)) }
            : {}),
          nodes: doc.nodes
            .filter((n) => !doomed.has(n.id) && !stranded.has(n.id))
            .map((n) => (n.zoneId && goneZones.has(n.zoneId) ? { ...n, zoneId: null } : n)),
          edges: doc.edges.filter(
            (e) => !edgeIds.includes(e.id) && !doomed.has(e.source) && !doomed.has(e.target),
          ),
        },
        registryOpts(registry),
      );
      const rf = materializeTemplate(next);
      commit(rf.nodes, rf.edges, next);
    }
  }, [readOnly, selectedNodeIds, selectedEdgeIds, showToast, registry, materializeTemplate, commit]);

  const patchNode = useCallback(
    (id: string, patch: Partial<DiagramNodeData>) => {
      if (readOnly) return;
      setNodes((current) =>
        current.map((n) => {
          if (n.id !== id) return n;
          const data = { ...(n.data as DiagramNodeData), ...patch };
          // Explicit undefined means "clear the field", not "keep the old value".
          for (const key of [
            "tags",
            "url",
            "locked",
            "providers",
            "date",
            "textAlign",
            "textVAlign",
            "wrap",
            "fill",
            "outline",
            "color",
            "opacity",
            "fontSize",
          ] as const) {
            if (key in patch && patch[key] === undefined) delete data[key];
          }
          // Changing kind can change which renderer the node needs.
          const def = kindDef(registry, data.kind);
          const type = def.container
            ? "group"
            : def.annotation
              ? "annotation"
              : def.point
                ? "point"
                : "shape";

          // A wrapped label decides the node's height. `validateTemplate` grows
          // the stored `h` for it, but the DOCUMENT is derived from the canvas
          // — so unless the canvas node grows too, the next derive reads the
          // old height back off it and the extra lines spill out of the box.
          // Anything that changes how many lines the label takes lands here.
          const affectsHeight =
            "wrap" in patch || "fontSize" in patch || ("label" in patch && data.wrap);
          const grown =
            affectsHeight && data.wrap && !def.container && !def.annotation
              ? wrappedTitleHeight(
                  data.label,
                  data.fontSize ?? DEFAULT_FONT_SIZE,
                  firstNumber(n.width, n.style?.width, n.measured?.width) ?? 170,
                  !!data.icon && data.icon !== "none",
                )
              : null;
          const height = grown
            ? Math.max(grown, NODE_MIN_SIZE.shape.h)
            : firstNumber(n.height, n.style?.height, n.measured?.height);

          // Materializing a dangling arrow's dot: changing a point's kind is
          // how "the thing this arrow points at" comes into existence, and a
          // real node in the dot's 12×12 box would be an invisible sliver.
          // Size it like a freshly inserted node of the new kind. (The other
          // direction — shrinking a node INTO a dot — keeps the box; the
          // stored size survives the round trip, like a collapsed group's.)
          const wasPoint = kindDef(registry, (n.data as DiagramNodeData).kind).point;
          const bodied =
            "kind" in patch && wasPoint && !def.point
              ? KIND_DEFAULT_SIZE[data.kind] ?? KIND_DEFAULT_SIZE.default
              : null;

          return {
            ...n,
            type,
            data,
            zIndex: def.container ? 0 : LEAF_Z_INDEX,
            ...(bodied
              ? {
                  width: bodied.w,
                  height: bodied.h,
                  style: { ...(n.style ?? {}), width: bodied.w, height: bodied.h },
                }
              : grown && height
                ? { height, style: { ...(n.style ?? {}), height } }
                : {}),
            // React Flow reads draggability from the node object, not data.
            ...("locked" in patch ? { draggable: !data.locked } : {}),
          };
        }),
      );
      commitLater(typingRunKey("node", id, patch));
    },
    [readOnly, setNodes, registry, commitLater],
  );

  const patchEdge = useCallback(
    (id: string, patch: Partial<DiagramEdgeData>) => {
      if (readOnly) return;
      setEdges((current) =>
        current.map((e) => {
          if (e.id !== id) return e;
          const data = { ...(e.data as DiagramEdgeData), ...patch };
          // A spread keeps keys explicitly set to undefined; delete them so
          // "routing: default" and a cleared seq, date, anchor, or route
          // genuinely unset the field.
          for (const key of ["routing", "seq", "direction", "startHead", "endHead", "date", "start", "end", "points"] as const) {
            if (key in patch && patch[key] === undefined) delete data[key];
          }
          // The edge's own routing changed (or was cleared) — recompute what
          // the renderer draws from the diagram default.
          if ("routing" in patch) {
            data.routingResolved = data.routing ?? resolveRouting(meta.current?.routing);
          }
          return {
            ...e,
            data,
            style: {
              stroke: EDGE_COLOR_HEX[data.color] ?? EDGE_COLOR_HEX.slate,
              strokeDasharray: EDGE_DASH[data.style]?.join(" ") || undefined,
              strokeWidth: 1.8,
            },
          };
        }),
      );
      commitLater(typingRunKey("edge", id, patch));
    },
    [readOnly, setEdges, commitLater],
  );

  // ── Re-parenting on drop ──────────────────────────────────────────────────

  /**
   * After a drag, put the node inside whichever container its centre landed in
   * (deepest wins), or lift it to the root if it landed on empty canvas.
   * Positions are converted between absolute and parent-relative by hand
   * because React Flow stores child positions relative to the parent.
   */
  /**
   * Alt-drag leaves a copy behind, the way every canvas editor does.
   *
   * Recorded on drag START but applied on drag STOP: cloning mid-gesture would
   * re-materialize the canvas under the pointer and drop the drag. The end
   * state is identical either way — the user drags the original away and the
   * clone is left where the drag began.
   */
  const altDragOrigins = useRef<Map<string, { x: number; y: number }> | null>(null);
  /** Ties an alt-drag's clone and its move into one undo entry. */
  const altDragCommitKey = useRef<string | null>(null);

  const onNodeDragStart = useCallback(
    (event: MouseEvent | TouchEvent, _node: Node, dragged: Node[]) => {
      // Touch has no alt key, so a touch drag simply never clones.
      if (readOnly || !("altKey" in event && event.altKey)) {
        altDragOrigins.current = null;
        return;
      }
      altDragOrigins.current = new Map(
        dragged
          .filter((n) => !isZoneNodeId(n.id) && !isBoundaryNodeId(n.id) && !isGhostNodeId(n.id))
          .map((n) => [n.id, { x: n.position.x, y: n.position.y }]),
      );
    },
    [readOnly],
  );

  const finishAltDrag = useCallback(() => {
    const origins = altDragOrigins.current;
    altDragOrigins.current = null;
    if (!origins?.size || readOnly) return false;

    const ids = [...origins.keys()];
    // offset 0 — the clone is placed by its recorded origin, not nudged.
    const { template: next, idMap } = duplicateWithConnections(templateRef.current, ids, {
      ...registryOpts(registry),
      offset: 0,
    });
    const placed = {
      ...next,
      nodes: next.nodes.map((n) => {
        const from = ids.find((id) => idMap[id] === n.id);
        const origin = from ? origins.get(from) : undefined;
        return origin ? { ...n, x: origin.x, y: origin.y } : n;
      }),
    };
    // The clone and the move that follows it are ONE gesture, so they share a
    // coalescing key and undo together. Two entries meant the first ⌘Z left
    // the original visually inside the group it was dragged into while its
    // stored parent still said otherwise — a state the user never made.
    const key = `altdrag:${Date.now()}`;
    altDragCommitKey.current = key;
    applyTemplate(placed, { fit: false, coalesce: key });
    showToast(`Left a copy of ${ids.length} node${ids.length === 1 ? "" : "s"} behind`);
    return true;
  }, [readOnly, registry, applyTemplate, showToast]);

  /**
   * Alignment guides and a drop-target highlight, while a node is moving.
   *
   * Two things were missing at once: nothing told you where a box would land
   * relative to its neighbours until you let go, and nothing told you which
   * container was about to swallow it — the answer to that arrived as a toast
   * AFTER the drop, which is the wrong end of the gesture.
   *
   * Guides are for a SINGLE dragged node. A multi-selection has no one box to
   * align, and snapping the group by one member's edge moves the others by an
   * amount nobody asked for.
   */
  /**
   * The nearest alignment between one node's edges/centres and any other's.
   *
   * Recomputed rather than remembered: `onNodeDrag` is throttled, so a delta
   * captured on the last frame is a frame stale by the time the pointer is
   * released — enough to land a box one pixel off the line the guide just
   * promised it was on.
   */
  const bestAlignment = useCallback(
    (nodeId: string, movingIds: ReadonlySet<string>) => {
      const boxOf = (id: string) => {
        const internal = flow.getInternalNode(id);
        if (!internal) return null;
        const { x, y } = internal.internals.positionAbsolute;
        const w = (internal.measured?.width as number) ?? 0;
        const h = (internal.measured?.height as number) ?? 0;
        return { x, y, w, h };
      };
      const self = boxOf(nodeId);
      if (!self) return null;

      // Left / centre / right and top / middle / bottom, against the same
      // three lines on every other box: the six alignments a person actually
      // reaches for.
      const selfX = [self.x, self.x + self.w / 2, self.x + self.w];
      const selfY = [self.y, self.y + self.h / 2, self.y + self.h];
      let best: { axis: "x" | "y"; at: number; delta: number; from: number; to: number } | null =
        null;
      for (const other of flow.getNodes()) {
        if (movingIds.has(other.id) || isBoundaryNodeId(other.id) || isGhostNodeId(other.id)) continue;
        const box = boxOf(other.id);
        if (!box) continue;
        const axes = [
          { axis: "x" as const, mine: selfX, theirs: [box.x, box.x + box.w / 2, box.x + box.w] },
          { axis: "y" as const, mine: selfY, theirs: [box.y, box.y + box.h / 2, box.y + box.h] },
        ];
        for (const { axis, mine, theirs } of axes) {
          for (const m of mine) {
            for (const t of theirs) {
              const delta = t - m;
              if (Math.abs(delta) > ALIGN_TOL) continue;
              if (best && Math.abs(best.delta) <= Math.abs(delta)) continue;
              best = {
                axis,
                at: t,
                delta,
                from: axis === "x" ? Math.min(self.y, box.y) : Math.min(self.x, box.x),
                to:
                  axis === "x"
                    ? Math.max(self.y + self.h, box.y + box.h)
                    : Math.max(self.x + self.w, box.x + box.w),
              };
            }
          }
        }
      }
      return best;
    },
    [flow],
  );

  const onNodeDrag = useCallback(
    (_event: unknown, node: Node, dragged: Node[]) => {
      if (readOnly) return;
      const boxOf = (id: string) => {
        const internal = flow.getInternalNode(id);
        if (!internal) return null;
        const { x, y } = internal.internals.positionAbsolute;
        const w = (internal.measured?.width as number) ?? 0;
        const h = (internal.measured?.height as number) ?? 0;
        return { x, y, w, h };
      };

      const self = boxOf(node.id);
      if (!self) return;

      // Which open container the centre is over — the same deepest-wins rule
      // the drop itself uses, so the highlight cannot promise a different
      // answer from the one the drop gives.
      const cx = self.x + self.w / 2;
      const cy = self.y + self.h / 2;
      const movingIds = new Set(dragged.map((n) => n.id));
      let over: string | null = null;
      let overDepth = -1;
      for (const candidate of flow.getNodes()) {
        if (movingIds.has(candidate.id) || isZoneNodeId(candidate.id)) continue;
        if (isBoundaryNodeId(candidate.id) || isGhostNodeId(candidate.id)) continue;
        const data = candidate.data as DiagramNodeData;
        if (!kindDef(registry, data.kind).container || data.collapsed) continue;
        const box = boxOf(candidate.id);
        if (!box) continue;
        if (cx <= box.x || cx >= box.x + box.w || cy <= box.y || cy >= box.y + box.h) continue;
        let depth = 0;
        for (let p = candidate.parentId; p; p = flow.getNode(p)?.parentId) depth += 1;
        if (depth > overDepth) {
          overDepth = depth;
          over = candidate.id;
        }
      }
      setDropTargetId(over);

      // Guides are for a SINGLE dragged node — a multi-selection has no one
      // box to align, and snapping the group by one member's edge moves the
      // others by an amount nobody asked for.
      if (dragged.length !== 1) {
        setDragGuides(null);
        pendingSnap.current = null;
        return;
      }

      const best = bestAlignment(node.id, movingIds);
      if (!best) {
        setDragGuides(null);
        pendingSnap.current = null;
        return;
      }
      setDragGuides({ axis: best.axis, at: best.at, from: best.from - 24, to: best.to + 24 });
      // Only WHETHER to snap and for which node — the amount is measured
      // again on release, from where the box actually ended up. With
      // snap-to-grid on there is no snap at all: two of them fighting over
      // the same axis would land the box on neither. The guide still shows,
      // because "you are level with that box" is worth knowing whichever
      // thing decides the last few pixels.
      pendingSnap.current = snapEnabled ? null : { id: node.id, moving: movingIds };
    },
    [readOnly, flow, registry, snapEnabled, bestAlignment],
  );

  const onNodeDragStop = useCallback(
    (_event: unknown, _node: Node, dragged: Node[]) => {
      setDragGuides(null);
      setDropTargetId(null);
      const snap = pendingSnap.current;
      pendingSnap.current = null;
      if (readOnly) return;
      // An alt-drag drops its copy first, so the clone is in the document
      // before this move is committed on top of it.
      altDragCommitKey.current = null;
      finishAltDrag();
      const dragKey = altDragCommitKey.current ?? undefined;

      const all = flow.getNodes();
      const absOf = (id: string) => flow.getInternalNode(id)?.internals.positionAbsolute;
      const sizeOf = (n: Node) => ({
        w: n.width ?? (n.measured?.width as number) ?? 0,
        h: n.height ?? (n.measured?.height as number) ?? 0,
      });

      const descendantsOf = (rootId: string) => {
        const out = new Set<string>([rootId]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const n of all) {
            if (n.parentId && out.has(n.parentId) && !out.has(n.id)) {
              out.add(n.id);
              grew = true;
            }
          }
        }
        return out;
      };

      const depthOfNode = (n: Node) => {
        let depth = 0;
        let cursor = n.parentId ? all.find((m) => m.id === n.parentId) : undefined;
        const guard = new Set<string>([n.id]);
        while (cursor && !guard.has(cursor.id)) {
          guard.add(cursor.id);
          depth++;
          cursor = cursor.parentId ? all.find((m) => m.id === cursor!.parentId) : undefined;
        }
        return depth;
      };

      // In a focused view the zone boxes live in root space while the canvas
      // shows drill space — judging one against the other would enrol nodes
      // in zones they never touched. Zones simply don't apply on this canvas.
      const zones = rfFocusRef.current ? [] : (templateRef.current.zones ?? []);
      const updates = new Map<
        string,
        { parentId?: string; position: { x: number; y: number }; zoneId?: string | null }
      >();
      /** Ghost drags land in `meta.views`, not in the node's own geometry. */
      const ghostMoves = new Map<string, { x: number; y: number; w: number; h: number }>();
      /** Collapsed frames that received a drop and must open to show it. */
      const expanded = new Set<string>();

      for (const node of dragged) {
        // Dragging a zone moves the backdrop; it has no parent and no zone.
        if (isZoneNodeId(node.id) || isBoundaryNodeId(node.id)) continue;
        if (isGhostNodeId(node.id)) {
          const { w, h } = sizeOf(node);
          ghostMoves.set(node.id, { x: node.position.x, y: node.position.y, w, h });
          continue;
        }
        const abs = absOf(node.id);
        if (!abs) continue;
        const { w, h } = sizeOf(node);
        const cx = abs.x + w / 2;
        const cy = abs.y + h / 2;
        const excluded = descendantsOf(node.id);

        let target: Node | null = null;
        let targetDepth = -1;
        for (const candidate of all) {
          if (excluded.has(candidate.id)) continue;
          // The boundary frame is scenery, and a ghost standing for a group
          // still isn't a drop target — neither exists in the document.
          if (isBoundaryNodeId(candidate.id) || isGhostNodeId(candidate.id)) continue;
          const def = kindDef(registry, (candidate.data as DiagramNodeData).kind);
          if (!def.container) continue;
          const cAbs = absOf(candidate.id);
          if (!cAbs) continue;
          const cSize = sizeOf(candidate);
          const inside =
            cx > cAbs.x && cx < cAbs.x + cSize.w && cy > cAbs.y && cy < cAbs.y + cSize.h;
          if (!inside) continue;
          const d = depthOfNode(candidate);
          if (d > targetDepth) {
            targetDepth = d;
            target = candidate;
          }
        }

        // Zone membership is decided by shape-aware containment, so dropping a
        // node in the notch of an L-shaped region does not put it in that
        // region — and a small island on top wins over the region hosting it.
        const currentZoneId = (node.data as DiagramNodeData).zoneId ?? null;
        const nextZone = zoneAt(zones, cx, cy);
        const nextZoneId = nextZone?.id ?? null;

        const nextParent = target?.id;
        const parentChanged = (nextParent ?? null) !== (node.parentId ?? null);
        const zoneChanged = nextZoneId !== currentZoneId;
        if (!parentChanged && !zoneChanged) continue;

        const parentAbs = target ? absOf(target.id) : { x: 0, y: 0 };
        updates.set(node.id, {
          parentId: nextParent,
          position: parentChanged
            ? { x: abs.x - (parentAbs?.x ?? 0), y: abs.y - (parentAbs?.y ?? 0) }
            : node.position,
          zoneId: nextZoneId,
        });

        if (parentChanged) {
          // Dropping into a COLLAPSED frame opens it. The node genuinely
          // joins the group, but the chip draws none of its contents — so it
          // sat on top of the chip looking un-nested until some later rebuild
          // swallowed it. Expanding shows the drop happening.
          if (target && (target.data as DiagramNodeData).collapsed) {
            expanded.add(target.id);
          }
          showToast(
            target ? `Moved into ${(target.data as DiagramNodeData).label}` : "Moved to canvas",
          );
        } else if (zoneChanged) {
          // Tinted like the zone it landed in, so the toast and the region
          // read as one thing.
          showToast(
            nextZone ? `Now on ${nextZone.label}` : "Removed from zone",
            nextZone ? providerDef(registry, nextZone.provider).color : undefined,
          );
        }
      }

      if (expanded.size) {
        setNodes((current) =>
          current.map((n) =>
            expanded.has(n.id) ? { ...n, data: { ...n.data, collapsed: false } } : n,
          ),
        );
      }

      // The alignment guide's snap, applied here rather than mid-drag and
      // measured from where the node actually ended up.
      const snapTo = snap ? bestAlignment(snap.id, snap.moving) : null;
      if (snapTo?.delta) {
        const existing = updates.get(snap!.id);
        const from =
          existing?.position ?? flow.getNode(snap!.id)?.position ?? { x: 0, y: 0 };
        const moved =
          snapTo.axis === "x"
            ? { x: Math.round(from.x + snapTo.delta), y: from.y }
            : { x: from.x, y: Math.round(from.y + snapTo.delta) };
        if (existing) updates.set(snap!.id, { ...existing, position: moved });
        else {
          const live = flow.getNode(snap!.id);
          updates.set(snap!.id, {
            ...(live?.parentId ? { parentId: live.parentId } : {}),
            position: moved,
            zoneId: (live?.data as DiagramNodeData | undefined)?.zoneId ?? null,
          });
        }
      }

      if (updates.size) {
        setNodes((current) => {
          const next = current.map((n) => {
            const update = updates.get(n.id);
            if (!update) return n;
            const { parentId, position, zoneId } = update;
            const copy: Node = {
              ...n,
              position,
              data: { ...(n.data as DiagramNodeData), zoneId },
            };
            if (parentId) copy.parentId = parentId;
            else delete copy.parentId;
            return copy;
          });
          // React Flow requires parents to precede children in the array.
          return sortByDepth(next);
        });
      }
      if (ghostMoves.size && rfFocusRef.current) {
        // A ghost's place is per-view presentation: write it into the
        // document's `meta.views[focus]` record. Document write → undoable,
        // and the next materialization renders the ghost where it was left.
        const focus = rfFocusRef.current;
        queueMicrotask(() => {
          const lifted = deriveTemplate(flow.getNodes() as Node[], flow.getEdges() as Edge[]);
          const views = { ...(lifted.meta?.views ?? {}) };
          const rec = {
            ...(views[focus] ?? {}),
            nodes: { ...(views[focus]?.nodes ?? {}) },
          };
          for (const [id, box] of ghostMoves) rec.nodes[id] = box;
          views[focus] = rec;
          const next = validateTemplate(
            { ...lifted, meta: { ...(lifted.meta ?? {}), views } },
            registryOpts(registry),
          );
          const rf = materializeTemplate(next);
          commit(rf.nodes, rf.edges, next, dragKey);
        });
        return;
      }
      commitLater(dragKey);
    },
    [readOnly, flow, registry, setNodes, showToast, commitLater, deriveTemplate, materializeTemplate, commit, finishAltDrag],
  );

  // ── Undo / redo ───────────────────────────────────────────────────────────

  const applySnapshot = useCallback(
    (snapshot: Snapshot) => {
      // Undo restores the DOCUMENT and re-materializes the view from it.
      // Re-deriving from the snapshot's stored arrays would judge them against
      // whatever frame is current *now* — undoing across a provider toggle
      // would then delete the very nodes the undo was meant to bring back.
      const doc =
        (snapshot.template as DiagramTemplate | undefined) ??
        deriveTemplate(snapshot.nodes, snapshot.edges);
      materializeTemplate(doc);
      if (onChange) {
        lastEmitted.current = JSON.stringify(doc);
        onChange(doc);
      }
    },
    [materializeTemplate, onChange, deriveTemplate],
  );

  const doUndo = useCallback(() => {
    const snapshot = undoHistory();
    if (snapshot) applySnapshot(snapshot);
  }, [undoHistory, applySnapshot]);

  const doRedo = useCallback(() => {
    const snapshot = redoHistory();
    if (snapshot) applySnapshot(snapshot);
  }, [redoHistory, applySnapshot]);

  // ── Drill navigation (C4 levels) ──────────────────────────────────────────

  /** Set the whole focus stack — the one write path for drill state. */
  const drillTo = useCallback((stack: string[]) => {
    focusStackRef.current = stack;
    setFocusStack(stack);
  }, []);

  /**
   * Step one level into a node. Zoom toward its box first when motion is
   * welcome; the swap itself is timer-driven so correctness never depends on
   * the tween (jsdom, reduced-motion, node off-canvas all skip it).
   */
  const drillInto = useCallback(
    (id: string) => {
      if (activeDiffBase) return; // compare mode owns the canvas
      const internal = flow.getInternalNode(id);
      const reduced =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const swap = () => {
        // The document may have changed mid-tween (an AI reply landing) —
        // a vanished target must not throw inside a timer callback.
        if (!templateRef.current.nodes.some((n) => n.id === id)) return;
        drillTo([...focusStackRef.current, id]);
        canvasRef.current?.classList.remove("as-canvas--refocus");
        window.setTimeout(
          () => flow.fitView({ padding: 0.15, duration: reduced ? 0 : 250 }),
          60,
        );
      };
      if (internal && !reduced) {
        const abs = internal.internals.positionAbsolute;
        canvasRef.current?.classList.add("as-canvas--refocus");
        void flow.fitBounds(
          {
            x: abs.x,
            y: abs.y,
            width: (internal.measured?.width as number) ?? 170,
            height: (internal.measured?.height as number) ?? 76,
          },
          { duration: 200, padding: 0.3 },
        );
        window.setTimeout(swap, 210);
      } else {
        swap();
      }
    },
    [activeDiffBase, flow, drillTo],
  );

  /** Step one level out. Esc's "clean" press and the breadcrumbs share this. */
  const drillOut = useCallback(() => {
    if (!focusStackRef.current.length) return;
    drillTo(focusStackRef.current.slice(0, -1));
    canvasRef.current?.classList.add("as-canvas--refocus");
    window.setTimeout(() => {
      canvasRef.current?.classList.remove("as-canvas--refocus");
      void flow.fitView({ padding: 0.15, duration: 250 });
    }, 60);
  }, [drillTo, flow]);

  /**
   * Jump to the level that shows a node, then select and centre it — the
   * search's cross-level fallback and a ghost's "go to definition".
   */
  const navigateToNode = useCallback(
    (id: string) => {
      const doc = templateRef.current;
      if (!doc.nodes.some((n) => n.id === id)) return;
      drillTo(focusPath(doc, id));
      // Post-materialize timer, the applyTemplate precedent: the rebuild
      // effect must run before the node exists to select.
      window.setTimeout(() => {
        setNodes((current) => current.map((n) => ({ ...n, selected: n.id === id })));
        const internal = flow.getInternalNode(id);
        if (internal) {
          const abs = internal.internals.positionAbsolute;
          void flow.setCenter(
            abs.x + ((internal.measured?.width as number) ?? 170) / 2,
            abs.y + ((internal.measured?.height as number) ?? 76) / 2,
            { zoom: Math.max(flow.getViewport().zoom, 0.9), duration: 300 },
          );
        } else {
          void flow.fitView({ padding: 0.15, duration: 250 });
        }
      }, 80);
    },
    [drillTo, flow, setNodes],
  );

  useEffect(() => {
    navigateToNodeRef.current = navigateToNode;
  }, [navigateToNode]);

  // Compare mode owns the whole canvas — entering it exits any drill.
  useEffect(() => {
    if (activeDiffBase && focusStackRef.current.length) drillTo([]);
  }, [activeDiffBase, drillTo]);

  // (The keyboard handler lives further down — it binds every command in this
  //  component, so it has to be declared after all of them.)

  /** Where `error` has a home. Anything else has to say so for itself. */
  const aiPanelVisible = panelOpen && !!generate && !readOnly;

  /**
   * A finger or a stylus rather than a mouse.
   *
   * Read once — a device does not change category mid-session, and re-reading
   * it per render would rebuild the canvas's gesture config for nothing.
   */
  const coarsePointer = useMemo(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches,
    [],
  );

  /** ⌘ or Ctrl, for the hints and tooltips that name a chord. */
  const modKey = isMac() ? "⌘" : "Ctrl+";
  const modKeyRef = useRef(modKey);
  modKeyRef.current = modKey;

  const handleVersionTagEditStarted = useCallback(() => setEditVersionTag(false), []);

  /**
   * Open the right-click menu on whatever is under the pointer.
   *
   * Right-clicking something that is not in the selection selects it first —
   * acting on a hidden selection while the user is pointing at something else
   * is how a context menu deletes the wrong thing.
   */
  const openContextMenu = useCallback(
    (event: React.MouseEvent, nodeId?: string, edgeId?: string) => {
      if (readOnly || activeDiffBase) return;
      event.preventDefault();
      setOpenMenu(null);
      if (nodeId && !selectionRef.current.nodes.includes(nodeId)) {
        setNodes((current) => current.map((n) => ({ ...n, selected: n.id === nodeId })));
        setEdges((current) => current.map((e) => ({ ...e, selected: false })));
      } else if (edgeId && !selectionRef.current.edges.includes(edgeId)) {
        setEdges((current) => current.map((e) => ({ ...e, selected: e.id === edgeId })));
        setNodes((current) => current.map((n) => ({ ...n, selected: false })));
      }
      const kind = edgeId ? "edge" : nodeId ? (isZoneNodeId(nodeId) ? "zone" : "node") : "pane";
      setContextMenu({ x: event.clientX, y: event.clientY, kind });
    },
    [readOnly, activeDiffBase, setNodes, setEdges],
  );

  // Any click or Escape dismisses it, like every other menu here.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [contextMenu]);

  /** Set when a dismiss-click has to be eaten whole. See the menu effect. */
  const swallowClick = useRef(false);

  const closeContext = useCallback(() => setContextMenu(null), []);

  const toggleMenu = useCallback(
    (id: "files" | "insert" | "arrange" | "view" | "checks" | "export") =>
      setOpenMenu((current) => (current === id ? null : id)),
    [],
  );

  // Any open dropdown closes on a click outside its own wrapper. A single
  // document-level listener serves every menu, so no menu needs its own
  // outside-click plumbing and two can never be open in disagreement.
  //
  // The dismiss click is CONSUMED inside the editor: clicking a node to get
  // rid of an open menu should get rid of the menu, not also select the node
  // (or clear the selection, or start a drag). Outside the editor it is left
  // alone — the host's own UI has to keep working while a menu happens to be
  // open. Captured, so it lands before React Flow's own pointer handlers.
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".as-menu-wrap")) return;
      setOpenMenu(null);
      // Only a click on the CANVAS is consumed. Clicking another control —
      // the inspector's Delete, a toolbar button — is a deliberate second
      // action, and eating it would make the editor feel like it had missed
      // the press. Only the canvas has the "I clicked it to get rid of the
      // menu" problem, because a click there also selects or deselects.
      if (target?.closest(".react-flow")) {
        event.preventDefault();
        event.stopPropagation();
        // pointerdown and click are separate events, and the SELECTION lands
        // on the click — so the whole gesture has to be swallowed, or the
        // dismiss still acts on whatever was underneath. The flag lives on a
        // ref, and the listener that reads it OUTLIVES this effect: closing
        // the menu is a state change, so the cleanup runs before the click
        // ever arrives.
        swallowClick.current = true;
      }
    };
    // pointerdown AND mousedown: React Flow's drag/select plumbing comes from
    // d3-drag, which listens for mousedown, so stopping only the pointer event
    // leaves the selection happening anyway.
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [openMenu]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // ── Export / import ───────────────────────────────────────────────────────

  // Derived in the theme workstream; dark until a light theme is passed.
  const exportPalette = useMemo(() => paletteFromTheme(theme), [theme]);

  const runDirectExport = useCallback(
    async (key: string) => {
      const exporter = registry.exporters[key];
      if (!exporter) return;
      try {
        // Export what is on screen. While scrubbing, that is the slice — asking
        // for a PNG of the March view and getting the finished architecture
        // would be the one thing nobody means. Ghost mode exports the whole
        // document because that is what it is showing — and so does an
        // exporter that carries its own timeline (`fullDocument`), which needs
        // the elements a hide-mode slice would strip.
        let subject =
          timelineActive && timelineFuture === "hide" && !exporter.fullDocument
            ? timelineView(template, timelineAt, "hide").template
            : template;
        // Same rule for drill focus: a picture exporter renders the level on
        // screen. Document exporters stay untouched — the drill never leaks
        // into a saved file. (A slice can have removed the focus node; fall
        // back to the whole picture rather than throwing mid-export.)
        if (focusId && !exporter.fullDocument && subject.nodes.some((n) => n.id === focusId)) {
          subject = scopedView(subject, focusId, { containerKinds: registry.containerKinds });
        }
        // A selection narrows a PICTURE export to what is selected — the
        // usual reason to select a subgraph and then reach for Export is to
        // put that part in a document. Descendants and internal wiring come
        // along, the same rule Copy uses, so a group exports as a group.
        // Document formats never narrow: "export → save to your database"
        // must not quietly become "save only what I had highlighted".
        if (exportSelectionOnly && !exporter.fullDocument && selectedDocNodeIds.length) {
          const fragment = copyFragment(subject, selectedDocNodeIds, { zones: selectedZoneIds });
          if (fragment.nodes.length) {
            subject = validateTemplate(
              {
                ...subject,
                // The zones the fragment actually references, so the backdrop
                // a selected node sits on comes with it and the regions it
                // has nothing to do with do not.
                zones: fragment.zones ?? [],
                nodes: fragment.nodes,
                edges: fragment.edges,
                meta: subject.meta,
              },
              registryOpts(registry),
            );
          }
        }
        const result = await exporter.run({ template: subject, registry, filename, palette: exportPalette });
        if (result) {
          download(result.blob, result.filename);
          showToast(`Exported ${result.filename}`);
        }
      } catch (err) {
        setError(`Export failed: ${(err as Error).message}`);
        setPanelOpen(true);
      }
    },
    [registry, template, filename, exportPalette, showToast, timelineActive, timelineAt, timelineFuture, focusId, exportSelectionOnly, selectedDocNodeIds, selectedZoneIds],
  );

  const stateAxes = useMemo(() => templateStateAxes(template), [template]);

  const runExport = useCallback(
    async (key: string) => {
      setOpenMenu(null);
      // A multi-state document gets the "which states?" modal — but only for
      // the UNTOUCHED builtin snapshot exporters. A host that overrides
      // png/svg/pdf supplied its own pipeline, which the combo loop couldn't
      // honor; those keep the direct path they always had.
      if (
        (key === "png" || key === "svg" || key === "pdf") &&
        registry.exporters[key] === BUILTIN_EXPORTERS[key] &&
        countStateCombos(stateAxes) > 1
      ) {
        setPendingExport(key);
        return;
      }
      await runDirectExport(key);
    },
    [registry, stateAxes, runDirectExport],
  );

  const onExportStatesChoice = useCallback(
    async (choice: ExportStatesChoice) => {
      const format = pendingExport;
      setPendingExport(null);
      if (!format) return;
      if (choice.kind === "current") {
        await runDirectExport(format);
        return;
      }
      try {
        // Combos materialize from copies — the live document, its undo
        // history, and onChange never see the forced providers or slices.
        const result = await runStateExport({
          format,
          filename,
          axes: stateAxes,
          combos: choice.combos,
          pdfLayout: choice.pdfLayout,
          materialize: (combo) => {
            const doc = materializeCombo(template, combo);
            // While drilled in, each state pictures the focused level — but a
            // slice can have removed the focus node; fall back to the whole
            // picture rather than throwing mid-run.
            return focusId && doc.nodes.some((n) => n.id === focusId)
              ? scopedView(doc, focusId, { containerKinds: registry.containerKinds })
              : doc;
          },
          renderSvg: (doc) => renderTemplateToSvg(doc, registry, exportPalette),
          renderCanvas: (doc) => renderTemplateToCanvas(doc, registry, 2, exportPalette),
        });
        download(result.blob, result.filename);
        showToast(
          choice.combos.length === 1
            ? `Exported ${result.filename}`
            : `Exported ${choice.combos.length} states → ${result.filename}`,
        );
      } catch (err) {
        setError(`Export failed: ${(err as Error).message}`);
        setPanelOpen(true);
      }
    },
    [pendingExport, runDirectExport, filename, stateAxes, template, registry, exportPalette, showToast, focusId],
  );

  const loadFile = useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        const raw = JSON.parse(text);
        // A layout file re-dresses the CURRENT document — it carries no
        // architecture of its own.
        if (raw?.format === PRESENTATION_FORMAT) {
          const pres = validatePresentation(raw);
          const current = templateRef.current;
          const nodeIds = new Set(current.nodes.map((n) => n.id));
          const edgeIds = new Set(current.edges.map((e) => e.id));
          const records = [
            ...Object.keys(pres.nodes ?? {}).map((id) => nodeIds.has(id)),
            ...Object.keys(pres.edges ?? {}).map((id) => edgeIds.has(id)),
          ];
          const applied = records.filter(Boolean).length;
          const unmatched = records.length - applied;
          applyTemplate(mergeTemplate(current, pres, registryOpts(registry)), { fit: false });
          setError("");
          // A layout exported from a DIFFERENT diagram merges nothing; the
          // counts are what stop that reading as success.
          showToast(
            `Applied layout to ${applied} element${applied === 1 ? "" : "s"}` +
              (unmatched ? ` · ${unmatched} unmatched` : ""),
          );
          return;
        }
        // Accept both our template shape and a raw React Flow export.
        const isReactFlow = Array.isArray(raw?.nodes) && raw.nodes[0] && "position" in raw.nodes[0];
        const incoming: DiagramTemplate = isReactFlow
          ? fromReactFlow(raw.nodes, raw.edges ?? [], registryOpts(registry))
          : raw;
        // A content doc (or any never-placed JSON) lays itself out, exactly
        // like the welcome modal's paste path.
        applyTemplate(layoutIfUnpositioned(validateTemplate(incoming, registryOpts(registry))));
        setError("");
        showToast(`Loaded ${file.name}`);
      } catch (err) {
        setError(`Could not load ${file.name}: ${(err as Error).message}`);
        setPanelOpen(true);
      }
    },
    [registry, applyTemplate, showToast],
  );

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      setDropActive(false);
      if (readOnly) return;
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      // A template REPLACES the whole diagram. It is undoable, but a
      // mis-aimed drag onto a canvas full of unsaved work is a shock worth
      // one question — and a LAYOUT file only re-dresses what is here, so it
      // never needs asking.
      const replaces =
        templateRef.current.nodes.length > 0 && !/\.layout\.json$/i.test(file.name);
      if (
        replaces &&
        typeof window !== "undefined" &&
        typeof window.confirm === "function" &&
        !window.confirm(
          `Replace this diagram with “${file.name}”?\n\n` +
            `The ${templateRef.current.nodes.length} elements on the canvas are replaced. ` +
            `${modKeyRef.current}Z undoes it.`,
        )
      ) {
        return;
      }
      void loadFile(file);
    },
    [readOnly, loadFile],
  );

  const onDragOver = useCallback(
    (event: DragEvent) => {
      if (readOnly) return;
      // Only react to an actual file drag, not to React Flow's internal drags.
      if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDropActive(true);
    },
    [readOnly],
  );

  // ── Save ──────────────────────────────────────────────────────────────────

  /**
   * Save, once at a time.
   *
   * The button disables itself while a save is in flight, but ⌘S did not —
   * so a slow host got overlapping calls with different documents racing to
   * be last. A ref rather than the `saving` state because two presses in the
   * same tick both read the pre-render value.
   */
  const savingRef = useRef(false);
  /**
   * The document as it was when it was last saved, so the button can say
   * whether there is anything to save. Without it Save looks identical
   * before and after, and the only way to know whether your work is safe is
   * to press it again.
   */
  const [savedJson, setSavedJson] = useState<string | null>(null);
  const handleSave = useCallback(async () => {
    if (!onSave || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      await onSave(template);
      setSavedJson(JSON.stringify(template));
      showToast("Saved");
    } catch (err) {
      setError(`Save failed: ${(err as Error).message}`);
      setPanelOpen(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [onSave, template, showToast]);

  /** Whether the document differs from what was last handed to `onSave`. */
  const dirty = savedJson !== null && savedJson !== JSON.stringify(template);

  // ── AI generation ─────────────────────────────────────────────────────────

  /**
   * Providers the document references — zone providers, node providers, edge
   * providers, and any node whose KIND belongs to a cloud pack (one
   * aws-lambda in the diagram makes the whole AWS pack first-class). Drives
   * which cloud packs count as "relevant": their kinds list un-demoted in the
   * kind picker, and their prompt sections ride along.
   */
  const referencedProviderSet = useMemo(
    () => referencedProviders(template, registry),
    [template, registry],
  );

  const promptForClouds = useCallback(
    (clouds: readonly string[], opts?: PromptScopeOptions) =>
      promptForCloudSelection(registry, clouds, opts),
    [registry],
  );

  // The AI panel's prompt adapts to the document: the clouds it references
  // contribute their kind ids and component sections automatically.
  const referencedClouds = useMemo(
    () => CLOUD_PROVIDER_IDS.filter((p) => referencedProviderSet.has(p)),
    [referencedProviderSet],
  );
  const systemPrompt = useMemo(
    () => promptForClouds(referencedClouds),
    [promptForClouds, referencedClouds],
  );
  // Refine speaks the CONTENT form: the same vocabulary minus geometry, plus
  // "keep ids stable" — the model never sees coordinates it could mangle.
  const refineSystemPrompt = useMemo(
    () => promptForCloudSelection(registry, referencedClouds, { geometry: false }),
    [registry, referencedClouds],
  );

  // ── Welcome modal ─────────────────────────────────────────────────────────

  /** Zones count as content — a zones-only document is a started diagram. */
  const isBlankDoc = (doc: DiagramTemplate) =>
    !doc.nodes.length && !doc.edges.length && !doc.zones?.length;

  const zeroFiles = files !== undefined && files.length === 0;
  const [welcomeOpen, setWelcomeOpen] = useState(
    () =>
      welcome &&
      !readOnly &&
      !diffBase &&
      !welcomeSuppressed() &&
      (isBlankDoc(initialTemplate) || zeroFiles),
  );
  // The open decision above already read the hand-off latch — clear it so it
  // can't suppress a later, genuinely new blank file.
  useEffect(() => {
    clearWelcomeSuppression();
  }, []);

  // Close as soon as there is content (insert, AI generate, controlled swap);
  // dismissal is sticky per mount, so undoing back to blank doesn't re-open.
  useEffect(() => {
    if (!isBlankDoc(template) || readOnly || diffBase) setWelcomeOpen(false);
  }, [template, readOnly, diffBase]);

  // Re-open when the workspace empties out, or when the host switches to a
  // NEW blank file, under a host that doesn't remount per file. The initial
  // decision is made once at mount, so on such a host "+ New file" used to
  // land on a bare canvas with none of the ways in the README promises.
  const prevFileCount = useRef(files?.length);
  const prevActiveFileId = useRef(activeFileId);
  useEffect(() => {
    if (!welcome || readOnly || diffBase) {
      prevFileCount.current = files?.length;
      prevActiveFileId.current = activeFileId;
      return;
    }
    const emptied = files?.length === 0 && prevFileCount.current !== 0;
    const switchedToBlank =
      activeFileId !== undefined &&
      activeFileId !== prevActiveFileId.current &&
      isBlankDoc(templateRef.current);
    if (emptied || switchedToBlank) setWelcomeOpen(true);
    prevFileCount.current = files?.length;
    prevActiveFileId.current = activeFileId;
  }, [files?.length, activeFileId, welcome, readOnly, diffBase]);

  const activeFile = files?.find((file) => file.id === activeFileId) ?? files?.[0];
  const welcomeName = zeroFiles ? "Untitled 1" : (activeFile?.name ?? filename);

  // Registry-aware, so a custom kind lints clean exactly where it inserts clean.
  const welcomeLint = useMemo(
    () =>
      buildArchitectureLint({
        kinds: registry.kindOrder,
        icons: registry.iconNames,
        providers: registry.providerOrder,
      }),
    [registry],
  );

  // The modal's AWS/Azure/GCP toggle — labels and colors from the registry,
  // skipping any cloud an extension deleted.
  const welcomeClouds = useMemo(() => cloudOptionsFor(registry), [registry]);
  // …and the services behind each chip, so the copied schema can be narrowed
  // to the handful of resources the next diagram actually needs.
  const welcomeResources = useMemo(() => cloudResourceOptions(registry), [registry]);
  const welcomeUsedResources = useMemo(
    () => usedCloudResources(template, registry),
    [template, registry],
  );

  const parseWelcomeJson = useCallback(
    (text: string) => parseArchitectureText(text, registryOpts(registry)),
    [registry],
  );

  const handleWelcomeInsert = useCallback(
    (doc: unknown, name: string) => {
      // The chosen name becomes the document's own title too — otherwise an
      // example doc's baked-in meta.title would win the title↔name sync and
      // stomp the name the user just typed.
      const incoming = withMetaTitle(doc as DiagramTemplate, name);
      if (zeroFiles && onFileCreate) {
        onFileCreate({ name, kind: "architecture", doc: incoming });
      } else {
        applyTemplate(incoming);
        if (activeFile && onFileRename && name !== activeFile.name) {
          onFileRename(activeFile.id, name);
        }
      }
      setWelcomeOpen(false);
    },
    [zeroFiles, onFileCreate, applyTemplate, activeFile, onFileRename],
  );

  /**
   * The picker chose "sequence" inside the architecture editor: this studio
   * cannot render that document, so the HOST gets a new file of the right
   * kind — unconditionally, not just on the zero-files path.
   */
  const handleWelcomeInsertOther = useCallback(
    (doc: unknown, name: string) => {
      const incoming = {
        ...(doc as Record<string, unknown>),
        meta: { ...((doc as { meta?: Record<string, unknown> })?.meta ?? {}), title: name },
      };
      onFileCreate?.({ name, kind: "sequence", doc: incoming });
      setWelcomeOpen(false);
    },
    [onFileCreate],
  );

  const sequencePromptForCopy = useMemo(() => buildSequencePrompt(), []);

  /**
   * The file name and the document's `meta.title` are ONE title with two
   * homes — the host's workspace label and the document itself (what exports
   * print, what the LLM writes). Renaming pushes the name into the active
   * document; the effect below pushes a document title (adopted, imported,
   * or AI-generated) back out to the host. Both directions converge on
   * equality, so they cannot ping-pong.
   */
  const renameFile = useCallback(
    (id: string, name: string) => {
      onFileRename?.(id, name);
      // Only the active document is in this editor's hands; a host that
      // stores the others can mirror the rename there (the example app does).
      if (id === activeFile?.id && name.trim()) {
        applyTemplate(withMetaTitle(templateRef.current, name.trim()), { fit: false });
      }
    },
    [onFileRename, activeFile?.id, applyTemplate],
  );

  const metaTitle = typeof template.meta?.title === "string" ? template.meta.title.trim() : "";
  /**
   * The last (title, name) pair the two homes agreed on, per file. The
   * reconciler below needs it as a tiebreaker: on a mismatch, WHICH side
   * moved since they last agreed decides the direction. Without it, a
   * host-side rename (another tab, the host's own UI) would be read as a
   * stale name and reverted by the document's title.
   */
  const titleSyncRef = useRef<{ fileId: string; title: string; name: string } | null>(null);
  useEffect(() => {
    if (!activeFile) return;
    // The LIVE document, not the render closure: when a host switches file
    // without remounting, `template` still derives from the previous file's
    // canvas for one render — long enough for this to rename the new file to
    // the old file's title, and then write that title into it.
    const liveTitle =
      typeof templateRef.current.meta?.title === "string"
        ? templateRef.current.meta.title.trim()
        : "";
    const name = activeFile.name;
    const prev = titleSyncRef.current;
    const record = () => {
      titleSyncRef.current = { fileId: activeFile.id, title: liveTitle, name };
    };

    // Mount, or a different file became active: the document names itself.
    if (!prev || prev.fileId !== activeFile.id) {
      if (liveTitle && liveTitle !== name) onFileRename?.(activeFile.id, liveTitle);
      record();
      return;
    }

    if (liveTitle !== prev.title) {
      // The document's title moved (edit, import, generation, undo) — push it
      // out. Ties (both moved) resolve this way too: the document is truth.
      if (liveTitle && liveTitle !== name) onFileRename?.(activeFile.id, liveTitle);
    } else if (name !== prev.name && name.trim() && name !== liveTitle) {
      // Only the NAME moved — an external rename. Adopt it as the title, the
      // same committed, undoable edit the ✎ affordance makes.
      applyTemplate(withMetaTitle(templateRef.current, name.trim()), { fit: false });
    }
    record();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaTitle, activeFile?.id, activeFile?.name, onFileRename, applyTemplate]);

  const handleWelcomeDismiss = useCallback(
    (name: string) => {
      setWelcomeOpen(false);
      // With no files at all, "manually" still needs a file to land in. The
      // latch keeps that brand-new blank file from greeting all over again,
      // and the node waits for the file to exist rather than landing in the
      // document that is about to be replaced.
      if (zeroFiles && onFileCreate) {
        suppressNextWelcome();
        onFileCreate({ name, kind: "architecture" });
        return;
      }
      // The button says "Insert Node Manually", so insert one. It used to
      // just close the modal, leaving an empty canvas and a promise unkept —
      // and a first node is exactly what someone who picked "manually" is
      // about to make anyway.
      if (!readOnly) addNode("service");
    },
    [zeroFiles, onFileCreate, readOnly, addNode],
  );

  const runGenerate = useCallback(
    async (mode: "create" | "refine") => {
      if (!generate || busy) return;
      const input = mode === "create" ? createInput : refineInput;
      if (!input.trim()) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      setError("");

      try {
        const rOpts = registryOpts(registry);
        // Refine sends the content form and keeps the layout at home: the
        // reply is merged with the CURRENT document's presentation, so every
        // surviving element keeps its exact place and only genuinely new ones
        // get positions (stacked into their container, nothing else moves).
        const split = mode === "refine" ? splitTemplate(template, rOpts) : null;
        // While drilled in, refine works INSIDE the focused component — the
        // whole content doc still travels (ids stay stable), the model is
        // just told where the user is looking.
        const focusNode =
          split && rfFocusRef.current
            ? template.nodes.find((n) => n.id === rfFocusRef.current)
            : undefined;
        const focusScope = focusNode ? { id: focusNode.id, label: focusNode.label } : undefined;
        const result = await generate(
          {
            mode,
            input: split
              ? buildRefineMessage(split.content, input, { focus: focusScope })
              : input,
            systemPrompt: mode === "refine" ? refineSystemPrompt : systemPrompt,
            ...(split ? { current: split.content } : {}),
          },
          controller.signal,
        );
        let next = coerceGeneratorResult(result, rOpts);
        if (split) {
          // Whatever geometry the model emitted anyway is stripped by the
          // split; the document's own presentation is the only layout source —
          // taken from the LIVE document, not the request-time snapshot, so a
          // node dragged while the model was thinking keeps its new place.
          next = mergeTemplate(
            splitTemplate(next, rOpts).content,
            splitTemplate(templateRef.current, rOpts).presentation,
            rOpts,
          );
        } else if (hasOverlaps(next, { containerKinds: registry.containerKinds })) {
          // Models are good at topology and bad at coordinates. Tidy only when
          // the output is actually a mess, so a well-placed generated diagram
          // keeps the arrangement it was given. A fresh generation has no
          // arrangement to protect on ANY level, so every frame is fair game.
          next = autoLayout(next, {
            containerKinds: registry.containerKinds,
            frames: "all",
          });
        }
        // Count what the reply touched OUTSIDE the focused subtree before the
        // canvas re-materializes — a scoped refine that spilled over should
        // say so rather than change levels silently.
        let outsideChanges = 0;
        if (focusScope) {
          const inSubtree = (doc: DiagramTemplate, rootId: string) => {
            const ids = new Set([rootId]);
            let grew = true;
            while (grew) {
              grew = false;
              for (const n of doc.nodes) {
                if (!ids.has(n.id) && n.parentId && ids.has(n.parentId)) {
                  ids.add(n.id);
                  grew = true;
                }
              }
            }
            return ids;
          };
          const beforeIds = inSubtree(templateRef.current, focusScope.id);
          const afterIds = inSubtree(next, focusScope.id);
          const outsideDiff = diffTemplates(
            {
              ...templateRef.current,
              nodes: templateRef.current.nodes.filter((n) => !beforeIds.has(n.id)),
            },
            { ...next, nodes: next.nodes.filter((n) => !afterIds.has(n.id)) },
          );
          outsideChanges = outsideDiff.summary.added + outsideDiff.summary.removed + outsideDiff.summary.changed;
        }
        const focusRemoved = focusScope && !next.nodes.some((n) => n.id === focusScope.id);
        applyTemplate(next);
        if (mode === "refine") setRefineInput("");
        setPanelOpen(false);
        showToast(
          mode === "create"
            ? "Diagram generated"
            : focusRemoved
              ? "Refinement removed the focused element — returned to overview"
              : outsideChanges > 0
                ? `Refinement applied · ${outsideChanges} change${outsideChanges === 1 ? "" : "s"} outside this level`
                : "Refinement applied",
        );
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setError((err as Error).message || "Generation failed — try a shorter input.");
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [generate, busy, createInput, refineInput, template, systemPrompt, refineSystemPrompt, registry, applyTemplate, showToast],
  );

  useEffect(() => () => abortRef.current?.abort(), []);

  // ── Selection ─────────────────────────────────────────────────────────────

  const onSelectionChange = useCallback((params: OnSelectionChangeParams) => {
    const nodeIds = params.nodes.map((n) => n.id);
    const edgeIds = params.edges.map((e) => e.id);
    // Selecting something else ends any run of typing: the next keystroke is
    // a different edit and must undo on its own.
    const before = selectionRef.current;
    if (before.nodes.join() !== nodeIds.join() || before.edges.join() !== edgeIds.join()) {
      endHistoryRun();
    }
    // Mirrored into a ref because `materializeTemplate` runs outside render
    // and needs the CURRENT selection to carry it across a rebuild.
    selectionRef.current = { nodes: nodeIds, edges: edgeIds };
    setSelectedNodeIds(nodeIds);
    setSelectedEdgeIds(edgeIds);
  }, [endHistoryRun]);

  // Report the selection to the host in template terms: zone nodes drop their
  // canvas prefix, a collapse-rerouted edge resolves to the document edge it
  // stands in for (deduped — several hidden edges can share one stand-in),
  // a ghost resolves to the document element it projects, and the boundary
  // frame is nothing at all. Keyed by content, not array identity, so hosts
  // aren't re-rendered by the no-op selection events React Flow emits while
  // dragging.
  const lastReported = useRef("");
  useEffect(() => {
    if (!onHostSelectionChange) return;
    const selection: StudioSelection = {
      nodes: [
        ...new Set(
          selectedNodeIds
            .filter((id) => !isZoneNodeId(id) && !isBoundaryNodeId(id))
            .map((id) => (isGhostNodeId(id) ? ghostSourceId(id) : id)),
        ),
      ],
      edges: [
        ...new Set(
          selectedEdgeIds.map((id) =>
            isCollapsedEdgeId(id)
              ? id.slice(COLLAPSED_EDGE_PREFIX.length)
              : isGhostEdgeId(id)
                ? ghostSourceId(id)
                : id,
          ),
        ),
      ],
      zones: selectedNodeIds.filter(isZoneNodeId).map(fromZoneNodeId),
    };
    const key = JSON.stringify(selection);
    if (key === lastReported.current) return;
    lastReported.current = key;
    onHostSelectionChange(selection);
  }, [selectedNodeIds, selectedEdgeIds, onHostSelectionChange]);

  const singleSelected =
    selectedNodeIds.length === 1 ? nodes.find((n) => n.id === selectedNodeIds[0]) : undefined;
  // Zones share React Flow's node array but need their own inspector.
  const selectedZoneNode = singleSelected && isZoneNodeId(singleSelected.id) ? singleSelected : undefined;
  const selectedNode = singleSelected && !isZoneNodeId(singleSelected.id) ? singleSelected : undefined;
  const selectedEdge = selectedEdgeIds.length === 1 ? edges.find((e) => e.id === selectedEdgeIds[0]) : undefined;
  /** What a node is called, for the bar that says what a line joins. */
  const nodeLabelOf = (id: string): string =>
    ((nodes.find((n) => n.id === id)?.data as DiagramNodeData | undefined)?.label ?? id);

  /**
   * Turn a connection round.
   *
   * Everything that describes an END travels with it — the anchor, the field
   * reference, the cardinality, the head glyph — because they describe the box
   * that end touches, not the position in the tuple. A route drawn for the old
   * direction is dropped: it bent toward where the line used to go.
   */
  const swapEdgeEnds = useCallback(
    (id: string) => {
      if (readOnly) return;
      setEdges((current) =>
        current.map((e) => {
          if (e.id !== id) return e;
          const d = (e.data ?? {}) as DiagramEdgeData;
          const next: DiagramEdgeData = { ...d };
          [next.start, next.end] = [d.end, d.start];
          [next.startField, next.endField] = [d.endField, d.startField];
          [next.startLabel, next.endLabel] = [d.endLabel, d.startLabel];
          [next.startHead, next.endHead] = [d.endHead, d.startHead];
          delete next.points;
          for (const key of ["start", "end", "startField", "endField", "startLabel", "endLabel", "startHead", "endHead"] as const) {
            if (next[key] === undefined) delete next[key];
          }
          return { ...e, source: e.target, target: e.source, data: next };
        }),
      );
      commitLater();
    },
    [readOnly, setEdges, commitLater],
  );

  // The rows the selected edge's ends could attach to. Read off the canvas,
  // so a field added a moment ago is already offered.
  const edgeEndFields = (endId: string | undefined): readonly NodeField[] =>
    (endId ? (nodes.find((n) => n.id === endId)?.data as DiagramNodeData | undefined)?.fields : undefined) ?? [];

  // ── Zones ─────────────────────────────────────────────────────────────────

  const zones = template.zones ?? [];
  const scenarioProviders = useMemo(() => templateProviders(template), [template]);
  const scenario = useMemo(() => activeScenario(template), [template]);

  /** Providers actually in use right now, with how many zones show each. */
  const legendRows = useMemo(() => {
    const counts = new Map<string, number>();
    for (const zone of zones) counts.set(zone.provider, (counts.get(zone.provider) ?? 0) + 1);
    return [...counts.entries()].map(([id, count]) => ({
      id,
      count,
      def: providerDef(registry, id),
    }));
  }, [zones, registry]);

  const patchZone = useCallback(
    (zoneId: string, patch: Partial<DiagramZone>) => {
      if (readOnly) return;
      // Geometry patches go through the document so members scale with the
      // box — including provider-hidden members, which aren't in the store.
      if (patch.w != null || patch.h != null) {
        const doc = templateRef.current;
        const zone = doc.zones?.find((z) => z.id === zoneId);
        if (!zone) return;
        const before = { x: zone.x, y: zone.y, w: zone.w, h: zone.h };
        const after = {
          x: patch.x ?? zone.x,
          y: patch.y ?? zone.y,
          w: patch.w ?? zone.w,
          h: patch.h ?? zone.h,
        };
        const scaled = scaleZoneMembers(doc, zoneId, before, after, {
          containerKinds: registry.containerKinds,
          annotationKinds: registry.annotationKinds,
        });
        const { x: _x, y: _y, w: _w, h: _h, ...rest } = patch;
        const next = Object.keys(rest).length
          ? {
              ...scaled,
              zones: (scaled.zones ?? []).map((z) => (z.id === zoneId ? { ...z, ...rest } : z)),
            }
          : scaled;
        const rf = materializeTemplate(next);
        commit(rf.nodes as Node[], rf.edges as Edge[], next);
        return;
      }
      setNodes((current) =>
        current.map((n) => {
          if (n.id !== toZoneNodeId(zoneId)) return n;
          const zone = { ...(n.data as unknown as ZoneNodeData).zone, ...patch };
          return {
            ...n,
            data: { ...n.data, zone } as unknown as Node["data"],
          };
        }),
      );
      commitLater(typingRunKey("zone", zoneId, patch));
    },
    [readOnly, setNodes, commitLater, registry, materializeTemplate, commit],
  );

  // ── Selection commands (keyboard-first, all also reachable from the UI) ───

  const selectAll = useCallback(() => {
    // Only what the user could have clicked. Derived view elements — the
    // boundary frame you are inside, the ghost stand-ins for other levels —
    // are marked unselectable precisely because they are not editable here,
    // and selecting them makes the next arrow press move things that snap
    // back on the following derive.
    setNodes((current) =>
      current.map((n) => ({ ...n, selected: n.selectable === false ? false : true })),
    );
    setEdges((current) =>
      current.map((e) => ({ ...e, selected: e.selectable === false ? false : true })),
    );
  }, [setNodes, setEdges]);

  /**
   * After a rubber band, take the lines whose BOTH ends were caught.
   *
   * React Flow's marquee selects nodes only, so "select this subgraph and copy
   * it" came back without any of its wiring — and a fragment carries only the
   * edges wholly inside it, so the paste arrived unconnected. An edge between
   * two selected boxes is unambiguously part of what was selected.
   */
  const selectEnclosedEdges = useCallback(() => {
    const chosen = new Set(flow.getNodes().filter((n) => n.selected).map((n) => n.id));
    if (chosen.size < 2) return;
    setEdges((current) =>
      current.map((e) =>
        !e.selected && chosen.has(e.source) && chosen.has(e.target) ? { ...e, selected: true } : e,
      ),
    );
  }, [flow, setEdges]);

  /** Drop the selection without touching anything else. What Escape means. */
  const clearSelection = useCallback(() => {
    setNodes((current) => (current.some((n) => n.selected) ? current.map((n) => ({ ...n, selected: false })) : current));
    setEdges((current) => (current.some((e) => e.selected) ? current.map((e) => ({ ...e, selected: false })) : current));
  }, [setNodes, setEdges]);

  const cutSelection = useCallback(async () => {
    if (readOnly) return;
    const fragment = await copySelection();
    if (fragment) deleteSelection();
  }, [readOnly, copySelection, deleteSelection]);

  /**
   * Move the selection by a fixed step.
   *
   * Deliberately ours rather than React Flow's built-in arrow handling: RF
   * nudges the one FOCUSED node, which is not the same set as the selection
   * and cannot move a multi-selection at all. `disableKeyboardA11y` turns its
   * version off so the two can't both fire and double the distance.
   */
  const nudgeSelection = useCallback(
    (dx: number, dy: number) => {
      if (readOnly) return;
      const ids = new Set(selectedNodeIds);
      if (!ids.size) return;
      setNodes((current) =>
        current.map((n) =>
          ids.has(n.id) && !isNodeLocked(n)
            ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
            : n,
        ),
      );
      commitLater();
    },
    [readOnly, selectedNodeIds, setNodes, commitLater],
  );

  const toggleLockSelection = useCallback(() => {
    if (readOnly || !selectedNodeIds.length) return;
    // One press makes the whole selection agree rather than flipping each node
    // independently — a half-locked selection is not a state anyone wants.
    const anyUnlocked = selectedNodeIds.some((id) => {
      const node = flow.getNode(id);
      return node && !isNodeLocked(node);
    });
    for (const id of selectedNodeIds) {
      if (isZoneNodeId(id)) patchZone(fromZoneNodeId(id), { locked: anyUnlocked || undefined });
      else patchNode(id, { locked: anyUnlocked || undefined });
    }
  }, [readOnly, selectedNodeIds, flow, patchNode, patchZone]);

  /**
   * Restack a selected ZONE.
   *
   * Only zones have a stored `z`. A node's z-index is DERIVED from its nesting
   * depth into fixed painting bands (zones < containers < edges < leaves), so
   * "bring to front" on a node would either do nothing or break the invariant
   * that a container renders behind its own children. Zones are where the
   * command means something, so that is where it applies.
   */
  const restackZones = useCallback(
    (mode: "front" | "back" | "forward" | "backward") => {
      if (readOnly) return;
      const zoneIds = selectedNodeIds.filter(isZoneNodeId).map(fromZoneNodeId);
      if (!zoneIds.length) return;
      const all = templateRef.current.zones ?? [];
      const zs = all.map((z) => z.z ?? 0);
      const top = Math.max(0, ...zs);
      const bottom = Math.min(0, ...zs);
      for (const id of zoneIds) {
        const current = all.find((z) => z.id === id)?.z ?? 0;
        if (mode === "front" || mode === "back") {
          patchZone(id, { z: mode === "front" ? top + 1 : bottom - 1 });
          continue;
        }
        // One step is a SWAP with the neighbour, not a ±1 on z. Incrementing
        // would only tie with the zone above — and `zoneAt` breaks a tie by
        // array order, so the press would appear to do nothing.
        const forward = mode === "forward";
        const neighbours = all
          .filter((z) => z.id !== id && (forward ? (z.z ?? 0) > current : (z.z ?? 0) < current))
          .sort((a, b) => (forward ? (a.z ?? 0) - (b.z ?? 0) : (b.z ?? 0) - (a.z ?? 0)));
        const swap = neighbours[0];
        if (!swap) continue;
        patchZone(id, { z: swap.z ?? 0 });
        patchZone(swap.id, { z: current });
      }
    },
    [readOnly, selectedNodeIds, patchZone],
  );

  /** Padding between a new group's frame and the nodes it was drawn around. */
  const GROUP_PAD = { side: 24, top: 48 };

  /**
   * Wrap the selection in a new container.
   *
   * Grouping is real nesting here, not a selection set: the new node becomes
   * the children's `parentId`, so it drags them, collapses them, and drills
   * into them. Positions go from absolute to parent-relative in the same pass,
   * which is what `parentId` means in this schema.
   */
  const groupSelection = useCallback(() => {
    if (readOnly) return;
    const ids = selectedNodeIds.filter((id) => !isZoneNodeId(id));
    if (ids.length < 1) return;

    const boxes = ids
      .map((id) => {
        const internal = flow.getInternalNode(id);
        if (!internal) return null;
        return {
          id,
          x: internal.internals.positionAbsolute.x,
          y: internal.internals.positionAbsolute.y,
          w: (internal.measured?.width as number) ?? 170,
          h: (internal.measured?.height as number) ?? 76,
        };
      })
      .filter((b): b is NonNullable<typeof b> => b !== null);
    if (!boxes.length) return;

    // Only top-level members are re-parented: a node whose own parent is also
    // in the selection already travels with it, and re-parenting it here would
    // flatten the nesting the user built.
    const chosen = new Set(ids);
    const roots = boxes.filter((b) => {
      const parent = flow.getNode(b.id)?.parentId;
      return !parent || !chosen.has(parent);
    });
    if (!roots.length) return;

    const minX = Math.min(...roots.map((b) => b.x)) - GROUP_PAD.side;
    const minY = Math.min(...roots.map((b) => b.y)) - GROUP_PAD.top;
    const maxX = Math.max(...roots.map((b) => b.x + b.w)) + GROUP_PAD.side;
    const maxY = Math.max(...roots.map((b) => b.y + b.h)) + GROUP_PAD.side;

    const groupId = nextId("group");
    const groupNode: Node = {
      id: groupId,
      type: "group",
      position: { x: minX, y: minY },
      width: maxX - minX,
      height: maxY - minY,
      style: { width: maxX - minX, height: maxY - minY },
      zIndex: 0,
      selected: true,
      data: {
        label: "New Group",
        kind: "group",
        icon: "none",
        description: "",
        fontSize: DEFAULT_FONT_SIZE,
        ...(timelineAtRef.current ? { date: timelineAtRef.current } : {}),
      } satisfies DiagramNodeData,
    };

    const rootIds = new Set(roots.map((b) => b.id));
    setNodes((current) => {
      const next = current.map((n) => {
        if (!rootIds.has(n.id)) return { ...n, selected: false };
        const box = roots.find((b) => b.id === n.id)!;
        return {
          ...n,
          parentId: groupId,
          // Absolute → parent-relative, which is what the child now stores.
          position: { x: box.x - minX, y: box.y - minY },
          selected: false,
        };
      });
      // React Flow requires a parent to appear before its children.
      return sortByDepth([...next, groupNode]);
    });
    commitLater();
    showToast(`Grouped ${roots.length} node${roots.length === 1 ? "" : "s"}`);
  }, [readOnly, selectedNodeIds, flow, setNodes, commitLater, showToast]);

  /** Unwrap: children go back to the group's own parent, the frame is removed. */
  const ungroupSelection = useCallback(() => {
    if (readOnly) return;
    const groupIds = selectedNodeIds.filter((id) => {
      const node = flow.getNode(id);
      return node && kindDef(registry, (node.data as DiagramNodeData).kind).container;
    });
    if (!groupIds.length) return;

    const all = flow.getNodes();
    setNodes((current) => {
      const next = current
        .map((n) => {
          if (!n.parentId || !groupIds.includes(n.parentId)) return n;
          const group = all.find((g) => g.id === n.parentId)!;
          return {
            ...n,
            parentId: group.parentId,
            // The child was relative to the group; make it relative to
            // whatever the group itself was relative to.
            position: { x: n.position.x + group.position.x, y: n.position.y + group.position.y },
            selected: true,
          };
        })
        .filter((n) => !groupIds.includes(n.id));
      return sortByDepth(next);
    });
    commitLater();
    showToast(`Ungrouped ${groupIds.length} container${groupIds.length === 1 ? "" : "s"}`);
  }, [readOnly, selectedNodeIds, flow, registry, setNodes, commitLater, showToast]);

  // ── Nesting: moving contents between C4 levels ────────────────────────────
  //
  // Both directions are pure document transforms (contract/nesting.ts) that
  // only change a node's KIND and geometry — which is enough, because "renders
  // inside the frame" versus "is a level deeper" is decided by nothing else.
  // They go through `applyTemplate` rather than `setNodes`: this changes which
  // nodes exist on the canvas, so the whole document is the honest unit, and
  // one undo entry covers the restructure. `fit: false` keeps the viewport
  // where the user left it.

  /** The dialog's subject, or null when it is closed. */
  const [pendingNest, setPendingNest] = useState<{
    id: string;
    label: string;
    count: number;
    mode: "nest" | "inline";
  } | null>(null);

  const runNesting = useCallback(
    (kind: string) => {
      const pending = pendingNest;
      setPendingNest(null);
      if (!pending || readOnly) return;
      const opts = { containerKinds: registry.containerKinds };
      const next =
        pending.mode === "nest"
          ? nestContents(templateRef.current, pending.id, {
              ...opts,
              kind,
              icon: kindDef(registry, kind).icon,
            })
          : inlineContents(templateRef.current, pending.id, opts);
      if (next === templateRef.current) return;
      applyTemplate(next, { fit: false });
      const nodes = `${pending.count} node${pending.count === 1 ? "" : "s"}`;
      showToast(
        pending.mode === "nest"
          ? `Nested ${nodes} a level deeper`
          : `Brought ${nodes} back to this level`,
      );
    },
    [pendingNest, readOnly, registry, applyTemplate, showToast],
  );

  // ── Keyboard ──────────────────────────────────────────────────────────────
  //
  // One window-level handler owns every binding, so precedence is readable top
  // to bottom instead of scattered across elements. Conventions follow
  // Excalidraw wherever this editor has the same concept; the three places
  // they could not, and why, are commented at the point of divergence.

  /** Any dialog is up, so the canvas is not what the keyboard is aimed at. */
  const modalOpen = welcomeOpen || !!pendingExport || !!pendingNest;

  /**
   * Whether a keystroke on `window` was meant for THIS editor.
   *
   * The handler has to be on `window` — the canvas is not focusable and the
   * user is usually pointing at it rather than tabbed into it — but "on
   * window" is not the same as "for us". Embedded in a panel, the editor was
   * answering Delete, N and the arrows while the user worked in the host's own
   * UI, and two mounted studios both answered every key.
   *
   * Three signals, in order of how sure each one is:
   *   focus inside us            → certainly ours
   *   focus on something else    → certainly not ours
   *   focus nowhere (the usual
   *   state after a canvas click) → whichever editor was touched last
   */
  const ownsKeyboard = useCallback((): boolean => {
    const root = rootRef.current;
    if (!root) return false;
    const active = typeof document !== "undefined" ? document.activeElement : null;
    if (active && active !== document.body) return root.contains(active);
    return activeStudio === studioId;
  }, [studioId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      // A dialog owns the keyboard while it is up. Without this, N inserts a
      // node behind the welcome modal, Delete removes the very group a Nesting
      // dialog is about to convert, and ⌘V pastes a fragment straight past the
      // paste box's own name field and lint. Escape still reaches the modal —
      // it registers its own capture listener — so this only silences the
      // shortcuts that would act on a canvas nobody can see.
      if (modalOpen) return;

      // A few chords belong to the application rather than to whatever has
      // focus, and are handled BEFORE the typing guard: "rename the node, hit
      // ⌘S" is the most natural sequence here, and standing down would hand
      // the key to the browser's Save-Page dialog.
      // (Excalidraw spends ⌘K on links; here search is both older and more
      //  valuable, so links take ⌘⇧K instead.)
      if (mod && key === "k" && !event.shiftKey) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (mod && event.shiftKey && key === "k") {
        event.preventDefault();
        linkInputRef.current?.focus();
        linkInputRef.current?.select();
        return;
      }
      if (mod && key === "s" && onSave) {
        event.preventDefault();
        void handleSave();
        return;
      }
      if (isTypingTarget(event.target)) return;

      // Everything below acts on the canvas, so it only applies while the
      // pointer or focus is actually in this editor. Two studios on one page
      // both answering Delete — or one answering it while the user is working
      // in the host's own UI — is the same class of bug as the modal case.
      if (!ownsKeyboard()) return;

      // Compare shows a diff rather than the document, so shortcuts that would
      // edit what the user cannot see are blocked. Timeline mode is NOT in
      // this list: it shows the real canvas, and editing it is the point.
      const editing = !readOnly && !activeDiffBase;
      if (
        activeDiffBase &&
        (event.key === "Delete" ||
          event.key === "Backspace" ||
          (mod && ["c", "v", "d", "x", "g", "a"].includes(key)))
      ) {
        return;
      }

      // ── History ──
      if (mod && key === "z") {
        event.preventDefault();
        if (event.shiftKey) doRedo();
        else doUndo();
        return;
      }
      if (mod && key === "y") {
        event.preventDefault();
        doRedo();
        return;
      }

      // ── Clipboard ──
      if (mod && key === "c") {
        // With nothing selected there is no fragment to copy, so the browser's
        // own copy must be left alone — otherwise text selected anywhere else
        // on the host page cannot be copied while this editor is mounted.
        if (!selectedNodeIds.length && !selectedEdgeIds.length) return;
        // Otherwise suppress it: the native copy races the async clipboard
        // write in copySelection and lands the DOM text selection on the
        // clipboard instead of the fragment.
        event.preventDefault();
        void copySelection();
        return;
      }
      if (mod && key === "v") {
        event.preventDefault();
        void pasteClipboard();
        return;
      }
      if (mod && key === "x") {
        event.preventDefault();
        void cutSelection();
        return;
      }
      if (mod && key === "d") {
        event.preventDefault();
        void duplicateSelection();
        return;
      }
      if (mod && key === "a") {
        event.preventDefault();
        selectAll();
        return;
      }

      // ── Structure ──
      if (mod && key === "g") {
        event.preventDefault();
        if (event.shiftKey) ungroupSelection();
        else groupSelection();
        return;
      }
      if (mod && event.shiftKey && key === "l") {
        event.preventDefault();
        toggleLockSelection();
        return;
      }
      if (mod && event.shiftKey && key === "e") {
        event.preventDefault();
        void runExport("png");
        return;
      }
      // Only zones carry a stored z — see restackZones for why nodes cannot.
      if (mod && (event.key === "]" || event.key === "[")) {
        event.preventDefault();
        const forward = event.key === "]";
        restackZones(
          event.shiftKey ? (forward ? "front" : "back") : forward ? "forward" : "backward",
        );
        return;
      }

      // ── View ──
      if (mod && (event.key === "=" || event.key === "+")) {
        event.preventDefault();
        void flow.zoomIn({ duration: 120 });
        return;
      }
      if (mod && event.key === "-") {
        event.preventDefault();
        void flow.zoomOut({ duration: 120 });
        return;
      }
      if (mod && event.key === "0") {
        event.preventDefault();
        void flow.zoomTo(1, { duration: 120 });
        return;
      }
      if (mod && event.key === "'") {
        event.preventDefault();
        setSnapEnabled((on) => !on);
        return;
      }
      // Matched on `code`, not `key`: ⇧1 produces "!" on a US layout and
      // something else on most others, but the physical key is Digit1 everywhere.
      if (event.shiftKey && !mod && event.code === "Digit1") {
        event.preventDefault();
        void flow.fitView({ padding: 0.15, duration: 300 });
        return;
      }
      if (event.shiftKey && !mod && event.code === "Digit2") {
        event.preventDefault();
        const nodes = selectedNodeIds.map((id) => ({ id }));
        if (nodes.length) void flow.fitView({ nodes, padding: 0.3, duration: 300 });
        return;
      }
      if (event.key === "?") {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      // ── Rename the selection in place ──
      if (
        editing &&
        !mod &&
        (event.key === "F2" || event.key === "Enter") &&
        selectedNodeIds.length === 1 &&
        !selectedEdgeIds.length
      ) {
        const id = selectedNodeIds[0]!;
        if (!isGhostNodeId(id) && !isBoundaryNodeId(id)) {
          event.preventDefault();
          setRenamingId(id);
          return;
        }
      }

      // ── Insert. Single letters, so they must not fire with a modifier. ──
      if (editing && !mod && !event.altKey) {
        const insert: Record<string, () => void> = {
          n: () => addNode("service"),
          g: () => addNode("group"),
          t: () => addNode("text"),
          z: () => addZone(),
        };
        if (insert[key]) {
          event.preventDefault();
          insert[key]();
          return;
        }
      }

      // ── Arrows. Three-way contention, resolved by what is selected: ──
      //  * a selection  → nudge it (React Flow's own arrow handling is off,
      //                   see nudgeSelection);
      //  * nothing, but scrubbing → walk the timeline stop to stop.
      if (event.key.startsWith("Arrow")) {
        const step = event.shiftKey ? 10 : 1;
        const [dx, dy] =
          event.key === "ArrowLeft" ? [-step, 0]
          : event.key === "ArrowRight" ? [step, 0]
          : event.key === "ArrowUp" ? [0, -step]
          : [0, step];

        if (selectedNodeIds.length) {
          event.preventDefault();
          if (mod && event.shiftKey) {
            // ⌘⇧arrow aligns instead of moving, as Excalidraw does.
            alignSelection(
              event.key === "ArrowLeft" ? "left"
              : event.key === "ArrowRight" ? "right"
              : event.key === "ArrowUp" ? "top"
              : "bottom",
            );
          } else {
            nudgeSelection(dx, dy);
          }
          return;
        }
        if (
          timelineActive &&
          !selectedEdgeIds.length &&
          (event.key === "ArrowLeft" || event.key === "ArrowRight")
        ) {
          event.preventDefault();
          stepTimelineStop(event.key === "ArrowRight" ? 1 : -1);
          return;
        }
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelection();
        return;
      }
      if (event.key === "Escape") {
        // One thing per press, outermost first. Closing every panel at once
        // meant dismissing the shortcuts sheet also threw away the timeline
        // cursor you had scrubbed to; and jumping straight to drill-out meant
        // Escape with a node selected left the level instead of doing the one
        // thing Escape means everywhere else.
        if (shortcutsOpen) {
          setShortcutsOpen(false);
          return;
        }
        if (openMenu !== null) {
          setOpenMenu(null);
          return;
        }
        if (panelOpen) {
          setPanelOpen(false);
          return;
        }
        if (selectedNodeIds.length || selectedEdgeIds.length) {
          clearSelection();
          return;
        }
        if (timelineCursor !== null) {
          setTimelineCursor(null);
          return;
        }
        if (focusStackRef.current.length) drillOut();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doUndo, doRedo, deleteSelection, onSave, template, copySelection, pasteClipboard, duplicateSelection, cutSelection, selectAll, clearSelection, nudgeSelection, alignSelection, groupSelection, ungroupSelection, toggleLockSelection, restackZones, runExport, addNode, addZone, flow, readOnly, shortcutsOpen, activeDiffBase, timelineActive, stepTimelineStop, selectedNodeIds, selectedEdgeIds, openMenu, panelOpen, timelineCursor, drillOut, modalOpen, ownsKeyboard, handleSave]);

  // ── Zone resize gesture ───────────────────────────────────────────────────
  //
  // Membership is captured at resize START: the per-frame derive re-judges
  // membership against the mid-drag box, so a shrink would strip the very
  // members the scale is meant to move, and a grow would enrol bystanders
  // that must not be scaled by after/before.
  const zoneScaleRef = useRef<{ zoneId: string; before: ZoneBox; memberIds: string[] } | null>(
    null,
  );

  const beginZoneResize = useCallback((zoneId: string, before: ZoneBox) => {
    const memberIds = templateRef.current.nodes
      .filter((n) => n.zoneId === zoneId && !n.parentId)
      .map((n) => n.id);
    zoneScaleRef.current = { zoneId, before, memberIds };
  }, []);

  const endZoneResize = useCallback(
    (zoneId: string, after: ZoneBox) => {
      const gesture = zoneScaleRef.current;
      zoneScaleRef.current = null;
      // Freshest store state, same reason commitLater defers.
      queueMicrotask(() => {
        const currentNodes = flow.getNodes();
        const currentEdges = flow.getEdges();
        const doc = deriveTemplate(currentNodes, currentEdges);
        if (!gesture || gesture.zoneId !== zoneId) {
          commit(currentNodes, currentEdges, doc);
          return;
        }
        const next = scaleZoneMembers(doc, zoneId, gesture.before, after, {
          memberIds: gesture.memberIds,
          containerKinds: registry.containerKinds,
          annotationKinds: registry.annotationKinds,
        });
        if (next === doc) {
          // Memberless zone — today's behavior, one plain commit.
          commit(currentNodes, currentEdges, doc);
          return;
        }
        const rf = materializeTemplate(next);
        commit(rf.nodes as Node[], rf.edges as Edge[], next);
      });
    },
    [flow, deriveTemplate, commit, registry, materializeTemplate],
  );

  // ── Slots ─────────────────────────────────────────────────────────────────

  const slotContext: StudioSlotContext = useMemo(
    () => ({ template, registry, setTemplate: (next) => applyTemplate(next, { fit: false }) }),
    [template, registry, applyTemplate],
  );
  const renderSlot = (slot: ArchitectureStudioProps["toolbarExtras"]) =>
    typeof slot === "function" ? slot(slotContext) : slot;

  // ── Render ────────────────────────────────────────────────────────────────

  // Direct-child counts, identity-stabilized on the parent LINKS rather than
  // the template object — a drag that changes only coordinates must not
  // re-render every memoized node card.
  const childCountsSig = useMemo(
    () => template.nodes.map((n) => `${n.id}→${n.parentId ?? ""}`).join("|"),
    [template],
  );
  const childCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const part of childCountsSig ? childCountsSig.split("|") : []) {
      const parent = part.slice(part.indexOf("→") + 1);
      if (parent) counts.set(parent, (counts.get(parent) ?? 0) + 1);
    }
    return counts;
  }, [childCountsSig]);

  /**
   * What the selected node affords about nesting, or nothing. A container
   * with contents can push them a level deeper; a card that already has
   * contents can bring them back. A node with no children affords neither —
   * there is nothing to move either way.
   */
  const nesting = useMemo(() => {
    if (readOnly || !selectedNode || isGhostNodeId(selectedNode.id)) return null;
    const count = childCounts.get(selectedNode.id) ?? 0;
    if (!count) return null;
    const data = selectedNode.data as DiagramNodeData;
    return {
      id: selectedNode.id,
      label: data.label,
      count,
      mode: kindDef(registry, data.kind).container ? ("nest" as const) : ("inline" as const),
    };
  }, [readOnly, selectedNode, childCounts, registry]);

  const focusContext = useMemo(
    () => (focusId ? { id: focusId, depth: focusStack.length } : null),
    [focusId, focusStack.length],
  );

  const studioContext = useMemo(
    () => ({
      registry,
      readOnly,
      tagFilter,
      showTeams,
      requestCommit: commitLater,
      beginZoneResize,
      endZoneResize,
      navigateFile: onNavigateFile,
      focus: focusContext,
      drillInto,
      navigateToNode,
      childCounts,
      renamingId,
      setRenamingId,
      showToast,
    }),
    [registry, readOnly, tagFilter, showTeams, commitLater, beginZoneResize, endZoneResize, onNavigateFile, focusContext, drillInto, navigateToNode, childCounts, renamingId, showToast],
  );
  const rootStyle = { ...themeToStyle(theme), ...style };

  return (
    <StudioContext.Provider value={studioContext}>
      <div
        ref={rootRef}
        className={`as-root${className ? ` ${className}` : ""}`}
        style={rootStyle}
        onPointerDownCapture={() => {
          activeStudio = studioId;
        }}
      >
        <div className="as-toolbar">
          {files?.length ? (
            <FileMenu
              files={files}
              activeFileId={activeFileId}
              open={openMenu === "files"}
              onToggle={() => toggleMenu("files")}
              onSelect={(id) => {
                setOpenMenu(null);
                onFileSelect?.(id);
              }}
              onCreate={onFileCreate}
              onRename={onFileRename ? renameFile : undefined}
              onDelete={onFileDelete}
              removedFiles={removedFiles}
              onFileRestore={onFileRestore}
            />
          ) : (
            <div className="as-brand">arch·studio</div>
          )}

          {generate && !readOnly ? (
            <button
              type="button"
              className={`as-btn ${panelOpen ? "as-btn--on" : "as-btn--primary"}`}
              onClick={() => setPanelOpen((open) => !open)}
            >
              ✦ AI
            </button>
          ) : null}

          {!readOnly ? (
            <div className="as-toolbar__group">
              <ToolbarMenu
                label="Insert"
                title="Add elements to the diagram"
                open={openMenu === "insert"}
                onToggle={() => toggleMenu("insert")}
                menuClassName="as-menu--left"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="as-menu__item"
                  onClick={() => {
                    addNode("service");
                    setOpenMenu(null);
                  }}
                >
                  <div className="as-menu__label">Node</div>
                  <div className="as-menu__hint">A service box — retype it in the inspector</div>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="as-menu__item"
                  onClick={() => {
                    addNode("table");
                    setOpenMenu(null);
                  }}
                >
                  <div className="as-menu__label">Table</div>
                  <div className="as-menu__hint">An entity with columns — for data models</div>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="as-menu__item"
                  onClick={() => {
                    addNode("group");
                    setOpenMenu(null);
                  }}
                >
                  <div className="as-menu__label">Group</div>
                  <div className="as-menu__hint">A container other nodes nest inside</div>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="as-menu__item"
                  onClick={() => {
                    addNode("text");
                    setOpenMenu(null);
                  }}
                >
                  <div className="as-menu__label">Text</div>
                  <div className="as-menu__hint">A free-floating annotation</div>
                </button>
                <div className="as-menu__sep" role="separator" />
                {(
                  [
                    ["llm", "LLM", "Frontier model, typically hosted"],
                    ["lm-medium", "Medium LM", "Self-hosted mid-size model"],
                    ["lm-small", "Small LM", "On-device or a few B params"],
                  ] as const
                ).map(([kind, label, hint]) => (
                  <button
                    key={kind}
                    type="button"
                    role="menuitem"
                    className="as-menu__item"
                    onClick={() => {
                      addNode(kind);
                      setOpenMenu(null);
                    }}
                  >
                    <div className="as-menu__label">{label}</div>
                    <div className="as-menu__hint">{hint}</div>
                  </button>
                ))}
                <div className="as-menu__sep" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="as-menu__item"
                  onClick={() => {
                    addNode("terminator");
                    setOpenMenu(null);
                  }}
                >
                  <div className="as-menu__label">Start / End</div>
                  <div className="as-menu__hint">Flow-chart terminator (stadium)</div>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="as-menu__item"
                  onClick={() => {
                    addNode("decision");
                    setOpenMenu(null);
                  }}
                >
                  <div className="as-menu__label">Decision</div>
                  <div className="as-menu__hint">Flow-chart branch (diamond) — label its edges yes/no</div>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="as-menu__item"
                  onClick={() => {
                    addNode("io");
                    setOpenMenu(null);
                  }}
                >
                  <div className="as-menu__label">Input / Output</div>
                  <div className="as-menu__hint">Flow-chart I/O (parallelogram)</div>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="as-menu__item"
                  onClick={() => {
                    addZone();
                    setOpenMenu(null);
                  }}
                >
                  <div className="as-menu__label">Zone</div>
                  <div className="as-menu__hint">A shaped infra background region</div>
                </button>
              </ToolbarMenu>

              <ToolbarMenu
                label="Arrange"
                title="Layout, alignment, routing, and snapping"
                open={openMenu === "arrange"}
                onToggle={() => toggleMenu("arrange")}
                menuClassName="as-menu--left"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="as-menu__item"
                  onClick={() => {
                    tidy();
                    setOpenMenu(null);
                  }}
                >
                  <div className="as-menu__label">Tidy</div>
                  <div className="as-menu__hint">Arrange nodes within their zones and groups</div>
                </button>
                <div className="as-menu__sep" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="as-menu__item"
                  disabled={nesting?.mode !== "nest"}
                  title={
                    nesting?.mode === "nest"
                      ? undefined
                      : "Select a group that has something in it"
                  }
                  onClick={() => {
                    if (nesting?.mode === "nest") setPendingNest(nesting);
                    setOpenMenu(null);
                  }}
                >
                  <div className="as-menu__label">Nest contents a level deeper</div>
                  <div className="as-menu__hint">
                    The frame becomes one card; its contents move to their own C4 level
                  </div>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="as-menu__item"
                  disabled={nesting?.mode !== "inline"}
                  title={
                    nesting?.mode === "inline"
                      ? undefined
                      : "Select a card that has a level inside it"
                  }
                  onClick={() => {
                    if (nesting?.mode === "inline") setPendingNest(nesting);
                    setOpenMenu(null);
                  }}
                >
                  <div className="as-menu__label">Show contents inline</div>
                  <div className="as-menu__hint">
                    Bring a card's internals back onto this level, inside a frame
                  </div>
                </button>
                <div className="as-menu__sep" role="separator" />
                {(
                  [
                    ["left", "⇤ Align left"],
                    ["centerX", "⇹ Align centre"],
                    ["right", "⇥ Align right"],
                    ["top", "⤒ Align top"],
                    ["centerY", "⇳ Align middle"],
                    ["bottom", "⤓ Align bottom"],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    role="menuitem"
                    className="as-menu__item"
                    disabled={selectedDiagramIds.length < 2}
                    title={selectedDiagramIds.length < 2 ? "Select at least two nodes" : undefined}
                    onClick={() => alignSelection(mode)}
                  >
                    <div className="as-menu__label">{label}</div>
                  </button>
                ))}
                <button
                  type="button"
                  role="menuitem"
                  className="as-menu__item"
                  disabled={selectedDiagramIds.length < 3}
                  title={selectedDiagramIds.length < 3 ? "Select at least three nodes" : undefined}
                  onClick={() => distributeSelection("x")}
                >
                  <div className="as-menu__label">↔ Distribute horizontally</div>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="as-menu__item"
                  disabled={selectedDiagramIds.length < 3}
                  title={selectedDiagramIds.length < 3 ? "Select at least three nodes" : undefined}
                  onClick={() => distributeSelection("y")}
                >
                  <div className="as-menu__label">↕ Distribute vertically</div>
                </button>
                <div className="as-menu__sep" role="separator" />
                {/* Unnamed radios: each is its own group, so two studios on
                    one page can't capture each other's dots. Checked state is
                    controlled from the document either way. */}
                <label
                  className="as-menu__check"
                  title="Smooth splines for the whole diagram (per-edge overrides win)"
                >
                  <input
                    type="radio"
                    checked={routing === "curved"}
                    onChange={() => setDefaultRouting("curved")}
                  />
                  Curved connectors
                </label>
                <label
                  className="as-menu__check"
                  title="Right-angle connectors for the whole diagram (per-edge overrides win)"
                >
                  <input
                    type="radio"
                    checked={routing === "orthogonal"}
                    onChange={() => setDefaultRouting("orthogonal")}
                  />
                  Right-angle connectors
                </label>
                <label
                  className="as-menu__check"
                  title="Direct point-to-point lines for the whole diagram (per-edge overrides win)"
                >
                  <input
                    type="radio"
                    checked={routing === "straight"}
                    onChange={() => setDefaultRouting("straight")}
                  />
                  Straight connectors
                </label>
                <label className="as-menu__check" title="Snap dragging to the grid">
                  <input
                    type="checkbox"
                    checked={snapEnabled}
                    onChange={() => setSnapEnabled((on) => !on)}
                  />
                  Snap to grid
                </label>
              </ToolbarMenu>
            </div>
          ) : null}

          {/* Always present. It was gated on having something provider-,
              tag- or team-shaped to say, which meant a diagram with a version
              tag and no tags lost the menu — taking Keyboard shortcuts, the
              only route to the `?` sheet from the UI, with it. */}
          {true ? (
            <div className="as-toolbar__group">
              <ToolbarMenu
                label={`View${tagFilter.length ? ` (${tagFilter.length})` : ""}`}
                title="Hidden nodes, team badges, and tag filtering"
                active={tagFilter.length > 0 || showHidden}
                open={openMenu === "view"}
                onToggle={() => toggleMenu("view")}
                menuClassName="as-menu--left"
              >
                {!readOnly && (hiddenCount > 0 || showHidden) ? (
                  <label
                    className="as-menu__check"
                    title="Show nodes hidden by the current provider selection, so they can still be edited"
                  >
                    <input
                      type="checkbox"
                      checked={showHidden}
                      onChange={() => setShowHidden((on) => !on)}
                    />
                    Show hidden nodes{hiddenCount ? ` (${hiddenCount})` : ""}
                  </label>
                ) : null}
                {anyTeams ? (
                  <label className="as-menu__check" title="Show each node's owning-team tag">
                    <input
                      type="checkbox"
                      checked={showTeams}
                      onChange={() => setShowTeams((on) => !on)}
                    />
                    Show team badges
                  </label>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className="as-menu__item"
                  onClick={() => {
                    setShortcutsOpen(true);
                    setOpenMenu(null);
                  }}
                >
                  <div className="as-menu__label">Keyboard shortcuts</div>
                  <div className="as-menu__hint">Or press ?</div>
                </button>
                {!readOnly && !versionTag ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="as-menu__item"
                    onClick={() => {
                      // Create it and put the cursor in it, rather than
                      // writing a placeholder and leaving the user to find the
                      // corner chip that now says "v0.1". The ellipsis
                      // promises somewhere to type; this is that place.
                      patchVersionTag({ versionTag: "v0.1" });
                      setOpenMenu(null);
                      setEditVersionTag(true);
                    }}
                  >
                    <div className="as-menu__label">Set version tag…</div>
                    <div className="as-menu__hint">A revision notice pinned in a corner</div>
                  </button>
                ) : null}
                {allTags.length ? (
                  <>
                    <div className="as-menu__caption">Dim nodes without tag</div>
                    {allTags.map((tag) => (
                      <label key={tag} className="as-menu__check">
                        <input
                          type="checkbox"
                          checked={tagFilter.includes(tag)}
                          onChange={() =>
                            setTagFilter((current) =>
                              current.includes(tag)
                                ? current.filter((t) => t !== tag)
                                : [...current, tag],
                            )
                          }
                        />
                        {tag}
                      </label>
                    ))}
                    {tagFilter.length ? (
                      <button
                        type="button"
                        className="as-menu__item"
                        onClick={() => {
                          setTagFilter([]);
                          setOpenMenu(null);
                        }}
                      >
                        <div className="as-menu__label">Clear filter</div>
                      </button>
                    ) : null}
                  </>
                ) : null}
              </ToolbarMenu>
            </div>
          ) : null}

          {/* Global scenario control — drives every zone that offers the
              provider, for the "show me the all-AWS build" case. */}
          {scenarioProviders.length > 1 && !readOnly ? (
            <div className="as-toolbar__group">
              <label className="as-scenario">
                <span className="as-scenario__label">Scenario</span>
                <select
                  className="as-select as-scenario__select"
                  value={scenario ?? "__mixed__"}
                  onChange={(event) => setScenario(event.target.value)}
                >
                  {scenario === null ? (
                    <option value="__mixed__" disabled>
                      Mixed
                    </option>
                  ) : null}
                  {scenarioProviders.map((p) => (
                    <option key={p} value={p}>
                      {providerDef(registry, p).label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}

          {!readOnly ? (
            <div className="as-toolbar__group">
              <button
                type="button"
                className="as-btn as-btn--icon"
                onClick={doUndo}
                disabled={!history.canUndo}
                title={`Undo (${modKey}Z)`}
                aria-label="Undo"
              >
                ↺
              </button>
              <button
                type="button"
                className="as-btn as-btn--icon"
                onClick={doRedo}
                disabled={!history.canRedo}
                title={`Redo (⇧${modKey}Z)`}
                aria-label="Redo"
              >
                ↻
              </button>
            </div>
          ) : null}

          <div className="as-toolbar__group">
            <ToolbarMenu
              label={findings.length ? `Checks (${findings.length})` : "Checks ✓"}
              title="Architecture lint — governance findings for this document"
              active={findings.some((f) => f.severity === "error")}
              open={openMenu === "checks"}
              onToggle={() => toggleMenu("checks")}
              menuClassName="as-menu--left"
            >
              {findings.length === 0 ? (
                <div className="as-menu__caption">All checks pass</div>
              ) : (
                findings.map((finding, i) => (
                  <button
                    key={`${finding.rule}:${i}`}
                    type="button"
                    role="menuitem"
                    className="as-menu__item"
                    onClick={() => {
                      jumpToFinding(finding);
                      setOpenMenu(null);
                    }}
                  >
                    <div className="as-menu__label">
                      <span className={`as-lint as-lint--${finding.severity}`} aria-hidden="true">
                        ●
                      </span>{" "}
                      {registry.lintRules[finding.rule]?.label ?? finding.rule}
                    </div>
                    <div className="as-menu__hint">{finding.message}</div>
                  </button>
                ))
              )}
            </ToolbarMenu>
          </div>

          {renderSlot(toolbarExtras)}

          <div className="as-toolbar__group as-toolbar__spacer">
            <input
              ref={searchInputRef}
              className="as-input as-search"
              value={searchQuery}
              placeholder={`Search… (${modKey}K)`}
              aria-label="Search nodes"
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setSearchIndex(-1);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && searchMatches.length) {
                  // `searchIndex` is the match the canvas is CENTRED on, and
                  // -1 means "typed but not yet jumped" — so the first Enter
                  // lands on match 1 and the readout agrees with it. Advancing
                  // before jumping left the counter one ahead of the node the
                  // user was looking at.
                  const n = searchMatches.length;
                  const next =
                    searchIndex < 0
                      ? event.shiftKey
                        ? n - 1
                        : 0
                      : (searchIndex + (event.shiftKey ? -1 : 1) + n) % n;
                  setSearchIndex(next);
                  jumpToMatch(next);
                }
                if (event.key === "Escape") {
                  setSearchQuery("");
                  (event.target as HTMLInputElement).blur();
                }
                event.stopPropagation();
              }}
            />
            {searchQuery ? (
              <span
                className="as-search__count"
                aria-live="polite"
                title="Enter for the next match, ⇧Enter for the previous"
              >
                {searchMatches.length
                  ? `${(searchIndex < 0 ? 0 : searchIndex % searchMatches.length) + 1}/${searchMatches.length}`
                  : "0 matches"}
              </span>
            ) : null}
            {/* A readout you can act on: click resets to 100%, which is the
                one thing a percentage makes you want to do. ⌘0 does the same
                but is only discoverable from the shortcut sheet. */}
            <button
              type="button"
              className="as-zoom"
              onClick={() => flow.zoomTo(1, { duration: 120 })}
              title={`Reset zoom to 100% (${modKey}0)`}
              aria-label={`Zoom ${Math.round(zoom * 100)} percent — click to reset`}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              className="as-btn"
              onClick={() => flow.fitView({ padding: 0.15, duration: 300 })}
            >
              Fit
            </button>

            <ToolbarMenu label="Export" open={openMenu === "export"} onToggle={() => toggleMenu("export")}>
              {selectedDocNodeIds.length ? (
                <label className="as-menu__check" title="Picture formats only — a saved document is never narrowed">
                  <input
                    type="checkbox"
                    checked={exportSelectionOnly}
                    onChange={() => setExportSelectionOnly((on) => !on)}
                  />
                  Selection only ({selectedDocNodeIds.length})
                </label>
              ) : null}
              {registry.exporterOrder.map((key) => {
                const exporter = registry.exporters[key];
                return (
                  <button
                    key={key}
                    type="button"
                    role="menuitem"
                    className="as-menu__item"
                    onClick={() => void runExport(key)}
                  >
                    <div className="as-menu__label">{exporter.label}</div>
                    {exporter.hint ? <div className="as-menu__hint">{exporter.hint}</div> : null}
                  </button>
                );
              })}
            </ToolbarMenu>

            {!readOnly ? (
              <>
                <button type="button" className="as-btn" onClick={() => fileInputRef.current?.click()}>
                  Import
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="as-sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void loadFile(file);
                    event.target.value = "";
                  }}
                />
              </>
            ) : null}

            {/* Offered only once something is dated — with no dates there is
                no timeline to scrub, and the button would be a dead end. */}
            {timeline.stops.length && !activeDiffBase ? (
              <button
                type="button"
                className={`as-btn${timelineActive ? " as-btn--on" : ""}`}
                onClick={() => (timelineActive ? setTimelineCursor(null) : enterTimeline())}
                aria-pressed={timelineActive}
                title={`Scrub through the ${timeline.stops.length} dated point${
                  timeline.stops.length === 1 ? "" : "s"
                } in this diagram`}
              >
                ⏱ Timeline
              </button>
            ) : null}

            {!diffBase ? (
              <>
                <button
                  type="button"
                  className={`as-btn${activeDiffBase ? " as-btn--on" : ""}`}
                  onClick={() => compareInputRef.current?.click()}
                  title="Compare with a template file — added, removed, and changed vs that baseline"
                >
                  Compare
                </button>
                <input
                  ref={compareInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="as-sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void loadCompareFile(file);
                    event.target.value = "";
                  }}
                />
              </>
            ) : null}

            {onSave && !readOnly ? (
              <button
                type="button"
                className={`as-btn as-btn--primary${dirty ? " as-btn--dirty" : ""}`}
                onClick={() => void handleSave()}
                disabled={saving}
                title={
                  saving
                    ? "Saving…"
                    : dirty
                      ? `Unsaved changes — Save (${modKey}S)`
                      : `Everything is saved (${modKey}S)`
                }
              >
                {saving ? "Saving…" : dirty ? "Save •" : "Save"}
              </button>
            ) : null}
          </div>
        </div>

        {activeDiffBase && diff ? (
          <div className="as-diffbar" role="status">
            <span className="as-diffbar__chip as-diffbar__chip--added">+{diff.summary.added}</span>
            <span className="as-diffbar__chip as-diffbar__chip--removed">
              −{diff.summary.removed}
            </span>
            <span className="as-diffbar__chip as-diffbar__chip--changed">
              ~{diff.summary.changed}
            </span>
            <span className="as-diffbar__note">
              vs baseline — read-only view; the document is untouched
            </span>
            {!diffBase ? (
              <button type="button" className="as-btn" onClick={() => setCompareTemplate(null)}>
                Exit compare
              </button>
            ) : null}
          </div>
        ) : null}

        {timelineActive ? (
          <TimelineScrubber
            timeline={timeline}
            at={timelineAt!}
            onScrub={setTimelineCursor}
            futureMode={timelineFuture}
            onFutureMode={setTimelineFuture}
            futureCount={timelineFutureCount}
            onExit={() => setTimelineCursor(null)}
            stampNotice={!readOnly}
          />
        ) : null}

        {focusStack.length > 0 && !activeDiffBase ? (
          <Breadcrumbs
            path={[
              { id: null, label: String(template.meta?.title ?? "Overview") },
              ...focusStack.map((id) => ({
                id,
                label: template.nodes.find((n) => n.id === id)?.label ?? id,
              })),
            ]}
            onNavigate={(index) => drillTo(focusStack.slice(0, index))}
            onExit={() => drillTo([])}
          />
        ) : null}

        <div
          ref={canvasRef}
          className={`as-canvas${dropActive ? " as-canvas--dropping" : ""}${activeDiffBase ? " as-canvas--diff" : ""}`}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={() => setDropActive(false)}
        >
          {aiPanelVisible ? (
            <div className="as-panel">
              <div className="as-panel__head">
                <h2 className="as-panel__title">Generate architecture</h2>
                <button
                  type="button"
                  className="as-btn as-btn--icon"
                  onClick={() => setPanelOpen(false)}
                  aria-label="Close panel"
                >
                  ✕
                </button>
              </div>

              {focusId ? (
                // Generate replaces the WHOLE document — the one thing nobody
                // means while staring at one component's internals.
                <p className="as-panel__scopednote">
                  Generate replaces the whole diagram —{" "}
                  <button type="button" className="as-panel__exitlink" onClick={() => drillTo([])}>
                    Exit focus
                  </button>{" "}
                  to use it.
                </p>
              ) : (
                <>
                  <textarea
                    className="as-textarea"
                    value={createInput}
                    onChange={(event) => setCreateInput(event.target.value)}
                    placeholder="Paste requirements, source code, or plain English…"
                  />
                  <button
                    type="button"
                    className="as-btn as-btn--primary"
                    onClick={() => void runGenerate("create")}
                    disabled={busy || !createInput.trim()}
                  >
                    {busy ? "Designing…" : "Generate diagram"}
                  </button>
                </>
              )}

              <div className="as-panel__section">
                <h3 className="as-panel__label">Refine current diagram</h3>
                {focusId ? (
                  <p className="as-panel__scopechip">
                    Refining inside: “
                    {template.nodes.find((n) => n.id === focusId)?.label ?? focusId}” ·{" "}
                    {levelLabel(focusStack.length)}
                  </p>
                ) : null}
                <input
                  className="as-input"
                  value={refineInput}
                  onChange={(event) => setRefineInput(event.target.value)}
                  placeholder={
                    focusId
                      ? '"add a cache between these" · "split the parser"'
                      : '"make the queue edges dotted" · "add a CDN"'
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void runGenerate("refine");
                  }}
                />
                <button
                  type="button"
                  className="as-btn"
                  onClick={() => void runGenerate("refine")}
                  disabled={busy || !refineInput.trim()}
                >
                  {busy ? "Working…" : "Apply refinement"}
                </button>
              </div>

              {error ? <div className="as-error">{error}</div> : null}

              <p className="as-panel__foot">
                Exports and saves always capture the live, cursor-edited state. The model is prompted
                with the schema generated from this editor's registry.
              </p>
            </div>
          ) : null}

          {activeDiffBase && diff ? (
            <DiffCanvas base={activeDiffBase} current={template} diff={diff} />
          ) : (
          <ReactFlow
            nodes={viewNodes}
            edges={viewEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onSelectionChange={onSelectionChange}
            // Only when the READOUT would change. Storing the raw zoom put a
            // state update — and a re-render of this whole component — on
            // every frame of every pan, for a number that shows two digits.
            onMove={(_, viewport) =>
              setZoom((current) =>
                Math.round(current * 100) === Math.round(viewport.zoom * 100)
                  ? current
                  : viewport.zoom,
              )
            }
            onPaneClick={() => {
              setOpenMenu(null);
              setContextMenu(null);
            }}
            onNodeContextMenu={(event, node) => openContextMenu(event, node.id)}
            onEdgeContextMenu={(event, edge) => openContextMenu(event, undefined, edge.id)}
            onPaneContextMenu={(event) => openContextMenu(event as React.MouseEvent)}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            // Manual mode makes React Flow honour each element's own zIndex.
            // In the default "basic" mode an edge touching a nested node
            // inherits that node's z (1000+), so splines ride over other
            // nodes — they must always travel under them (see EDGE_Z_INDEX).
            zIndexMode="manual"
            defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
            connectionMode={ConnectionMode.Loose}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            elementsSelectable
            // The component owns Delete/Backspace so it can cascade to children.
            deleteKeyCode={null}
            // …and the arrow keys, so they move the SELECTION rather than the
            // one focused node. React Flow's built-in nudge would otherwise
            // fire alongside ours and move a focused node twice per press.
            disableKeyboardA11y
            // Double-click means DRILL now (nodes.tsx) — pane zoom on the same
            // gesture would fight it, and React Flow's dblclick-zoom plumbing
            // swallows the event before node handlers see it on
            // non-draggable (readOnly) nodes.
            zoomOnDoubleClick={false}
            // Shift as well as ⌘/Ctrl. React Flow's default is the platform
            // modifier alone, but Shift+click is what Figma, Excalidraw and
            // draw.io all extend a selection with — and it was doing nothing
            // here, so the second click replaced the selection instead.
            multiSelectionKeyCode={["Meta", "Control", "Shift"]}
            // On a COARSE pointer a one-finger drag has to pan: there is no
            // modifier to hold and no second button to pan with, so
            // rubber-band-on-drag left a touch user unable to move the canvas
            // at all. On a mouse, drag-to-select stays the default and pan
            // lives on the middle button, space, and the scroll wheel.
            selectionOnDrag={!coarsePointer}
            panOnDrag={coarsePointer ? true : [1, 2]}
            // Touch a box and it is in the selection. Requiring full
            // enclosure means a rubber band round "these four services" has to
            // clear every edge of every one of them, and misses whichever card
            // sticks out — which is not what a rubber band means anywhere else.
            selectionMode={SelectionMode.Partial}
            onSelectionEnd={selectEnclosedEdges}
            panOnScroll
            snapToGrid={snapEnabled}
            snapGrid={[12, 12]}
            selectNodesOnDrag={false}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.15}
            maxZoom={2.5}
            proOptions={{ hideAttribution: false }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="var(--as-grid-dot)" />
            {/* Drawn in flow coordinates so the guide stays on the line it
                names at any zoom. */}
            {dragGuides ? (
              <ViewportPortal>
                <div
                  className={`as-align-guide as-align-guide--${dragGuides.axis}`}
                  style={
                    dragGuides.axis === "x"
                      ? {
                          transform: `translate(${dragGuides.at}px, ${dragGuides.from}px)`,
                          height: dragGuides.to - dragGuides.from,
                        }
                      : {
                          transform: `translate(${dragGuides.from}px, ${dragGuides.at}px)`,
                          width: dragGuides.to - dragGuides.from,
                        }
                  }
                />
              </ViewportPortal>
            ) : null}
            <Controls showInteractive={false} />
            {minimap ? (
              <MiniMap
                pannable
                zoomable
                bgColor="var(--as-surface)"
                maskColor="color-mix(in srgb, var(--as-bg) 70%, transparent)"
                nodeColor={(node) =>
                  isZoneNodeId(node.id)
                    ? zoneInk(registry, (node.data as unknown as ZoneNodeData).zone)
                    : kindDef(registry, (node.data as DiagramNodeData).kind).accent
                }
              />
            ) : null}

            {/* Infra legend. Corner-anchored so it reads as a map key. */}
            {legend && legendRows.length ? (
              <Panel position="top-right" className="as-legend">
                <p className="as-legend__title">Infrastructure</p>
                {legendRows.map((row) => (
                  <div key={row.id} className="as-legend__row">
                    <span
                      className="as-legend__swatch"
                      style={{ "--as-legend-color": row.def.color } as CSSProperties}
                    />
                    {row.def.label}
                    {legendRows.length > 1 || row.count > 1 ? (
                      <span className="as-legend__count">{row.count}</span>
                    ) : null}
                  </div>
                ))}
                {template.nodes.length - visibility.nodes.size > 0 ? (
                  <p className="as-legend__hidden">
                    {template.nodes.length - visibility.nodes.size} node
                    {template.nodes.length - visibility.nodes.size === 1 ? "" : "s"} hidden by this
                    selection
                  </p>
                ) : null}
              </Panel>
            ) : null}

            {versionTag ? (
              <Panel position={versionTagPosition} className="as-version-panel">
                <VersionTagChip
                  tag={versionTag}
                  position={versionTagPosition}
                  readOnly={readOnly}
                  onCommit={patchVersionTag}
                  autoEdit={editVersionTag}
                  onAutoEditHandled={handleVersionTagEditStarted}
                />
              </Panel>
            ) : null}
          </ReactFlow>
          )}

          {/* More than one thing selected: the single-element inspector has
              nothing to show, and hiding the bar altogether took Delete and
              Duplicate with it — so selecting five nodes left the user with
              fewer controls than selecting one. */}
          {multiSelected && !readOnly && !activeDiffBase ? (
            <div className="as-inspector">
              <MultiInspector
                nodeIds={selectedDocNodeIds}
                edgeIds={selectedEdgeIds}
                zoneIds={selectedZoneIds}
                onPatchNode={patchNode}
                onPatchEdge={patchEdge}
                onPatchZone={patchZone}
                onAlign={alignSelection}
                onDistribute={distributeSelection}
                onDuplicate={duplicateSelection}
                onDelete={deleteSelection}
                onGroup={groupSelection}
              />
              {renderSlot(inspectorExtras)}
            </div>
          ) : null}

          {(selectedNode || selectedEdge || selectedZoneNode) && !multiSelected && !readOnly && !activeDiffBase ? (
            <div className="as-inspector">
              {selectedZoneNode ? (
                <ZoneInspector
                  zone={(selectedZoneNode.data as unknown as ZoneNodeData).zone}
                  registry={registry}
                  zones={zones}
                  onPatch={patchZone}
                  onRestack={restackZones}
                />
              ) : null}
              {selectedNode && isGhostNodeId(selectedNode.id) ? (
                // A ghost is a projection of an element on another level —
                // its edit form lives there, so this card only points the way.
                <InspectorSection caption="External">
                  <span className="as-inspector__ghostnote">
                    “{(selectedNode.data as DiagramNodeData).label}” lives outside this level.
                  </span>
                  <button
                    type="button"
                    className="as-btn"
                    onClick={() => navigateToNode(ghostSourceId(selectedNode.id))}
                  >
                    Go to definition
                  </button>
                </InspectorSection>
              ) : selectedNode ? (
                <NodeInspector
                  node={selectedNode}
                  linkRef={linkInputRef}
                  registry={registry}
                  zones={zones}
                  // Authoritative membership comes from the derived template.
                  // React Flow's copy can lag by a frame after a zone is
                  // dragged, since the reassignment happens during derivation.
                  zoneId={template.nodes.find((n) => n.id === selectedNode.id)?.zoneId ?? null}
                  relevantProviders={referencedProviderSet}
                  onPatch={patchNode}
                />
              ) : null}
              {selectedEdge && isGhostEdgeId(selectedEdge.id) ? (
                <InspectorSection caption="External connection">
                  <span className="as-inspector__ghostnote">
                    Stands in for a connection crossing this level — edit it where both ends are
                    visible.
                  </span>
                </InspectorSection>
              ) : selectedEdge ? (
                <EdgeInspector
                  edge={selectedEdge}
                  sourceFields={edgeEndFields(selectedEdge.source)}
                  targetFields={edgeEndFields(selectedEdge.target)}
                  sourceLabel={nodeLabelOf(selectedEdge.source)}
                  targetLabel={nodeLabelOf(selectedEdge.target)}
                  relevantProviders={[...referencedProviderSet]}
                  registry={registry}
                  onPatch={patchEdge}
                  onSwapEnds={swapEdgeEnds}
                />
              ) : null}
              {renderSlot(inspectorExtras)}
              {nesting ? (
                <button
                  type="button"
                  className="as-btn"
                  onClick={() => setPendingNest(nesting)}
                  title={
                    nesting.mode === "nest"
                      ? `Move the ${nesting.count} nodes inside this frame to their own level`
                      : `Bring this card's ${nesting.count} internal nodes back to this level`
                  }
                >
                  {/* An ellipsis, not a caret: this opens a dialog, and the
                      caret would promise a dropdown. */}
                  {nesting.mode === "nest" ? "Nest…" : "Inline…"}
                </button>
              ) : null}
              {(selectedNode && !isGhostNodeId(selectedNode.id)) || selectedZoneNode ? (
                <button
                  type="button"
                  className="as-btn as-btn--icon"
                  onClick={duplicateSelection}
                  aria-label="Duplicate with connections"
                  title={
                    selectedZoneNode
                      ? `Duplicate this zone with its member nodes and their connections (${modKey}D)`
                      : `Duplicate this node together with its direct connections (${modKey}D)`
                  }
                >
                  ⧉
                </button>
              ) : null}
              <button type="button" className="as-btn as-btn--danger" onClick={deleteSelection}>
                Delete
              </button>
            </div>
          ) : null}

          {focusId &&
          !activeDiffBase &&
          !nodes.some(
            (n) => !isZoneNodeId(n.id) && !isBoundaryNodeId(n.id) && !isGhostNodeId(n.id),
          ) ? (
            <div className="as-focus-empty" role="status">
              <div className="as-focus-empty__card">
                <p className="as-focus-empty__title">
                  “{template.nodes.find((n) => n.id === focusId)?.label ?? focusId}” has no
                  internals yet.
                </p>
                <p className="as-focus-empty__hint">
                  Anything you add here becomes its next C4 level.
                </p>
                {!readOnly ? (
                  <div className="as-focus-empty__actions">
                    <button type="button" className="as-btn" onClick={() => addNode("service")}>
                      ＋ Add node
                    </button>
                    {generate ? (
                      <button
                        type="button"
                        className="as-btn as-btn--primary"
                        onClick={() => setPanelOpen(true)}
                      >
                        ✦ Draft with AI
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Failures have to be visible whether or not the AI panel exists.
              The panel is the only other home for `error`, and it only renders
              when the host passed `generate` — so without one, a rejected save
              flipped the button back to "Save" and said nothing at all. */}
          {error && !aiPanelVisible ? (
            <div className="as-errorbar" role="alert">
              <span className="as-errorbar__text">{error}</span>
              <button
                type="button"
                className="as-btn as-btn--icon"
                onClick={() => setError("")}
                aria-label="Dismiss this error"
                title="Dismiss"
              >
                ✕
              </button>
            </div>
          ) : null}

          <div className="as-status">
            {toast ? (
              <div
                className={`as-toast${toast.color ? " as-toast--tinted" : ""}`}
                style={toast.color ? ({ "--as-toast-color": toast.color } as CSSProperties) : undefined}
              >
                {toast.message}
              </div>
            ) : null}
            {!readOnly ? (
              <div className="as-hint">
                drag from a node edge to connect · drop nodes into groups to nest · drag an edge label
                to slide it · {modKey}Z undo
              </div>
            ) : null}
          </div>
        </div>

        {welcomeOpen ? (
          <WelcomeModal
            kind="architecture"
            defaultName={welcomeName}
            showNameField={zeroFiles ? !!onFileCreate : !!(activeFile && onFileRename)}
            systemPrompt={systemPrompt}
            // Refine's content-form prompt doubles as the "elements only"
            // option in the copy button's hover menu.
            systemPromptContent={refineSystemPrompt}
            cloudProviders={welcomeClouds}
            promptForClouds={promptForClouds}
            cloudResources={welcomeResources}
            usedResources={welcomeUsedResources}
            initialClouds={referencedClouds}
            parse={parseWelcomeJson}
            onInsert={handleWelcomeInsert}
            parseOther={onFileCreate ? parseLlmSequence : undefined}
            onInsertOther={onFileCreate ? handleWelcomeInsertOther : undefined}
            systemPromptOther={sequencePromptForCopy}
            onDismiss={handleWelcomeDismiss}
            lint={welcomeLint}
          />
        ) : null}

        {pendingExport ? (
          <ExportStatesModal
            format={pendingExport}
            axes={stateAxes}
            registry={registry}
            filename={filename}
            onCancel={() => setPendingExport(null)}
            onConfirm={(choice) => void onExportStatesChoice(choice)}
          />
        ) : null}

        {pendingNest ? (
          <NestingModal
            subject={pendingNest}
            mode={pendingNest.mode}
            registry={registry}
            relevantProviders={referencedProviderSet}
            onCancel={() => setPendingNest(null)}
            onConfirm={runNesting}
          />
        ) : null}
        {contextMenu ? (
          <div
            className="as-context"
            role="menu"
            aria-label="Actions"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {contextMenu.kind === "pane" ? (
              <>
                <ContextItem label="Node" hint="N" onPick={() => addNode("service")} close={closeContext} />
                <ContextItem label="Group" hint="G" onPick={() => addNode("group")} close={closeContext} />
                <ContextItem label="Text note" hint="T" onPick={() => addNode("text")} close={closeContext} />
                <ContextItem label="Zone" hint="Z" onPick={addZone} close={closeContext} />
                <hr className="as-context__rule" />
                <ContextItem
                  label="Paste"
                  hint={`${modKey}V`}
                  onPick={() => void pasteClipboard()}
                  close={closeContext}
                />
                <ContextItem label="Select all" hint={`${modKey}A`} onPick={selectAll} close={closeContext} />
                <ContextItem label="Tidy" onPick={tidy} close={closeContext} />
              </>
            ) : (
              <>
                <ContextItem
                  label="Copy"
                  hint={`${modKey}C`}
                  onPick={() => void copySelection()}
                  close={closeContext}
                />
                <ContextItem
                  label="Duplicate"
                  hint={`${modKey}D`}
                  onPick={() => void duplicateSelection()}
                  close={closeContext}
                />
                {contextMenu.kind !== "edge" ? (
                  <>
                    <ContextItem
                      label="Rename"
                      hint="F2"
                      disabled={selectedDocNodeIds.length !== 1}
                      onPick={() => setRenamingId(selectedDocNodeIds[0] ?? null)}
                      close={closeContext}
                    />
                    <ContextItem
                      label="Group selection"
                      hint={`${modKey}G`}
                      disabled={selectedDocNodeIds.length < 1}
                      onPick={groupSelection}
                      close={closeContext}
                    />
                    <ContextItem
                      label="Lock / unlock"
                      hint={`⇧${modKey}L`}
                      onPick={toggleLockSelection}
                      close={closeContext}
                    />
                  </>
                ) : (
                  <ContextItem
                    label="Clear route"
                    disabled={!selectedEdge?.data?.points}
                    onPick={() => {
                      for (const id of selectedEdgeIds) patchEdge(id, { points: undefined });
                    }}
                    close={closeContext}
                  />
                )}
                <hr className="as-context__rule" />
                <ContextItem label="Delete" danger hint="Del" onPick={deleteSelection} close={closeContext} />
              </>
            )}
          </div>
        ) : null}
        {shortcutsOpen ? <ShortcutsModal onClose={() => setShortcutsOpen(false)} /> : null}
      </div>
    </StudioContext.Provider>
  );
}

// ─── Inspectors ──────────────────────────────────────────────────────────────

/**
 * Zone controls: label, shape, which providers it can be switched between, and
 * stacking. The active provider is switched on the zone itself, not here — a
 * toggle you have to open an inspector to reach isn't a toggle.
 */
/**
 * The one date control, shared by the node, edge, and zone inspectors.
 *
 * A native `<input type="date">` because its value format IS the stored
 * format — no parsing, no locale ambiguity, and the platform's own picker.
 * Clearing it passes `undefined`, which every patch path reads as "unset the
 * field" rather than "keep what was there".
 */
function DateSection({
  date,
  what,
  label,
  onChange,
}: {
  date?: string;
  /** What carries the date — "Node", "Edge", "Zone". Names the control. */
  what: string;
  label: string;
  onChange: (date: string | undefined) => void;
}) {
  return (
    <InspectorSection caption="Date">
      <input
        className="as-input as-inspector__date"
        type="date"
        value={date ?? ""}
        onChange={(event) => onChange(event.target.value || undefined)}
        // Not just "Date": the section's own caption is already that, and two
        // controls with the same accessible name are two ambiguous targets.
        aria-label={`${what} date`}
        title={label}
      />
      {date ? (
        <button
          type="button"
          className="as-btn as-btn--icon"
          onClick={() => onChange(undefined)}
          aria-label="Clear date"
          title="Clear the date — the element goes back to being always present"
        >
          ✕
        </button>
      ) : null}
    </InspectorSection>
  );
}

/**
 * Chips with a free-text "add" input — the one editor behind zone Supports and
 * node tags. Click a chip to toggle it; type a name and press Enter to add an
 * entry that isn't among the offered options. Options the caller knows about
 * render in their own colour; ad-hoc entries fall back to neutral until the
 * host registers them.
 */
function ChipListEditor({
  caption,
  options,
  active,
  ariaLabel,
  addPlaceholder,
  labelOf = (id) => id,
  colorOf,
  customIds,
  onToggle,
  onAdd,
}: {
  caption: string;
  /** Chips to show — typically the union of known options and active entries. */
  options: string[];
  active: string[];
  ariaLabel: string;
  addPlaceholder: string;
  labelOf?: (id: string) => string;
  colorOf?: (id: string) => string | undefined;
  /** Entries not in the caller's registry — marked with × while active. */
  customIds?: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onAdd: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");

  const submit = () => {
    const id = draft.trim();
    if (!id) return;
    setDraft("");
    if (active.includes(id)) return; // already on — nothing to add
    onAdd(id);
  };

  return (
    <span className="as-inspector__group" role="group" aria-label={ariaLabel}>
      <span className="as-inspector__caption">{caption}</span>
      {options.map((id) => {
        const on = active.includes(id);
        const color = colorOf?.(id);
        return (
          <button
            key={id}
            type="button"
            className={`as-chip${on ? " as-chip--on" : ""}`}
            style={on && color ? { borderColor: color, color } : undefined}
            aria-pressed={on}
            onClick={() => onToggle(id)}
            title={`${on ? "Remove" : "Add"} ${labelOf(id)}`}
          >
            {labelOf(id)}
            {on && customIds?.has(id) ? <span className="as-chip__x"> ×</span> : null}
          </button>
        );
      })}
      <input
        className="as-chip__add"
        value={draft}
        placeholder={addPlaceholder}
        aria-label={`${ariaLabel} — add`}
        title="Type a name and press Enter to add it"

        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
          // Abandon the half-typed value rather than adding it. Committing on
          // blur turned "type two letters, then click the canvas" into a tag
          // nobody asked for — and on a zone, into a whole custom provider.
          if (event.key === "Escape") {
            event.preventDefault();
            setDraft("");
            (event.target as HTMLInputElement).blur();
          }
          event.stopPropagation();
        }}
        onBlur={() => setDraft("")}
      />
    </span>
  );
}

/** One row of the right-click menu. */
function ContextItem({
  label,
  hint,
  danger,
  disabled,
  onPick,
  close,
}: {
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onPick: () => void;
  close: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`as-context__item${danger ? " as-context__item--danger" : ""}`}
      disabled={disabled}
      onClick={() => {
        onPick();
        close();
      }}
    >
      <span>{label}</span>
      {hint ? <span className="as-context__hint">{hint}</span> : null}
    </button>
  );
}

/**
 * The inspector for a selection of several things.
 *
 * There was none: the bar rendered only for exactly one element, so selecting
 * five nodes hid it — along with Delete and Duplicate, leaving a
 * multi-selection with fewer controls than a single node. And the fields a
 * team actually sets in bulk (owner, lifecycle stage, a tag, a lock) had to be
 * set one box at a time.
 *
 * Only the fields that MEAN something across a mixed selection are offered.
 * Each shows the shared value, or blank when they disagree — and setting one
 * writes it to everything selected, which is the whole point.
 */
function MultiInspector({
  nodeIds,
  edgeIds,
  zoneIds,
  onPatchNode,
  onPatchEdge,
  onPatchZone,
  onAlign,
  onDistribute,
  onDuplicate,
  onDelete,
  onGroup,
}: {
  nodeIds: string[];
  edgeIds: string[];
  zoneIds: string[];
  onPatchNode: (id: string, patch: Partial<DiagramNodeData>) => void;
  onPatchEdge: (id: string, patch: Partial<DiagramEdgeData>) => void;
  onPatchZone: (id: string, patch: Partial<DiagramZone>) => void;
  onAlign: (mode: "left" | "centerX" | "right" | "top" | "centerY" | "bottom") => void;
  onDistribute: (axis: "x" | "y") => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onGroup: () => void;
}) {
  const flow = useReactFlow();
  const [team, setTeam] = useState("");
  const [tag, setTag] = useState("");

  const dataOf = (id: string) => flow.getNode(id)?.data as DiagramNodeData | undefined;
  /** The one value they all share, or undefined when they disagree. */
  const shared = <T,>(read: (d: DiagramNodeData) => T): T | undefined => {
    const values = nodeIds.map((id) => dataOf(id)).filter(Boolean).map((d) => read(d!));
    if (!values.length) return undefined;
    const first = values[0];
    return values.every((v) => v === first) ? first : undefined;
  };

  const counts = [
    nodeIds.length ? `${nodeIds.length} node${nodeIds.length === 1 ? "" : "s"}` : "",
    zoneIds.length ? `${zoneIds.length} zone${zoneIds.length === 1 ? "" : "s"}` : "",
    edgeIds.length ? `${edgeIds.length} connection${edgeIds.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean);

  const sharedStatus = shared((d) => d.status ?? "active");
  const sharedLocked = shared((d) => !!d.locked);

  return (
    <>
      <InspectorSection caption="Selection">
        <span className="as-inspector__count">{counts.join(" · ")}</span>
      </InspectorSection>

      {nodeIds.length ? (
        <>
          <InspectorSection caption="Status">
            <select
              className="as-select"
              value={sharedStatus ?? ""}
              aria-label="Lifecycle status for the whole selection"
              onChange={(event) => {
                const next = event.target.value as NodeStatus;
                for (const id of nodeIds) {
                  onPatchNode(id, { status: next === "active" ? undefined : next });
                }
              }}
            >
              {sharedStatus === undefined ? (
                <option value="" disabled>
                  Mixed
                </option>
              ) : null}
              {NODE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </InspectorSection>

          <InspectorSection caption="Team">
            <input
              className="as-input"
              value={team}
              placeholder={shared((d) => d.team ?? "") ?? "Mixed"}
              aria-label="Owning team for the whole selection"
              title="Type a team and press Enter to set it on everything selected"
              onChange={(event) => setTeam(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return event.stopPropagation();
                const next = team.trim();
                for (const id of nodeIds) onPatchNode(id, { team: next || undefined });
                setTeam("");
                event.stopPropagation();
              }}
            />
          </InspectorSection>

          <InspectorSection caption="Add tag">
            <input
              className="as-input"
              value={tag}
              placeholder="+ tag…"
              aria-label="Add a tag to the whole selection"
              title="Type a tag and press Enter to add it to everything selected"
              onChange={(event) => setTag(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return event.stopPropagation();
                const next = tag.trim();
                if (next) {
                  for (const id of nodeIds) {
                    const current = dataOf(id)?.tags ?? [];
                    if (!current.includes(next)) onPatchNode(id, { tags: [...current, next] });
                  }
                }
                setTag("");
                event.stopPropagation();
              }}
            />
          </InspectorSection>
        </>
      ) : null}

      {edgeIds.length ? (
        <InspectorSection caption="Line">
          <select
            className="as-select"
            defaultValue=""
            aria-label="Line style for the selected connections"
            onChange={(event) => {
              const next = event.target.value as EdgeStyle;
              if (!next) return;
              for (const id of edgeIds) onPatchEdge(id, { style: next });
            }}
          >
            <option value="" disabled>
              Style…
            </option>
            {EDGE_STYLES.map((style) => (
              <option key={style} value={style}>
                {style}
              </option>
            ))}
          </select>
          <span className="as-swatches" role="group" aria-label="Colour for the selected connections">
            {EDGE_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className="as-swatch"
                style={{ background: EDGE_COLOR_HEX[color] }}
                aria-label={`Edge colour ${color}`}
                title={color}
                onClick={() => {
                  for (const id of edgeIds) onPatchEdge(id, { color });
                }}
              />
            ))}
          </span>
        </InspectorSection>
      ) : null}

      <InspectorSection caption="Arrange">
        {(
          [
            ["left", "⇤"],
            ["centerX", "⇹"],
            ["right", "⇥"],
            ["top", "⤒"],
            ["centerY", "⇳"],
            ["bottom", "⤓"],
          ] as const
        ).map(([edge, glyph]) => (
          <button
            key={edge}
            type="button"
            className="as-btn as-btn--icon"
            onClick={() => onAlign(edge)}
            aria-label={`Align ${edge}`}
            title={`Align ${edge}`}
          >
            {glyph}
          </button>
        ))}
        <button
          type="button"
          className="as-btn as-btn--icon"
          onClick={() => onDistribute("x")}
          aria-label="Distribute horizontally"
          title="Distribute horizontally"
        >
          ↔
        </button>
        <button
          type="button"
          className="as-btn as-btn--icon"
          onClick={() => onDistribute("y")}
          aria-label="Distribute vertically"
          title="Distribute vertically"
        >
          ↕
        </button>
      </InspectorSection>

      {nodeIds.length > 1 ? (
        <button type="button" className="as-btn" onClick={onGroup} title="Wrap the selection in a container">
          Group
        </button>
      ) : null}
      <button
        type="button"
        className={`as-btn as-btn--icon${sharedLocked ? " as-btn--on" : ""}`}
        onClick={() => {
          const next = !sharedLocked;
          for (const id of nodeIds) onPatchNode(id, { locked: next || undefined });
          for (const id of zoneIds) onPatchZone(id, { locked: next || undefined });
        }}
        aria-pressed={!!sharedLocked}
        aria-label={sharedLocked ? "Unlock the selection" : "Lock the selection in place"}
        title={sharedLocked ? "Unlock the selection" : "Lock the selection in place"}
      >
        {sharedLocked ? "🔒" : "🔓"}
      </button>
      <button
        type="button"
        className="as-btn as-btn--icon"
        onClick={onDuplicate}
        aria-label="Duplicate the selection"
        title="Duplicate the selection with its direct connections"
      >
        ⧉
      </button>
      <button type="button" className="as-btn as-btn--danger" onClick={onDelete}>
        Delete
      </button>
    </>
  );
}

function ZoneInspector({
  zone,
  registry,
  zones,
  onPatch,
  onRestack,
}: {
  zone: DiagramZone;
  registry: ResolvedRegistry;
  /** Every zone in the document — the palette harvests their custom colours. */
  zones: DiagramZone[];
  onPatch: (zoneId: string, patch: Partial<DiagramZone>) => void;
  /** Same swap semantics as ⌘] / ⌘[ — see `restackZones`. */
  onRestack: (mode: "front" | "back" | "forward" | "backward") => void;
}) {
  const ink = zoneInk(registry, zone);

  /**
   * The swatch palette: every provider default, then every custom colour any
   * zone in the document already uses — matching an existing colour should be
   * one click, not an eyedropper exercise. Deduped by canonical hex; customs
   * that merely equal a default collapse into it.
   */
  const paletteColors = useMemo(() => {
    const out: Array<{ color: string; label: string }> = [];
    const seen = new Set<string>();
    for (const providerId of registry.providerOrder) {
      const def = providerDef(registry, providerId);
      const hex = def.color.toLowerCase();
      if (seen.has(hex)) continue;
      seen.add(hex);
      out.push({ color: def.color, label: def.label });
    }
    for (const other of zones) {
      const hex = other.color?.toLowerCase();
      if (!hex || seen.has(hex)) continue;
      seen.add(hex);
      out.push({ color: hex, label: `Custom (${other.label})` });
    }
    return out;
  }, [registry, zones]);
  const toggleProvider = (provider: string) => {
    const next = zone.providers.includes(provider)
      ? zone.providers.filter((p) => p !== provider)
      : [...zone.providers, provider];
    // A zone with no providers has no colour and no toggle; keep at least one.
    if (!next.length) return;
    onPatch(zone.id, {
      providers: next,
      provider: next.includes(zone.provider) ? zone.provider : next[0],
    });
  };

  // Chips are the UNION of registry providers and whatever the zone already
  // lists — a custom provider (typed here, or from LLM output, which the
  // validator deliberately keeps) must render, or it can never be removed.
  const providerOptions = useMemo(() => {
    const out = [...registry.providerOrder];
    for (const p of zone.providers) if (!out.includes(p)) out.push(p);
    return out;
  }, [registry.providerOrder, zone.providers]);
  const customProviders = useMemo(
    () => new Set(zone.providers.filter((p) => !registry.providerOrder.includes(p))),
    [zone.providers, registry.providerOrder],
  );

  return (
    <>
      <InspectorSection caption="Zone">
        <input
          className="as-input as-inspector__name"
          value={zone.label}
          onChange={(event) => onPatch(zone.id, { label: event.target.value })}
          aria-label="Zone label"
        />
        <select
          className="as-select"
          value={zone.shape}
          onChange={(event) => {
            const shape = event.target.value as ZoneShape;
            onPatch(zone.id, {
              shape,
              // Seed an editable outline the first time polygon is chosen.
              ...(shape === "polygon" && !zone.points ? { points: [...DEFAULT_POLYGON_POINTS] } : {}),
            });
          }}
          aria-label="Zone shape"
        >
          {ZONE_SHAPES.map((shape) => (
            <option key={shape} value={shape}>
              {shape}
            </option>
          ))}
        </select>
      </InspectorSection>

      {/* The picker sets the OUTLINE colour — the vivid one a human reads —
          and the background fill derives from it as a dull tint, so one choice
          styles the whole region coherently in either theme. */}
      <InspectorSection caption="Colour">
        <div className="as-swatches">
          {paletteColors.map(({ color, label }) => (
            <button
              key={color}
              type="button"
              title={label}
              aria-label={`Zone colour ${label}`}
              aria-pressed={color.toLowerCase() === ink.toLowerCase()}
              className={`as-swatch${color.toLowerCase() === ink.toLowerCase() ? " as-swatch--on" : ""}`}
              style={{ background: color }}
              onClick={() => onPatch(zone.id, { color: color.toLowerCase() })}
            />
          ))}
        </div>
        <input
          className="as-swatch as-swatch--custom"
          type="color"
          value={ink}
          onChange={(event) => onPatch(zone.id, { color: event.target.value.toLowerCase() })}
          aria-label="Custom zone colour"
          title="Pick any outline colour — the fill derives from it"
        />
        {zone.color ? (
          <button
            type="button"
            className="as-chip"
            onClick={() => onPatch(zone.id, { color: undefined })}
            title="Back to the provider's colour"
          >
            Auto
          </button>
        ) : null}
      </InspectorSection>

      <InspectorSection caption="Style">
        <select
          className="as-select"
          value={zone.outline ?? "solid"}
          onChange={(event) => {
            const value = event.target.value as ZoneOutline;
            // `solid` is the default and never stored.
            onPatch(zone.id, { outline: value === "solid" ? undefined : value });
          }}
          aria-label="Zone outline style"
          title="Outline — solid, dashed, dotted, or none"
        >
          {ZONE_OUTLINES.map((o) => (
            <option key={o} value={o}>
              outline: {o}
            </option>
          ))}
        </select>
        <label className="as-check" title="Draw the derived background tint">
          <input
            type="checkbox"
            checked={zone.fill !== false}
            onChange={(event) =>
              // Filled is the default; only the opt-out is stored.
              onPatch(zone.id, { fill: event.target.checked ? undefined : false })
            }
          />
          Fill
        </label>
        <input
          className="as-range"
          type="range"
          min={0}
          max={0.6}
          step={0.02}
          value={zone.opacity ?? DEFAULT_ZONE_OPACITY}
          disabled={zone.fill === false}
          onChange={(event) => onPatch(zone.id, { opacity: Number(event.target.value) })}
          aria-label="Fill opacity"
          title="How strong the background tint is"
        />
      </InspectorSection>

      <ChipListEditor
        caption="Supports"
        ariaLabel="Providers this zone supports"
        addPlaceholder="+ add…"
        options={providerOptions}
        active={zone.providers}
        customIds={customProviders}
        labelOf={(p) => providerDef(registry, p).label}
        colorOf={(p) => providerDef(registry, p).color}
        onToggle={toggleProvider}
        onAdd={toggleProvider}
      />

      <DateSection
        date={zone.date}
        what="Zone"
        label="When this region comes into existence. It does not date the nodes on it."
        onChange={(date) => onPatch(zone.id, { date })}
      />

      <button
        type="button"
        className={`as-btn as-btn--icon${zone.locked ? " as-btn--on" : ""}`}
        onClick={() => onPatch(zone.id, { locked: !zone.locked })}
        aria-pressed={!!zone.locked}
        aria-label={zone.locked ? "Unlock" : "Lock in place"}
        title={zone.locked ? "Unlock — allow moving and resizing" : "Lock in place"}
      >
        {zone.locked ? "🔒" : "🔓"}
      </button>
      {/* Swap with the neighbour rather than ±1 on `z`: equal z resolves by
          array order, so incrementing past a zone two levels up looks like
          the button doing nothing at all. Both directions, because a raise
          you cannot undo by eye is a one-way door. */}
      <button
        type="button"
        className="as-btn as-btn--icon"
        onClick={() => onRestack("backward")}
        aria-label="Send this zone behind the one below it"
        title="Send backward — behind the zone below it"
      >
        ⤓
      </button>
      <button
        type="button"
        className="as-btn as-btn--icon"
        onClick={() => onRestack("forward")}
        aria-label="Bring this zone in front of the one above it"
        title="Bring forward — in front of the zone above it"
      >
        ⤒
      </button>
    </>
  );
}

function NodeInspector({
  node,
  linkRef,
  registry,
  zones,
  zoneId,
  relevantProviders,
  onPatch,
}: {
  node: Node;
  /** So ⌘⇧K can put the cursor straight in the Link field. */
  linkRef: React.RefObject<HTMLInputElement>;
  registry: ResolvedRegistry;
  zones: DiagramZone[];
  zoneId: string | null;
  /** Providers the document references — the kind picker demotes the rest. */
  relevantProviders: ReadonlySet<string>;
  onPatch: (id: string, patch: Partial<DiagramNodeData>) => void;
}) {
  const data = node.data as DiagramNodeData;
  const def = kindDef(registry, data.kind);
  const zone = zoneId ? zones.find((z) => z.id === zoneId) : undefined;

  /**
   * Toggling a provider off restricts the node to the remaining ones. Turning
   * every provider on is the same as "always visible", so that clears the list
   * rather than storing a redundant full set.
   */
  const toggleNodeProvider = (provider: string) => {
    if (!zone) return;
    const current = data.providers?.length ? data.providers : [...zone.providers];
    const next = current.includes(provider)
      ? current.filter((p) => p !== provider)
      : [...current, provider];
    const all = zone.providers.every((p) => next.includes(p));
    onPatch(node.id, { providers: all || !next.length ? undefined : next });
  };

  return (
    <>
      <InspectorSection caption="Node">
        <input
          className="as-input as-inspector__name"
          value={data.label}
          onChange={(event) => onPatch(node.id, { label: event.target.value })}
          aria-label="Node label"
        />
        <KindSelect
          registry={registry}
          value={data.kind as string}
          relevantProviders={relevantProviders}
          onChange={(kind) => {
            // Adopt the new kind's default icon so the node doesn't keep a glyph
            // that made sense only for the old kind.
            onPatch(node.id, { kind, icon: kindDef(registry, kind).icon });
          }}
        />
        {!def.annotation ? (
          <select
            className="as-select"
            value={data.status ?? "active"}
            onChange={(event) => {
              const value = event.target.value as NodeStatus;
              // `active` is the default and never stored.
              onPatch(node.id, { status: value === "active" ? undefined : value });
            }}
            aria-label="Lifecycle status"
            title="Lifecycle stage — proposed/planned/stubbed outline, dark hazard-taped, deprecated/retired dim"
          >
            {NODE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        ) : null}
      </InspectorSection>

      {!def.container && !def.annotation ? (
        <InspectorSection caption="Style">
          <select
            className="as-select"
            value={data.icon as string}
            onChange={(event) => onPatch(node.id, { icon: event.target.value })}
            aria-label="Node icon"
          >
            {registry.iconNames.map((icon) => (
              <option key={icon} value={icon}>
                {icon === "none" ? "no icon" : icon}
              </option>
            ))}
          </select>
          <input
            className="as-input as-inspector__desc"
            value={data.description}
            placeholder="Description…"
            onChange={(event) => onPatch(node.id, { description: event.target.value })}
            aria-label="Node description"
          />
        </InspectorSection>
      ) : null}

      {def.annotation ? (
        <InspectorSection caption="Style">
          <select
            className="as-select"
            value={data.fontSize ?? 13}
            onChange={(event) => onPatch(node.id, { fontSize: Number(event.target.value) })}
            aria-label="Font size"
          >
            {[11, 13, 16, 20, 26].map((size) => (
              <option key={size} value={size}>
                {size}px
              </option>
            ))}
          </select>
          <label className="as-check" title="Draw an outline and background behind this note">
            <input
              type="checkbox"
              checked={!data.plain}
              onChange={(event) =>
                // Boxed is the default, so only the opt-OUT is stored.
                onPatch(node.id, { plain: event.target.checked ? undefined : true })
              }
            />
            Outline
          </label>
          {/* A note's sentence is its label (double-click the note to edit);
              the description is the dim sub-line under it, and this is the
              only place to type one. */}
          <input
            className="as-input as-inspector__desc"
            value={data.description}
            placeholder="Description…"
            onChange={(event) => onPatch(node.id, { description: event.target.value })}
            aria-label="Node description"
          />
        </InspectorSection>
      ) : null}

      {/* Text layout. Every default is left/middle/unwrapped, and validation
          stores a value only when it differs — so touching nothing here leaves
          the document byte-identical. Annotations keep their own editor. */}
      {!def.annotation ? (
        <InspectorSection caption="Text">
          <select
            className="as-select"
            value={data.textAlign ?? "left"}
            onChange={(event) => {
              const value = event.target.value as NodeTextAlign;
              onPatch(node.id, { textAlign: value === "left" ? undefined : value });
            }}
            aria-label="Text alignment"
            title="Horizontal alignment of the label and description"
          >
            {NODE_TEXT_ALIGNS.map((a) => (
              <option key={a} value={a}>
                align: {a}
              </option>
            ))}
          </select>
          <select
            className="as-select"
            value={data.textVAlign ?? "middle"}
            onChange={(event) => {
              const value = event.target.value as NodeTextVAlign;
              onPatch(node.id, { textVAlign: value === "middle" ? undefined : value });
            }}
            aria-label="Vertical text alignment"
            title="Where the text block sits in the box"
          >
            {NODE_TEXT_VALIGNS.map((a) => (
              <option key={a} value={a}>
                vertical: {a}
              </option>
            ))}
          </select>
          <select
            className="as-select"
            value={data.fontSize ?? DEFAULT_FONT_SIZE}
            onChange={(event) => {
              const value = Number(event.target.value);
              onPatch(node.id, { fontSize: value === DEFAULT_FONT_SIZE ? undefined : value });
            }}
            aria-label="Label size"
            title="Label size"
          >
            {[11, 13, 16, 20, 26].map((size) => (
              <option key={size} value={size}>
                {size}px
              </option>
            ))}
          </select>
          <label className="as-check" title="Wrap the label across lines, growing the box to fit">
            <input
              type="checkbox"
              checked={!!data.wrap}
              onChange={(event) =>
                // One ellipsised line is the default, so only the opt-IN is stored.
                onPatch(node.id, { wrap: event.target.checked ? true : undefined })
              }
            />
            Wrap
          </label>
        </InspectorSection>
      ) : null}

      {/* Container frame — the same three controls a zone gets, because it is
          the same vocabulary. Fill off + outline none is an invisible grouping
          box that still nests, still accepts drops, and still drills in. */}
      {def.container ? (
        <InspectorSection caption="Frame">
          <select
            className="as-select"
            value={data.outline ?? "dashed"}
            onChange={(event) => {
              const value = event.target.value as NodeOutline;
              // `dashed` is the group default and never stored.
              onPatch(node.id, { outline: value === "dashed" ? undefined : value });
            }}
            aria-label="Frame outline style"
            title="Outline — solid, dashed, dotted, or none"
          >
            {NODE_OUTLINES.map((o) => (
              <option key={o} value={o}>
                outline: {o}
              </option>
            ))}
          </select>
          <label className="as-check" title="Draw the background tint">
            <input
              type="checkbox"
              checked={data.fill !== false}
              onChange={(event) =>
                // Filled is the default; only the opt-out is stored.
                onPatch(node.id, { fill: event.target.checked ? undefined : false })
              }
            />
            Fill
          </label>
          <input
            className="as-range"
            type="range"
            min={0}
            max={0.6}
            step={0.02}
            value={data.opacity ?? DEFAULT_CONTAINER_OPACITY}
            disabled={data.fill === false}
            onChange={(event) => onPatch(node.id, { opacity: Number(event.target.value) })}
            aria-label="Frame fill opacity"
            title="How strong the background tint is"
          />
          <input
            className="as-swatch as-swatch--custom"
            type="color"
            value={data.color ?? def.accent}
            onChange={(event) => onPatch(node.id, { color: event.target.value })}
            aria-label="Frame colour"
            title="Frame ink — the outline colour the fill is derived from"
          />
          {data.color ? (
            <button
              type="button"
              className="as-chip"
              onClick={() => onPatch(node.id, { color: undefined, opacity: undefined })}
              title="Back to the kind's own colour"
            >
              Auto
            </button>
          ) : null}
        </InspectorSection>
      ) : null}

      {/* Which deployments this node exists in. Only meaningful on a zone —
          without one there is no provider to compare against. */}
      {zone && zone.providers.length > 1 ? (
        <span className="as-inspector__group" role="group" aria-label="Visible on">
          <span className="as-inspector__caption">On</span>
          {zone.providers.map((p) => {
            const on = !data.providers?.length || data.providers.includes(p);
            const pd = providerDef(registry, p);
            return (
              <button
                key={p}
                type="button"
                className={`as-chip${on ? " as-chip--on" : ""}`}
                style={on ? { borderColor: pd.color, color: pd.color } : undefined}
                aria-pressed={on}
                onClick={() => toggleNodeProvider(p)}
                title={on ? `Hide on ${pd.label}` : `Show on ${pd.label}`}
              >
                {pd.label}
              </button>
            );
          })}
        </span>
      ) : null}

      {/* Rows, for the kinds whose substance is rows — plus any node that
          already has some, so a document that arrived with fields on a
          "service" can still be edited rather than only viewed. */}
      {def.record || data.fields?.length ? (
        <FieldsEditor
          fields={data.fields ?? []}
          onChange={(fields) => onPatch(node.id, { fields })}
        />
      ) : null}

      {!def.annotation ? (
        <ChipListEditor
          caption="Tags"
          ariaLabel="Node tags"
          addPlaceholder="+ tag…"
          options={data.tags ?? []}
          active={data.tags ?? []}
          customIds={new Set(data.tags ?? [])}
          onToggle={(tag) => {
            const next = (data.tags ?? []).filter((t) => t !== tag);
            onPatch(node.id, { tags: next.length ? next : undefined });
          }}
          onAdd={(tag) => onPatch(node.id, { tags: [...(data.tags ?? []), tag] })}
        />
      ) : null}

      {!def.annotation ? (
        <InspectorSection caption="Team">
          <input
            className="as-input as-inspector__team"
            value={data.team ?? ""}
            placeholder="Owning team…"
            onChange={(event) => onPatch(node.id, { team: event.target.value || undefined })}
            aria-label="Owning team"
          />
        </InspectorSection>
      ) : null}

      <DateSection
        date={data.date}
        what="Node"
        label="When this node lands. Undated means it is always there."
        onChange={(date) => onPatch(node.id, { date })}
      />

      {!def.annotation ? (
        <InspectorSection caption="Link">
          <input
            ref={linkRef}
            className="as-input as-inspector__url"
            value={data.url ?? ""}
            placeholder="https://… or file:Name"
            onChange={(event) => onPatch(node.id, { url: event.target.value || undefined })}
            aria-label="Documentation link"
          />
          {data.url && !data.url.startsWith("file:") ? (
            <a
              className="as-btn as-btn--icon"
              href={data.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${data.url}`}
              aria-label="Open link"
            >
              ↗
            </a>
          ) : null}
        </InspectorSection>
      ) : null}

      <button
        type="button"
        className={`as-btn as-btn--icon${data.locked ? " as-btn--on" : ""}`}
        onClick={() => onPatch(node.id, { locked: data.locked ? undefined : true })}
        aria-pressed={!!data.locked}
        aria-label={data.locked ? "Unlock" : "Lock in place"}
        title={data.locked ? "Unlock — allow moving and resizing" : "Lock in place"}
      >
        {data.locked ? "🔒" : "🔓"}
      </button>
    </>
  );
}

/**
 * The row editor for a record node — a table's columns, a class's properties.
 *
 * Rows are ordered, and the order is visible: it decides where each one sits
 * in the box and therefore where a foreign-key line lands, so the list offers
 * a move-up rather than making the user retype a column to re-place it.
 */
function FieldsEditor({
  fields,
  onChange,
}: {
  fields: readonly NodeField[];
  onChange: (fields: NodeField[] | undefined) => void;
}) {
  /** An id nothing else in this node uses — edges reference rows by id. */
  const freshId = () => {
    const taken = new Set(fields.map((f) => f.id));
    let n = fields.length + 1;
    while (taken.has(`field_${n}`)) n++;
    return `field_${n}`;
  };

  const replace = (next: NodeField[]) => onChange(next.length ? next : undefined);
  const patch = (index: number, part: Partial<NodeField>) =>
    replace(fields.map((f, i) => (i === index ? { ...f, ...part } : f)));

  return (
    <span className="as-inspector__section as-fields" role="group" aria-label="Fields">
      <span className="as-inspector__caption">Fields</span>
      <span className="as-fields__list">
        {fields.map((field, index) => (
          <span className="as-fieldrow" key={field.id}>
            <select
              className="as-select as-fieldrow__key"
              value={field.key ?? ""}
              onChange={(event) =>
                patch(index, { key: (event.target.value || undefined) as FieldKey | undefined })
              }
              aria-label={`Key role of ${field.name || "field"}`}
              title="Key role — primary, foreign, or both"
            >
              <option value="">—</option>
              {FIELD_KEYS.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
            <input
              className="as-input as-fieldrow__name"
              value={field.name}
              placeholder="column"
              onChange={(event) => patch(index, { name: event.target.value })}
              aria-label={`Field ${index + 1} name`}
            />
            <input
              className="as-input as-fieldrow__type"
              value={field.type ?? ""}
              placeholder="type"
              onChange={(event) => patch(index, { type: event.target.value || undefined })}
              aria-label={`Field ${index + 1} type`}
            />
            <button
              type="button"
              className={`as-btn as-btn--icon${field.required ? " as-btn--on" : ""}`}
              onClick={() => patch(index, { required: field.required ? undefined : true })}
              aria-pressed={!!field.required}
              aria-label={`${field.required ? "Optional" : "Required"}: ${field.name || `field ${index + 1}`}`}
              title={field.required ? "Required — click to make optional" : "Optional — click to require"}
            >
              *
            </button>
            {/* Both directions. Row order is meaning here — a foreign-key
                line anchors to a column by its position — and with only ↑,
                moving the first of ten columns to the bottom was nine clicks
                on nine other rows. */}
            <button
              type="button"
              className="as-btn as-btn--icon"
              disabled={index === 0}
              onClick={() => {
                const next = [...fields];
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                replace(next);
              }}
              aria-label={`Move ${field.name || `field ${index + 1}`} up`}
              title="Move up"
            >
              ↑
            </button>
            <button
              type="button"
              className="as-btn as-btn--icon"
              disabled={index === fields.length - 1}
              onClick={() => {
                const next = [...fields];
                [next[index], next[index + 1]] = [next[index + 1], next[index]];
                replace(next);
              }}
              aria-label={`Move ${field.name || `field ${index + 1}`} down`}
              title="Move down"
            >
              ↓
            </button>
            <button
              type="button"
              className="as-btn as-btn--icon"
              onClick={() => replace(fields.filter((_, i) => i !== index))}
              aria-label={`Remove ${field.name || `field ${index + 1}`}`}
              title="Remove this field"
            >
              ×
            </button>
          </span>
        ))}
      </span>
      <button
        type="button"
        className="as-btn"
        disabled={fields.length >= MAX_NODE_FIELDS}
        onClick={() => replace([...fields, { id: freshId(), name: "" }])}
        title={
          fields.length >= MAX_NODE_FIELDS
            ? `A node holds at most ${MAX_NODE_FIELDS} fields`
            : "Add a field"
        }
      >
        + field
      </button>
    </span>
  );
}

function EdgeInspector({
  edge,
  sourceFields,
  targetFields,
  sourceLabel,
  targetLabel,
  relevantProviders,
  registry,
  onPatch,
  onSwapEnds,
}: {
  edge: Edge;
  /** Rows of the endpoint nodes — what an end may attach to. */
  sourceFields: readonly NodeField[];
  targetFields: readonly NodeField[];
  /** What the ends are called, so the bar can say what this line joins. */
  sourceLabel: string;
  targetLabel: string;
  relevantProviders: readonly string[];
  registry: ResolvedRegistry;
  onPatch: (id: string, patch: Partial<DiagramEdgeData>) => void;
  onSwapEnds: (id: string) => void;
}) {
  const data = (edge.data ?? {}) as DiagramEdgeData;
  return (
    <>
      {/* Which boxes this line joins, and a way to turn it round. The schema
          has carried edge endpoints since the beginning and the inspector
          never showed them — so "I drew that the wrong way" meant deleting
          the line and drawing it again, losing its label and its route. */}
      <InspectorSection caption="Between">
        <span className="as-inspector__ends" title={`${sourceLabel} → ${targetLabel}`}>
          {sourceLabel} → {targetLabel}
        </span>
        <button
          type="button"
          className="as-btn as-btn--icon"
          onClick={() => onSwapEnds(edge.id)}
          aria-label="Reverse this connection"
          title="Reverse — swap which end it starts from"
        >
          ⇄
        </button>
      </InspectorSection>

      {relevantProviders.length ? (
        // An edge can be scoped to a topology exactly like a node — the
        // README sells "a replication stream present on AWS but not Azure" —
        // and there was no control for it anywhere, so the field could only
        // be set by hand-editing the JSON.
        <ChipListEditor
          caption="On"
          ariaLabel="Providers this connection exists on"
          addPlaceholder="+ add…"
          options={[...relevantProviders]}
          active={data.providers ?? []}
          labelOf={(p) => providerDef(registry, p).label}
          colorOf={(p) => providerDef(registry, p).color}
          onToggle={(p) => {
            const current = data.providers ?? [];
            const next = current.includes(p)
              ? current.filter((x) => x !== p)
              : [...current, p];
            onPatch(edge.id, { providers: next.length ? next : undefined });
          }}
          onAdd={(p) => onPatch(edge.id, { providers: [...(data.providers ?? []), p] })}
        />
      ) : null}

      <InspectorSection caption="Edge">
        <input
          className="as-input as-inspector__name"
          value={data.label ?? ""}
          placeholder="Edge label"
          onChange={(event) => onPatch(edge.id, { label: event.target.value })}
          aria-label="Edge label"
        />
        <input
          className="as-input as-inspector__tech"
          value={data.tech ?? ""}
          placeholder="Tech: JSON/HTTPS"
          onChange={(event) => onPatch(edge.id, { tech: event.target.value })}
          aria-label="Edge technology"
        />
      </InspectorSection>

      <InspectorSection caption="Flow">
        <select
          className="as-select"
          value={data.direction ?? "forward"}
          onChange={(event) => onPatch(edge.id, { direction: event.target.value as EdgeDirection })}
          aria-label="Edge direction"
          title="Arrowheads"
        >
          <option value="forward">→</option>
          <option value="both">↔</option>
          <option value="none">—</option>
        </select>
        <select
          className="as-select"
          value={data.startHead ?? "default"}
          onChange={(event) => {
            const value = event.target.value;
            onPatch(edge.id, {
              startHead: value === "default" ? undefined : (value as EdgeHead),
            });
          }}
          aria-label="Start glyph"
          title="Glyph at the source end — default follows the direction setting"
        >
          <option value="default">tail: default</option>
          {EDGE_HEADS.map((head) => (
            <option key={head} value={head}>
              tail: {head}
            </option>
          ))}
        </select>
        <select
          className="as-select"
          value={data.endHead ?? "default"}
          onChange={(event) => {
            const value = event.target.value;
            onPatch(edge.id, {
              endHead: value === "default" ? undefined : (value as EdgeHead),
            });
          }}
          aria-label="End glyph"
          title="Glyph at the target end — default follows the direction setting"
        >
          <option value="default">head: default</option>
          {EDGE_HEADS.map((head) => (
            <option key={head} value={head}>
              head: {head}
            </option>
          ))}
        </select>
        <input
          className="as-input as-inspector__seq"
          type="number"
          min={0}
          value={data.seq ?? ""}
          placeholder="#"
          onChange={(event) => {
            const n = Number.parseInt(event.target.value, 10);
            onPatch(edge.id, { seq: Number.isFinite(n) && n > 0 ? n : undefined });
          }}
          aria-label="Sequence number"
          title="Step number for a dynamic (numbered-flow) diagram"
        />
      </InspectorSection>

      {/* Cardinality and the rows each end attaches to. Offered where it means
          something — either endpoint has rows, or this edge already carries
          end labels — rather than on every architecture connection. */}
      {sourceFields.length || targetFields.length || data.startLabel || data.endLabel ? (
        <InspectorSection caption="Ends">
          <input
            className="as-input as-inspector__end"
            value={data.startLabel ?? ""}
            placeholder="1"
            onChange={(event) => onPatch(edge.id, { startLabel: event.target.value || undefined })}
            aria-label="Cardinality at the source end"
            title="Cardinality at the source end — 1, 0..1, 0..*, 1..*"
          />
          {sourceFields.length ? (
            <select
              className="as-select"
              value={data.startField ?? ""}
              onChange={(event) => onPatch(edge.id, { startField: event.target.value || undefined })}
              aria-label="Source field"
              title="Which row of the source this line leaves from"
            >
              <option value="">from: box</option>
              {sourceFields.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.name || field.id}
                </option>
              ))}
            </select>
          ) : null}
          {targetFields.length ? (
            <select
              className="as-select"
              value={data.endField ?? ""}
              onChange={(event) => onPatch(edge.id, { endField: event.target.value || undefined })}
              aria-label="Target field"
              title="Which row of the target this line lands on"
            >
              <option value="">to: box</option>
              {targetFields.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.name || field.id}
                </option>
              ))}
            </select>
          ) : null}
          <input
            className="as-input as-inspector__end"
            value={data.endLabel ?? ""}
            placeholder="0..*"
            onChange={(event) => onPatch(edge.id, { endLabel: event.target.value || undefined })}
            aria-label="Cardinality at the target end"
            title="Cardinality at the target end — 1, 0..1, 0..*, 1..*"
          />
        </InspectorSection>
      ) : null}

      <DateSection
        date={data.date}
        what="Edge"
        label="When this connection lands. It is never shown before the nodes it joins."
        onChange={(date) => onPatch(edge.id, { date })}
      />

      <InspectorSection caption="Style">
        <select
          className="as-select"
          value={data.style ?? "solid"}
          onChange={(event) => onPatch(edge.id, { style: event.target.value as EdgeStyle })}
          aria-label="Edge style"
        >
          {EDGE_STYLES.map((style) => (
            <option key={style} value={style}>
              {style}
            </option>
          ))}
        </select>
        <select
          className="as-select"
          value={data.routing ?? "default"}
          onChange={(event) => {
            const value = event.target.value;
            onPatch(edge.id, { routing: value === "default" ? undefined : (value as EdgeRouting) });
          }}
          aria-label="Edge routing"
          title="Routing — default follows the diagram setting"
        >
          <option value="default">routing: default</option>
          {EDGE_ROUTINGS.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
        <select
          className="as-select"
          value={data.start?.side ?? "auto"}
          onChange={(event) => {
            const value = event.target.value;
            // Choosing a side drops any stored fraction: the picker pins the
            // centre of that side; drag the line itself for finer routing.
            onPatch(edge.id, {
              start: value === "auto" ? undefined : { side: value as EdgeAnchorSide },
            });
          }}
          aria-label="Start anchor"
          title="Which side of the source box the line leaves — auto faces wherever it's going"
        >
          <option value="auto">start: auto</option>
          {EDGE_ANCHOR_SIDES.map((side) => (
            <option key={side} value={side}>
              start: {side}
            </option>
          ))}
        </select>
        <select
          className="as-select"
          value={data.end?.side ?? "auto"}
          onChange={(event) => {
            const value = event.target.value;
            onPatch(edge.id, {
              end: value === "auto" ? undefined : { side: value as EdgeAnchorSide },
            });
          }}
          aria-label="End anchor"
          title="Which side of the target box the line arrives at"
        >
          <option value="auto">end: auto</option>
          {EDGE_ANCHOR_SIDES.map((side) => (
            <option key={side} value={side}>
              end: {side}
            </option>
          ))}
        </select>
        {data.points?.length ? (
          <button
            type="button"
            className="as-btn"
            onClick={() => onPatch(edge.id, { points: undefined })}
            title="Remove the waypoints this line bends through (drag the line to bend it; double-click edits the label)"
          >
            Clear route ({data.points.length})
          </button>
        ) : null}
        <div className="as-swatches">
          {EDGE_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              title={color}
              aria-label={`Edge colour ${color}`}
              aria-pressed={data.color === color}
              className={`as-swatch${data.color === color ? " as-swatch--on" : ""}`}
              // Resolves through the theme's --as-edge-* override when set,
              // so the picker shows the colour the edge will actually be.
              style={{ background: `var(--as-edge-${color}, ${EDGE_COLOR_HEX[color as EdgeColor]})` }}
              onClick={() => onPatch(edge.id, { color: color as EdgeColor })}
            />
          ))}
        </div>
      </InspectorSection>
    </>
  );
}

// ─── Small utilities ─────────────────────────────────────────────────────────

/**
 * Points a deletion strands: dangling-arrow dots whose LAST edge is being
 * removed. Only dots the deletion itself disconnects are swept — a point
 * that was already alone (authored via JSON, or by an LLM) is the author's
 * to keep or delete, and removing it as a side effect of deleting something
 * unrelated would be a surprise.
 */
function strandedPoints(
  pointIds: ReadonlySet<string>,
  edges: ReadonlyArray<{ id: string; source: string; target: string }>,
  removed: (edge: { id: string; source: string; target: string }) => boolean,
): Set<string> {
  const out = new Set<string>();
  const kept = edges.filter((e) => !removed(e));
  for (const e of edges) {
    if (!removed(e)) continue;
    for (const end of [e.source, e.target]) {
      if (pointIds.has(end) && !kept.some((k) => k.source === end || k.target === end)) {
        out.add(end);
      }
    }
  }
  return out;
}

/** The document with its title set — the write half of the title↔name sync. */
function withMetaTitle<T extends { meta?: Record<string, unknown> }>(doc: T, title: string): T {
  return { ...doc, meta: { ...doc.meta, title } };
}

function registryOpts(registry: ResolvedRegistry) {
  return {
    knownKinds: registry.kindOrder,
    knownIcons: registry.iconNames,
    containerKinds: registry.containerKinds,
    annotationKinds: registry.annotationKinds,
    knownProviders: registry.providerOrder,
  };
}

function registryKinds(registry: ResolvedRegistry, showHidden = false) {
  return {
    containerKinds: registry.containerKinds,
    annotationKinds: registry.annotationKinds,
    pointKinds: registry.pointKinds,
    showHidden,
  };
}

/**
 * What the canvas is currently showing: each zone's provider, plus whether
 * ghosts are on. The canvas rebuilds when this changes.
 *
 * Both inputs must be in the signature. If the initial value were computed
 * differently from the one the effect compares against, the effect would fire
 * on mount and record a spurious undo entry before the user touched anything.
 */
function viewSignatureOf(
  template: DiagramTemplate,
  showHidden: boolean,
  focusId: string | null = null,
): string {
  const zones = (template.zones ?? []).map((z) => `${z.id}:${z.provider}`).join("|");
  const collapsed = template.nodes
    .filter((n) => n.collapsed)
    .map((n) => n.id)
    .join(",");
  // The DOCUMENT part is everything before `|hidden:` — the rebuild effect
  // splits on it to separate edits (provider switch, collapse → commit) from
  // pure view changes (ghost toggle, drill focus → no undo entry). Anything
  // document-derived added later must go BEFORE that marker; view state after.
  return `${zones}|collapsed:${collapsed}|hidden:${showHidden}|focus:${focusId ?? ""}`;
}

/** The longest prefix of the focus stack whose nodes still exist in `doc`. */
function pruneFocusStack(doc: DiagramTemplate, stack: readonly string[]): string[] {
  const ids = new Set(doc.nodes.map((n) => n.id));
  const out: string[] = [];
  for (const id of stack) {
    if (!ids.has(id)) break;
    out.push(id);
  }
  return out;
}

/**
 * View-only affordance pass over a scoped canvas: the boundary frame is
 * scenery (locked already stops drags; selection would put a dead-end in the
 * inspector), and ghosts move only to be tidied — their drags land in
 * `meta.views`, handled by drag-stop, not by the ordinary commit path.
 */
function decorateScopedNodes(nodes: Node[]): Node[] {
  return nodes.map((n) =>
    isBoundaryNodeId(n.id)
      ? // Not selectable (its inspector would be a dead end) and not
        // draggable (the frame is derived from what it wraps) — but very
        // much CONNECTABLE: an edge drawn to the frame is an edge to the
        // component itself, which is how you wire this level to its parent.
        { ...n, selectable: false, draggable: false }
      : n,
  );
}

/**
 * Flag the canvas for the scrub cursor: later elements are either greyed out
 * or dropped from the render.
 *
 * A pure map over what the editor already holds, applied on the way INTO
 * React Flow and never written back into state, so the document the editor
 * derives from its canvas is unaffected by where the cursor stands.
 */
function applyTimelineView(
  nodes: Node[],
  edges: Edge[],
  future: TimelineFuture | null,
  mode: TimelineFutureMode,
): { nodes: Node[]; edges: Edge[] } {
  if (!future) return { nodes, edges };

  // Zones share the node array under a prefixed id, and a scoped view's
  // derived elements stand in for real ones — the future sets are keyed by
  // DOCUMENT id, so every synthetic id is consulted through its real one.
  const nodeIsFuture = (id: string) =>
    isZoneNodeId(id)
      ? future.zones.has(fromZoneNodeId(id))
      : isBoundaryNodeId(id)
        ? future.nodes.has(id.slice(BOUNDARY_NODE_PREFIX.length))
        : isGhostNodeId(id)
          ? future.nodes.has(ghostSourceId(id))
          : future.nodes.has(id);

  function mark<T extends { className?: string; hidden?: boolean; selected?: boolean }>(
    item: T,
    isFuture: boolean,
  ): T {
    if (!isFuture) return item;
    // Hidden rather than removed: React Flow keeps it in the array, so the
    // editor's own state stays complete. Deselected with it, or the inspector
    // would be editing something invisible.
    if (mode === "hide") return { ...item, hidden: true, selected: false };
    return { ...item, className: `${item.className ? `${item.className} ` : ""}as-future` };
  }

  return {
    nodes: nodes.map((n) => mark(n, nodeIsFuture(n.id))),
    // An endpoint check as well as the edge's own id: a collapse-rerouted edge
    // carries a synthetic id that no future set can know about.
    edges: edges.map((e) => {
      const isFuture =
        future.edges.has(e.id) || nodeIsFuture(e.source) || nodeIsFuture(e.target);
      // The label renders through a portal, outside the edge's own group, so a
      // wrapper class alone would leave it bright — see DiagramEdgeData.future.
      const flagged = isFuture ? { ...e, data: { ...e.data, future: true } } : e;
      return mark(flagged, isFuture);
    }),
  };
}

/**
 * React Flow requires a parent to appear before its children in the array.
 * Zones sort ahead of everything so they paint behind the diagram.
 */
function sortByDepth(nodes: Node[]): Node[] {
  const zoneNodes = nodes.filter((n) => isZoneNodeId(n.id));
  nodes = nodes.filter((n) => !isZoneNodeId(n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = (n: Node) => {
    let d = 0;
    let cursor = n.parentId ? byId.get(n.parentId) : undefined;
    const guard = new Set<string>([n.id]);
    while (cursor && !guard.has(cursor.id)) {
      guard.add(cursor.id);
      d++;
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return d;
  };
  return [...zoneNodes, ...[...nodes].sort((a, b) => depth(a) - depth(b))];
}

export default ArchitectureStudio;

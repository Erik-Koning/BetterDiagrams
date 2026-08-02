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
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type OnSelectionChangeParams,
} from "@xyflow/react";

import {
  DEFAULT_ZONE_OPACITY,
  EDGE_COLORS,
  EDGE_COLOR_HEX,
  EDGE_DASH,
  EDGE_STYLES,
  EMPTY_TEMPLATE,
  NODE_STATUSES,
  ZONE_SHAPES,
  activeScenario,
  assignZonesByGeometry,
  buildSystemPrompt,
  snapNodesIntoZones,
  fromReactFlow,
  fromZoneNodeId,
  isZoneNodeId,
  setAllZoneProviders,
  templateProviders,
  toReactFlow,
  toZoneNodeId,
  validateTemplate,
  visibleElements,
  zoneAt,
  type DiagramEdgeData,
  type DiagramNodeData,
  type DiagramTemplate,
  type DiagramZone,
  type EdgeColor,
  type EdgeDirection,
  type EdgeRouting,
  type EdgeStyle,
  type NodeStatus,
  type VersionTagPosition,
  type ZoneNodeData,
  type ZoneShape,
} from "../contract/schema";
import { DEFAULT_POLYGON_POINTS } from "../contract/zones";
import { lintTemplate, type LintFinding } from "../contract/lint";
import { diffTemplates } from "../contract/diff";
import {
  currentStopIndex,
  templateTimeline,
  timelineStop,
  timelineView,
  type TimelineFutureMode,
} from "../contract/timeline";
import { DiffCanvas } from "./DiffCanvas";
import { TimelineCanvas } from "./TimelineCanvas";
import {
  FileMenu,
  InspectorSection,
  TimelineScrubber,
  ToolbarMenu,
  VersionTagChip,
  type StudioFile,
} from "./chrome";
import { autoLayout, hasOverlaps } from "../contract/layout";
import {
  copyFragment,
  duplicateWithConnections,
  parseFragment,
  pasteFragment,
} from "../contract/clipboard";
import { createRegistry } from "./create-registry";
import type { RegistryExtensions, ResolvedRegistry } from "./registry-types";
import { kindDef, providerDef } from "./registry-types";
import { NODE_TYPES } from "./nodes";
import { EDGE_TYPES } from "./edges";
import { StudioContext } from "./context";
import { paletteFromTheme, themeToStyle, type Theme } from "./theme";
import { useHistory, type Snapshot } from "./history";
import {
  buildRefineMessage,
  coerceGeneratorResult,
  type DiagramGenerator,
} from "../contract/llm";

// ─── Props ───────────────────────────────────────────────────────────────────

export interface StudioSlotContext {
  /** The diagram as it stands, ready to persist. */
  template: DiagramTemplate;
  registry: ResolvedRegistry;
  /** Replace the whole document (adds an undo point). */
  setTemplate: (next: DiagramTemplate) => void;
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
  onFileCreate?: () => void;
  onFileRename?: (id: string, name: string) => void;
  onFileDelete?: (id: string) => void;
  /** Deleted documents the host still holds, offered for recovery. */
  removedFiles?: StudioFile[];
  onFileRestore?: (id: string) => void;
  onNavigateFile?: (ref: string) => void;
  /** Extra toolbar content, rendered after the built-in buttons. */
  toolbarExtras?: ReactNode | ((ctx: StudioSlotContext) => ReactNode);
  /** Extra inspector content, rendered when something is selected. */
  inspectorExtras?: ReactNode | ((ctx: StudioSlotContext) => ReactNode);
  className?: string;
  style?: CSSProperties;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

/** True when focus is in a text field, so global key handlers should stand down. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

// ─── Component ───────────────────────────────────────────────────────────────

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
  toolbarExtras,
  inspectorExtras,
  className,
  style,
}: ArchitectureStudioProps) {
  const registry = useMemo(() => createRegistry(registryExtensions), [registryExtensions]);
  const flow = useReactFlow();

  const initialTemplate = useMemo(
    () => validateTemplate(value ?? defaultValue ?? EMPTY_TEMPLATE, registryOpts(registry)),
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
  } = history;

  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  /**
   * Which toolbar dropdown is open. One slot for all of them, so opening a
   * menu closes whichever other menu was open — no two-menus-at-once states.
   */
  const [openMenu, setOpenMenu] = useState<
    "files" | "insert" | "arrange" | "view" | "checks" | "export" | null
  >(null);
  const [panelOpen, setPanelOpen] = useState(false);
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
  const [searchIndex, setSearchIndex] = useState(0);
  /**
   * Which timeline stop is being shown, or null when the scrubber is off.
   * Pure view state: it never reaches the document, and the scrubbed canvas is
   * a separate read-only React Flow instance, so nothing here can edit.
   */
  const [timelineIndex, setTimelineIndex] = useState<number | null>(null);
  const [timelineFuture, setTimelineFuture] = useState<TimelineFutureMode>("dim");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const compareInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
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

  /** `color` tints the toast like its subject — e.g. the zone a node moved into. */
  const showToast = useCallback((message: string, color?: string) => {
    setToast({ message, color });
    window.setTimeout(
      () => setToast((current) => (current?.message === message ? null : current)),
      2200,
    );
  }, []);

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

  const deriveTemplate = useCallback(
    (n: Node[], e: Edge[]): DiagramTemplate =>
      // Geometry is truth in the editor: the user just dragged something, so a
      // node's zone is whichever zone it now sits in. This is what makes
      // dragging a *zone* over some nodes actually enrol them.
      assignZonesByGeometry(
        fromReactFlow(n, e, {
          ...registryOpts(registry),
          meta: meta.current,
          base: baseRef.current,
          allNodesPresent: rfIncludesHiddenRef.current,
        }),
      ),
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
    (n: Node[], e: Edge[], derived?: DiagramTemplate) => {
      const next = derived ?? deriveTemplate(n, e);
      // The snapshot carries the full document so undo can re-materialize it
      // instead of re-deriving against whatever frame is current by then —
      // undoing across a provider toggle must not re-judge (and lose) nodes.
      commitHistory({ nodes: n, edges: e, meta: meta.current, template: next });
      if (!onChange) return;
      const json = JSON.stringify(next);
      if (json === lastEmitted.current) return;
      lastEmitted.current = json;
      onChange(next);
    },
    [commitHistory, onChange, deriveTemplate],
  );

  /** Commit whatever is in state right now — for changes applied via setNodes. */
  const commitLater = useCallback(() => {
    // Read the freshest state from the store rather than the render closure.
    queueMicrotask(() => commit(flow.getNodes(), flow.getEdges()));
  }, [commit, flow]);

  // ── Controlled mode: adopt external value changes ─────────────────────────

  useEffect(() => {
    if (!value) return;
    // Compare the VALIDATED form on both sides. Comparing the raw prop against
    // the validated JSON never matches — validation fills in defaults such as
    // `fontSize`, so the guard would fail and this effect would re-sync on
    // every render.
    const validated = validateTemplate(value, registryOpts(registry));
    const json = JSON.stringify(validated);
    if (json === lastEmitted.current) return; // the echo of our own onChange

    const next = toReactFlow(validated, registryKinds(registry, showHidden));
    meta.current = validated.meta;
    lastEmitted.current = json;
    baseRef.current = validated; // materialization point: frame follows the canvas
    templateRef.current = validated;
    zoneSignatureRef.current = viewSignatureOf(validated, showHidden);
    rfIncludesHiddenRef.current = showHidden;
    setNodes(next.nodes as Node[]);
    setEdges(next.edges as Edge[]);
    resetHistory({
      nodes: next.nodes as Node[],
      edges: next.edges as Edge[],
      meta: meta.current,
      template: validated,
    });
  }, [value, registry, showHidden, setNodes, setEdges, resetHistory]);

  /**
   * Re-render the canvas when a zone's provider changes.
   *
   * Toggling a provider only mutates that zone node's `data`, which React Flow
   * happily re-renders — but the *set* of nodes on the canvas has to change
   * too, because a provider switch reveals and hides nodes. Rebuilding from
   * the full template is what actually makes the toggle do anything.
   */
  useEffect(() => {
    const signature = viewSignatureOf(template, showHidden);
    if (signature === zoneSignatureRef.current) return;
    // The document part alone decides whether this rebuild is an EDIT
    // (provider switch, collapse — belongs in undo, host must hear) or a pure
    // VIEW change (ghost toggle — committing it would put a do-nothing entry
    // in the undo stack and burn a ⌘Z press on it).
    const docChanged =
      signature.split("|hidden:")[0] !== zoneSignatureRef.current.split("|hidden:")[0];
    zoneSignatureRef.current = signature;

    // Materialization point: the canvas is rebuilt from `template`, so
    // `template` becomes the frame later derivations are judged against.
    baseRef.current = template;
    const next = toReactFlow(template, registryKinds(registry, showHidden));
    rfIncludesHiddenRef.current = showHidden;
    setNodes(next.nodes as Node[]);
    setEdges(next.edges as Edge[]);
    if (docChanged) commit(next.nodes as Node[], next.edges as Edge[], template);
  }, [template, registry, showHidden, setNodes, setEdges, commit]);

  // ── Replace the whole document ────────────────────────────────────────────

  const applyTemplate = useCallback(
    (incoming: DiagramTemplate, { fit = true }: { fit?: boolean } = {}) => {
      // The declaration is truth on import: a generated document usually gets
      // membership right and coordinates approximately right, so move the node
      // to match its declared zone rather than dropping the membership.
      const validated = snapNodesIntoZones(validateTemplate(incoming, registryOpts(registry)));
      const next = toReactFlow(validated, registryKinds(registry, showHidden));
      meta.current = validated.meta;
      baseRef.current = validated; // materialization point
      templateRef.current = validated;
      zoneSignatureRef.current = viewSignatureOf(validated, showHidden);
      rfIncludesHiddenRef.current = showHidden;
      setNodes(next.nodes as Node[]);
      setEdges(next.edges as Edge[]);
      commitHistory({
        nodes: next.nodes as Node[],
        edges: next.edges as Edge[],
        meta: meta.current,
        template: validated,
      });
      if (onChange) {
        const json = JSON.stringify(validated);
        lastEmitted.current = json;
        onChange(validated);
      }
      if (fit) window.setTimeout(() => flow.fitView({ padding: 0.15, duration: 300 }), 50);
    },
    [registry, setNodes, setEdges, history, onChange, flow],
  );

  // ── Node / edge mutations ─────────────────────────────────────────────────

  const addNode = useCallback(
    (kind: string) => {
      if (readOnly) return;
      const def = kindDef(registry, kind);
      const type = def.container ? "group" : def.annotation ? "annotation" : "shape";
      const size = def.container
        ? { w: 320, h: 240 }
        : def.annotation
          ? { w: 280, h: 56 }
          : { w: 170, h: 76 };

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
        zIndex: def.container ? 0 : 1000,
        selected: true,
        data: {
          label: def.annotation ? "Double-click to edit this note." : `New ${def.label}`,
          kind,
          icon: def.icon,
          description: "",
          fontSize: 13,
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

  const copySelection = useCallback(async () => {
    const ids = selectedNodeIds.filter((id) => !isZoneNodeId(id));
    // A selected zone copies as a SUBJECT: the zone plus its member nodes.
    const zoneIds = selectedNodeIds.filter(isZoneNodeId).map(fromZoneNodeId);
    if (!ids.length && !zoneIds.length) return;
    const fragment = copyFragment(templateRef.current, ids, { zones: zoneIds });
    localClipboard.current = fragment;
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
        // pastes here; fall back to the in-memory copy.
        try {
          const text = await navigator.clipboard?.readText();
          if (text) source = parseFragment(text);
        } catch {
          // Permission denied or unsupported.
        }
        source ??= localClipboard.current;
      }
      if (!source?.nodes.length && !source?.zones?.length) return;

      const { template: next, newNodeIds, newZoneIds } = pasteFragment(templateRef.current, source, {
        ...registryOpts(registry),
      });
      applyTemplate(next, { fit: false });
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

  /** Nodes currently on the canvas that match the query. Zones excluded. */
  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return nodes.filter((n) => {
      if (isZoneNodeId(n.id)) return false;
      const d = n.data as DiagramNodeData;
      return (
        n.id.toLowerCase().includes(q) ||
        d.label?.toLowerCase().includes(q) ||
        d.description?.toLowerCase().includes(q) ||
        String(d.kind).toLowerCase().includes(q) ||
        d.tags?.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [nodes, searchQuery]);

  /** Select + centre one match. Enter cycles through them. */
  const jumpToMatch = useCallback(
    (index: number) => {
      const match = searchMatches[((index % searchMatches.length) + searchMatches.length) % searchMatches.length];
      if (!match) return;
      const internal = flow.getInternalNode(match.id);
      const abs = internal?.internals.positionAbsolute ?? match.position;
      const w = match.width ?? (internal?.measured?.width as number) ?? 170;
      const h = match.height ?? (internal?.measured?.height as number) ?? 76;
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
        setCompareTemplate(validateTemplate(raw, registryOpts(registry)));
        // Compare and timeline are both read-only views of the same canvas
        // slot; leaving the scrubber "on" underneath would make the toolbar
        // claim a mode the canvas isn't in.
        setTimelineIndex(null);
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
  // Compare and timeline are both read-only views of the same canvas slot, and
  // a host can turn compare on via the `diffBase` prop at any moment. Deciding
  // the precedence once, here, is what keeps the toolbar, the bar, the canvas,
  // and the inspector from ever disagreeing about which mode is on.
  const timelineActive =
    timelineIndex !== null && timeline.stops.length > 0 && !activeDiffBase;
  const timelineAt = timelineActive ? timelineStop(timeline, timelineIndex) : null;
  // Asked in "dim" mode deliberately: the count is the same either way, and
  // that mode returns the document as-is instead of allocating a filtered copy
  // on every step of a drag.
  const timelineFutureCount = useMemo(
    () => (timelineAt ? timelineView(template, timelineAt, "dim").futureCount : 0),
    [template, timelineAt],
  );

  const enterTimeline = useCallback(() => {
    // Open on today rather than at the origin: the interesting question is
    // usually "what changes from here", not "what did we start with".
    setTimelineIndex(currentStopIndex(timeline));
    // Compare and timeline are both read-only views of the same canvas slot;
    // only one can own it.
    setCompareTemplate(null);
    setOpenMenu(null);
  }, [timeline]);

  const stepTimeline = useCallback(
    (delta: number) => {
      setTimelineIndex((current) =>
        current === null
          ? current
          : Math.max(0, Math.min(timeline.stops.length - 1, current + delta)),
      );
    },
    [timeline.stops.length],
  );

  const versionTag = template.meta?.versionTag;
  const versionTagPosition: VersionTagPosition = template.meta?.versionTagPosition ?? "top-left";
  const patchVersionTag = useCallback(
    (patch: { versionTag?: string; versionTagPosition?: VersionTagPosition }) => {
      // Through applyTemplate (the toggleRouting pattern) so the change is
      // validated, committed, undoable, and emitted like any document edit.
      applyTemplate(
        { ...templateRef.current, meta: { ...templateRef.current.meta, ...patch } },
        { fit: false },
      );
    },
    [applyTemplate],
  );

  const routing: EdgeRouting = template.meta?.routing === "orthogonal" ? "orthogonal" : "curved";

  const toggleRouting = useCallback(() => {
    if (readOnly) return;
    const next: EdgeRouting = routing === "orthogonal" ? "curved" : "orthogonal";
    // Through applyTemplate so every edge's resolved routing refreshes.
    applyTemplate(
      { ...templateRef.current, meta: { ...templateRef.current.meta, routing: next } },
      { fit: false },
    );
    showToast(next === "orthogonal" ? "Right-angle connectors" : "Curved connectors");
  }, [readOnly, routing, applyTemplate, showToast]);

  const tidy = useCallback(() => {
    if (readOnly) return;
    applyTemplate(autoLayout(templateRef.current), { fit: true });
    showToast("Tidied");
  }, [readOnly, applyTemplate, showToast]);

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
      if (connection.source === connection.target) return;
      setEdges((current) =>
        addEdge(
          {
            ...connection,
            id: nextId("e"),
            type: "labeled",
            data: {
              label: "",
              labelT: 0.5,
              style: "solid",
              color: "slate",
              // New edges inherit the diagram default (no own `routing`).
              routingResolved: meta.current?.routing === "orthogonal" ? "orthogonal" : "curved",
            } satisfies DiagramEdgeData,
            style: { stroke: EDGE_COLOR_HEX.slate, strokeWidth: 1.8 },
          },
          current,
        ),
      );
      commitLater();
    },
    [readOnly, setEdges, commitLater],
  );

  const deleteSelection = useCallback(() => {
    if (readOnly) return;
    if (!selectedNodeIds.length && !selectedEdgeIds.length) return;

    // Deleting a container deletes everything nested inside it.
    const doomed = new Set(selectedNodeIds);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of flow.getNodes()) {
        if (n.parentId && doomed.has(n.parentId) && !doomed.has(n.id)) {
          doomed.add(n.id);
          grew = true;
        }
      }
    }

    setNodes((current) => current.filter((n) => !doomed.has(n.id)));
    setEdges((current) =>
      current.filter(
        (e) => !selectedEdgeIds.includes(e.id) && !doomed.has(e.source) && !doomed.has(e.target),
      ),
    );
    commitLater();
  }, [readOnly, selectedNodeIds, selectedEdgeIds, flow, setNodes, setEdges, commitLater]);

  const patchNode = useCallback(
    (id: string, patch: Partial<DiagramNodeData>) => {
      if (readOnly) return;
      setNodes((current) =>
        current.map((n) => {
          if (n.id !== id) return n;
          const data = { ...(n.data as DiagramNodeData), ...patch };
          // Explicit undefined means "clear the field", not "keep the old value".
          for (const key of ["tags", "url", "locked", "providers", "date"] as const) {
            if (key in patch && patch[key] === undefined) delete data[key];
          }
          // Changing kind can change which renderer the node needs.
          const def = kindDef(registry, data.kind);
          const type = def.container ? "group" : def.annotation ? "annotation" : "shape";
          return {
            ...n,
            type,
            data,
            zIndex: def.container ? 0 : 1000,
            // React Flow reads draggability from the node object, not data.
            ...("locked" in patch ? { draggable: !data.locked } : {}),
          };
        }),
      );
      commitLater();
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
          // "routing: default" and a cleared seq or date genuinely unset the
          // field.
          for (const key of ["routing", "seq", "direction", "date"] as const) {
            if (key in patch && patch[key] === undefined) delete data[key];
          }
          // The edge's own routing changed (or was cleared) — recompute what
          // the renderer draws from the diagram default.
          if ("routing" in patch) {
            data.routingResolved =
              data.routing ?? (meta.current?.routing === "orthogonal" ? "orthogonal" : "curved");
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
      commitLater();
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
  const onNodeDragStop = useCallback(
    (_event: unknown, _node: Node, dragged: Node[]) => {
      if (readOnly) return;

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

      const zones = templateRef.current.zones ?? [];
      const updates = new Map<
        string,
        { parentId?: string; position: { x: number; y: number }; zoneId?: string | null }
      >();

      for (const node of dragged) {
        // Dragging a zone moves the backdrop; it has no parent and no zone.
        if (isZoneNodeId(node.id)) continue;
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
      commitLater();
    },
    [readOnly, flow, registry, setNodes, showToast, commitLater],
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
      meta.current = doc.meta;
      baseRef.current = doc; // materialization point
      templateRef.current = doc;
      zoneSignatureRef.current = viewSignatureOf(doc, showHidden);
      rfIncludesHiddenRef.current = showHidden;
      const rf = toReactFlow(doc, registryKinds(registry, showHidden));
      setNodes(rf.nodes as Node[]);
      setEdges(rf.edges as Edge[]);
      if (onChange) {
        lastEmitted.current = JSON.stringify(doc);
        onChange(doc);
      }
    },
    [registry, showHidden, setNodes, setEdges, onChange, deriveTemplate],
  );

  const doUndo = useCallback(() => {
    const snapshot = undoHistory();
    if (snapshot) applySnapshot(snapshot);
  }, [undoHistory, applySnapshot]);

  const doRedo = useCallback(() => {
    const snapshot = redoHistory();
    if (snapshot) applySnapshot(snapshot);
  }, [redoHistory, applySnapshot]);

  // ── Keyboard ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      // ⌘K works from anywhere, including other inputs — it's a navigation key.
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (isTypingTarget(event.target)) return;

      // Arrow keys step the scrubber whenever the canvas has focus, so the
      // whole plan can be walked without aiming at the slider.
      if (timelineActive && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        stepTimeline(event.key === "ArrowRight" ? 1 : -1);
        return;
      }

      // Compare and timeline both show something other than the live document
      // — block shortcuts that would edit what the user cannot see. Undo,
      // redo, and save stay live; both views recompute from the document, so
      // they remain coherent.
      if (
        (activeDiffBase || timelineActive) &&
        (event.key === "Delete" ||
          event.key === "Backspace" ||
          (mod && ["c", "v", "d", "x"].includes(event.key.toLowerCase())))
      ) {
        return;
      }

      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) doRedo();
        else doUndo();
        return;
      }
      if (mod && event.key.toLowerCase() === "y") {
        event.preventDefault();
        doRedo();
        return;
      }
      if (mod && event.key.toLowerCase() === "c") {
        void copySelection();
        return;
      }
      if (mod && event.key.toLowerCase() === "v") {
        event.preventDefault();
        void pasteClipboard();
        return;
      }
      if (mod && event.key.toLowerCase() === "d") {
        event.preventDefault();
        void duplicateSelection();
        return;
      }
      if (mod && event.key.toLowerCase() === "s" && onSave) {
        event.preventDefault();
        void handleSave();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelection();
        return;
      }
      if (event.key === "Escape") {
        setOpenMenu(null);
        setPanelOpen(false);
        setTimelineIndex(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doUndo, doRedo, deleteSelection, onSave, template, copySelection, pasteClipboard, duplicateSelection, activeDiffBase, timelineActive, stepTimeline]);

  const toggleMenu = useCallback(
    (id: "files" | "insert" | "arrange" | "view" | "checks" | "export") =>
      setOpenMenu((current) => (current === id ? null : id)),
    [],
  );

  // Any open dropdown closes on a click outside its own wrapper. A single
  // document-level listener serves every menu, so no menu needs its own
  // outside-click plumbing and two can never be open in disagreement.
  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".as-menu-wrap")) setOpenMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openMenu]);

  // ── Export / import ───────────────────────────────────────────────────────

  // Derived in the theme workstream; dark until a light theme is passed.
  const exportPalette = useMemo(() => paletteFromTheme(theme), [theme]);

  const runExport = useCallback(
    async (key: string) => {
      setOpenMenu(null);
      const exporter = registry.exporters[key];
      if (!exporter) return;
      try {
        // Export what is on screen. While scrubbing, that is the slice — asking
        // for a PNG of the March view and getting the finished architecture
        // would be the one thing nobody means. Ghost mode exports the whole
        // document because that is what it is showing.
        const subject =
          timelineActive && timelineFuture === "hide"
            ? timelineView(template, timelineAt, "hide").template
            : template;
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
    [registry, template, filename, exportPalette, showToast, timelineActive, timelineAt, timelineFuture],
  );

  const loadFile = useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        const raw = JSON.parse(text);
        // Accept both our template shape and a raw React Flow export.
        const isReactFlow = Array.isArray(raw?.nodes) && raw.nodes[0] && "position" in raw.nodes[0];
        const incoming: DiagramTemplate = isReactFlow
          ? fromReactFlow(raw.nodes, raw.edges ?? [], registryOpts(registry))
          : raw;
        applyTemplate(incoming);
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
      if (file) void loadFile(file);
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

  const handleSave = useCallback(async () => {
    if (!onSave) return;
    setSaving(true);
    setError("");
    try {
      await onSave(template);
      showToast("Saved");
    } catch (err) {
      setError(`Save failed: ${(err as Error).message}`);
      setPanelOpen(true);
    } finally {
      setSaving(false);
    }
  }, [onSave, template, showToast]);

  // ── AI generation ─────────────────────────────────────────────────────────

  const systemPrompt = useMemo(
    () =>
      buildSystemPrompt({
        kinds: registry.kindOrder,
        icons: registry.iconNames,
        extraRules: registry.promptExtraRules,
      }),
    [registry],
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
        const result = await generate(
          {
            mode,
            input: mode === "refine" ? buildRefineMessage(template, input) : input,
            systemPrompt,
            ...(mode === "refine" ? { current: template } : {}),
          },
          controller.signal,
        );
        let next = coerceGeneratorResult(result, registryOpts(registry));
        // Models are good at topology and bad at coordinates. Tidy only when
        // the output is actually a mess, so a well-placed diagram — or one the
        // user is refining — keeps the arrangement it was given.
        if (hasOverlaps(next)) next = autoLayout(next);
        applyTemplate(next);
        if (mode === "refine") setRefineInput("");
        setPanelOpen(false);
        showToast(mode === "create" ? "Diagram generated" : "Refinement applied");
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setError((err as Error).message || "Generation failed — try a shorter input.");
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [generate, busy, createInput, refineInput, template, systemPrompt, registry, applyTemplate, showToast],
  );

  useEffect(() => () => abortRef.current?.abort(), []);

  // ── Selection ─────────────────────────────────────────────────────────────

  const onSelectionChange = useCallback((params: OnSelectionChangeParams) => {
    setSelectedNodeIds(params.nodes.map((n) => n.id));
    setSelectedEdgeIds(params.edges.map((e) => e.id));
  }, []);

  const singleSelected =
    selectedNodeIds.length === 1 ? nodes.find((n) => n.id === selectedNodeIds[0]) : undefined;
  // Zones share React Flow's node array but need their own inspector.
  const selectedZoneNode = singleSelected && isZoneNodeId(singleSelected.id) ? singleSelected : undefined;
  const selectedNode = singleSelected && !isZoneNodeId(singleSelected.id) ? singleSelected : undefined;
  const selectedEdge = selectedEdgeIds.length === 1 ? edges.find((e) => e.id === selectedEdgeIds[0]) : undefined;

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
      setNodes((current) =>
        current.map((n) => {
          if (n.id !== toZoneNodeId(zoneId)) return n;
          const zone = { ...(n.data as unknown as ZoneNodeData).zone, ...patch };
          return {
            ...n,
            data: { ...n.data, zone } as unknown as Node["data"],
            ...(patch.w != null || patch.h != null
              ? {
                  width: patch.w ?? n.width,
                  height: patch.h ?? n.height,
                  style: { width: patch.w ?? zone.w, height: patch.h ?? zone.h },
                }
              : {}),
          };
        }),
      );
      commitLater();
    },
    [readOnly, setNodes, commitLater],
  );

  // ── Slots ─────────────────────────────────────────────────────────────────

  const slotContext: StudioSlotContext = useMemo(
    () => ({ template, registry, setTemplate: (next) => applyTemplate(next, { fit: false }) }),
    [template, registry, applyTemplate],
  );
  const renderSlot = (slot: ArchitectureStudioProps["toolbarExtras"]) =>
    typeof slot === "function" ? slot(slotContext) : slot;

  // ── Render ────────────────────────────────────────────────────────────────

  const studioContext = useMemo(
    () => ({
      registry,
      readOnly,
      tagFilter,
      showTeams,
      requestCommit: commitLater,
      navigateFile: onNavigateFile,
    }),
    [registry, readOnly, tagFilter, showTeams, commitLater, onNavigateFile],
  );
  const rootStyle = { ...themeToStyle(theme), ...style };

  return (
    <StudioContext.Provider value={studioContext}>
      <div className={`as-root${className ? ` ${className}` : ""}`} style={rootStyle}>
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
              onRename={onFileRename}
              onDelete={onFileDelete}
              removedFiles={removedFiles}
              onFileRestore={onFileRestore}
            />
          ) : (
            <div className="as-brand">
              <span className="as-brand__mark" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
              </span>
              arch·studio
            </div>
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
                <label
                  className="as-menu__check"
                  title="Right-angle connectors for the whole diagram (per-edge overrides win)"
                >
                  <input
                    type="checkbox"
                    checked={routing === "orthogonal"}
                    onChange={toggleRouting}
                  />
                  Right-angle connectors
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

          {(!readOnly && (hiddenCount > 0 || showHidden || !versionTag)) ||
          allTags.length ||
          anyTeams ? (
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
                {!readOnly && !versionTag ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="as-menu__item"
                    onClick={() => {
                      patchVersionTag({ versionTag: "v0.1" });
                      setOpenMenu(null);
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
                title="Undo (⌘Z)"
                aria-label="Undo"
              >
                ↺
              </button>
              <button
                type="button"
                className="as-btn as-btn--icon"
                onClick={doRedo}
                disabled={!history.canRedo}
                title="Redo (⇧⌘Z)"
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
              placeholder="Search… (⌘K)"
              aria-label="Search nodes"
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setSearchIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && searchMatches.length) {
                  jumpToMatch(searchIndex);
                  setSearchIndex((i) => i + 1);
                }
                if (event.key === "Escape") {
                  setSearchQuery("");
                  (event.target as HTMLInputElement).blur();
                }
                event.stopPropagation();
              }}
            />
            {searchQuery ? (
              <span className="as-search__count" aria-live="polite">
                {searchMatches.length
                  ? `${(searchIndex % searchMatches.length) + 1}/${searchMatches.length}`
                  : "0 matches"}
              </span>
            ) : null}
            <span className="as-zoom">{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              className="as-btn"
              onClick={() => flow.fitView({ padding: 0.15, duration: 300 })}
            >
              Fit
            </button>

            <ToolbarMenu label="Export" open={openMenu === "export"} onToggle={() => toggleMenu("export")}>
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
                onClick={() => (timelineActive ? setTimelineIndex(null) : enterTimeline())}
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
                className="as-btn as-btn--primary"
                onClick={() => void handleSave()}
                disabled={saving}
                title="Save (⌘S)"
              >
                {saving ? "Saving…" : "Save"}
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
            index={timelineIndex}
            onIndex={setTimelineIndex}
            futureMode={timelineFuture}
            onFutureMode={setTimelineFuture}
            futureCount={timelineFutureCount}
            onExit={() => setTimelineIndex(null)}
          />
        ) : null}

        <div
          ref={canvasRef}
          className={`as-canvas${dropActive ? " as-canvas--dropping" : ""}${activeDiffBase ? " as-canvas--diff" : ""}${
            timelineActive ? " as-canvas--timeline" : ""
          }`}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={() => setDropActive(false)}
        >
          {panelOpen && generate && !readOnly ? (
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

              <div className="as-panel__section">
                <h3 className="as-panel__label">Refine current diagram</h3>
                <input
                  className="as-input"
                  value={refineInput}
                  onChange={(event) => setRefineInput(event.target.value)}
                  placeholder={'"make the queue edges dotted" · "add a CDN"'}
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
          ) : timelineActive ? (
            <TimelineCanvas
              template={template}
              at={timelineAt}
              mode={timelineFuture}
              registry={registry}
            />
          ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStop={onNodeDragStop}
            onSelectionChange={onSelectionChange}
            onMove={(_, viewport) => setZoom(viewport.zoom)}
            onPaneClick={() => setOpenMenu(null)}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            connectionMode={ConnectionMode.Loose}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            elementsSelectable
            // The component owns Delete/Backspace so it can cascade to children.
            deleteKeyCode={null}
            selectionOnDrag
            panOnDrag={[1, 2]}
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
            <Controls showInteractive={false} />
            {minimap ? (
              <MiniMap
                pannable
                zoomable
                bgColor="var(--as-surface)"
                maskColor="color-mix(in srgb, var(--as-bg) 70%, transparent)"
                nodeColor={(node) =>
                  isZoneNodeId(node.id)
                    ? providerDef(registry, (node.data as unknown as ZoneNodeData).zone.provider).color
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
                />
              </Panel>
            ) : null}
          </ReactFlow>
          )}

          {(selectedNode || selectedEdge || selectedZoneNode) &&
          !readOnly &&
          !activeDiffBase &&
          !timelineActive ? (
            <div className="as-inspector">
              {selectedZoneNode ? (
                <ZoneInspector
                  zone={(selectedZoneNode.data as unknown as ZoneNodeData).zone}
                  registry={registry}
                  onPatch={patchZone}
                />
              ) : null}
              {selectedNode ? (
                <NodeInspector
                  node={selectedNode}
                  registry={registry}
                  zones={zones}
                  // Authoritative membership comes from the derived template.
                  // React Flow's copy can lag by a frame after a zone is
                  // dragged, since the reassignment happens during derivation.
                  zoneId={template.nodes.find((n) => n.id === selectedNode.id)?.zoneId ?? null}
                  onPatch={patchNode}
                />
              ) : null}
              {selectedEdge ? <EdgeInspector edge={selectedEdge} onPatch={patchEdge} /> : null}
              {renderSlot(inspectorExtras)}
              {selectedNode || selectedZoneNode ? (
                <button
                  type="button"
                  className="as-btn as-btn--icon"
                  onClick={duplicateSelection}
                  aria-label="Duplicate with connections"
                  title={
                    selectedZoneNode
                      ? "Duplicate this zone with its member nodes and their connections (⌘D)"
                      : "Duplicate this node together with its direct connections (⌘D)"
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

          <div className="as-status">
            {toast ? (
              <div
                className={`as-toast${toast.color ? " as-toast--tinted" : ""}`}
                style={toast.color ? ({ "--as-toast-color": toast.color } as CSSProperties) : undefined}
              >
                {toast.message}
              </div>
            ) : null}
            <div className="as-hint">
              drag from a node edge to connect · drop nodes into groups to nest · drag an edge label to
              slide it · ⌘Z undo
            </div>
          </div>
        </div>
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
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
          event.stopPropagation();
        }}
        onBlur={submit}
      />
    </span>
  );
}

function ZoneInspector({
  zone,
  registry,
  onPatch,
}: {
  zone: DiagramZone;
  registry: ResolvedRegistry;
  onPatch: (zoneId: string, patch: Partial<DiagramZone>) => void;
}) {
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
      <button
        type="button"
        className="as-btn"
        onClick={() => onPatch(zone.id, { z: (zone.z ?? 0) + 1 })}
        title="Bring this zone above the others"
      >
        Raise
      </button>
    </>
  );
}

function NodeInspector({
  node,
  registry,
  zones,
  zoneId,
  onPatch,
}: {
  node: Node;
  registry: ResolvedRegistry;
  zones: DiagramZone[];
  zoneId: string | null;
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
        <select
          className="as-select"
          value={data.kind as string}
          onChange={(event) => {
            const kind = event.target.value;
            // Adopt the new kind's default icon so the node doesn't keep a glyph
            // that made sense only for the old kind.
            onPatch(node.id, { kind, icon: kindDef(registry, kind).icon });
          }}
          aria-label="Node kind"
        >
          {registry.kindOrder.map((kind) => (
            <option key={kind} value={kind}>
              {registry.nodeKinds[kind].label}
            </option>
          ))}
        </select>
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
            title="Lifecycle stage — proposed/planned outline, deprecated/retired dim"
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

function EdgeInspector({
  edge,
  onPatch,
}: {
  edge: Edge;
  onPatch: (id: string, patch: Partial<DiagramEdgeData>) => void;
}) {
  const data = (edge.data ?? {}) as DiagramEdgeData;
  return (
    <>
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
          <option value="curved">curved</option>
          <option value="orthogonal">orthogonal</option>
        </select>
        <div className="as-swatches">
          {EDGE_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              title={color}
              aria-label={`Edge colour ${color}`}
              aria-pressed={data.color === color}
              className={`as-swatch${data.color === color ? " as-swatch--on" : ""}`}
              style={{ background: EDGE_COLOR_HEX[color as EdgeColor] }}
              onClick={() => onPatch(edge.id, { color: color as EdgeColor })}
            />
          ))}
        </div>
      </InspectorSection>
    </>
  );
}

// ─── Small utilities ─────────────────────────────────────────────────────────

function registryOpts(registry: ResolvedRegistry) {
  return {
    knownKinds: registry.kindOrder,
    knownIcons: registry.iconNames,
    containerKinds: registry.containerKinds,
    knownProviders: registry.providerOrder,
  };
}

function registryKinds(registry: ResolvedRegistry, showHidden = false) {
  return {
    containerKinds: registry.containerKinds,
    annotationKinds: registry.annotationKinds,
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
function viewSignatureOf(template: DiagramTemplate, showHidden: boolean): string {
  const zones = (template.zones ?? []).map((z) => `${z.id}:${z.provider}`).join("|");
  const collapsed = template.nodes
    .filter((n) => n.collapsed)
    .map((n) => n.id)
    .join(",");
  // `hidden:` MUST come last: the rebuild effect splits on it to separate the
  // document part (zones + collapse → commit) from the view part (ghost
  // toggle → no undo entry). Collapse after it would silently stop committing.
  return `${zones}|collapsed:${collapsed}|hidden:${showHidden}`;
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

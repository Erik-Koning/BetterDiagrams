/**
 * SequenceStudio.tsx — the sequence-diagram editor.
 *
 * Same UX language as ArchitectureStudio (React Flow canvas, toolbar
 * dropdowns, bottom-centre inspector, undo, save, exports, theming) over the
 * sequence schema — but with a much simpler state machine. Nothing in a
 * sequence diagram is ever hidden, so the document derives TOTALLY from the
 * canvas: no baseRef, no visibility carry-through, none of the machinery the
 * architecture editor needs. Every commit re-materializes the canvas from
 * the derived document, which is what snaps rows and columns back to the
 * grid after a drag.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import {
  ACT_ID_PREFIX,
  EMPTY_SEQUENCE,
  FRAG_ID_PREFIX,
  MESSAGE_STYLES,
  NOTE_SIDES,
  NOTE_ID_PREFIX,
  PARTICIPANT_KINDS,
  buildSequencePrompt,
  buildSequenceRefineMessage,
  fromSequenceFlow,
  parseLlmSequence,
  toSequenceFlow,
  validateSequence,
  type SeqActivation,
  type SeqFragment,
  type SeqMessage,
  type SeqNote,
  type SeqParticipant,
  type SeqRFEdge,
  type SeqRFNode,
  type SequenceTemplate,
} from "../../contract/sequence";
import {
  BAR_OVERHANG,
  BAR_W,
  FRAG_HEAD_H,
  HEADER_H,
  HEADER_W,
  MIN_BAR_H,
  ROW_HEIGHT,
  messageRowAt,
} from "../../contract/sequence-layout";
import { NODE_STATUSES, type NodeStatus, type VersionTagPosition } from "../../contract/schema";
import type { DiagramGenerator } from "../../contract/llm";
import type { DiagramTemplate } from "../../contract/schema";
import {
  currentStopIndex,
  sequenceTimeline,
  sequenceTimelineView,
  timelineStop,
  type TimelineFutureMode,
} from "../../contract/timeline";
import { useHistory, type Snapshot } from "../history";
import {
  FileMenu,
  InspectorSection,
  TimelineScrubber,
  ToolbarMenu,
  VersionTagChip,
  type StudioFile,
} from "../chrome";
import { SequenceContext, type SequenceContextValue } from "./context";
import { SequenceTimelineCanvas } from "./SequenceTimelineCanvas";
import { SEQUENCE_NODE_TYPES } from "./SequenceNodes";
import { SEQUENCE_EDGE_TYPES } from "./MessageEdge";
import { BUILTIN_SEQUENCE_EXPORTERS } from "../sequence-exporters";
import { createRegistry } from "../create-registry";
import { paletteFromTheme, themeToStyle, type Theme } from "../theme";

export interface SequenceStudioProps {
  /** Controlled document. Provide with `onChange`. */
  value?: SequenceTemplate;
  /** Initial document for uncontrolled use. Defaults to an empty diagram. */
  defaultValue?: SequenceTemplate;
  /** Fires on every committed edit with the full, validated document. */
  onChange?: (template: SequenceTemplate) => void;
  /** Shows a Save button when provided. `⌘S` also triggers it. */
  onSave?: (template: SequenceTemplate) => void | Promise<void>;
  /**
   * Supply to enable the AI panel — the SAME generator function the
   * architecture editor takes (`createProxyGenerator` works unchanged; the
   * sequence system prompt travels with each request). Omit and no network
   * code runs.
   */
  generate?: DiagramGenerator;
  readOnly?: boolean;
  theme?: Theme;
  /** Base name for exported files. */
  filename?: string;
  /** Host workspace files — same contract as the architecture editor. */
  files?: StudioFile[];
  activeFileId?: string;
  onFileSelect?: (id: string) => void;
  onFileCreate?: () => void;
  onFileRename?: (id: string, name: string) => void;
  onFileDelete?: (id: string) => void;
  /** Deleted documents the host still holds, offered for recovery. */
  removedFiles?: StudioFile[];
  onFileRestore?: (id: string) => void;
  toolbarExtras?: ReactNode;
  inspectorExtras?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

let idCounter = 0;
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
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** Per-node decorations the adapter can't know about (drag constraints). */
function decorate(nodes: SeqRFNode[]): Node[] {
  return nodes.map((n) =>
    n.type === "participant"
      ? // Pin participants to y = 0: the extent bounds the node RECT, so the
        // max edge is y + height.
        ({ ...n, extent: [[-1e6, 0], [1e6, HEADER_H]] } as unknown as Node)
      : (n as unknown as Node),
  );
}

export function SequenceStudio(props: SequenceStudioProps) {
  return (
    <ReactFlowProvider>
      <SequenceInner {...props} />
    </ReactFlowProvider>
  );
}

function SequenceInner({
  value,
  defaultValue,
  onChange,
  onSave,
  generate,
  readOnly = false,
  theme,
  filename = "sequence",
  files,
  activeFileId,
  onFileSelect,
  onFileCreate,
  onFileRename,
  onFileDelete,
  removedFiles,
  onFileRestore,
  toolbarExtras,
  inspectorExtras,
  className,
  style,
}: SequenceStudioProps) {
  const flow = useReactFlow();
  const registry = useMemo(() => createRegistry(), []);

  const initial = useMemo(
    () => validateSequence(value ?? defaultValue ?? EMPTY_SEQUENCE),
    // First mount only; later `value` changes go through the sync effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const initialRF = useMemo(() => toSequenceFlow(initial), [initial]);

  const [nodes, setNodes, onNodesChange] = useNodesState(decorate(initialRF.nodes));
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialRF.edges as unknown as Edge[]);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const [openMenu, setOpenMenu] = useState<"files" | "insert" | "view" | "export" | null>(null);
  const [toast, setToast] = useState("");
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [panelOpen, setPanelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [genError, setGenError] = useState("");
  const [createInput, setCreateInput] = useState("");
  const [refineInput, setRefineInput] = useState("");
  /** Scrub cursor, or null when the timeline is off. Pure view state. */
  const [timelineIndex, setTimelineIndex] = useState<number | null>(null);
  const [timelineFuture, setTimelineFuture] = useState<TimelineFutureMode>("dim");
  const abortRef = useRef<AbortController | null>(null);

  const templateRef = useRef<SequenceTemplate>(initial);
  const metaRef = useRef<SequenceTemplate["meta"]>(initial.meta);
  const lastEmitted = useRef<string>(JSON.stringify(initial));
  const fileInputRef = useRef<HTMLInputElement>(null);

  const history = useHistory({
    nodes: decorate(initialRF.nodes),
    edges: initialRF.edges as unknown as Edge[],
    template: initial,
  });
  const {
    commit: commitHistory,
    reset: resetHistory,
    undo: undoHistory,
    redo: redoHistory,
  } = history;

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((cur) => (cur === message ? "" : cur)), 2200);
  }, []);

  /** Re-materialize the canvas from a validated document. The one write path. */
  const adopt = useCallback(
    (validated: SequenceTemplate, opts: { record?: boolean; emit?: boolean; reset?: boolean }) => {
      templateRef.current = validated;
      metaRef.current = validated.meta;
      const rf = toSequenceFlow(validated);
      const selN = new Set(flow.getNodes().filter((n) => n.selected).map((n) => n.id));
      const selE = new Set(flow.getEdges().filter((e) => e.selected).map((e) => e.id));
      const nn = decorate(rf.nodes).map((n) => ({ ...n, selected: selN.has(n.id) }));
      const ne = (rf.edges as unknown as Edge[]).map((e) => ({ ...e, selected: selE.has(e.id) }));
      setNodes(nn);
      setEdges(ne);
      const snapshot: Snapshot = { nodes: nn, edges: ne, template: validated };
      if (opts.reset) resetHistory(snapshot);
      else if (opts.record) commitHistory(snapshot);
      lastEmitted.current = JSON.stringify(validated);
      if (opts.emit) onChange?.(validated);
    },
    [flow, setNodes, setEdges, commitHistory, resetHistory, onChange],
  );

  /** Derive the document from the live canvas and adopt it (undo + onChange). */
  const commit = useCallback(() => {
    const next = fromSequenceFlow(
      flow.getNodes() as unknown as SeqRFNode[],
      flow.getEdges() as unknown as SeqRFEdge[],
      { meta: metaRef.current },
    );
    adopt(next, { record: true, emit: true });
  }, [flow, adopt]);

  // Latest-closure trampoline so a queued microtask never runs a stale commit.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const commitQueued = useRef(false);
  const commitLater = useCallback(() => {
    if (commitQueued.current) return;
    commitQueued.current = true;
    queueMicrotask(() => {
      commitQueued.current = false;
      commitRef.current();
    });
  }, []);

  const applyTemplate = useCallback(
    (incoming: unknown) => {
      adopt(validateSequence(incoming), { record: true, emit: true });
    },
    [adopt],
  );

  // Controlled mode: adopt external value changes, ignoring our own echoes.
  useEffect(() => {
    if (value === undefined) return;
    const validated = validateSequence(value);
    if (JSON.stringify(validated) === lastEmitted.current) return;
    adopt(validated, { reset: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // ── Gesture endings ───────────────────────────────────────────────────────

  /** Anchor a bar/fragment node to the message rows its box covers. */
  const commitSpanGeometry = useCallback(
    (nodeId: string) => {
      const node = flow.getNodes().find((n) => n.id === nodeId);
      if (!node) return;
      const rows = [...flow.getEdges()].sort(
        (a, b) => ((a.data?.y as number) ?? 0) - ((b.data?.y as number) ?? 0),
      );
      if (!rows.length) {
        setNodes((cur) => cur.filter((n) => n.id !== nodeId));
        showToast("Add a message first — bars anchor to message rows");
        return;
      }
      const isBar = nodeId.startsWith(ACT_ID_PREFIX);
      const topPad = isBar ? BAR_OVERHANG : FRAG_HEAD_H;
      const y = node.position.y;
      const h = (node.height ?? Number(node.style?.height)) || MIN_BAR_H;
      const clamp = (i: number) => Math.max(0, Math.min(rows.length - 1, i));
      const fromIdx = clamp(messageRowAt(y + topPad));
      const toIdx = Math.max(
        fromIdx,
        clamp(messageRowAt(y + h - (isBar ? BAR_OVERHANG : ROW_HEIGHT / 2))),
      );
      const fromId = (rows[fromIdx].data as { message: SeqMessage }).message.id;
      const toId = (rows[toIdx].data as { message: SeqMessage }).message.id;

      setNodes((cur) =>
        cur.map((n) => {
          if (n.id !== nodeId) return n;
          if (isBar) {
            const act = (n.data as { activation: SeqActivation }).activation;
            return { ...n, data: { ...n.data, activation: { ...act, from: fromId, to: toId } } };
          }
          const frag = (n.data as { fragment: SeqFragment }).fragment;
          return { ...n, data: { ...n.data, fragment: { ...frag, from: fromId, to: toId } } };
        }),
      );
      commitLater();
    },
    [flow, setNodes, showToast, commitLater],
  );

  /** Bars only move vertically along their own lifeline. */
  const onNodeDrag = useCallback(
    (_event: unknown, node: Node) => {
      if (node.type !== "activation") return;
      setNodes((cur) =>
        cur.map((n) =>
          n.id === node.id
            ? {
                ...n,
                position: {
                  x: (HEADER_W - BAR_W) / 2,
                  y: Math.max(HEADER_H + 8, n.position.y),
                },
              }
            : n,
        ),
      );
    },
    [setNodes],
  );

  const onNodeDragStop = useCallback(
    (_event: unknown, node: Node) => {
      if (readOnly) return;
      if (node.type === "participant") {
        // Derivation sorts columns by x and renormalizes their positions.
        commitLater();
      } else if (node.type === "activation" || node.type === "fragment") {
        commitSpanGeometry(node.id);
      } else if (node.type === "seqnote") {
        // A dropped note re-reads its side and row from where it landed.
        const note = (node.data as { note: SeqNote }).note;
        const anchor = flow.getNodes().find((n) => n.id === note.participant);
        const rows = [...flow.getEdges()].sort(
          (a, b) => ((a.data?.y as number) ?? 0) - ((b.data?.y as number) ?? 0),
        );
        const lifeX = (anchor?.position.x ?? 0) + HEADER_W / 2;
        const cx = node.position.x + ((node.width ?? 168) as number) / 2;
        const side = Math.abs(cx - lifeX) < 50 ? "over" : cx < lifeX ? "left" : "right";
        const rowIdx = rows.length
          ? Math.max(0, Math.min(rows.length - 1, messageRowAt(node.position.y + 16)))
          : undefined;
        const at =
          rowIdx !== undefined
            ? (rows[rowIdx].data as { message: SeqMessage }).message.id
            : undefined;
        setNodes((cur) =>
          cur.map((n) =>
            n.id === node.id
              ? { ...n, data: { ...n.data, note: { ...note, side, ...(at ? { at } : {}) } } }
              : n,
          ),
        );
        commitLater();
      }
    },
    [readOnly, flow, setNodes, commitLater, commitSpanGeometry],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (readOnly || !conn.source || !conn.target) return;
      const t = templateRef.current;
      applyTemplate({
        ...t,
        messages: [
          ...t.messages,
          { id: nextId("m"), from: conn.source, to: conn.target, label: "message", style: "sync" },
        ],
      });
    },
    [readOnly, applyTemplate],
  );

  const onSelectionChange = useCallback(
    ({ nodes: selNodes, edges: selEdges }: { nodes: Node[]; edges: Edge[] }) => {
      setSelectedNodeIds(selNodes.map((n) => n.id));
      setSelectedEdgeIds(selEdges.map((e) => e.id));
    },
    [],
  );

  // ── Document edits ────────────────────────────────────────────────────────

  const addParticipant = useCallback(
    (kind: SeqParticipant["kind"]) => {
      const t = templateRef.current;
      applyTemplate({
        ...t,
        participants: [
          ...t.participants,
          { id: nextId("p"), label: kind === "actor" ? "New Actor" : "New Participant", kind },
        ],
      });
    },
    [applyTemplate],
  );

  const selectedParticipantId = useMemo(() => {
    // From live canvas state, not a ref — a ref would go stale when
    // participants change without the selection changing (e.g. deletion).
    const participantIds = new Set(
      nodes.filter((n) => n.type === "participant").map((n) => n.id),
    );
    return (
      selectedNodeIds.find((nid) => participantIds.has(nid)) ??
      nodes.find((n) => n.type === "participant")?.id
    );
  }, [selectedNodeIds, nodes]);

  const addMessage = useCallback(
    (self: boolean) => {
      const t = templateRef.current;
      const from = self ? selectedParticipantId : t.participants[0]?.id;
      const to = self ? selectedParticipantId : t.participants[1]?.id;
      if (!from || !to) return;
      applyTemplate({
        ...t,
        messages: [
          ...t.messages,
          { id: nextId("m"), from, to, label: self ? "do work" : "message", style: "sync" },
        ],
      });
    },
    [applyTemplate, selectedParticipantId],
  );

  const addNote = useCallback(() => {
    const t = templateRef.current;
    if (!selectedParticipantId) return;
    applyTemplate({
      ...t,
      notes: [
        ...(t.notes ?? []),
        { id: nextId("n"), text: "Note", side: "right", participant: selectedParticipantId },
      ],
    });
  }, [applyTemplate, selectedParticipantId]);

  const addFragment = useCallback(() => {
    const t = templateRef.current;
    const index = new Map(t.messages.map((m, i) => [m.id, i]));
    const covered = selectedEdgeIds.filter((id) => index.has(id));
    if (!covered.length) return;
    const sorted = [...covered].sort((a, b) => index.get(a)! - index.get(b)!);
    applyTemplate({
      ...t,
      fragments: [
        ...(t.fragments ?? []),
        { id: nextId("f"), kind: "opt", label: "condition", from: sorted[0], to: sorted[sorted.length - 1] },
      ],
    });
  }, [applyTemplate, selectedEdgeIds]);

  const deleteSelection = useCallback(() => {
    if (readOnly) return;
    if (!selectedNodeIds.length && !selectedEdgeIds.length) return;
    const t = templateRef.current;
    const nodeIds = new Set(selectedNodeIds);
    const edgeIds = new Set(selectedEdgeIds);
    const stripped = (prefix: string) =>
      new Set(
        selectedNodeIds.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length)),
      );
    const acts = stripped(ACT_ID_PREFIX);
    const frags = stripped(FRAG_ID_PREFIX);
    const notes = stripped(NOTE_ID_PREFIX);
    applyTemplate({
      ...t,
      participants: t.participants.filter((p) => !nodeIds.has(p.id)),
      messages: t.messages.filter((m) => !edgeIds.has(m.id)),
      activations: (t.activations ?? []).filter((a) => !acts.has(a.id)),
      fragments: (t.fragments ?? []).filter((f) => !frags.has(f.id)),
      notes: (t.notes ?? []).filter((n) => !notes.has(n.id)),
    });
  }, [readOnly, selectedNodeIds, selectedEdgeIds, applyTemplate]);

  // ── Timeline mode ─────────────────────────────────────────────────────────
  // Same contract as the architecture editor: the document's own dates are the
  // stops, and the scrubbed canvas is a separate read-only React Flow instance
  // — this editor's inverse adapter is TOTAL, so a filtered canvas would
  // derive a document with those participants and messages simply gone.
  //
  // Declared above the key handler on purpose: the handler names
  // `timelineActive` in its dependency array, which is evaluated during render.
  const template = templateRef.current;
  const autonumber = template.meta?.autonumber === true;
  const versionTag = template.meta?.versionTag;
  const versionTagPosition: VersionTagPosition = template.meta?.versionTagPosition ?? "top-left";

  const timeline = useMemo(() => sequenceTimeline(template), [template]);
  const timelineActive = timelineIndex !== null && timeline.stops.length > 0;
  const timelineAt = timelineActive ? timelineStop(timeline, timelineIndex) : null;
  // "dim" deliberately: the count is mode-independent, and that mode returns
  // the document as-is instead of allocating a filtered copy on every step.
  const timelineFutureCount = useMemo(
    () => (timelineAt ? sequenceTimelineView(template, timelineAt, "dim").futureCount : 0),
    [template, timelineAt],
  );

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

  // ── Undo / redo / keyboard ────────────────────────────────────────────────

  const applySnapshot = useCallback(
    (snapshot: Snapshot | null) => {
      if (!snapshot) return;
      const template = snapshot.template as SequenceTemplate;
      templateRef.current = template;
      metaRef.current = template.meta;
      setNodes(snapshot.nodes);
      setEdges(snapshot.edges);
      lastEmitted.current = JSON.stringify(template);
      onChange?.(template);
    },
    [setNodes, setEdges, onChange],
  );

  const doUndo = useCallback(() => applySnapshot(undoHistory()), [applySnapshot, undoHistory]);
  const doRedo = useCallback(() => applySnapshot(redoHistory()), [applySnapshot, redoHistory]);

  const handleSave = useCallback(async () => {
    if (!onSave) return;
    setSaving(true);
    try {
      await onSave(templateRef.current);
      showToast("Saved");
    } finally {
      setSaving(false);
    }
  }, [onSave, showToast]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (isTypingTarget(event.target)) return;
      if (timelineActive && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        stepTimeline(event.key === "ArrowRight" ? 1 : -1);
        return;
      }
      // The scrubbed canvas shows a slice, not the document — a delete here
      // would remove something the user may not even be able to see.
      if (timelineActive && (event.key === "Delete" || event.key === "Backspace")) return;
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
        setTimelineIndex(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [doUndo, doRedo, deleteSelection, handleSave, onSave, timelineActive, stepTimeline]);

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".as-menu-wrap")) setOpenMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openMenu]);

  const toggleMenu = useCallback(
    (id: "files" | "insert" | "view" | "export") =>
      setOpenMenu((cur) => (cur === id ? null : id)),
    [],
  );

  // ── Export / import / meta ────────────────────────────────────────────────

  const exportPalette = useMemo(() => paletteFromTheme(theme), [theme]);
  const runExport = useCallback(
    async (key: string) => {
      setOpenMenu(null);
      const exporter = BUILTIN_SEQUENCE_EXPORTERS[key];
      if (!exporter) return;
      // Export what is on screen — while scrubbing with later steps hidden,
      // that is the slice, not the finished flow.
      const subject =
        timelineActive && timelineFuture === "hide"
          ? sequenceTimelineView(templateRef.current, timelineAt, "hide").template
          : templateRef.current;
      const result = await exporter.run({
        template: subject,
        registry,
        filename,
        palette: exportPalette,
      });
      if (result) {
        download(result.blob, result.filename);
        showToast(`Exported ${result.filename}`);
      }
    },
    [registry, filename, exportPalette, showToast, timelineActive, timelineAt, timelineFuture],
  );

  const loadFile = useCallback(
    async (file: File) => {
      try {
        applyTemplate(JSON.parse(await file.text()));
        showToast(`Loaded ${file.name}`);
      } catch (err) {
        showToast(`Could not load ${file.name}: ${(err as Error).message}`);
      }
    },
    [applyTemplate, showToast],
  );

  const patchMeta = useCallback(
    (patch: Record<string, unknown>) => {
      applyTemplate({
        ...templateRef.current,
        meta: { ...templateRef.current.meta, ...patch },
      });
    },
    [applyTemplate],
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
      setGenError("");

      try {
        const result = await generate(
          {
            mode,
            input:
              mode === "refine" ? buildSequenceRefineMessage(templateRef.current, input) : input,
            systemPrompt: buildSequencePrompt(),
            // The generator contract is shared with the architecture editor;
            // the payload shape is identical, only the schema differs.
            ...(mode === "refine"
              ? { current: templateRef.current as unknown as DiagramTemplate }
              : {}),
          },
          controller.signal,
        );
        const next =
          typeof result === "string" ? parseLlmSequence(result) : validateSequence(result);
        applyTemplate(next);
        if (mode === "refine") setRefineInput("");
        setPanelOpen(false);
        showToast(mode === "create" ? "Sequence generated" : "Refinement applied");
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setGenError((err as Error).message || "Generation failed — try a shorter input.");
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [generate, busy, createInput, refineInput, applyTemplate, showToast],
  );

  const context = useMemo<SequenceContextValue>(
    () => ({ readOnly, autonumber, requestCommit: commitLater, commitSpanGeometry }),
    [readOnly, autonumber, commitLater, commitSpanGeometry],
  );

  // ── Inspector helpers ─────────────────────────────────────────────────────

  const patchNodeData = useCallback(
    (nodeId: string, dataPatch: Record<string, unknown>) => {
      setNodes((cur) =>
        cur.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...dataPatch } } : n)),
      );
      commitLater();
    },
    [setNodes, commitLater],
  );

  const patchMessage = useCallback(
    (edgeId: string, patch: Partial<SeqMessage>) => {
      setEdges((cur) =>
        cur.map((e) =>
          e.id === edgeId
            ? { ...e, data: { ...e.data, message: { ...(e.data as { message: SeqMessage }).message, ...patch } } }
            : e,
        ),
      );
      commitLater();
    },
    [setEdges, commitLater],
  );

  const singleNode =
    selectedNodeIds.length === 1 && !selectedEdgeIds.length
      ? nodes.find((n) => n.id === selectedNodeIds[0])
      : undefined;
  const singleEdge =
    selectedEdgeIds.length === 1 && !selectedNodeIds.length
      ? edges.find((e) => e.id === selectedEdgeIds[0])
      : undefined;

  const rootStyle = { ...themeToStyle(theme), ...style };

  return (
    <SequenceContext.Provider value={context}>
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
              seq·studio
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
                title="Add participants, messages, notes, or fragments"
                open={openMenu === "insert"}
                onToggle={() => toggleMenu("insert")}
                menuClassName="as-menu--left"
              >
                <button type="button" role="menuitem" className="as-menu__item" onClick={() => { addParticipant("service"); setOpenMenu(null); }}>
                  <div className="as-menu__label">Participant</div>
                  <div className="as-menu__hint">A service column with its lifeline</div>
                </button>
                <button type="button" role="menuitem" className="as-menu__item" onClick={() => { addParticipant("actor"); setOpenMenu(null); }}>
                  <div className="as-menu__label">Actor</div>
                  <div className="as-menu__hint">A human participant</div>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="as-menu__item"
                  disabled={template.participants.length < 2}
                  onClick={() => { addMessage(false); setOpenMenu(null); }}
                >
                  <div className="as-menu__label">Message</div>
                  <div className="as-menu__hint">Or drag between two lifeline headers</div>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="as-menu__item"
                  disabled={!template.participants.length}
                  onClick={() => { addMessage(true); setOpenMenu(null); }}
                >
                  <div className="as-menu__label">Self-message</div>
                  <div className="as-menu__hint">A participant calling itself</div>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="as-menu__item"
                  disabled={!template.participants.length}
                  onClick={() => { addNote(); setOpenMenu(null); }}
                >
                  <div className="as-menu__label">Note</div>
                  <div className="as-menu__hint">Beside the selected participant</div>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="as-menu__item"
                  disabled={!selectedEdgeIds.length}
                  title={selectedEdgeIds.length ? undefined : "Select one or more messages first"}
                  onClick={() => { addFragment(); setOpenMenu(null); }}
                >
                  <div className="as-menu__label">Fragment around selection</div>
                  <div className="as-menu__hint">loop / alt / opt / par frame</div>
                </button>
              </ToolbarMenu>
            </div>
          ) : null}

          {!readOnly ? (
            <div className="as-toolbar__group">
              <button type="button" className="as-btn as-btn--icon" onClick={doUndo} disabled={!history.canUndo} title="Undo (⌘Z)" aria-label="Undo">
                ↺
              </button>
              <button type="button" className="as-btn as-btn--icon" onClick={doRedo} disabled={!history.canRedo} title="Redo (⇧⌘Z)" aria-label="Redo">
                ↻
              </button>
            </div>
          ) : null}

          <div className="as-toolbar__group">
            <ToolbarMenu
              label="View"
              title="Numbering and the version tag"
              active={autonumber}
              open={openMenu === "view"}
              onToggle={() => toggleMenu("view")}
              menuClassName="as-menu--left"
            >
              <label className="as-menu__check" title="Number every message, Mermaid autonumber-style">
                <input
                  type="checkbox"
                  checked={autonumber}
                  disabled={readOnly}
                  onChange={() => patchMeta({ autonumber: autonumber ? undefined : true })}
                />
                Autonumber messages
              </label>
              {!readOnly && !versionTag ? (
                <button
                  type="button"
                  role="menuitem"
                  className="as-menu__item"
                  onClick={() => { patchMeta({ versionTag: "v0.1" }); setOpenMenu(null); }}
                >
                  <div className="as-menu__label">Set version tag…</div>
                  <div className="as-menu__hint">A revision notice pinned in a corner</div>
                </button>
              ) : null}
            </ToolbarMenu>
          </div>

          {toolbarExtras}

          <div className="as-toolbar__group as-toolbar__spacer">
            {/* Offered only once something is dated. */}
            {timeline.stops.length ? (
              <button
                type="button"
                className={`as-btn${timelineActive ? " as-btn--on" : ""}`}
                onClick={() =>
                  setTimelineIndex(timelineActive ? null : currentStopIndex(timeline))
                }
                aria-pressed={timelineActive}
                title={`Scrub through the ${timeline.stops.length} dated point${
                  timeline.stops.length === 1 ? "" : "s"
                } in this flow`}
              >
                ⏱ Timeline
              </button>
            ) : null}
            <span className="as-zoom">{Math.round(zoom * 100)}%</span>
            <button type="button" className="as-btn" onClick={() => flow.fitView({ padding: 0.15, duration: 300 })}>
              Fit
            </button>
            <ToolbarMenu label="Export" open={openMenu === "export"} onToggle={() => toggleMenu("export")}>
              {Object.entries(BUILTIN_SEQUENCE_EXPORTERS).map(([key, exporter]) => (
                <button key={key} type="button" role="menuitem" className="as-menu__item" onClick={() => void runExport(key)}>
                  <div className="as-menu__label">{exporter.label}</div>
                  {exporter.hint ? <div className="as-menu__hint">{exporter.hint}</div> : null}
                </button>
              ))}
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
            {onSave && !readOnly ? (
              <button type="button" className="as-btn as-btn--primary" onClick={() => void handleSave()} disabled={saving} title="Save (⌘S)">
                {saving ? "Saving…" : "Save"}
              </button>
            ) : null}
          </div>
        </div>

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

        <div className={`as-canvas${timelineActive ? " as-canvas--timeline" : ""}`}>
          {panelOpen && generate && !readOnly ? (
            <div className="as-panel">
              <div className="as-panel__head">
                <h2 className="as-panel__title">Generate sequence</h2>
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
                placeholder="Describe the sequence — who participates, how it flows, the steps in order, conditions and retries…"
              />
              <button
                type="button"
                className="as-btn as-btn--primary"
                onClick={() => void runGenerate("create")}
                disabled={busy || !createInput.trim()}
              >
                {busy ? "Working…" : "Generate sequence"}
              </button>

              <div className="as-panel__section">
                <h3 className="as-panel__label">Refine current sequence</h3>
                <input
                  className="as-input"
                  value={refineInput}
                  onChange={(event) => setRefineInput(event.target.value)}
                  placeholder={'"add a retry loop around the DB call" · "make the charge async"'}
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

              {genError ? <div className="as-error">{genError}</div> : null}

              <p className="as-panel__foot">
                The model is prompted with the sequence schema; message order is time, and your
                description of the steps drives the ordering, activations, and fragments.
              </p>
            </div>
          ) : null}

          {timelineActive ? (
            <SequenceTimelineCanvas template={template} at={timelineAt} mode={timelineFuture} />
          ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onSelectionChange={onSelectionChange}
            onMove={(_, viewport) => setZoom(viewport.zoom)}
            onPaneClick={() => setOpenMenu(null)}
            nodeTypes={SEQUENCE_NODE_TYPES}
            edgeTypes={SEQUENCE_EDGE_TYPES}
            connectionMode={ConnectionMode.Loose}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            elementsSelectable
            fitView
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.1}
            proOptions={{ hideAttribution: false }}
            deleteKeyCode={null}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="var(--as-grid-dot)" />
            <Controls showInteractive={false} />
            {versionTag ? (
              <Panel position={versionTagPosition} className="as-version-panel">
                <VersionTagChip
                  tag={versionTag}
                  position={versionTagPosition}
                  readOnly={readOnly}
                  onCommit={patchMeta}
                />
              </Panel>
            ) : null}
          </ReactFlow>
          )}

          {(singleNode || singleEdge) && !readOnly && !timelineActive ? (
            <div className="as-inspector">
              {singleNode?.type === "participant" ? (
                <ParticipantInspector
                  node={singleNode}
                  onPatch={(patch) =>
                    patchNodeData(singleNode.id, {
                      participant: {
                        ...(singleNode.data as { participant: SeqParticipant }).participant,
                        ...patch,
                      },
                    })
                  }
                />
              ) : null}
              {singleNode?.type === "fragment" ? (
                <FragmentInspector
                  node={singleNode}
                  messages={template.messages}
                  onPatch={(patch) =>
                    patchNodeData(singleNode.id, {
                      fragment: {
                        ...(singleNode.data as { fragment: SeqFragment }).fragment,
                        ...patch,
                      },
                    })
                  }
                />
              ) : null}
              {singleNode?.type === "seqnote" ? (
                <NoteInspector
                  node={singleNode}
                  onPatch={(patch) =>
                    patchNodeData(singleNode.id, {
                      note: { ...(singleNode.data as { note: SeqNote }).note, ...patch },
                    })
                  }
                />
              ) : null}
              {singleNode?.type === "activation" ? (
                <InspectorSection caption="Activation">
                  <span className="as-inspector__caption">
                    on {(singleNode.data as { activation: SeqActivation }).activation.participant}
                  </span>
                </InspectorSection>
              ) : null}
              {singleEdge ? (
                <MessageInspector edge={singleEdge} onPatch={(patch) => patchMessage(singleEdge.id, patch)} />
              ) : null}
              {inspectorExtras}
              <button type="button" className="as-btn as-btn--danger" onClick={deleteSelection}>
                Delete
              </button>
            </div>
          ) : null}

          <div className="as-status">
            {toast ? <div className="as-toast">{toast}</div> : null}
            <div className="as-hint">
              drag between headers to connect · press-drag a lifeline to add a bar · drag a
              message label up/down to reorder · ⌘Z undo
            </div>
          </div>
        </div>
      </div>
    </SequenceContext.Provider>
  );
}

// ─── Inspectors ──────────────────────────────────────────────────────────────

function ParticipantInspector({
  node,
  onPatch,
}: {
  node: Node;
  onPatch: (patch: Partial<SeqParticipant>) => void;
}) {
  const p = (node.data as { participant: SeqParticipant }).participant;
  return (
    <>
      <InspectorSection caption="Participant">
        <input
          className="as-input as-inspector__name"
          value={p.label}
          onChange={(e) => onPatch({ label: e.target.value })}
          aria-label="Participant label"
        />
        <select
          className="as-select"
          value={p.kind}
          onChange={(e) => onPatch({ kind: e.target.value as SeqParticipant["kind"] })}
          aria-label="Participant kind"
        >
          {PARTICIPANT_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select
          className="as-select"
          value={p.status ?? "active"}
          onChange={(e) => {
            const v = e.target.value as NodeStatus;
            onPatch({ status: v === "active" ? undefined : v });
          }}
          aria-label="Lifecycle status"
        >
          {NODE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </InspectorSection>
      <InspectorSection caption="Info">
        <input
          className="as-input as-inspector__desc"
          value={p.description ?? ""}
          placeholder="Description…"
          onChange={(e) => onPatch({ description: e.target.value || undefined })}
          aria-label="Participant description"
        />
      </InspectorSection>
      <InspectorSection caption="Team">
        <input
          className="as-input as-inspector__team"
          value={p.team ?? ""}
          placeholder="Owning team…"
          onChange={(e) => onPatch({ team: e.target.value || undefined })}
          aria-label="Owning team"
        />
      </InspectorSection>
      <SeqDateSection
        date={p.date}
        what="Participant"
        label="When this participant joins the flow. Undated means always present."
        onChange={(date) => onPatch({ date })}
      />
    </>
  );
}

/**
 * The date control, shared by the participant and message inspectors.
 *
 * A native `<input type="date">` because its value format IS the stored format
 * — mirrors the architecture editor's control exactly, so the two editors
 * behave identically for a field they share.
 */
function SeqDateSection({
  date,
  what,
  label,
  onChange,
}: {
  date?: string;
  /** What carries the date — "Participant", "Message". Names the control. */
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
        onChange={(e) => onChange(e.target.value || undefined)}
        // Not just "Date": the section's own caption is already that.
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

function MessageInspector({
  edge,
  onPatch,
}: {
  edge: Edge;
  onPatch: (patch: Partial<SeqMessage>) => void;
}) {
  const m = (edge.data as { message: SeqMessage }).message;
  return (
    <>
      <InspectorSection caption="Message">
        <input
          className="as-input as-inspector__name"
          value={m.label}
          onChange={(e) => onPatch({ label: e.target.value })}
          aria-label="Message label"
        />
        <input
          className="as-input as-inspector__tech"
          value={m.tech ?? ""}
          placeholder="Tech: JSON/HTTPS"
          onChange={(e) => onPatch({ tech: e.target.value || undefined })}
          aria-label="Message technology"
        />
      </InspectorSection>
      <InspectorSection caption="Style">
        <select
          className="as-select"
          value={m.style}
          onChange={(e) => onPatch({ style: e.target.value as SeqMessage["style"] })}
          aria-label="Message style"
        >
          {MESSAGE_STYLES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="as-btn as-btn--icon"
          disabled={m.from === m.to}
          onClick={() => onPatch({ from: m.to, to: m.from })}
          title="Swap direction"
          aria-label="Swap message direction"
        >
          ⇄
        </button>
      </InspectorSection>
      <SeqDateSection
        date={m.date}
        what="Message"
        label="When this step enters the flow. It is never shown before either participant."
        onChange={(date) => onPatch({ date })}
      />
    </>
  );
}

function FragmentInspector({
  node,
  messages,
  onPatch,
}: {
  node: Node;
  messages: SeqMessage[];
  onPatch: (patch: Partial<SeqFragment>) => void;
}) {
  const f = (node.data as { fragment: SeqFragment }).fragment;
  const index = new Map(messages.map((m, i) => [m.id, i]));
  const fromIdx = index.get(f.from) ?? 0;
  const toIdx = index.get(f.to) ?? fromIdx;
  // First message strictly inside the span not already used by a branch.
  const usedAts = new Set((f.elses ?? []).map((e) => e.at));
  const nextBranchAt = messages
    .slice(fromIdx + 1, toIdx + 1)
    .find((m) => !usedAts.has(m.id))?.id;

  return (
    <>
      <InspectorSection caption="Fragment">
        <select
          className="as-select"
          value={f.kind}
          onChange={(e) => onPatch({ kind: e.target.value as SeqFragment["kind"] })}
          aria-label="Fragment kind"
        >
          {["loop", "alt", "opt", "par", "break"].map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input
          className="as-input as-inspector__name"
          value={f.label}
          placeholder="Guard, e.g. valid?"
          onChange={(e) => onPatch({ label: e.target.value })}
          aria-label="Fragment guard"
        />
      </InspectorSection>
      <InspectorSection caption="Branches">
        <button
          type="button"
          className="as-btn"
          disabled={!nextBranchAt}
          title={nextBranchAt ? "Add an else/and branch" : "No free message row inside the span"}
          onClick={() =>
            onPatch({ elses: [...(f.elses ?? []), { label: "else", at: nextBranchAt! }] })
          }
        >
          + branch
        </button>
        {(f.elses ?? []).length ? (
          <button
            type="button"
            className="as-btn"
            onClick={() => {
              const elses = (f.elses ?? []).slice(0, -1);
              onPatch({ elses: elses.length ? elses : undefined });
            }}
          >
            − branch
          </button>
        ) : null}
      </InspectorSection>
    </>
  );
}

function NoteInspector({
  node,
  onPatch,
}: {
  node: Node;
  onPatch: (patch: Partial<SeqNote>) => void;
}) {
  const n = (node.data as { note: SeqNote }).note;
  return (
    <InspectorSection caption="Note">
      <input
        className="as-input as-inspector__desc"
        value={n.text}
        onChange={(e) => onPatch({ text: e.target.value })}
        aria-label="Note text"
      />
      <select
        className="as-select"
        value={n.side}
        onChange={(e) => onPatch({ side: e.target.value as SeqNote["side"] })}
        aria-label="Note side"
      >
        {NOTE_SIDES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </InspectorSection>
  );
}

export default SequenceStudio;

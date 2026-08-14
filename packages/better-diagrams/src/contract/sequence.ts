/**
 * sequence.ts — the sequence-diagram document: a SECOND schema beside the
 * architecture template, sharing the same philosophy:
 *
 *   - `validateSequence` repairs rather than throws: unknown kinds coerce,
 *     dangling references drop or degrade, defaults are stripped so an old
 *     document round-trips byte-identical through load → save.
 *   - The document stores NO coordinates. Participant column = array order,
 *     message time = array order. Activations, fragments, and notes anchor to
 *     MESSAGE IDS, so inserting a message inside a span grows the span and
 *     deleting one degrades predictably.
 *   - The React Flow adapters are TOTAL: nothing in a sequence diagram is
 *     ever hidden (no providers, no collapse), so `fromSequenceFlow` reads
 *     the whole document back with no base-merge machinery.
 *
 * Reference rules, used throughout validation:
 *   - DEFINING refs (activation.from, fragment.from/to, note.participant,
 *     message endpoints) dangling → the construct is dropped.
 *   - AUXILIARY refs (activation.to, fragment else markers, note.at/across)
 *     dangling → the field degrades (deleted), the construct survives.
 */
import { NODE_STATUSES, VERSION_TAG_POSITIONS, hiddenInline, visibleAnchor } from "./schema";
import type { DiagramTemplate, Migration, NodeStatus, VersionTagPosition } from "./schema";
import { normalizeDate, type DiagramDate } from "./timeline";
import { parseLlmJson } from "./json-repair";
import {
  BAR_OVERHANG,
  BAR_W,
  FRAG_HEAD_H,
  FRAG_PAD_X,
  HEADER_H,
  HEADER_W,
  ROW_HEIGHT,
  diagramHeight,
  lifelineX,
  orderByCoordinate,
  rowY,
  slotX,
} from "./sequence-layout";

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const SEQ_CURRENT_VERSION = 1;

/** Same registration shape as the architecture MIGRATIONS — empty until v2. */
export const SEQ_MIGRATIONS: Record<number, Migration> = {};

export const PARTICIPANT_KINDS = ["actor", "service", "database", "queue", "external"] as const;
export type ParticipantKind = (typeof PARTICIPANT_KINDS)[number];

/** Semantic, not visual: sync = filled arrow, async = open arrow, reply = dashed open. */
export const MESSAGE_STYLES = ["sync", "async", "reply"] as const;
export type MessageStyle = (typeof MESSAGE_STYLES)[number];

export const FRAGMENT_KINDS = ["loop", "alt", "opt", "par", "break"] as const;
export type FragmentKind = (typeof FRAGMENT_KINDS)[number];

export const NOTE_SIDES = ["left", "right", "over"] as const;
export type NoteSide = (typeof NOTE_SIDES)[number];

// ─── Document ────────────────────────────────────────────────────────────────

export interface SeqParticipant {
  id: string;
  label: string;
  kind: ParticipantKind;
  description?: string;
  /** Owning / contact team — same semantics as the architecture schema. */
  team?: string;
  /** Lifecycle stage; absent = active. Same vocabulary as the architecture schema. */
  status?: NodeStatus;
  /**
   * When this participant joins the flow, `YYYY-MM-DD`. Same semantics as
   * `DiagramNode.date`: absent means always present, and the timeline scrubber
   * runs on the distinct dates in the document.
   */
  date?: DiagramDate;
}

export interface SeqMessage {
  id: string;
  /** null = FOUND message (arrives from the environment). */
  from: string | null;
  /** null = LOST message (leaves to the environment). from === to = self-message. */
  to: string | null;
  label: string;
  style: MessageStyle;
  /** Protocol/format, C4 style — rendered as a [bracketed] sub-label. */
  tech?: string;
  /**
   * When this step enters the flow, `YYYY-MM-DD`. A message is never shown
   * before either participant it runs between, so this only pushes it later.
   */
  date?: DiagramDate;
}

/** A vertical activation bar on a lifeline, spanning a message range. */
export interface SeqActivation {
  id: string;
  participant: string;
  /** Message id where the bar opens. Defining — dangling drops the bar. */
  from: string;
  /** Message id where it closes. Absent = runs to the lifeline end. */
  to?: string;
}

/** A combined fragment (loop/alt/opt/par/break) framing a message range. */
export interface SeqFragment {
  id: string;
  kind: FragmentKind;
  /** Guard / condition of the first section, rendered as [label]. */
  label: string;
  from: string;
  to: string;
  /** alt/par branch dividers: `at` = first message of that branch. */
  elses?: Array<{ label: string; at: string }>;
}

export interface SeqNote {
  id: string;
  text: string;
  side: NoteSide;
  participant: string;
  /** Second participant for "over A,B". */
  across?: string;
  /** Message the note sits beside; absent = above the first row. */
  at?: string;
}

export interface SequenceTemplate {
  version: number;
  meta?: {
    title?: string;
    versionTag?: string;
    versionTagPosition?: VersionTagPosition;
    /** Number every message, Mermaid autonumber-style. */
    autonumber?: boolean;
    [key: string]: unknown;
  };
  participants: SeqParticipant[];
  messages: SeqMessage[];
  activations?: SeqActivation[];
  fragments?: SeqFragment[];
  notes?: SeqNote[];
}

export const EMPTY_SEQUENCE: SequenceTemplate = { version: 1, participants: [], messages: [] };

// ─── Key vocabularies ────────────────────────────────────────────────────────
// Known keys per object, for editors that warn about keys the schema doesn't
// define. See TEMPLATE_KEYS in schema.ts for how the Record enforces the list.
// `meta` is absent — its index signature admits anything.

const SEQUENCE_KEY_MAP: Record<keyof SequenceTemplate, true> = {
  version: true,
  meta: true,
  participants: true,
  messages: true,
  activations: true,
  fragments: true,
  notes: true,
};
export const SEQUENCE_KEYS: readonly string[] = Object.keys(SEQUENCE_KEY_MAP);

const PARTICIPANT_KEY_MAP: Record<keyof SeqParticipant, true> = {
  id: true,
  label: true,
  kind: true,
  description: true,
  team: true,
  status: true,
  date: true,
};
export const PARTICIPANT_KEYS: readonly string[] = Object.keys(PARTICIPANT_KEY_MAP);

const MESSAGE_KEY_MAP: Record<keyof SeqMessage, true> = {
  id: true,
  from: true,
  to: true,
  label: true,
  style: true,
  tech: true,
  date: true,
};
export const MESSAGE_KEYS: readonly string[] = Object.keys(MESSAGE_KEY_MAP);

const ACTIVATION_KEY_MAP: Record<keyof SeqActivation, true> = {
  id: true,
  participant: true,
  from: true,
  to: true,
};
export const ACTIVATION_KEYS: readonly string[] = Object.keys(ACTIVATION_KEY_MAP);

const FRAGMENT_KEY_MAP: Record<keyof SeqFragment, true> = {
  id: true,
  kind: true,
  label: true,
  from: true,
  to: true,
  elses: true,
};
export const FRAGMENT_KEYS: readonly string[] = Object.keys(FRAGMENT_KEY_MAP);

export const FRAGMENT_ELSE_KEYS: readonly string[] = ["label", "at"];

const NOTE_KEY_MAP: Record<keyof SeqNote, true> = {
  id: true,
  text: true,
  side: true,
  participant: true,
  across: true,
  at: true,
};
export const NOTE_KEYS: readonly string[] = Object.keys(NOTE_KEY_MAP);

// ─── Migration ───────────────────────────────────────────────────────────────

/** Mirror of `migrateTemplate`: run registered steps; a FUTURE version throws. */
export function migrateSequence(raw: unknown): Record<string, unknown> {
  const doc = (raw && typeof raw === "object" ? { ...(raw as object) } : {}) as Record<
    string,
    unknown
  >;
  let version = typeof doc.version === "number" ? doc.version : 1;
  if (version > SEQ_CURRENT_VERSION) {
    throw new Error(
      `This sequence document is v${version}, but this build understands up to v${SEQ_CURRENT_VERSION}. ` +
        `Opening it could silently drop data a newer version added — upgrade the library instead.`,
    );
  }
  let out = doc;
  while (version < SEQ_CURRENT_VERSION) {
    const step = SEQ_MIGRATIONS[version];
    if (!step) break;
    out = step(out);
    version += 1;
  }
  out.version = SEQ_CURRENT_VERSION;
  return out;
}

// ─── Validation ──────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const trimmed = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Unique, non-empty id: keep the given one, suffix duplicates, invent missing. */
function idFor(rawId: unknown, prefix: string, index: number, used: Set<string>): string {
  let id = trimmed(rawId) || `${prefix}${index + 1}`;
  while (used.has(id)) id = `${id}_2`;
  used.add(id);
  return id;
}

/**
 * Repair a raw sequence document. Never throws on recoverable input; the only
 * hard error is a FUTURE version (via `migrateSequence`).
 */
export function validateSequence(raw: unknown): SequenceTemplate {
  const doc = migrateSequence(raw);

  const out: SequenceTemplate = { version: SEQ_CURRENT_VERSION, participants: [], messages: [] };

  if (doc.meta && typeof doc.meta === "object") {
    const meta: NonNullable<SequenceTemplate["meta"]> = { ...(doc.meta as Raw) };
    const versionTag = trimmed(meta.versionTag);
    if (versionTag) meta.versionTag = versionTag;
    else delete meta.versionTag;
    if (!VERSION_TAG_POSITIONS.includes(meta.versionTagPosition as VersionTagPosition)) {
      delete meta.versionTagPosition;
    }
    if (meta.autonumber !== true) delete meta.autonumber;
    out.meta = meta;
  }

  // -- participants ----------------------------------------------------------
  const usedIds = new Set<string>();
  const rawParticipants = Array.isArray(doc.participants) ? (doc.participants as Raw[]) : [];
  out.participants = rawParticipants
    .filter((p) => p && typeof p === "object")
    .map((p, i) => {
      const id = idFor(p.id, "p", i, usedIds);
      const team = trimmed(p.team);
      const description = trimmed(p.description);
      const date = normalizeDate(p.date);
      return {
        id,
        label: str(p.label, id),
        kind: PARTICIPANT_KINDS.includes(p.kind as ParticipantKind)
          ? (p.kind as ParticipantKind)
          : "service",
        ...(description ? { description } : {}),
        ...(team ? { team } : {}),
        ...(date ? { date } : {}),
        ...(NODE_STATUSES.includes(p.status as NodeStatus) && p.status !== "active"
          ? { status: p.status as NodeStatus }
          : {}),
      };
    });
  const participantIds = new Set(out.participants.map((p) => p.id));

  // -- messages --------------------------------------------------------------
  // Endpoint rules: `null` is intentional (lost/found); a STRING that doesn't
  // resolve is an error and drops the message (defining ref).
  const endpoint = (v: unknown): { ok: boolean; id: string | null } => {
    if (v === null || v === undefined || v === "") return { ok: true, id: null };
    const id = trimmed(v);
    return participantIds.has(id) ? { ok: true, id } : { ok: false, id: null };
  };
  const rawMessages = Array.isArray(doc.messages) ? (doc.messages as Raw[]) : [];
  out.messages = rawMessages
    .filter((m) => m && typeof m === "object")
    .flatMap((m, i) => {
      const from = endpoint(m.from);
      const to = endpoint(m.to);
      if (!from.ok || !to.ok) return []; // dangling endpoint → dropped
      if (from.id === null && to.id === null) return []; // both lost AND found is meaningless
      const tech = trimmed(m.tech);
      const date = normalizeDate(m.date);
      return [
        {
          id: idFor(m.id, "m", i, usedIds),
          from: from.id,
          to: to.id,
          label: str(m.label),
          style: MESSAGE_STYLES.includes(m.style as MessageStyle)
            ? (m.style as MessageStyle)
            : "sync",
          ...(tech ? { tech } : {}),
          ...(date ? { date } : {}),
        },
      ];
    });
  const messageIndex = new Map(out.messages.map((m, i) => [m.id, i]));

  // -- activations -----------------------------------------------------------
  const rawActivations = Array.isArray(doc.activations) ? (doc.activations as Raw[]) : [];
  const activations = rawActivations
    .filter((a) => a && typeof a === "object")
    .flatMap((a, i) => {
      const participant = trimmed(a.participant);
      const from = trimmed(a.from);
      if (!participantIds.has(participant) || !messageIndex.has(from)) return [];
      const to = trimmed(a.to);
      const keepTo = messageIndex.has(to) && messageIndex.get(to)! >= messageIndex.get(from)!;
      return [
        {
          id: idFor(a.id, "a", i, usedIds),
          participant,
          from,
          ...(keepTo ? { to } : {}),
        },
      ];
    });
  if (activations.length) out.activations = activations;

  // -- fragments -------------------------------------------------------------
  const rawFragments = Array.isArray(doc.fragments) ? (doc.fragments as Raw[]) : [];
  const fragments = rawFragments
    .filter((f) => f && typeof f === "object")
    .flatMap((f, i) => {
      let from = trimmed(f.from);
      let to = trimmed(f.to);
      if (!messageIndex.has(from) || !messageIndex.has(to)) return [];
      if (messageIndex.get(from)! > messageIndex.get(to)!) [from, to] = [to, from];
      const fromIdx = messageIndex.get(from)!;
      const toIdx = messageIndex.get(to)!;
      const rawElses = Array.isArray(f.elses) ? (f.elses as Raw[]) : [];
      const seenAts = new Set<string>();
      const elses = rawElses
        .filter((e) => e && typeof e === "object")
        .flatMap((e) => {
          const at = trimmed(e.at);
          const idx = messageIndex.get(at);
          // A branch marker must sit strictly inside (from .. to], and each
          // row can carry at most one divider.
          if (idx === undefined || idx <= fromIdx || idx > toIdx || seenAts.has(at)) return [];
          seenAts.add(at);
          return [{ label: str(e.label), at }];
        })
        .sort((a, b) => messageIndex.get(a.at)! - messageIndex.get(b.at)!);
      return [
        {
          id: idFor(f.id, "f", i, usedIds),
          kind: FRAGMENT_KINDS.includes(f.kind as FragmentKind)
            ? (f.kind as FragmentKind)
            : "opt",
          label: str(f.label),
          from,
          to,
          ...(elses.length ? { elses } : {}),
        },
      ];
    });
  if (fragments.length) out.fragments = fragments;

  // -- notes -----------------------------------------------------------------
  const rawNotes = Array.isArray(doc.notes) ? (doc.notes as Raw[]) : [];
  const notes = rawNotes
    .filter((n) => n && typeof n === "object")
    .flatMap((n, i) => {
      const participant = trimmed(n.participant);
      if (!participantIds.has(participant)) return [];
      const across = trimmed(n.across);
      const at = trimmed(n.at);
      return [
        {
          id: idFor(n.id, "n", i, usedIds),
          text: str(n.text),
          side: NOTE_SIDES.includes(n.side as NoteSide) ? (n.side as NoteSide) : "right",
          participant,
          ...(participantIds.has(across) && across !== participant ? { across } : {}),
          ...(messageIndex.has(at) ? { at } : {}),
        },
      ];
    });
  if (notes.length) out.notes = notes;

  return out;
}

// ─── Derived geometry helpers ────────────────────────────────────────────────

/** Column order per participant id. */
export function participantOrder(t: SequenceTemplate): Map<string, number> {
  return new Map(t.participants.map((p, i) => [p.id, i]));
}

/**
 * A fragment's frame box. The x-span is DERIVED from the participants its
 * covered messages touch (never stored); y spans its message rows plus the
 * label tab.
 */
export function fragmentBox(
  t: SequenceTemplate,
  frag: SeqFragment,
): { x: number; y: number; w: number; h: number } {
  const order = participantOrder(t);
  const index = new Map(t.messages.map((m, i) => [m.id, i]));
  const fromIdx = index.get(frag.from) ?? 0;
  const toIdx = index.get(frag.to) ?? fromIdx;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = fromIdx; i <= toIdx; i++) {
    const m = t.messages[i];
    for (const end of [m?.from, m?.to]) {
      const o = end != null ? order.get(end) : undefined;
      if (o !== undefined) {
        min = Math.min(min, o);
        max = Math.max(max, o);
      }
    }
  }
  // No resolvable endpoints (all lost/found): frame every column.
  if (!Number.isFinite(min)) {
    min = 0;
    max = Math.max(0, t.participants.length - 1);
  }
  const x = slotX(min) - FRAG_PAD_X;
  const w = slotX(max) + HEADER_W + FRAG_PAD_X - x;
  const y = rowY(fromIdx) - FRAG_HEAD_H;
  const h = rowY(toIdx) - y + ROW_HEIGHT / 2;
  return { x, y, w, h };
}

/** An activation bar's absolute box, derived from its anchored message rows. */
export function activationBox(
  t: SequenceTemplate,
  act: SeqActivation,
): { x: number; y: number; w: number; h: number } {
  const order = participantOrder(t).get(act.participant) ?? 0;
  const index = new Map(t.messages.map((m, i) => [m.id, i]));
  const fromIdx = index.get(act.from) ?? 0;
  const toIdx = act.to !== undefined ? (index.get(act.to) ?? fromIdx) : undefined;
  const top = rowY(fromIdx) - BAR_OVERHANG;
  const bottom =
    toIdx !== undefined
      ? rowY(toIdx) + BAR_OVERHANG
      : diagramHeight(t.messages.length) - ROW_HEIGHT / 2;
  return { x: lifelineX(order) - BAR_W / 2, y: top, w: BAR_W, h: bottom - top };
}

// ─── React Flow adapters ─────────────────────────────────────────────────────
//
// Structural node/edge shapes, mirroring `toReactFlow`'s approach: describe
// the shape without importing the library. Prefixed ids keep the element
// families apart: participants and messages use their raw ids; activations,
// fragments, and notes are namespaced.

export const ACT_ID_PREFIX = "act:";
export const FRAG_ID_PREFIX = "frag:";
export const NOTE_ID_PREFIX = "note:";

export type SeqRFNode = {
  id: string;
  type: "participant" | "activation" | "fragment" | "seqnote";
  position: { x: number; y: number };
  width: number;
  height: number;
  style: { width: number; height: number };
  parentId?: string;
  zIndex?: number;
  draggable?: boolean;
  dragHandle?: string;
  selected?: boolean;
  data: Record<string, unknown>;
};

export type SeqRFEdge = {
  id: string;
  type: "message";
  source: string;
  target: string;
  selected?: boolean;
  zIndex?: number;
  className?: string;
  /**
   * `future` is set only by the read-only timeline scrubber. It rides in the
   * data rather than on `className` alone because a message's label renders
   * through `EdgeLabelRenderer` — a portal outside the edge's own `<g>`, which
   * a wrapper class cannot reach.
   */
  data: { message: SeqMessage; index: number; y: number; future?: boolean };
};

/** Materialize a validated document as React Flow state. Pure. */
export function toSequenceFlow(t: SequenceTemplate): { nodes: SeqRFNode[]; edges: SeqRFEdge[] } {
  const order = participantOrder(t);
  const height = diagramHeight(t.messages.length);
  const nodes: SeqRFNode[] = [];

  const msgIdx = new Map(t.messages.map((m, i) => [m.id, i]));

  // Fragments first — they must paint behind everything.
  for (const frag of t.fragments ?? []) {
    const box = fragmentBox(t, frag);
    // Divider positions for the renderer, relative to the frame's top.
    const elseOffsets = (frag.elses ?? []).flatMap((branch) => {
      const idx = msgIdx.get(branch.at);
      return idx === undefined ? [] : [{ label: branch.label, at: branch.at, dy: rowY(idx) - 20 - box.y }];
    });
    nodes.push({
      id: `${FRAG_ID_PREFIX}${frag.id}`,
      type: "fragment",
      position: { x: box.x, y: box.y },
      width: box.w,
      height: box.h,
      style: { width: box.w, height: box.h },
      zIndex: -1000,
      dragHandle: ".as-seq-frag__tab",
      data: { fragment: frag, elseOffsets },
    });
  }

  t.participants.forEach((p, i) => {
    nodes.push({
      id: p.id,
      type: "participant",
      position: { x: slotX(i), y: 0 },
      width: HEADER_W,
      height: HEADER_H,
      style: { width: HEADER_W, height: HEADER_H },
      zIndex: 500,
      data: { participant: p, order: i, diagramHeight: height },
    });
  });

  for (const act of t.activations ?? []) {
    const box = activationBox(t, act);
    const colX = slotX(order.get(act.participant) ?? 0);
    nodes.push({
      id: `${ACT_ID_PREFIX}${act.id}`,
      type: "activation",
      // Parent-relative; the participant sits at y = 0, so relative y equals
      // absolute y and the bar follows its column when participants reorder.
      position: { x: box.x - colX, y: box.y },
      width: BAR_W,
      height: box.h,
      style: { width: BAR_W, height: box.h },
      parentId: act.participant,
      zIndex: 600,
      data: { activation: act },
    });
  }

  for (const note of t.notes ?? []) {
    const o = order.get(note.participant) ?? 0;
    const atIdx = note.at !== undefined ? (msgIdx.get(note.at) ?? 0) : undefined;
    const y = atIdx !== undefined ? rowY(atIdx) - 16 : HEADER_H + 16;
    const w = 168;
    const x =
      note.side === "left"
        ? lifelineX(o) - w - 24
        : note.side === "over"
          ? lifelineX(o) - w / 2
          : lifelineX(o) + 24;
    nodes.push({
      id: `${NOTE_ID_PREFIX}${note.id}`,
      type: "seqnote",
      position: { x, y },
      width: w,
      height: 56,
      style: { width: w, height: 56 },
      zIndex: 700,
      data: { note },
    });
  }

  const edges: SeqRFEdge[] = t.messages.map((m, i) => ({
    id: m.id,
    type: "message",
    // Lost/found messages still need real node endpoints for React Flow;
    // the message data carries the true (possibly null) ends.
    source: m.from ?? m.to!,
    target: m.to ?? m.from!,
    zIndex: 800,
    data: { message: m, index: i, y: rowY(i) },
  }));

  return { nodes, edges };
}

/**
 * Read the whole document back from React Flow state. TOTAL: sequence mode
 * hides nothing, so there is no base to merge against. Participant order
 * derives from x, message order from y; activations, fragments, and notes are
 * authoritative in their `data` (gestures rewrite them at commit time), then
 * everything passes through `validateSequence`.
 */
export function fromSequenceFlow(
  nodes: readonly SeqRFNode[],
  edges: readonly SeqRFEdge[],
  opts: { meta?: SequenceTemplate["meta"] } = {},
): SequenceTemplate {
  const participants = orderByCoordinate(
    nodes.filter((n) => n.type === "participant"),
    (n) => n.position.x,
  ).map((n) => n.data.participant as SeqParticipant);

  const messages = orderByCoordinate(
    [...edges],
    (e) => e.data.y ?? rowY(e.data.index ?? 0),
  ).map((e) => e.data.message);

  const activations = nodes
    .filter((n) => n.type === "activation")
    .map((n) => n.data.activation as SeqActivation);
  const fragments = nodes
    .filter((n) => n.type === "fragment")
    .map((n) => n.data.fragment as SeqFragment);
  const notes = nodes
    .filter((n) => n.type === "seqnote")
    .map((n) => n.data.note as SeqNote);

  return validateSequence({
    version: SEQ_CURRENT_VERSION,
    ...(opts.meta ? { meta: opts.meta } : {}),
    participants,
    messages,
    ...(activations.length ? { activations } : {}),
    ...(fragments.length ? { fragments } : {}),
    ...(notes.length ? { notes } : {}),
  });
}

// ─── Architecture → sequence ─────────────────────────────────────────────────

/** Architecture node kind → participant kind. Unmapped kinds become services. */
const ARCH_KIND_TO_PARTICIPANT: Record<string, ParticipantKind> = {
  client: "actor",
  database: "database",
  queue: "queue",
  external: "external",
};

/**
 * Derive a BASE sequence diagram from an architecture template —
 * deterministic, no model involved.
 *
 * Edges carrying `seq` (the numbered dynamic flow) become the messages, in
 * seq order; a document with no numbered edges falls back to every edge in
 * document order. Participants are the endpoints in order of first
 * appearance, with kind/team/status/description carried over. A `direction:
 * "both"` edge becomes a call plus a dashed reply. Activations and fragments
 * are left for the human (or the AI panel) — this is the skeleton, not the
 * interpretation.
 */
export function sequenceFromTemplate(arch: DiagramTemplate): SequenceTemplate {
  // Drill-in detail stays behind its card here too: a crossing call reads as
  // the CARD doing the talking (the actor a root-level sequence knows), and
  // wiring wholly inside one card is not part of this level's story.
  const drillHidden = hiddenInline(arch);
  const rawById = new Map(arch.nodes.map((n) => [n.id, n]));
  const edges = drillHidden.size
    ? arch.edges.flatMap((e) => {
        const source = visibleAnchor(e.source, rawById, drillHidden);
        const target = visibleAnchor(e.target, rawById, drillHidden);
        if (source === target) return [];
        if (source === e.source && target === e.target) return [e];
        return [{ ...e, source, target }];
      })
    : arch.edges;

  const numbered = edges.filter((e) => typeof e.seq === "number" && e.seq > 0);
  const flow = numbered.length
    ? [...numbered].sort((a, b) => a.seq! - b.seq!)
    : edges;

  const nodeById = new Map(arch.nodes.map((n) => [n.id, n]));
  const participants: SeqParticipant[] = [];
  const seen = new Set<string>();
  const addParticipant = (id: string) => {
    const n = nodeById.get(id);
    if (!n || seen.has(id)) return;
    seen.add(id);
    participants.push({
      id: n.id,
      label: n.label,
      kind: ARCH_KIND_TO_PARTICIPANT[n.kind as string] ?? "service",
      ...(n.description ? { description: n.description } : {}),
      ...(n.team ? { team: n.team } : {}),
      ...(n.status ? { status: n.status } : {}),
      ...(n.date ? { date: n.date } : {}),
    });
  };

  const messages: SeqMessage[] = [];
  for (const e of flow) {
    if (!nodeById.has(e.source) || !nodeById.has(e.target)) continue;
    addParticipant(e.source);
    addParticipant(e.target);
    messages.push({
      id: e.id,
      from: e.source,
      to: e.target,
      label: e.label ?? "",
      style: e.style === "solid" ? "sync" : "async",
      ...(e.tech ? { tech: e.tech } : {}),
      ...(e.date ? { date: e.date } : {}),
    });
    if (e.direction === "both") {
      messages.push({
        id: `${e.id}__reply`,
        from: e.target,
        to: e.source,
        label: "",
        style: "reply",
      });
    }
  }

  return validateSequence({
    version: 1,
    meta: {
      ...(arch.meta?.title ? { title: String(arch.meta.title) } : {}),
      autonumber: true,
    },
    participants,
    messages,
  });
}

// ─── LLM integration ─────────────────────────────────────────────────────────

/**
 * The system prompt for sequence generation — interpolated from the SAME
 * constants the validator checks, so prompt and validation cannot drift.
 */
export function buildSequencePrompt(): string {
  const kinds = PARTICIPANT_KINDS.join("|");
  const styles = MESSAGE_STYLES.join("|");
  const frags = FRAGMENT_KINDS.join("|");
  const sides = NOTE_SIDES.join("|");
  return `You produce and edit SEQUENCE DIAGRAM documents for a visual editor. Return ONLY a JSON object matching:

{"version":1,"meta":{"title":"Name","autonumber":true},"participants":[{"id":"slug","label":"Name","kind":"${kinds}","description":"one short line or empty","team":"","status":"${NODE_STATUSES.join("|")}","date":"YYYY-MM-DD"}],"messages":[{"id":"m1","from":"participantId","to":"participantId","label":"what is sent","style":"${styles}","tech":"JSON/HTTPS","date":"YYYY-MM-DD"}],"activations":[{"id":"a1","participant":"participantId","from":"messageId","to":"messageId"}],"fragments":[{"id":"f1","kind":"${frags}","label":"guard condition","from":"messageId","to":"messageId","elses":[{"label":"else guard","at":"messageId"}]}],"notes":[{"id":"n1","text":"...","side":"${sides}","participant":"participantId","at":"messageId"}]}

Rules:
- Message ARRAY ORDER is time: earlier entries happen first. There are no coordinates anywhere.
- "from"/"to" are participant ids. from === to is a self-message. null "from" = a message arriving from outside the system (found); null "to" = one leaving it (lost).
- "style": sync = a blocking call (solid, filled arrow), async = fire-and-forget (dashed, open arrow), reply = a response (dashed).
- "tech" = protocol/format ("JSON/HTTPS", "gRPC", "SQL"); omit when obvious.
- Activations mark the span a participant is busy: "from"/"to" are MESSAGE ids (the call that starts the work and the reply that ends it). Fragments frame a message range; "elses" split alt/par branches, where "at" is the first message of that branch.
- Participant "status" = lifecycle stage when stated ("stubbed" scaffolding only, "dark" built but not enabled, "deprecated" being sunset); omit for normal active participants.
- "date" ("YYYY-MM-DD") is WHEN a participant or step joins the flow, not where it sits in it — ordering is still array order. Set it only when the user describes a rollout, phases, or a migration; omit it otherwise. Undated means always present, so date the new steps and leave the existing flow undated.
- Follow the user's description of the flow and its steps faithfully — keep their ordering, add activations for request/response spans, and fragments for the loops and conditions they describe.
- Return the FULL document as pure JSON. No markdown fences, no commentary.`;
}

/**
 * Parse a model reply (possibly fenced, possibly chatty) into a validated
 * sequence. Lightly damaged JSON is healed by json-repair rather than
 * rejected; what can't be healed throws a user-facing message.
 */
export function parseLlmSequence(llmText: string): SequenceTemplate {
  return validateSequence(parseLlmJson(llmText));
}

/** Build the user-turn message for a sequence refine request. */
export function buildSequenceRefineMessage(
  current: SequenceTemplate,
  instruction: string,
): string {
  return [
    "CURRENT SEQUENCE DOCUMENT:",
    JSON.stringify(current),
    "",
    "Apply this instruction and return the FULL updated sequence JSON:",
    instruction,
  ].join("\n");
}

// ─── Example ─────────────────────────────────────────────────────────────────

/** An order flow exercising every feature: self-message, reply, async,
 * lost/found-free happy path, activations, alt + loop fragments, a note. */
export const EXAMPLE_SEQUENCE: SequenceTemplate = {
  version: 1,
  meta: { title: "Order flow", autonumber: true },
  participants: [
    { id: "user", label: "Customer", kind: "actor" },
    { id: "web", label: "Web App", kind: "service", team: "Frontend" },
    { id: "api", label: "Order API", kind: "service", team: "Platform" },
    { id: "db", label: "Orders DB", kind: "database" },
    { id: "pay", label: "Payment Gateway", kind: "external" },
  ],
  messages: [
    { id: "m1", from: "user", to: "web", label: "Place order", style: "sync" },
    { id: "m2", from: "web", to: "api", label: "POST /orders", style: "sync", tech: "JSON/HTTPS" },
    { id: "m3", from: "api", to: "api", label: "Validate cart", style: "sync" },
    { id: "m4", from: "api", to: "db", label: "INSERT order", style: "sync", tech: "SQL" },
    { id: "m5", from: "db", to: "api", label: "order id", style: "reply" },
    { id: "m6", from: "api", to: "pay", label: "Charge", style: "async", tech: "gRPC" },
    { id: "m7", from: "pay", to: "api", label: "receipt", style: "reply" },
    { id: "m8", from: "api", to: "web", label: "201 Created", style: "reply" },
    { id: "m9", from: "web", to: "user", label: "Confirmation", style: "reply" },
  ],
  activations: [
    { id: "a1", participant: "api", from: "m2", to: "m8" },
    { id: "a2", participant: "db", from: "m4", to: "m5" },
    { id: "a3", participant: "pay", from: "m6", to: "m7" },
  ],
  fragments: [
    { id: "f1", kind: "loop", label: "retry ×3", from: "m4", to: "m5" },
    { id: "f2", kind: "alt", label: "card valid", from: "m6", to: "m7", elses: [{ label: "card declined", at: "m7" }] },
  ],
  notes: [
    { id: "n1", text: "Idempotent by order id", side: "right", participant: "api", at: "m4" },
  ],
};

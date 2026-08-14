/**
 * schema.ts — the portable contract between an LLM and the editor.
 *
 *   LLM ──(buildSystemPrompt)──▶ DiagramTemplate JSON
 *   DiagramTemplate ──(validateTemplate → toReactFlow)──▶ <ArchitectureStudio />
 *   cursor edits ──(fromReactFlow)──▶ DiagramTemplate JSON ──▶ your database
 *
 * This file has ZERO dependencies on React, React Flow, or the rest of the
 * package — copy it into a backend or an LLM pipeline as-is. The React Flow
 * types at the bottom are structural, and are assignable to @xyflow/react's
 * `Node[]` / `Edge[]` without a cast.
 *
 * It is also the single source of truth for the vocabulary: the node kinds,
 * icon names, edge styles, and the system prompt are all derived from the
 * constants here, so the prompt can never drift from what the validator
 * accepts.
 */

import {
  DEFAULT_POLYGON_POINTS,
  ZONE_OUTLINES,
  ZONE_SHAPES,
  clampBoxIntoZone,
  pointInZone,
  zoneAt,
  type DiagramZone,
  type ZoneOutline,
  type ZonePoint,
  type ZoneShape,
} from "./zones";
import { ALL_CLOUD_KIND_IDS } from "./cloud";
import { normalizeDate, type DiagramDate } from "./timeline";
import { parseLlmJson } from "./json-repair";

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const NODE_KINDS = [
  "service",
  "database",
  "queue",
  "gateway",
  "client",
  "external",
  "table", // data-model entity — its columns live in `fields`
  "group", // container / boundary — other nodes nest inside via parentId
  "text", // free-floating annotation; the text lives in `label`
] as const;
export type NodeKind = (typeof NODE_KINDS)[number] | (string & {});

/** Kinds with container semantics. Children reference them via `parentId`. */
export const CONTAINER_KINDS: readonly string[] = ["group"];
/** Kinds rendered as bare text rather than a box. */
export const ANNOTATION_KINDS: readonly string[] = ["text"];

export const ICON_NAMES = [
  "none",
  "user",
  "users",
  "database",
  "server",
  "layers",
  "globe",
  "cloud",
  "window",
  "mobile",
  "lock",
  "gear",
  "bolt",
  "doc",
  "code",
  "mail",
  "box",
  "shield",
] as const;
export type IconName = (typeof ICON_NAMES)[number] | (string & {});

export const EDGE_STYLES = ["solid", "dashed", "dotted"] as const;
export type EdgeStyle = (typeof EDGE_STYLES)[number];

export const EDGE_COLORS = ["slate", "sky", "emerald", "amber", "rose", "violet"] as const;
export type EdgeColor = (typeof EDGE_COLORS)[number];

/** Infra providers a zone can be switched between. Extensible via the registry. */
export const PROVIDER_IDS = ["azure", "aws", "gcp", "onprem", "k8s", "saas"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number] | (string & {});

/** Arrowhead placement. `forward` (default) points at the target only. */
export const EDGE_DIRECTIONS = ["forward", "both", "none"] as const;
export type EdgeDirection = (typeof EDGE_DIRECTIONS)[number];

/** How an edge is routed. Unset on an edge means "inherit `meta.routing`". */
export const EDGE_ROUTINGS = ["curved", "orthogonal"] as const;
export type EdgeRouting = (typeof EDGE_ROUTINGS)[number];

/** Sides of a node box an edge endpoint can be pinned to. */
export const EDGE_ANCHOR_SIDES = ["top", "right", "bottom", "left"] as const;
export type EdgeAnchorSide = (typeof EDGE_ANCHOR_SIDES)[number];

/**
 * A pinned attachment point on a node box: `side` picks the face, `t` slides
 * along it (0 → the top/left corner, 1 → the other one). An edge without an
 * anchor floats — it attaches to whichever side faces the other end, exactly
 * as every edge did before anchors existed.
 */
export interface EdgeAnchor {
  side: EdgeAnchorSide;
  /** Fraction along the side, 0–1. 0.5 (the centre) is the default and never stored. */
  t?: number;
}

/** Key role of a field: primary key, foreign key, or both. */
export const FIELD_KEYS = ["pk", "fk", "pfk"] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

/**
 * One row inside a node's body — a table column, a class property, a struct
 * member. This is what makes a data model expressible in the same document as
 * an architecture diagram: a table is a node whose substance is its rows.
 *
 * Fields are CONTENT, not presentation. `splitTemplate` leaves them in the
 * content half, so an elements-only AI edit owns them and a layout file never
 * mentions them — the same division that keeps node x/y out of the model's
 * reach.
 */
export interface NodeField {
  /** Unique within its node. An edge's `startField`/`endField` names this. */
  id: string;
  /** Column / attribute name. */
  name: string;
  /** Data type or signature ("uuid", "varchar(255)"). Omitted when unset. */
  type?: string;
  /** Key role — renders as a leading PK/FK badge. Omit for a plain attribute. */
  key?: FieldKey;
  /** Required / NOT NULL — renders as a trailing marker. */
  required?: boolean;
}

/**
 * Field-list metrics, in node-local pixels. Three things must agree on where
 * row N sits: the canvas renderer (through matching values in styles.css), the
 * export emitter, and the row-anchor maths below that lands a foreign-key line
 * on its column. They agree because all three derive from these constants —
 * change one here and the line, the screen, and the PNG move together.
 */
export const FIELD_ROW_H = 19;
/** Kind caption + title + the list's own top rule, above the first row. */
const FIELD_HEAD_H = 40;
/**
 * The band a description takes when the node has one. A node with rows shows
 * its description on ONE line (both renderers ellipsise it) — a second line
 * would shift every row below it and put the anchors off their columns.
 */
const FIELD_DESC_H = 14;
/** Breathing room under the last row. */
const FIELD_LIST_PAD = 8;

/** Distance from a node's top edge to the top of its first field row. */
export function fieldListTop(hasDescription: boolean): number {
  return FIELD_HEAD_H + (hasDescription ? FIELD_DESC_H : 0);
}

/** The height a node needs to show `count` rows without clipping any. */
export function fieldsBoxHeight(count: number, hasDescription = false): number {
  return fieldListTop(hasDescription) + count * FIELD_ROW_H + FIELD_LIST_PAD;
}

/**
 * Lifecycle stage of a node. `active` is the default and is never stored —
 * validation strips it so pre-status documents stay byte-identical.
 */
/**
 * Lifecycle stages, in rough chronological order. Everything except `active`
 * renders visually set apart:
 *
 *   proposed   an idea — dotted outline
 *   planned    committed future work — dashed outline
 *   stubbed    scaffolding exists, the implementation doesn't — heavy
 *              construction dashes over a faint diagonal hatch
 *   dark       built and shipped but not yet switched on ("shipped dark") —
 *              black/white hazard-tape outline
 *   active     the default; never stored
 *   deprecated being sunset — dimmed
 *   retired    gone — heavily dimmed, struck through
 *
 * Every dulled stage brightens to full strength under the cursor, so its
 * label stays readable.
 */
export const NODE_STATUSES = ["proposed", "planned", "stubbed", "dark", "active", "deprecated", "retired"] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/** Corner the version-tag notice sits in. */
export const VERSION_TAG_POSITIONS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
export type VersionTagPosition = (typeof VERSION_TAG_POSITIONS)[number];

export const EDGE_COLOR_HEX: Record<EdgeColor, string> = {
  slate: "#64748b",
  sky: "#38bdf8",
  emerald: "#34d399",
  amber: "#f59e0b",
  rose: "#fb7185",
  violet: "#a78bfa",
};

export const EDGE_DASH: Record<EdgeStyle, number[]> = {
  solid: [],
  dashed: [8, 5],
  dotted: [2, 4],
};

/** Default geometry per kind, used to fill in anything the LLM omits. */
export const KIND_DEFAULT_SIZE: Record<string, { w: number; h: number }> = {
  group: { w: 320, h: 240 },
  text: { w: 300, h: 60 },
  // Wider than a service box: a column line is "name  type", two words that
  // must not ellipsise. The height is a floor — a table with rows grows.
  table: { w: 230, h: 96 },
  default: { w: 170, h: 76 },
};

// ─── Template shape (what the LLM generates) ─────────────────────────────────

export interface DiagramNode {
  /** Unique slug, e.g. "api", "postgres", "vpc" */
  id: string;
  /** Display name — or the full annotation text when kind === "text" */
  label: string;
  kind: NodeKind;
  /** Visual glyph; "none" hides it. Ignored for group/text. */
  icon: IconName;
  /** One short line of tech detail rendered under the label. "" to omit. */
  description: string;
  /**
   * The node's rows — a table's columns, a class's properties. Absent on an
   * ordinary architecture box; a node that has them renders them as a list and
   * is grown tall enough to show every one (see `fieldsBoxHeight`).
   */
  fields?: NodeField[];
  /** id of the enclosing container, or null for canvas root */
  parentId: string | null;
  /** Position — RELATIVE to the parent container's top-left when parentId is set */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Only meaningful for kind === "text" (default 13) */
  fontSize?: number;

  /**
   * The infra zone this node sits on, or null. Independent of `parentId` — a
   * node can be in the "Azure" zone and the "Payments" group at the same time.
   */
  zoneId?: string | null;
  /**
   * Provider ids this node exists on. Absent or empty means "always visible".
   * Otherwise the node renders only while its zone's active provider is in
   * this list — this is what makes one diagram show several topologies.
   */
  providers?: string[];

  /** Free labels ("pci", "deprecated", "planned") — filterable in the editor. */
  tags?: string[];
  /** Deep link to the thing this box represents: ADR, repo, runbook, dashboard. */
  url?: string;
  /**
   * Owning / contact team ("Payments", "Platform"). Rendered as a small tag
   * riding the node's top edge, coloured stably per team name.
   */
  team?: string;
  /**
   * Lifecycle stage: proposed/planned/stubbed render with dotted/dashed/
   * construction outlines, dark with a hazard-tape outline, deprecated/
   * retired dimmed. Absent means `active`. See NODE_STATUSES.
   */
  status?: NodeStatus;
  /**
   * When this element lands (or landed): `YYYY-MM-DD`. Rendered as a small
   * outlined chip on the node, and it is what the timeline scrubber runs on —
   * absent means "always there", present at every point on the timeline.
   */
  date?: DiagramDate;
  /** Pinned in place — the editor refuses to drag or resize it. */
  locked?: boolean;
  /**
   * Annotation kinds only: render as bare text with no outline or background.
   * Absent = the default boxed note.
   */
  plain?: boolean;
  /**
   * Container kinds only: render as a compact chip with the contents hidden
   * and their edges re-routed to this node. Stored `w`/`h` are the EXPANDED
   * size and survive collapse — expanding restores the layout exactly.
   */
  collapsed?: boolean;
}

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  /** Short verb phrase or "" */
  label: string;
  /** Label position along the arrow, 0.15–0.85 (default 0.5 = midpoint) */
  labelT?: number;
  style: EdgeStyle;
  color: EdgeColor;
  /**
   * Provider ids this connection exists on, mirroring `DiagramNode.providers`.
   * Absent or empty means "wherever both endpoints exist".
   *
   * Evaluated against the zone of the SOURCE node, falling back to the
   * target's — an edge has no position of its own, so it borrows the
   * membership of the end that originates it. With neither endpoint zoned
   * there is no provider to compare against and the list is ignored, exactly
   * as for an unzoned node.
   *
   * Lets you express a link that only exists in one topology, e.g. a
   * cross-region replication stream present on AWS but not on Azure.
   */
  providers?: string[];

  /** Technology / protocol, C4-style: rendered as a smaller `[JSON/HTTPS]` line. */
  tech?: string;
  /** Arrowheads: `forward` (default), `both`, or `none`. Stored only when non-default. */
  direction?: EdgeDirection;
  /** Step number for a C4 dynamic diagram — renders as a circled badge. */
  seq?: number;
  /** Routing override for this edge. Unset inherits `meta.routing`. */
  routing?: EdgeRouting;
  /** Pin the line's start to a side of the source box. Absent = floating. */
  start?: EdgeAnchor;
  /** Pin the line's end to a side of the target box. Absent = floating. */
  end?: EdgeAnchor;
  /**
   * Cardinality (or any role text) at each end: "1", "0..*", "owns". Rendered
   * just inside the endpoint, unlike `label` which rides the middle of the line.
   */
  startLabel?: string;
  endLabel?: string;
  /**
   * The FIELD each end attaches to — a foreign key points at the column it
   * references, not merely at the table. Semantic, so it lives here in content
   * rather than in the layout file: the line re-aims itself when rows are
   * reordered, and degrades to the box when the row isn't on screen (a
   * collapsed group, another drill-in level). Dropped on validation if it
   * names no field of that endpoint.
   */
  startField?: string;
  endField?: string;
  /**
   * Waypoints the line routes through, in ABSOLUTE canvas coordinates —
   * unlike a zone's `points`, which are normalised into its box. Presentation,
   * not architecture: they stay put when a node is dragged (the endpoints
   * remain attached; only the interior route holds still) and a Tidy discards
   * them as stale.
   */
  points?: Array<[number, number]>;
  /**
   * When this connection lands, `YYYY-MM-DD`. On the timeline an edge is never
   * earlier than the boxes it joins, so this only ever pushes it later — use it
   * for a link that arrives after both ends already exist.
   */
  date?: DiagramDate;
}

export interface DiagramTemplate {
  version: 1;
  /**
   * Optional document metadata; unknown keys round-trip untouched.
   * `routing` sets the diagram-wide default edges inherit when they don't
   * carry their own — unset means "curved", so old documents don't change.
   */
  meta?: {
    title?: string;
    routing?: EdgeRouting;
    /** Revision label ("v2.1", "2026-Q3 draft") shown as a corner notice. */
    versionTag?: string;
    /** Which corner the notice sits in. Default "top-left" (legend owns top-right). */
    versionTagPosition?: VersionTagPosition;
    /**
     * Per-view presentation overrides for drill-in views, keyed by the
     * focused node's id. Presentation data living inline, like node x/y —
     * `splitTemplate` moves it to the layout document.
     */
    views?: Record<string, ViewRecord>;
    [key: string]: unknown;
  };
  /**
   * Infra zones, drawn behind everything. Optional — a template without zones
   * is exactly the document this schema described before zones existed, so old
   * saved diagrams keep loading unchanged.
   */
  zones?: DiagramZone[];
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export const EMPTY_TEMPLATE: DiagramTemplate = { version: 1, nodes: [], edges: [] };

// ─── Key vocabularies ────────────────────────────────────────────────────────
//
// The known keys of each document object, for editors that warn about keys
// the schema doesn't define (they are ignored on load, never an error).
// `Record<keyof T, true>` makes the compiler enforce the list in BOTH
// directions: add a field to the interface and this line stops compiling
// until the list learns it; list a key the interface lacks and it also fails.
// `meta` is deliberately absent — its index signature admits anything.

const TEMPLATE_KEY_MAP: Record<keyof DiagramTemplate, true> = {
  version: true,
  meta: true,
  zones: true,
  nodes: true,
  edges: true,
};
export const TEMPLATE_KEYS: readonly string[] = Object.keys(TEMPLATE_KEY_MAP);

const NODE_KEY_MAP: Record<keyof DiagramNode, true> = {
  id: true,
  label: true,
  kind: true,
  icon: true,
  description: true,
  fields: true,
  parentId: true,
  x: true,
  y: true,
  w: true,
  h: true,
  fontSize: true,
  zoneId: true,
  providers: true,
  tags: true,
  url: true,
  team: true,
  status: true,
  date: true,
  locked: true,
  plain: true,
  collapsed: true,
};
export const NODE_KEYS: readonly string[] = Object.keys(NODE_KEY_MAP);

const EDGE_KEY_MAP: Record<keyof DiagramEdge, true> = {
  id: true,
  source: true,
  target: true,
  label: true,
  labelT: true,
  style: true,
  color: true,
  providers: true,
  tech: true,
  direction: true,
  seq: true,
  routing: true,
  start: true,
  end: true,
  startLabel: true,
  endLabel: true,
  startField: true,
  endField: true,
  points: true,
  date: true,
};
export const EDGE_KEYS: readonly string[] = Object.keys(EDGE_KEY_MAP);

/** The known keys of one `NodeField`, for the JSON editor's key lint. */
const FIELD_KEY_MAP: Record<keyof NodeField, true> = {
  id: true,
  name: true,
  type: true,
  key: true,
  required: true,
};
export const NODE_FIELD_KEYS: readonly string[] = Object.keys(FIELD_KEY_MAP);

// ─── Versioning ──────────────────────────────────────────────────────────────

/** The version this build writes. Bump when a change needs a migration. */
export const CURRENT_VERSION = 1;

/** One step in the upgrade chain: version N in, version N+1 out. */
export type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;

/**
 * Registered migrations, keyed by the version they upgrade FROM.
 *
 * Empty today — v1 is the only shape that has ever shipped. It exists so the
 * chain has somewhere to go: without it, bumping to v2 would leave every row
 * already in a database with nothing to run through, and the additive-only
 * changes so far (zones, providers) would have to stay additive forever.
 */
export const MIGRATIONS: Record<number, Migration> = {};

/**
 * Bring a stored document up to `CURRENT_VERSION`.
 *
 * A *newer* version than this build understands throws rather than being
 * coerced: silently dropping fields a future release added would turn "open an
 * old client" into irreversible data loss the moment the user hit save.
 * Everything else is handled by `validateTemplate`, which repairs rather than
 * rejects — so a missing or malformed `version` is treated as v1 rather than
 * failing a document that is otherwise fine.
 */
export function migrateTemplate(raw: unknown): Record<string, unknown> {
  const doc = { ...(raw as Record<string, unknown>) };
  const declared = Number(doc.version);
  let version = Number.isFinite(declared) && declared >= 1 ? Math.floor(declared) : 1;

  if (version > CURRENT_VERSION) {
    throw new Error(
      `This diagram was saved by a newer version (v${version}); this build understands up to v${CURRENT_VERSION}. Upgrade to open it.`,
    );
  }

  let current = doc;
  while (version < CURRENT_VERSION) {
    const migrate = MIGRATIONS[version];
    if (!migrate) {
      throw new Error(`No migration registered from v${version} to v${version + 1}`);
    }
    current = migrate(current);
    version += 1;
  }

  current.version = CURRENT_VERSION;
  return current;
}

// ─── System prompt, generated from the vocabulary above ──────────────────────

export interface PromptOptions {
  /** Extra node kinds contributed by a registry, appended to the built-ins. */
  kinds?: readonly string[];
  /** Extra icon names contributed by a registry. */
  icons?: readonly string[];
  /** Provider ids contributed by a registry. */
  providers?: readonly string[];
  /** Appended verbatim — domain rules like "always place the CDN left of the ALB". */
  extraRules?: string;
  /**
   * When false, the prompt describes the CONTENT form: no node x/y/w/h, no
   * labelT, and layout rules replaced by "never emit geometry, keep ids
   * stable". Used for refine flows that merge the reply with the document's
   * own presentation — the model cannot mangle a layout it never sees.
   * Zone boxes stay in the skeleton either way: zone geometry is membership,
   * not presentation. Default true (the full inline form).
   */
  geometry?: boolean;
}

/**
 * Build the system prompt from the live vocabulary. Because the enumerations
 * are interpolated rather than hand-written, a kind added to a registry is
 * automatically offered to the model, and the prompt can never advertise a
 * value that `validateTemplate` would reject.
 */
export function buildSystemPrompt(opts: PromptOptions = {}): string {
  const kinds = [...new Set([...NODE_KINDS, ...(opts.kinds ?? [])])].join("|");
  const icons = [...new Set([...ICON_NAMES, ...(opts.icons ?? [])])].join("|");
  const providers = [...new Set([...PROVIDER_IDS, ...(opts.providers ?? [])])].join("|");
  const styles = EDGE_STYLES.join("|");
  const colors = EDGE_COLORS.join("|");
  const shapes = ZONE_SHAPES.join("|");
  const geo = opts.geometry !== false;

  return `You convert software requirements, source code, or natural-language descriptions into an architecture diagram template. Respond with ONLY compact valid JSON (no markdown fences, no commentary) matching:
{"version":1,"meta":{"title":"Name","routing":"curved|orthogonal","versionTag":"v1.0"},"zones":[{"id":"slug","label":"Name","shape":"${shapes}","x":0,"y":0,"w":900,"h":600,"providers":["${PROVIDER_IDS[0]}"],"provider":"${PROVIDER_IDS[0]}","z":0,"date":"YYYY-MM-DD","color":"#38bdf8","outline":"solid|dashed|dotted|none"}],"nodes":[{"id":"slug","label":"Name","kind":"${kinds}","icon":"${icons}","description":"one short line or empty","fields":[{"id":"col","name":"user_id","type":"uuid","key":"${FIELD_KEYS.join("|")}","required":true}],"parentId":null,"zoneId":null,"providers":[],"tags":[],"url":"","team":"","status":"${NODE_STATUSES.join("|")}","date":"YYYY-MM-DD","plain":false${geo ? ',"x":0,"y":0,"w":170,"h":76' : ""},"fontSize":13}],"edges":[{"id":"e1","source":"id","target":"id","label":"","tech":""${geo ? ',"labelT":0.5' : ""},"style":"${styles}","color":"${colors}","direction":"forward|both|none","seq":0,"startLabel":"","endLabel":"","startField":"","endField":"","date":"YYYY-MM-DD"}]}
Rules:
- "group" = boundary (VPC, cluster, tier, bounded context). Children set parentId${geo ? "; child x/y are RELATIVE to the group's top-left. Size groups to contain all children (+24px sides, +48px top). Children of a NON-group parent use small local coordinates starting near 0,0 (their own drilled canvas); never size the parent to contain them." : "."}
- "text" = free annotation; put the sentence in label, fontSize 12-16${geo ? ", w~300 h~60" : ""}, no edges.
- ${geo ? "Regular nodes: w 160-200, h 64-84. Pick" : "Pick"} a fitting icon. description is an optional one-line tech detail (C4 style, e.g. "Node.js / Express").
- Edge style semantics: dashed = async/event-driven, dotted = cache/optional/telemetry, solid = synchronous. Vary color by concern (e.g. amber = data, violet = messaging).${geo ? " labelT (0.15-0.85) slides the label along the arrow to avoid collisions." : ""}
- Edge "tech" = protocol/format, C4 style ("JSON/HTTPS", "gRPC", "SQL"); omit when obvious. "direction":"both" for genuinely bidirectional links, "none" for plain association; omit for normal flow. When the user asks for a request flow or sequence, number the participating edges with "seq":1,2,3… in traversal order; omit seq otherwise.
- meta.routing "orthogonal" gives right-angle connectors (formal/dense diagrams); omit for curved. meta.title names the diagram. meta.versionTag labels the revision ("v2.1", "2026-Q3 draft") when the user gives one; omit otherwise.
- Node "tags" = short lowercase labels for cross-cutting concerns the user mentions ("pci","gdpr","deprecated","planned"); omit when none. Node "url" = deep link to docs/repo if the user supplies one; omit otherwise. Node "team" = the owning or contact team when the user names one ("Payments", "Platform"); omit otherwise. Node "status" = lifecycle stage when stated: "planned" for future work, "stubbed" for scaffolding that exists but does nothing yet, "dark" for built-and-shipped but not yet enabled, "deprecated" for being sunset; omit for normal active components. Text notes draw a subtle box by default; set "plain":true only when the user wants bare text with no outline.
- Node/edge/zone "date" = when that piece lands or landed, as "YYYY-MM-DD". Set it ONLY when the user gives a roadmap, phases, quarters, or a migration order; omit it everywhere else. Undated elements are treated as always present, so a phased plan dates the new pieces and leaves today's system undated. A node inside a group is never shown before the group, so date the group with its earliest phase.
- parentId may reference ANY existing node. A child of a "group" renders inside its frame. A child of any other node is that component's INTERNAL decomposition (the next C4 level) — shown only when the user drills into that component, never on the parent's own diagram. Do NOT decompose a component into children unless the user explicitly asks for its internal detail. Never create a parent cycle.
- DATA MODELS: an entity/table is a node of kind "table" whose columns are "fields" — {id, name, type, key:"pk"/"fk"/"pfk", required}. Field ids are unique within their node.${geo ? " Give a table w 200-260; the editor grows its height to fit the rows, so h is only a hint." : ""} A relationship is an ordinary edge between the two tables: name the columns it joins with "startField"/"endField" (field ids on the source and target), and put cardinality in "startLabel"/"endLabel" ("1", "0..1", "0..*", "1..*") — these render as crow's-foot symbols, so write real cardinalities there rather than prose. Use "fields" ONLY for data modelling — an ordinary architecture node omits the key entirely. Subject areas are "group" parents, exactly as elsewhere.
- ZONES are infra backgrounds, drawn behind everything, in ABSOLUTE canvas coordinates (never relative). Provider ids: ${providers}. Omit the "zones" key entirely unless the request actually involves infrastructure or hosting.
- Zone "color" (optional) is the OUTLINE hex; the background derives from it automatically. It may carry "/NN" percent alpha for fill strength ("#38bdf8/22"). Omit for the provider's default colour. Zone "outline" (optional): dashed for logical/planned boundaries, dotted for soft groupings, none for a pure background wash; omit for solid.
- A zone's "providers" lists every provider it could run on; "provider" is the one shown. Use a higher "z" for a small zone that sits on top of a bigger one (e.g. a third-party SaaS island inside a cloud region).
- Nodes reference a zone with "zoneId" — this is INDEPENDENT of parentId, so a node can be in a zone and a group at once.${geo ? " Position them so they fall inside the zone's box." : ""}
- A node's "providers" lists which providers it exists on; it is hidden when the zone shows anything else. Omit it (or use []) for nodes present in every deployment. Use it to show provider-specific services, e.g. a node with providers:["aws"] for RDS alongside one with providers:["azure"] for Azure SQL.
- Use "shape":"polygon" with normalised "points":[[0,0],[1,0],[1,1]] (0..1 within the zone box) only for genuinely irregular regions; prefer "rounded".
- ${
    geo
      ? "Lay out left-to-right by request flow, spread vertically, no overlapping nodes. 6-14 nodes per level (a component's children form their own level with their own budget)."
      : "NEVER emit x/y/w/h on nodes or labelT on edges — placement is managed outside this document and is preserved across your edits. KEEP EVERY EXISTING ID EXACTLY as given (ids are how elements keep their places); give new elements new ids. Array order = rough left-to-right flow. 6-14 nodes per level (a component's children form their own level with their own budget)."
  } fontSize only on text nodes. Keep JSON compact.${
    opts.extraRules ? `\n${opts.extraRules}` : ""
  }`;
}

/** The prompt for the built-in vocabulary, with no registry extensions. */
export const DIAGRAM_SYSTEM_PROMPT = buildSystemPrompt();

// ─── Runtime validation ──────────────────────────────────────────────────────

export interface ValidateOptions {
  /** Kinds to accept beyond the built-ins (supplied by a node-kind registry). */
  knownKinds?: readonly string[];
  /** Icons to accept beyond the built-ins (supplied by an icon registry). */
  knownIcons?: readonly string[];
  /** Kinds that may act as a parent. Defaults to CONTAINER_KINDS. */
  containerKinds?: readonly string[];
  /** Kinds that render as bare text. Defaults to ANNOTATION_KINDS. */
  annotationKinds?: readonly string[];
  /** Provider ids to accept (supplied by a provider registry). */
  knownProviders?: readonly string[];
}

/** Fill opacity for a zone when it doesn't specify one — a tint, not a slab. */
export const DEFAULT_ZONE_OPACITY = 0.14;

/**
 * Coerce arbitrary parsed JSON into a valid DiagramTemplate.
 *
 * This never throws on recoverable problems — an LLM producing a slightly-off
 * document should still render. It throws only when there is no usable
 * `nodes` array at all. Unrecoverable-per-item problems are repaired:
 *
 *  - unknown kind → "service"; unknown icon → "none"
 *  - duplicate id → suffixed until unique
 *  - parentId pointing at a missing node, at itself, at a non-container, or
 *    forming a cycle → nulled out
 *  - edges referencing missing nodes → dropped
 *  - non-finite / NaN coordinates → 0, or the kind's default size
 */
export function validateTemplate(raw: unknown, opts: ValidateOptions = {}): DiagramTemplate {
  // Upgrade first: a v0 document must reach the current shape before the rules
  // below are applied to it. Throws only for a version from the future.
  const r = migrateTemplate(raw ?? {}) as unknown as Partial<DiagramTemplate>;
  if (!Array.isArray(r.nodes)) throw new Error("Template is missing a `nodes` array");

  // Cloud pack kinds (aws-lambda, azure-functions, …) are base vocabulary:
  // a backend or host validating without the react registry must not coerce
  // them away.
  const kindSet = new Set<string>([
    ...NODE_KINDS,
    ...ALL_CLOUD_KIND_IDS,
    ...(opts.knownKinds ?? []),
  ]);
  const iconSet = new Set<string>([...ICON_NAMES, ...(opts.knownIcons ?? [])]);
  const containerSet = new Set<string>(opts.containerKinds ?? CONTAINER_KINDS);
  const annotationSet = new Set<string>(opts.annotationKinds ?? ANNOTATION_KINDS);
  const providerSet = new Set<string>([...PROVIDER_IDS, ...(opts.knownProviders ?? [])]);

  const zones = validateZones(r.zones, providerSet);
  const zoneIds = new Set(zones.map((z) => z.id));

  const seen = new Set<string>();
  const nodes: DiagramNode[] = r.nodes
    .filter((n): n is DiagramNode => !!n && typeof (n as DiagramNode).id === "string")
    .map((n) => {
      let id = String(n.id);
      // Suffix duplicates rather than dropping them — an LLM repeating an id
      // usually means two real nodes, not one.
      let bump = 2;
      while (seen.has(id)) id = `${String(n.id)}_${bump++}`;
      seen.add(id);

      const kind: NodeKind = kindSet.has(n.kind as string) ? n.kind : "service";
      const size = KIND_DEFAULT_SIZE[kind] ?? KIND_DEFAULT_SIZE.default;

      // A node lists the providers it exists on. An empty list would hide it
      // everywhere, which is never what anyone means — treat it as "always".
      const providers = Array.isArray(n.providers)
        ? [...new Set(n.providers.filter((p): p is string => typeof p === "string" && !!p))]
        : undefined;
      const tags = Array.isArray(n.tags)
        ? [...new Set(n.tags.map((t) => String(t).trim()).filter(Boolean))]
        : undefined;
      const url = typeof n.url === "string" ? n.url.trim() : "";
      const team = typeof n.team === "string" ? n.team.trim() : "";
      // Unparseable dates are dropped rather than kept verbatim: the whole
      // timeline orders by string comparison, and one malformed value would
      // sort somewhere arbitrary instead of failing visibly.
      const date = normalizeDate(n.date);
      const fields = validateFields(n.fields);
      const description = n.description ? String(n.description) : "";

      return {
        id,
        label: String(n.label ?? id),
        kind,
        icon: iconSet.has(n.icon as string) ? n.icon : "none",
        description,
        ...(fields ? { fields } : {}),
        parentId: n.parentId ? String(n.parentId) : null,
        zoneId: n.zoneId && zoneIds.has(String(n.zoneId)) ? String(n.zoneId) : null,
        ...(providers && providers.length ? { providers } : {}),
        ...(tags && tags.length ? { tags } : {}),
        ...(url ? { url } : {}),
        ...(team ? { team } : {}),
        ...(date ? { date } : {}),
        // `active` is the default — stripping it keeps old documents
        // byte-identical through a load/save round-trip.
        ...(NODE_STATUSES.includes(n.status as NodeStatus) && n.status !== "active"
          ? { status: n.status as NodeStatus }
          : {}),
        ...(n.locked === true ? { locked: true } : {}),
        // Collapse is a container concept; on anything else it is meaningless
        // and would still hide "descendants" if a later edit made it one.
        ...(n.collapsed === true && containerSet.has(kind) ? { collapsed: true } : {}),
        // `plain` opts a text note OUT of its box. Boxed is the default, so
        // the field is stored only when true, and only where it means
        // something — every other kind draws its own shape.
        ...(n.plain === true && annotationSet.has(kind) ? { plain: true } : {}),
        // x/y may legitimately be 0; w/h/fontSize may not, so they fall back
        // to the kind default rather than collapsing the node to a sliver.
        x: num(n.x, 0),
        y: num(n.y, 0),
        w: positive(n.w, size.w),
        // A node never renders fewer rows than it carries: whatever height the
        // model (or an old document written before a column was added) asks
        // for, it grows to fit the list. Rows are content; clipping them would
        // silently drop meaning, unlike clipping a description.
        h: fields
          ? Math.max(positive(n.h, size.h), fieldsBoxHeight(fields.length, !!description))
          : positive(n.h, size.h),
        fontSize: positive(n.fontSize, 13),
      };
    });

  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Repair parent references, in three passes so each rule is independent.
  // ANY node may parent: a child of a container kind renders inside its frame;
  // a child of any other kind is that node's drill-in detail (its next C4
  // level), hidden inline and shown only in a scoped view. Only missing
  // parents and self-parents are repaired here.
  for (const n of nodes) {
    if (!n.parentId) continue;
    const parent = byId.get(n.parentId);
    if (!parent || parent.id === n.id) {
      n.parentId = null;
    }
  }
  breakParentCycles(nodes, byId);

  const edges: DiagramEdge[] = (Array.isArray(r.edges) ? r.edges : [])
    .filter(
      (e): e is DiagramEdge =>
        !!e && byId.has(String(e.source)) && byId.has(String(e.target)) && e.source !== e.target,
    )
    .map((e, i) => {
      const providers = Array.isArray(e.providers)
        ? [...new Set(e.providers.filter((p): p is string => typeof p === "string" && !!p))]
        : undefined;
      const tech = typeof e.tech === "string" ? e.tech.trim() : "";
      const seq = Math.floor(num(e.seq, 0));
      const date = normalizeDate(e.date);
      const start = validateAnchor(e.start);
      const end = validateAnchor(e.end);
      const points = validateEdgePoints(e.points);
      const startLabel = typeof e.startLabel === "string" ? e.startLabel.trim() : "";
      const endLabel = typeof e.endLabel === "string" ? e.endLabel.trim() : "";
      // A field reference is only meaningful if that endpoint actually has the
      // row. A dangling one is dropped rather than kept: the line would attach
      // to a phantom position, and the same repair-don't-throw rule already
      // governs every other reference in this document.
      const startField = fieldIdOn(byId.get(String(e.source)), e.startField);
      const endField = fieldIdOn(byId.get(String(e.target)), e.endField);
      return {
        id: e.id ? String(e.id) : `e${i}`,
        source: String(e.source),
        target: String(e.target),
        label: e.label ? String(e.label) : "",
        labelT: clamp(num(e.labelT, 0.5), 0.15, 0.85),
        style: (EDGE_STYLES as readonly string[]).includes(e.style) ? e.style : "solid",
        color: (EDGE_COLORS as readonly string[]).includes(e.color) ? e.color : "slate",
        // An empty list would hide the edge everywhere, which is never meant.
        ...(providers && providers.length ? { providers } : {}),
        ...(tech ? { tech } : {}),
        ...(date ? { date } : {}),
        // Defaults are stripped so an old document round-trips byte-identical.
        ...(e.direction === "both" || e.direction === "none" ? { direction: e.direction } : {}),
        ...(seq > 0 ? { seq } : {}),
        ...((EDGE_ROUTINGS as readonly string[]).includes(e.routing as string)
          ? { routing: e.routing }
          : {}),
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
        ...(startLabel ? { startLabel } : {}),
        ...(endLabel ? { endLabel } : {}),
        ...(startField ? { startField } : {}),
        ...(endField ? { endField } : {}),
        ...(points ? { points } : {}),
      };
    });

  // De-duplicate edge ids the same way as node ids.
  const edgeSeen = new Set<string>();
  for (const e of edges) {
    let bump = 2;
    let id = e.id;
    while (edgeSeen.has(id)) id = `${e.id}_${bump++}`;
    edgeSeen.add(id);
    e.id = id;
  }

  const out: DiagramTemplate = { version: 1, nodes, edges };
  // Only attach `zones` when there are some, so a zone-less document
  // round-trips byte-identical to what it was before zones existed.
  if (zones.length) out.zones = zones;
  if (r.meta && typeof r.meta === "object") {
    const meta: NonNullable<DiagramTemplate["meta"]> = { ...r.meta };
    const versionTag = typeof meta.versionTag === "string" ? meta.versionTag.trim() : "";
    if (versionTag) meta.versionTag = versionTag;
    else delete meta.versionTag;
    if (!VERSION_TAG_POSITIONS.includes(meta.versionTagPosition as VersionTagPosition)) {
      delete meta.versionTagPosition;
    }
    // Repaired and re-appended LAST — a canonical key position, so the
    // split/merge round-trip stays byte-identical.
    const views = validateViewRecords(meta.views);
    delete meta.views;
    if (views) meta.views = views;
    out.meta = meta;
  }
  return out;
}

/**
 * Coerce the zones array. Like node validation, this repairs rather than
 * rejects: an unknown shape becomes "rounded", an out-of-range polygon point is
 * clamped, and an active provider that isn't in the zone's own list falls back
 * to the first one it does offer.
 */
function validateZones(raw: unknown, providerSet: Set<string>): DiagramZone[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();

  return raw
    .filter((z): z is DiagramZone => !!z && typeof (z as DiagramZone).id === "string")
    .map((z) => {
      let id = String(z.id);
      let bump = 2;
      while (seen.has(id)) id = `${String(z.id)}_${bump++}`;
      seen.add(id);

      // A zone must offer at least one provider, or its toggle is meaningless
      // and its colour is undefined.
      let providers = Array.isArray(z.providers)
        ? [...new Set(z.providers.filter((p): p is string => typeof p === "string" && !!p))]
        : [];
      if (!providers.length) {
        providers = [typeof z.provider === "string" && z.provider ? z.provider : PROVIDER_IDS[0]];
      }
      // Unknown provider ids are kept — a registry may define them, and
      // dropping them would silently destroy the author's intent.
      void providerSet;

      const provider =
        typeof z.provider === "string" && providers.includes(z.provider) ? z.provider : providers[0];

      const shape: ZoneShape = (ZONE_SHAPES as readonly string[]).includes(z.shape)
        ? z.shape
        : "rounded";

      const points = shape === "polygon" ? validatePolygon(z.points) : undefined;
      const date = normalizeDate(z.date);
      const color = normalizeHexColor(z.color);

      return {
        id,
        label: String(z.label ?? id),
        shape,
        ...(points ? { points } : {}),
        ...(date ? { date } : {}),
        ...(color ? { color: color.hex } : {}),
        // `solid` is the default and never stored; garbage strips with it.
        ...((ZONE_OUTLINES as readonly string[]).includes(z.outline as string) &&
        z.outline !== "solid"
          ? { outline: z.outline as ZoneOutline }
          : {}),
        // Filled is the default; only the opt-out persists.
        ...(z.fill === false ? { fill: false } : {}),
        x: num(z.x, 0),
        y: num(z.y, 0),
        w: positive(z.w, 400),
        h: positive(z.h, 300),
        providers,
        provider,
        // Precedence via num()'s fallback chain: an explicit `opacity` wins,
        // an alpha carried on the colour ("#38bdf8/40" or #rrggbbaa) comes
        // second, the default last.
        opacity: clamp(num(z.opacity, color?.alpha ?? DEFAULT_ZONE_OPACITY), 0, 1),
        z: Math.round(num(z.z, 0)),
        ...(z.locked === true ? { locked: true } : {}),
      };
    });
}

/** At least 3 points, each clamped into the normalised 0..1 box. */
function validatePolygon(raw: unknown): ZonePoint[] | undefined {
  if (!Array.isArray(raw)) return [...DEFAULT_POLYGON_POINTS];
  const points = raw
    .filter((p): p is [unknown, unknown] => Array.isArray(p) && p.length >= 2)
    .map(([x, y]): ZonePoint => [clamp(num(x, 0), 0, 1), clamp(num(y, 0), 0, 1)]);
  return points.length >= 3 ? points : [...DEFAULT_POLYGON_POINTS];
}

/**
 * How many rows one node may carry. A model asked for "the schema" can emit a
 * hundred columns for one table; past this the node is a wall of text rather
 * than a diagram, and the excess is dropped instead of rendered off-box.
 */
export const MAX_NODE_FIELDS = 40;

/**
 * Coerce a node's rows. Repairs in the house style: an entry with no usable
 * name is dropped, a missing id is derived from the name, duplicates are
 * suffixed (an edge references a row BY id, so two rows sharing one would
 * silently re-aim a foreign key), and an unknown key role is simply forgotten.
 * Returns undefined for "no rows", so a node without them round-trips
 * byte-identical to what it was before fields existed.
 */
function validateFields(raw: unknown): NodeField[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: NodeField[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const f = entry as Partial<NodeField>;
    const name = typeof f.name === "string" ? f.name.trim() : "";
    const rawId = typeof f.id === "string" ? f.id.trim() : "";
    if (!name && !rawId) continue;
    let id = rawId || slugifyFieldId(name);
    let bump = 2;
    while (seen.has(id)) id = `${rawId || slugifyFieldId(name)}_${bump++}`;
    seen.add(id);
    const type = typeof f.type === "string" ? f.type.trim() : "";
    out.push({
      id,
      name: name || id,
      ...(type ? { type } : {}),
      ...((FIELD_KEYS as readonly string[]).includes(f.key as string)
        ? { key: f.key as FieldKey }
        : {}),
      ...(f.required === true ? { required: true } : {}),
    });
    if (out.length === MAX_NODE_FIELDS) break;
  }
  return out.length ? out : undefined;
}

/** A URL-ish id from a column name: "User ID" → "user_id". */
function slugifyFieldId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "field";
}

/** The field id if that node really has it, else undefined. */
function fieldIdOn(node: DiagramNode | undefined, fieldId: unknown): string | undefined {
  if (typeof fieldId !== "string" || !fieldId) return undefined;
  return node?.fields?.some((f) => f.id === fieldId) ? fieldId : undefined;
}

/** Where a row's centre sits as a fraction of the node's height, or nothing. */
export function fieldRowT(
  node: { fields?: readonly NodeField[]; description?: string; h: number },
  fieldId: string | undefined,
): number | undefined {
  if (!fieldId || !node.fields?.length || !(node.h > 0)) return undefined;
  const index = node.fields.findIndex((f) => f.id === fieldId);
  if (index < 0) return undefined;
  const y = fieldListTop(!!node.description) + index * FIELD_ROW_H + FIELD_ROW_H / 2;
  return clamp(y / node.h, 0, 1);
}

/** A node as the row-anchor maths needs to see it: its rows and its box. */
export interface FieldAnchorNode {
  fields?: readonly NodeField[];
  description?: string;
  h: number;
  /** Absolute centre x — decides which face the line leaves through. */
  centerX: number;
}

/**
 * Resolve an edge's stored anchors with its field references applied, so a
 * foreign key lands on the row it references rather than the middle of the
 * table.
 *
 * The side is the user's if they pinned one and the rows are vertical there
 * (left/right); otherwise it's the face looking at the other box. A pin to top
 * or bottom wins outright — a row fraction along a horizontal face points at a
 * column of the box, which is not what a row means. Everything else falls
 * through untouched, so an edge with no field references routes exactly as it
 * always did.
 *
 * Both the canvas and the exporters call this, which is what keeps a PNG's
 * foreign-key lines on the same rows as the screen's.
 */
export function fieldAnchors(
  edge: Pick<DiagramEdge, "start" | "end" | "startField" | "endField">,
  source: FieldAnchorNode,
  target: FieldAnchorNode,
): { start?: EdgeAnchor; end?: EdgeAnchor } {
  const resolve = (
    anchor: EdgeAnchor | undefined,
    fieldId: string | undefined,
    self: FieldAnchorNode,
    other: FieldAnchorNode,
  ): EdgeAnchor | undefined => {
    if (!fieldId) return anchor;
    if (anchor && (anchor.side === "top" || anchor.side === "bottom")) return anchor;
    const t = fieldRowT({ fields: self.fields, description: self.description, h: self.h }, fieldId);
    if (t === undefined) return anchor;
    const side: EdgeAnchorSide = anchor?.side ?? (other.centerX >= self.centerX ? "right" : "left");
    return { side, t };
  };
  const start = resolve(edge.start, edge.startField, source, target);
  const end = resolve(edge.end, edge.endField, target, source);
  return { ...(start ? { start } : {}), ...(end ? { end } : {}) };
}

/**
 * An edge anchor, or nothing. Repair rules: an unknown side drops the whole
 * anchor (there is no sensible fallback side), `t` clamps into 0..1, and a
 * centred `t` is stripped so the default is never stored.
 */
function validateAnchor(raw: unknown): EdgeAnchor | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const side = (raw as { side?: unknown }).side;
  if (!(EDGE_ANCHOR_SIDES as readonly string[]).includes(side as string)) return undefined;
  const t = clamp(num((raw as { t?: unknown }).t, 0.5), 0, 1);
  return t === 0.5 ? { side: side as EdgeAnchorSide } : { side: side as EdgeAnchorSide, t };
}

/**
 * Edge waypoints — NOT `validatePolygon`, which clamps into a zone's
 * normalised 0..1 box; these are absolute canvas coordinates. Rounded to
 * whole pixels, capped so a runaway document can't smuggle in thousands.
 */
const MAX_EDGE_POINTS = 16;
function validateEdgePoints(raw: unknown): Array<[number, number]> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const points = raw
    .filter(
      (p): p is [unknown, unknown] =>
        Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])),
    )
    .slice(0, MAX_EDGE_POINTS)
    .map(([x, y]): [number, number] => [Math.round(Number(x)), Math.round(Number(y))]);
  return points.length ? points : undefined;
}

// ─── Per-view records ────────────────────────────────────────────────────────

/**
 * Presentation overrides for ONE drill-in view (`meta.views[focusId]`).
 *
 * Records are keyed by DERIVED ids only — a ghost stand-in's placement, a
 * ghost edge's route. Real children need no record: their document x/y ARE
 * their placement in the focused view (coordinate identity).
 */
export interface ViewRecord {
  /** Placement overrides for `ghost:` nodes in this view. */
  nodes?: Record<string, { x: number; y: number; w: number; h: number }>;
  /** Route overrides for `ghost:` edges in this view. */
  edges?: Record<
    string,
    { labelT?: number; start?: EdgeAnchor; end?: EdgeAnchor; points?: Array<[number, number]> }
  >;
}

/**
 * Repair a `views` map the same way `validatePresentation` repairs its
 * records: broken geometry dropped, defaults stripped, empty layers removed.
 * Returns undefined when nothing survives, so the key is default-absent.
 * Stale focus ids are KEPT — validation cannot know which content edit made
 * them stale, and they are bytes, not behavior.
 */
export function validateViewRecords(raw: unknown): Record<string, ViewRecord> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, ViewRecord> = {};
  for (const [focusId, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!focusId || !entry || typeof entry !== "object") continue;
    const view: ViewRecord = {};

    const rawNodes = (entry as { nodes?: unknown }).nodes;
    if (rawNodes && typeof rawNodes === "object" && !Array.isArray(rawNodes)) {
      const nodes: NonNullable<ViewRecord["nodes"]> = {};
      for (const [id, rec] of Object.entries(rawNodes as Record<string, unknown>)) {
        if (!id || !rec || typeof rec !== "object") continue;
        const { x, y, w, h } = rec as Record<string, unknown>;
        if (![x, y, w, h].every((v) => Number.isFinite(Number(v)))) continue;
        if (Number(w) <= 0 || Number(h) <= 0) continue;
        nodes[id] = { x: Number(x), y: Number(y), w: Number(w), h: Number(h) };
      }
      if (Object.keys(nodes).length) view.nodes = nodes;
    }

    const rawEdges = (entry as { edges?: unknown }).edges;
    if (rawEdges && typeof rawEdges === "object" && !Array.isArray(rawEdges)) {
      const edges: NonNullable<ViewRecord["edges"]> = {};
      for (const [id, rec] of Object.entries(rawEdges as Record<string, unknown>)) {
        if (!id || !rec || typeof rec !== "object") continue;
        const route: NonNullable<ViewRecord["edges"]>[string] = {};
        const labelT = clamp(num((rec as { labelT?: unknown }).labelT, 0.5), 0.15, 0.85);
        if (labelT !== 0.5) route.labelT = labelT;
        const start = validateAnchor((rec as { start?: unknown }).start);
        if (start) route.start = start;
        const end = validateAnchor((rec as { end?: unknown }).end);
        if (end) route.end = end;
        const points = validateEdgePoints((rec as { points?: unknown }).points);
        if (points) route.points = points;
        if (Object.keys(route).length) edges[id] = route;
      }
      if (Object.keys(edges).length) view.edges = edges;
    }

    if (view.nodes || view.edges) out[focusId] = view;
  }
  return Object.keys(out).length ? out : undefined;
}

// ─── Collapse ────────────────────────────────────────────────────────────────

/** Rendered size of a collapsed container chip. Stored w/h keep the expanded size. */
export const COLLAPSED_SIZE = { w: 180, h: 44 } as const;

/** Ids of nodes whose descendants are hidden below them (they render closed). */
function hiddenBelow(t: DiagramTemplate, closed: ReadonlySet<string>): Set<string> {
  if (!closed.size) return new Set();

  const hidden = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of t.nodes) {
      if (!node.parentId || hidden.has(node.id)) continue;
      if (closed.has(node.parentId) || hidden.has(node.parentId)) {
        hidden.add(node.id);
        grew = true;
      }
    }
  }
  return hidden;
}

/** Parents whose kind is not a container: their children are drill-in detail. */
function cardParentIds(t: DiagramTemplate, containerKinds?: readonly string[]): Set<string> {
  const containerSet = new Set(containerKinds ?? CONTAINER_KINDS);
  const parentIds = new Set(t.nodes.map((n) => n.parentId).filter((p): p is string => !!p));
  return new Set(
    t.nodes.filter((n) => parentIds.has(n.id) && !containerSet.has(n.kind as string)).map((n) => n.id),
  );
}

/**
 * Every node hidden because an ancestor renders closed — a collapsed container
 * or a non-container parent (whose children are drill-in detail, its next C4
 * level, never shown inline).
 *
 * The closed node itself stays visible (chip or card); its descendants
 * disappear. Shared by `toReactFlow` and `fromReactFlow` so both sides agree
 * on what "was hidden" means — if they disagreed, an edit while a group is
 * collapsed would judge its children as user-deleted and destroy them, the
 * same data-loss class as the provider-toggle bugs.
 */
export function hiddenByCollapse(
  t: DiagramTemplate,
  opts: { containerKinds?: readonly string[] } = {},
): Set<string> {
  const closed = new Set(t.nodes.filter((n) => n.collapsed).map((n) => n.id));
  for (const id of cardParentIds(t, opts.containerKinds)) closed.add(id);
  return hiddenBelow(t, closed);
}

/**
 * Only the nodes hidden inline by non-container parents — transient collapse
 * flags deliberately ignored. This is the set view derivation keys on: which
 * level a node belongs to must not change when the user collapses a group.
 */
export function hiddenInline(
  t: DiagramTemplate,
  containerKinds?: readonly string[],
): Set<string> {
  return hiddenBelow(t, cardParentIds(t, containerKinds));
}

/**
 * Where an edge endpoint attaches while collapse hides its node: the nearest
 * visible ancestor — by construction a collapsed container rendering as a chip.
 */
export function visibleAnchor(
  nodeId: string,
  byId: Map<string, DiagramNode>,
  hidden: ReadonlySet<string>,
): string {
  let id = nodeId;
  const guard = new Set<string>();
  while (hidden.has(id) && !guard.has(id)) {
    guard.add(id);
    const parent = byId.get(id)?.parentId;
    if (!parent) break;
    id = parent;
  }
  return id;
}

/** Synthetic id marker for edges re-routed to a collapsed chip. */
export const COLLAPSED_EDGE_PREFIX = "collapsed:";
export const isCollapsedEdgeId = (id: string) => id.startsWith(COLLAPSED_EDGE_PREFIX);

/**
 * Synthetic id markers for elements a scoped view derives (see scope.ts): the
 * boundary frame standing for the focused node, and ghost stand-ins for
 * elements outside the focused level. Like `collapsed:` and the React Flow
 * `zone:` prefix, these are RESERVED — a document element whose own id starts
 * with one of them would be stripped as a view artifact on the next canvas
 * round-trip.
 */
export const BOUNDARY_NODE_PREFIX = "boundary:";
export const GHOST_NODE_PREFIX = "ghost:";
/** Ghost EDGES share the "ghost:" string — node and edge ids never mix. */
export const GHOST_EDGE_PREFIX = "ghost:";
export const isBoundaryNodeId = (id: string) => id.startsWith(BOUNDARY_NODE_PREFIX);
export const isGhostNodeId = (id: string) => id.startsWith(GHOST_NODE_PREFIX);
export const isGhostEdgeId = (id: string) => id.startsWith(GHOST_EDGE_PREFIX);
/** The document id a ghost stands in for — the target of click-to-navigate. */
export const ghostSourceId = (id: string) => id.slice(GHOST_NODE_PREFIX.length);

// ─── Provider-driven visibility ──────────────────────────────────────────────

export interface Visibility {
  nodes: Set<string>;
  edges: Set<string>;
  /** Nodes hidden by the current provider selection, for reporting in the UI. */
  hiddenNodeCount: number;
}

/**
 * Which nodes and edges render under the current provider selection.
 *
 * A node is hidden when it sits on a zone and declares a `providers` list that
 * excludes that zone's active provider. Hiding cascades through `parentId` —
 * hiding a group must hide everything nested inside it, or orphaned children
 * would float over the canvas. Edges hide with either endpoint.
 */
export function visibleElements(template: DiagramTemplate): Visibility {
  const zoneById = new Map((template.zones ?? []).map((z) => [z.id, z]));

  const hidden = new Set<string>();
  for (const node of template.nodes) {
    if (!node.zoneId || !node.providers?.length) continue;
    const zone = zoneById.get(node.zoneId);
    if (!zone) continue;
    if (!node.providers.includes(zone.provider)) hidden.add(node.id);
  }

  // Cascade to descendants of anything hidden.
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of template.nodes) {
      if (node.parentId && hidden.has(node.parentId) && !hidden.has(node.id)) {
        hidden.add(node.id);
        grew = true;
      }
    }
  }

  const nodes = new Set(template.nodes.filter((n) => !hidden.has(n.id)).map((n) => n.id));

  const nodeById = new Map(template.nodes.map((n) => [n.id, n]));
  const edges = new Set(
    template.edges
      .filter((e) => {
        // An edge always needs both ends present.
        if (!nodes.has(e.source) || !nodes.has(e.target)) return false;
        if (!e.providers?.length) return true;
        // Borrow membership from the source, then the target. With neither
        // zoned there is nothing to compare against, so the list is ignored.
        const zoneId = nodeById.get(e.source)?.zoneId ?? nodeById.get(e.target)?.zoneId;
        if (!zoneId) return true;
        const zone = zoneById.get(zoneId);
        return !zone || e.providers.includes(zone.provider);
      })
      .map((e) => e.id),
  );
  return { nodes, edges, hiddenNodeCount: hidden.size };
}

// ─── Zone membership reconciliation ──────────────────────────────────────────
//
// `zoneId` and node position can disagree, and which one is right depends on
// how they came to disagree — so there are two reconcilers, not one:
//
//   editor  → the user dragged something, so GEOMETRY is truth
//   import  → an author declared membership, so the DECLARATION is truth
//
// Without the first, dragging a zone over some nodes leaves them un-enrolled:
// they look enclosed but the provider toggle ignores them. Without the second,
// LLM output that gets membership right and coordinates slightly wrong loses
// the membership entirely.

/**
 * Recompute every node's `zoneId` from where it actually sits.
 *
 * Uses the node's centre and shape-aware containment, so an L-shaped zone's
 * notch does not enrol anything. Call after any change to zone geometry.
 *
 * Nodes hidden inline under a non-container parent are SKIPPED: their
 * coordinates live in that parent's drilled canvas, so their absolute centre
 * is meaningless against root-space zone boxes — the declared membership
 * passes through verbatim.
 */
export function assignZonesByGeometry(
  template: DiagramTemplate,
  opts: { containerKinds?: readonly string[] } = {},
): DiagramTemplate {
  const zones = template.zones ?? [];
  if (!zones.length) {
    // No zones left — clear stale ids rather than leaving dangling references.
    if (!template.nodes.some((n) => n.zoneId)) return template;
    return { ...template, nodes: template.nodes.map((n) => ({ ...n, zoneId: null })) };
  }

  const byId = new Map(template.nodes.map((n) => [n.id, n]));
  const drillHidden = hiddenInline(template, opts.containerKinds);
  let changed = false;

  const nodes = template.nodes.map((node) => {
    if (drillHidden.has(node.id)) return node;
    const { x, y } = absolutePosition(node, byId);
    const zone = zoneAt(zones, x + node.w / 2, y + node.h / 2);
    const zoneId = zone?.id ?? null;
    if (zoneId === (node.zoneId ?? null)) return node;
    changed = true;
    return { ...node, zoneId };
  });

  return changed ? { ...template, nodes } : template;
}

/**
 * Move nodes so they satisfy the `zoneId` they declare.
 *
 * The inverse of `assignZonesByGeometry`, for freshly imported or generated
 * documents where the declaration is the author's intent and the coordinates
 * are the unreliable part.
 *
 * Only touches root-level nodes: a node inside a group is positioned relative
 * to that group, so moving it would fight the group's own layout. Its zone is
 * corrected by geometry instead.
 */
export function snapNodesIntoZones(
  template: DiagramTemplate,
  opts: { containerKinds?: readonly string[] } = {},
): DiagramTemplate {
  const zones = template.zones ?? [];
  if (!zones.length) return template;
  const zoneById = new Map(zones.map((z) => [z.id, z]));
  let changed = false;

  const nodes = template.nodes.map((node) => {
    if (!node.zoneId || node.parentId) return node;
    const zone = zoneById.get(node.zoneId);
    if (!zone) return node;
    if (pointInZone(zone, node.x + node.w / 2, node.y + node.h / 2)) return node;
    const { x, y } = clampBoxIntoZone({ x: node.x, y: node.y, w: node.w, h: node.h }, zone);
    if (x === node.x && y === node.y) return node;
    changed = true;
    return { ...node, x, y };
  });

  // Nodes the snap could not fix (nested, or in a zone that no longer exists)
  // still need their membership to match reality.
  return assignZonesByGeometry(changed ? { ...template, nodes } : template, opts);
}

/**
 * Minimum node sizes by kind class. These mirror the editor's resize-handle
 * minima (react/nodes.tsx), which read this table — one source of truth for
 * "how small can it get" whether the user drags a corner or a zone scales it.
 */
export const NODE_MIN_SIZE = {
  shape: { w: 110, h: 52 },
  group: { w: 160, h: 120 },
  annotation: { w: 80, h: 28 },
} as const;

/** A zone's bounding box, absolute canvas coordinates. */
export interface ZoneBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScaleZoneOptions {
  /**
   * Root-level member ids captured BEFORE the gesture. Defaults to nodes with
   * `zoneId === zoneId` and no parent — pass explicitly when membership may
   * have been re-judged mid-gesture (the editor derives the document every
   * frame of a resize drag, and `assignZonesByGeometry` re-judges membership
   * against the mid-drag box).
   */
  memberIds?: readonly string[];
  /** Kinds that clamp to the group minimum. Defaults to CONTAINER_KINDS. */
  containerKinds?: readonly string[];
  /** Kinds that clamp to the annotation minimum. Defaults to ANNOTATION_KINDS. */
  annotationKinds?: readonly string[];
}

/**
 * Move a zone's box from `before` to `after` and scale its members with it —
 * positions relative to the box and node sizes, per axis, so the layout
 * inside the zone keeps its proportions.
 *
 * Only root-level members transform directly; descendants follow by having
 * their parent-relative offsets and sizes scaled by the same factors, so a
 * group's inner layout tracks the group (offsetting them absolutely would
 * double the shift — see the same rule in clipboard.ts's pasteFragment).
 * Locked nodes scale too: `locked` guards individual gestures, and this is a
 * zone-level transform of everything the zone contains. Sizes clamp to the
 * per-kind minima, so extreme shrinks trade strict proportionality for
 * legibility. Polygon points are untouched — they are normalised 0..1, so the
 * silhouette rides the box for free.
 *
 * Degenerate axes pass through: a `before` width/height of zero scales that
 * axis by 1 rather than producing NaN. Returns the SAME template reference
 * when there is nothing to do (unknown zone, or no members and the box
 * already at `after`), so callers can skip re-materialising.
 */
export function scaleZoneMembers(
  template: DiagramTemplate,
  zoneId: string,
  before: ZoneBox,
  after: ZoneBox,
  opts: ScaleZoneOptions = {},
): DiagramTemplate {
  const zone = (template.zones ?? []).find((z) => z.id === zoneId);
  if (!zone) return template;

  const rawSx = after.w / before.w;
  const rawSy = after.h / before.h;
  const sx = before.w > 0 && Number.isFinite(rawSx) ? rawSx : 1;
  const sy = before.h > 0 && Number.isFinite(rawSy) ? rawSy : 1;

  const memberSet = new Set(
    opts.memberIds ??
      template.nodes.filter((n) => n.zoneId === zoneId && !n.parentId).map((n) => n.id),
  );

  const boxUnchanged =
    zone.x === after.x && zone.y === after.y && zone.w === after.w && zone.h === after.h;
  if (!memberSet.size && boxUnchanged) return template;

  const containerSet = new Set(opts.containerKinds ?? CONTAINER_KINDS);
  const annotationSet = new Set(opts.annotationKinds ?? ANNOTATION_KINDS);
  const minFor = (kind: string) =>
    containerSet.has(kind)
      ? NODE_MIN_SIZE.group
      : annotationSet.has(kind)
        ? NODE_MIN_SIZE.annotation
        : NODE_MIN_SIZE.shape;

  const byId = new Map(template.nodes.map((n) => [n.id, n]));
  const descendsFromMember = (node: DiagramNode): boolean => {
    // Parent cycles are broken at validation time, but guard anyway.
    let parentId = node.parentId;
    let guard = 0;
    while (parentId && guard++ < 10_000) {
      if (memberSet.has(parentId)) return true;
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return false;
  };

  const nodes = template.nodes.map((node) => {
    const min = minFor(node.kind);
    if (memberSet.has(node.id) && !node.parentId) {
      return {
        ...node,
        x: after.x + (node.x - before.x) * sx,
        y: after.y + (node.y - before.y) * sy,
        w: Math.max(min.w, node.w * sx),
        h: Math.max(min.h, node.h * sy),
      };
    }
    if (node.parentId && descendsFromMember(node)) {
      // Parent-relative: scaling the offset keeps the child at the same
      // fraction of its container.
      return {
        ...node,
        x: node.x * sx,
        y: node.y * sy,
        w: Math.max(min.w, node.w * sx),
        h: Math.max(min.h, node.h * sy),
      };
    }
    return node;
  });

  const zones = (template.zones ?? []).map((z) =>
    z.id === zoneId ? { ...z, x: after.x, y: after.y, w: after.w, h: after.h } : z,
  );

  // Waypoints are canvas-absolute, so a route between two transformed nodes
  // must ride the same transform or it would stay behind at the old location.
  // An edge with only one end inside keeps its points: half a transform would
  // bend it unpredictably, and the untouched route still ends where the
  // outside node still is.
  const moved = new Set<string>();
  for (const node of template.nodes) {
    if ((memberSet.has(node.id) && !node.parentId) || (node.parentId && descendsFromMember(node))) {
      moved.add(node.id);
    }
  }
  const needsRouteScale = template.edges.some(
    (e) => e.points && moved.has(e.source) && moved.has(e.target),
  );
  const edges = needsRouteScale
    ? template.edges.map((e) => {
        if (!e.points || !moved.has(e.source) || !moved.has(e.target)) return e;
        return {
          ...e,
          points: e.points.map(([px, py]): [number, number] => [
            Math.round(after.x + (px - before.x) * sx),
            Math.round(after.y + (py - before.y) * sy),
          ]),
        };
      })
    : template.edges;

  return { ...template, nodes, zones, edges };
}

/** Set one zone's active provider, ignoring providers it doesn't offer. */
export function setZoneProvider(
  template: DiagramTemplate,
  zoneId: string,
  provider: string,
): DiagramTemplate {
  return {
    ...template,
    zones: (template.zones ?? []).map((z) =>
      z.id === zoneId && z.providers.includes(provider) ? { ...z, provider } : z,
    ),
  };
}

/**
 * Drive every zone to one provider — the "show me the all-AWS build" control.
 * Zones that don't offer the provider keep their current selection rather than
 * being forced onto something they can't represent.
 */
export function setAllZoneProviders(template: DiagramTemplate, provider: string): DiagramTemplate {
  return {
    ...template,
    zones: (template.zones ?? []).map((z) =>
      z.providers.includes(provider) ? { ...z, provider } : z,
    ),
  };
}

/** Every provider offered by any zone, in first-seen order. */
export function templateProviders(template: DiagramTemplate): string[] {
  const out: string[] = [];
  for (const zone of template.zones ?? []) {
    for (const p of zone.providers) if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * The provider every zone currently sits on, or null when they differ.
 * Drives the "Mixed" state of the global scenario control.
 */
export function activeScenario(template: DiagramTemplate): string | null {
  const zones = template.zones ?? [];
  if (!zones.length) return null;
  const first = zones[0].provider;
  return zones.every((z) => z.provider === first) ? first : null;
}

/**
 * Null out the `parentId` that closes each parent cycle (a→b→a).
 * The original code guarded traversals with a depth counter, which stopped the
 * infinite loop but left the document in a state that laid out nonsensically
 * and could not round-trip. Breaking the cycle at validation time means every
 * downstream consumer can assume the parent graph is a forest.
 */
function breakParentCycles(nodes: DiagramNode[], byId: Map<string, DiagramNode>): void {
  const state = new Map<string, "visiting" | "done">();

  for (const start of nodes) {
    if (state.get(start.id) === "done") continue;

    // Walk this node's ancestor chain, marking as we go.
    const path: DiagramNode[] = [];
    let cur: DiagramNode | undefined = start;

    while (cur) {
      const seenState = state.get(cur.id);
      if (seenState === "done") break;
      if (seenState === "visiting") {
        // `cur` is already on the current path — the edge into it closes a
        // cycle. Cut it at `cur` itself, which is the deepest repeated node.
        cur.parentId = null;
        break;
      }
      state.set(cur.id, "visiting");
      path.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }

    for (const n of path) state.set(n.id, "done");
  }
}

/**
 * Coerce to a finite number.
 *
 * Note `Number(null)` and `Number("")` are both 0, not NaN — so absent values
 * have to be rejected explicitly or a missing width becomes a zero width.
 */
function num(v: unknown, fallback: number): number {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Like `num`, but for values where zero and negatives are meaningless. */
function positive(v: unknown, fallback: number): number {
  const n = num(v, fallback);
  return n > 0 ? n : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Coerce a colour into canonical lowercase `#rrggbb`, or null.
 *
 * Accepts `#rgb` (expanded), `#rrggbb`, `#rrggbbaa` (CSS 8-digit hex), and
 * `#rrggbb/NN` (NN = percent). An alpha, however written, comes back as a
 * separate 0..1 number rather than staying inside the colour — the schema
 * stores fill opacity in one place (`opacity`), and a second copy riding the
 * hex would drift from it.
 */
function normalizeHexColor(raw: unknown): { hex: string; alpha?: number } | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase();

  const slash = /^(#[0-9a-f]{3}|#[0-9a-f]{6})\/(\d{1,3})$/.exec(text);
  const base = slash ? slash[1] : text;
  let alpha: number | undefined = slash ? clamp(Number(slash[2]), 0, 100) / 100 : undefined;

  let hex: string | null = null;
  if (/^#[0-9a-f]{6}$/.test(base)) hex = base;
  else if (/^#[0-9a-f]{3}$/.test(base)) hex = `#${[...base.slice(1)].map((c) => c + c).join("")}`;
  else if (/^#[0-9a-f]{8}$/.test(base)) {
    hex = base.slice(0, 7);
    // 8-digit hex carries its own alpha; a /NN suffix on top is malformed and
    // the explicit suffix wins.
    alpha ??= Number.parseInt(base.slice(7), 16) / 255;
  }
  if (!hex) return null;
  return alpha !== undefined ? { hex, alpha } : { hex };
}

/**
 * Strip markdown fences / prose and parse the first JSON object in an LLM
 * reply or a pasted document. Lightly damaged JSON (smart quotes, trailing
 * commas, a truncated reply) is healed by json-repair rather than rejected;
 * what can't be healed throws a user-facing message pointing at the damage.
 */
export function parseLlmTemplate(llmText: string, opts?: ValidateOptions): DiagramTemplate {
  return validateTemplate(parseLlmJson(llmText), opts);
}

// ─── Geometry helpers ────────────────────────────────────────────────────────

/** Absolute canvas position of a node, resolving the parent chain. */
export function absolutePosition(
  node: DiagramNode,
  byId: Map<string, DiagramNode>,
): { x: number; y: number } {
  let x = node.x;
  let y = node.y;
  let parent = node.parentId ? byId.get(node.parentId) : undefined;
  // The parent graph is a forest after validateTemplate, but guard anyway so
  // this helper is safe on hand-built input.
  const guard = new Set<string>([node.id]);
  while (parent && !guard.has(parent.id)) {
    guard.add(parent.id);
    x += parent.x;
    y += parent.y;
    parent = parent.parentId ? byId.get(parent.parentId) : undefined;
  }
  return { x, y };
}

/** Nesting depth — 0 for a root node. */
export function depthOf(node: DiagramNode, byId: Map<string, DiagramNode>): number {
  let depth = 0;
  let parent = node.parentId ? byId.get(node.parentId) : undefined;
  const guard = new Set<string>([node.id]);
  while (parent && !guard.has(parent.id)) {
    guard.add(parent.id);
    depth++;
    parent = parent.parentId ? byId.get(parent.parentId) : undefined;
  }
  return depth;
}

/**
 * Bounding box of the whole diagram in absolute coordinates, including zones —
 * a zone usually extends past the nodes sitting on it, and an export that
 * cropped to the nodes would slice its background off.
 *
 * `onlyVisible` restricts the box to what the current provider selection
 * actually renders, so exporting a scenario doesn't leave whitespace where the
 * hidden nodes would have been.
 */
export function templateBounds(
  t: DiagramTemplate,
  opts: { onlyVisible?: boolean; containerKinds?: readonly string[] } = {},
): { minX: number; minY: number; maxX: number; maxY: number } {
  const zones = t.zones ?? [];
  const visible = opts.onlyVisible ? visibleElements(t).nodes : null;
  // Children of non-container parents live in that parent's drilled canvas —
  // summing their local coords into root space would inflate the box with
  // phantom area no renderer draws.
  const drillHidden = hiddenInline(t, opts.containerKinds);
  const nodes = t.nodes.filter(
    (n) => !drillHidden.has(n.id) && (!visible || visible.has(n.id)),
  );
  if (!nodes.length && !zones.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  const byId = new Map(t.nodes.map((n) => [n.id, n]));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const extend = (x: number, y: number, w: number, h: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };

  for (const zone of zones) extend(zone.x, zone.y, zone.w, zone.h);
  for (const n of nodes) {
    const { x, y } = absolutePosition(n, byId);
    extend(x, y, n.w, n.h);
  }
  return { minX, minY, maxX, maxY };
}

// ─── React Flow conversion ───────────────────────────────────────────────────
// Declared as type aliases (not interfaces) so they carry implicit index
// signatures and are assignable to @xyflow/react's Node<T>/Edge<T> generics
// without a cast.

export type DiagramNodeData = {
  label: string;
  kind: NodeKind;
  icon: IconName;
  description: string;
  /** The node's rows — a table's columns. Absent on an ordinary box. */
  fields?: NodeField[];
  fontSize?: number;
  zoneId?: string | null;
  providers?: string[];
  tags?: string[];
  url?: string;
  team?: string;
  status?: NodeStatus;
  plain?: boolean;
  locked?: boolean;
  collapsed?: boolean;
  date?: DiagramDate;
  /**
   * Rendered only because ghost mode is on — this node is hidden by the active
   * provider selection. Purely presentational; never persisted, because it
   * describes the current view rather than the document.
   */
  ghost?: boolean;
};

/** Payload for the React Flow node that renders a zone. */
export type ZoneNodeData = {
  zone: DiagramZone;
};

/** React Flow node ids are one namespace; zones get a prefix so a zone and a
 *  node may share an id without colliding. */
export const ZONE_ID_PREFIX = "zone:";
export const toZoneNodeId = (zoneId: string) => `${ZONE_ID_PREFIX}${zoneId}`;
export const fromZoneNodeId = (nodeId: string) => nodeId.slice(ZONE_ID_PREFIX.length);
export const isZoneNodeId = (nodeId: string) => nodeId.startsWith(ZONE_ID_PREFIX);

export type DiagramEdgeData = {
  style: EdgeStyle;
  color: EdgeColor;
  labelT: number;
  label: string;
  providers?: string[];
  tech?: string;
  direction?: EdgeDirection;
  seq?: number;
  date?: DiagramDate;
  /**
   * The edge's OWN routing, possibly unset — this is what persists. Writing
   * the resolved value here instead would bake the diagram default onto every
   * edge, and flipping `meta.routing` later would stop affecting them.
   */
  routing?: EdgeRouting;
  /** routing ?? meta.routing ?? "curved" — what renderers/exporters draw. */
  routingResolved: EdgeRouting;
  /** Pinned attachment on the source box. Absent = floating. */
  start?: EdgeAnchor;
  /** Pinned attachment on the target box. Absent = floating. */
  end?: EdgeAnchor;
  /** Cardinality / role text rendered just inside each endpoint. */
  startLabel?: string;
  endLabel?: string;
  /** The row each end attaches to, when the endpoint has fields. */
  startField?: string;
  endField?: string;
  /** Absolute-canvas waypoints the line routes through. */
  points?: Array<[number, number]>;
  /**
   * Set only by the read-only DiffCanvas overlay — recolours the edge by its
   * comparison state. View-only, like a node's `ghost`; never persisted
   * (`fromReactFlow` reads named fields and this is not one of them).
   */
  diffState?: "added" | "removed" | "changed";
};

export type RFNode = {
  id: string;
  type: string;
  data: DiagramNodeData;
  position: { x: number; y: number };
  width: number;
  height: number;
  style: { width: number; height: number };
  parentId?: string;
  extent?: "parent";
  /** Groups sit behind their children and must not capture clicks meant for them. */
  zIndex?: number;
};

export type RFEdge = {
  id: string;
  source: string;
  target: string;
  type: string;
  data: DiagramEdgeData;
  style: { stroke: string; strokeDasharray?: string; strokeWidth: number };
};

/**
 * The shape `fromReactFlow` reads. Deliberately looser than `RFNode`: live
 * React Flow state stores dimensions in several places depending on how the
 * node got its size (authored, measured from the DOM, or set by NodeResizer),
 * and `width`/`height` are optional there.
 */
export type RFNodeLike = {
  id: string;
  type?: string;
  data?: Partial<DiagramNodeData>;
  position: { x: number; y: number };
  width?: number | null;
  height?: number | null;
  measured?: { width?: number | null; height?: number | null };
  style?: { width?: number | string; height?: number | string };
  parentId?: string;
};

export type RFEdgeLike = {
  id: string;
  source: string;
  target: string;
  data?: Partial<DiagramEdgeData>;
};

/** First finite number among the candidates, else undefined. */
function firstSize(...values: Array<number | string | null | undefined>): number | undefined {
  for (const v of values) {
    const n = typeof v === "string" ? Number.parseFloat(v) : v;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/**
 * The canvas paints in fixed bands: zones (-1000…) under container boundaries
 * (0…depth) under edges under leaf nodes (1000…). This is the edges' band —
 * splines must clear a container's translucent body but always travel UNDER
 * the nodes themselves, never across a card. Requires the canvas to run React
 * Flow in `zIndexMode="manual"`; the default "basic" mode raises any edge
 * whose endpoint sits inside a container to that node's own z, putting the
 * spline on top of every node it crosses.
 */
export const EDGE_Z_INDEX = 500;

/**
 * Map a validated template to React Flow nodes/edges.
 *
 * React Flow requires a parent to appear BEFORE its children in the array for
 * sub-flows to lay out, so nodes are sorted by nesting depth.
 */
export function toReactFlow(
  t: DiagramTemplate,
  opts: {
    annotationKinds?: readonly string[];
    containerKinds?: readonly string[];
    /** Drop nodes hidden by the active provider selection. Default true. */
    applyVisibility?: boolean;
    /**
     * Keep hidden nodes on the canvas, flagged `data.ghost`, instead of
     * omitting them. Without this a provider-hidden node cannot be selected,
     * edited, or deleted at all — the only way to reach it is to switch the
     * zone to a provider that shows it.
     */
    showHidden?: boolean;
  } = {},
): { nodes: RFNode[]; edges: RFEdge[] } {
  const byId = new Map(t.nodes.map((n) => [n.id, n]));
  const containers = new Set(opts.containerKinds ?? CONTAINER_KINDS);
  const annotations = new Set(opts.annotationKinds ?? ANNOTATION_KINDS);

  const applyVisibility = opts.applyVisibility !== false;
  const visible = applyVisibility ? visibleElements(t) : null;

  // Zones render first and lowest — they are the backdrop everything sits on.
  // Sorted by `z` so an island stacks above the region hosting it.
  const zoneNodes: RFNode[] = [...(t.zones ?? [])]
    .sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
    .map((zone, index) => ({
      id: toZoneNodeId(zone.id),
      type: "zone",
      data: { zone } as unknown as DiagramNodeData,
      position: { x: zone.x, y: zone.y },
      width: zone.w,
      height: zone.h,
      style: { width: zone.w, height: zone.h },
      // Negative so every real node paints on top, whatever its own zIndex.
      zIndex: -1000 + index,
      // Only the header chip drags the zone; the body stays click-through so
      // it never steals a click meant for a node sitting on it.
      dragHandle: ".as-zone__header",
      ...(zone.locked ? { draggable: false } : {}),
      selectable: true,
    })) as RFNode[];

  const showHidden = opts.showHidden === true;
  // Collapse hides regardless of ghost mode — ghosts reveal provider-hidden
  // nodes for editing, but a collapsed group is intentional viewing state.
  const collapseHidden = hiddenByCollapse(t, { containerKinds: opts.containerKinds });

  const diagramNodes: RFNode[] = [...t.nodes]
    .filter((n) => !collapseHidden.has(n.id) && (!visible || showHidden || visible.nodes.has(n.id)))
    .sort((a, b) => depthOf(a, byId) - depthOf(b, byId))
    .map((n) => {
      const depth = depthOf(n, byId);
      const ghost = !!visible && !visible.nodes.has(n.id);
      const isContainer = containers.has(n.kind as string);
      const type = isContainer ? "group" : annotations.has(n.kind as string) ? "annotation" : "shape";
      // A collapsed container renders as a compact chip; its stored w/h are
      // the expanded size and come back untouched on expand.
      const w = n.collapsed ? COLLAPSED_SIZE.w : n.w;
      const h = n.collapsed ? COLLAPSED_SIZE.h : n.h;
      return {
        id: n.id,
        type,
        data: {
          label: n.label,
          kind: n.kind,
          icon: n.icon,
          description: n.description,
          ...(n.fields?.length ? { fields: n.fields } : {}),
          fontSize: n.fontSize,
          zoneId: n.zoneId ?? null,
          ...(n.providers?.length ? { providers: n.providers } : {}),
          ...(n.tags?.length ? { tags: n.tags } : {}),
          ...(n.url ? { url: n.url } : {}),
          ...(n.team ? { team: n.team } : {}),
          ...(n.status ? { status: n.status } : {}),
          ...(n.date ? { date: n.date } : {}),
          ...(n.plain ? { plain: true } : {}),
          ...(n.locked ? { locked: true } : {}),
          ...(n.collapsed ? { collapsed: true } : {}),
          ...(ghost ? { ghost: true } : {}),
        },
        position: { x: n.x, y: n.y },
        width: w,
        height: h,
        style: { width: w, height: h },
        // Containers must render behind their children; deeper nesting wins.
        // A collapsed container is a solid chip with no children on the
        // canvas, so it joins the leaf band and edges pass under it too.
        zIndex: isContainer && !n.collapsed ? depth : 1000 + depth,
        ...(n.locked ? { draggable: false } : {}),
        // Deliberately NOT `extent: "parent"`. That clamps a child inside its
        // container, which makes it impossible to drag a node back out of a
        // group. The editor re-parents on drop instead, so nesting stays
        // reversible.
        ...(n.parentId ? { parentId: n.parentId } : {}),
      };
    });

  const renderedNodeIds = new Set(diagramNodes.map((n) => n.id));
  const defaultRouting: EdgeRouting = (EDGE_ROUTINGS as readonly string[]).includes(
    t.meta?.routing as string,
  )
    ? (t.meta!.routing as EdgeRouting)
    : "curved";

  const rerouteSeen = new Set<string>();
  const edges: RFEdge[] = t.edges
    // Provider hiding drops an edge; collapse RE-ROUTES it (below). In ghost
    // mode an edge renders whenever both ends are on the canvas, so a ghosted
    // node still shows what it connects to.
    .filter((e) => {
      const providerOk = !visible
        ? true
        : showHidden
          ? renderedNodeIds.has(visibleAnchor(e.source, byId, collapseHidden)) &&
            renderedNodeIds.has(visibleAnchor(e.target, byId, collapseHidden))
          : visible.edges.has(e.id);
      return providerOk;
    })
    .flatMap((e) => {
      // Edges into a collapsed group attach to its chip instead of vanishing —
      // the chip must still show what the hidden contents talk to.
      const source = visibleAnchor(e.source, byId, collapseHidden);
      const target = visibleAnchor(e.target, byId, collapseHidden);
      if (!renderedNodeIds.has(source) || !renderedNodeIds.has(target)) return [];
      // Both ends inside the same collapsed group: internal wiring, not shown.
      if (source === target) return [];

      const rerouted = source !== e.source || target !== e.target;
      if (rerouted) {
        // Many hidden edges can converge on one chip pair; draw it once.
        const key = `${source}→${target}`;
        if (rerouteSeen.has(key)) return [];
        rerouteSeen.add(key);
      }

      return [
        {
          // Synthetic id so fromReactFlow can strip re-routed edges — they are
          // a view artifact, never part of the document.
          id: rerouted ? `${COLLAPSED_EDGE_PREFIX}${e.id}` : e.id,
          source,
          target,
          type: "labeled",
          data: {
            style: e.style,
            color: e.color,
            labelT: e.labelT ?? 0.5,
            // A re-routed edge summarises possibly many originals; a specific
            // label/tech/seq from one of them would be misleading.
            label: rerouted ? "" : e.label,
            ...(e.providers?.length ? { providers: e.providers } : {}),
            ...(!rerouted && e.tech ? { tech: e.tech } : {}),
            ...(!rerouted && e.date ? { date: e.date } : {}),
            ...(e.direction ? { direction: e.direction } : {}),
            ...(!rerouted && e.seq ? { seq: e.seq } : {}),
            ...(e.routing ? { routing: e.routing } : {}),
            // Anchors/waypoints describe the ORIGINAL endpoints' boxes; a
            // re-routed edge connects different boxes, so they don't apply.
            ...(!rerouted && e.start ? { start: e.start } : {}),
            ...(!rerouted && e.end ? { end: e.end } : {}),
            // Cardinality and row anchors name the ORIGINAL endpoints: "0..*"
            // against a chip standing in for six hidden tables is a claim
            // about none of them.
            ...(!rerouted && e.startLabel ? { startLabel: e.startLabel } : {}),
            ...(!rerouted && e.endLabel ? { endLabel: e.endLabel } : {}),
            ...(!rerouted && e.startField ? { startField: e.startField } : {}),
            ...(!rerouted && e.endField ? { endField: e.endField } : {}),
            ...(!rerouted && e.points ? { points: e.points } : {}),
            routingResolved: e.routing ?? defaultRouting,
          },
          style: {
            stroke: EDGE_COLOR_HEX[e.color],
            strokeDasharray: EDGE_DASH[e.style].join(" ") || undefined,
            strokeWidth: 1.8,
          },
        },
      ];
    });

  return { nodes: [...zoneNodes, ...diagramNodes], edges };
}

/**
 * Lift React Flow state back into the template shape — this is what makes
 * cursor edits savable. Runs through validateTemplate so the result is
 * guaranteed to satisfy the same contract as LLM output.
 */
export function fromReactFlow(
  nodes: readonly RFNodeLike[],
  edges: readonly RFEdgeLike[],
  opts: ValidateOptions & {
    meta?: DiagramTemplate["meta"];
    /**
     * The document the React Flow state was derived from.
     *
     * REQUIRED whenever zones are in play. `toReactFlow` omits nodes hidden by
     * the active provider selection, so without the original document those
     * nodes would be absent here and silently deleted on the next edit —
     * toggling a zone to AWS and back would permanently destroy every
     * Azure-only node. With `base`, anything still hidden is carried through
     * untouched.
     */
    base?: DiagramTemplate;
    /**
     * The React Flow state already contains every node, hidden ones included —
     * i.e. ghost mode is on. Skips the carry-through entirely, because with
     * nothing missing, an absent node can only mean the user deleted it.
     * Without this, deleting a ghosted node would silently resurrect it.
     */
    allNodesPresent?: boolean;
    /**
     * The exact set of base elements the current VIEW hides (a scoped
     * drill-in canvas shows one level only). When provided it REPLACES the
     * collapse-derived hidden set: the view knows better — elements it shows
     * that collapse would call hidden are genuinely editable there, so their
     * absence means deletion, not hiding.
     */
    viewHidden?: { nodes: ReadonlySet<string>; edges: ReadonlySet<string> };
    /**
     * The canvas holding no zone nodes is a view artifact (scoped views never
     * render zones), not a deletion — keep the base document's zones.
     */
    carryZones?: boolean;
  } = {},
): DiagramTemplate {
  const zoneNodes = nodes.filter((n) => isZoneNodeId(n.id));
  // Boundary frames and ghost stand-ins are scoped-view artifacts, never
  // document content — same rule as `collapsed:` edges below.
  const diagramNodes = nodes.filter(
    (n) => !isZoneNodeId(n.id) && !isBoundaryNodeId(n.id) && !isGhostNodeId(n.id),
  );
  const baseNodeById = new Map((opts.base?.nodes ?? []).map((n) => [n.id, n]));

  const zones: DiagramZone[] = zoneNodes.map((n) => {
    const stored = (n.data as unknown as ZoneNodeData | undefined)?.zone;
    return {
      ...(stored ?? { id: fromZoneNodeId(n.id), label: fromZoneNodeId(n.id), shape: "rounded", providers: [], provider: "" }),
      id: fromZoneNodeId(n.id),
      // Geometry is owned by React Flow once the zone has been dragged or
      // resized, so it wins over whatever the stored copy still says.
      x: n.position.x,
      y: n.position.y,
      w: firstSize(n.width, n.style?.width, n.measured?.width) ?? stored?.w ?? 400,
      h: firstSize(n.height, n.style?.height, n.measured?.height) ?? stored?.h ?? 300,
    } as DiagramZone;
  });

  const built = diagramNodes.map((n) => {
    const collapsed = n.data?.collapsed === true;
    // A collapsed container renders at chip size — its stored w/h are the
    // EXPANDED dimensions and must never be overwritten by the chip's, or
    // expanding would restore a group shrunk to 180×44 with its layout gone.
    const baseSize = collapsed ? baseNodeById.get(n.id) : undefined;
    return {
      id: n.id,
      label: n.data?.label ?? n.id,
      kind: n.data?.kind ?? (n.type === "group" ? "group" : "service"),
      icon: n.data?.icon ?? "none",
      description: n.data?.description ?? "",
      fields: n.data?.fields,
      parentId: n.parentId ?? null,
      zoneId: n.data?.zoneId ?? null,
      providers: n.data?.providers,
      tags: n.data?.tags,
      url: n.data?.url,
      team: n.data?.team,
      status: n.data?.status,
      date: n.data?.date,
      plain: n.data?.plain,
      locked: n.data?.locked,
      collapsed,
      x: n.position.x,
      y: n.position.y,
      // Size can live in any of three places: `width`/`height` after a
      // NodeResizer drag, `style` as authored, or `measured` once the DOM has
      // been laid out. Take the first that has a usable number; validateTemplate
      // fills in the kind default if none do.
      w: baseSize?.w ?? firstSize(n.width, n.style?.width, n.measured?.width),
      h: baseSize?.h ?? firstSize(n.height, n.style?.height, n.measured?.height),
      fontSize: n.data?.fontSize ?? 13,
    };
  });

  const builtEdges = edges
    // Re-routed collapse edges and scoped-view ghost edges are view
    // artifacts; the originals they stand in for come back via the
    // carry-through below.
    .filter((e) => !isCollapsedEdgeId(e.id) && !isGhostEdgeId(e.id))
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.data?.label ?? "",
      style: e.data?.style ?? "solid",
      color: e.data?.color ?? "slate",
      labelT: e.data?.labelT ?? 0.5,
      providers: e.data?.providers,
      tech: e.data?.tech,
      direction: e.data?.direction,
      seq: e.data?.seq,
      date: e.data?.date,
      // The edge's OWN routing — never routingResolved, which would bake the
      // diagram default onto every edge.
      routing: e.data?.routing,
      start: e.data?.start,
      end: e.data?.end,
      startLabel: e.data?.startLabel,
      endLabel: e.data?.endLabel,
      startField: e.data?.startField,
      endField: e.data?.endField,
      points: e.data?.points,
    }));

  // Carry through whatever was hidden, and only that.
  if (opts.base) {
    const present = new Set(built.map((n) => n.id));
    const presentEdges = new Set(builtEdges.map((e) => e.id));

    // Evaluate visibility against the base's OWN zones — the selection the
    // React Flow state was built from. Using the new zones would be wrong at
    // exactly the moment that matters: right after a provider toggle, React
    // Flow still holds the previous selection, so a node the new provider
    // reveals is absent from it. Judged against the new zones that node looks
    // "visible but missing" — i.e. deleted — and would be dropped.
    //
    // Against the old zones the rule is unambiguous:
    //   absent + was hidden  → it was never rendered, so carry it through
    //   absent + was visible → the user deleted it, so let it go
    //
    // Two independent reasons a node can be hidden, with different ghost-mode
    // behaviour: provider hiding is revealed by ghost mode (allNodesPresent ⇒
    // an absent provider-hidden node WAS deleted), while collapse hiding is
    // not — collapsed children are off the canvas in every mode, so they are
    // always carried.
    const before = visibleElements(opts.base);
    const beforeCollapse = hiddenByCollapse(opts.base, { containerKinds: opts.containerKinds });
    const wasNodeHidden = (id: string) =>
      (opts.viewHidden ? opts.viewHidden.nodes.has(id) : beforeCollapse.has(id)) ||
      (!opts.allNodesPresent && !before.nodes.has(id));
    const wasEdgeHidden = (e: DiagramEdge) =>
      (opts.viewHidden
        ? opts.viewHidden.edges.has(e.id)
        : beforeCollapse.has(e.source) || beforeCollapse.has(e.target)) ||
      (!opts.allNodesPresent && !before.edges.has(e.id));

    for (const node of opts.base.nodes) {
      if (!present.has(node.id) && wasNodeHidden(node.id)) {
        built.push({ ...node, providers: node.providers } as (typeof built)[number]);
      }
    }
    for (const edge of opts.base.edges) {
      if (!presentEdges.has(edge.id) && wasEdgeHidden(edge)) {
        builtEdges.push({
          ...edge,
          labelT: edge.labelT ?? 0.5,
          providers: edge.providers,
        } as (typeof builtEdges)[number]);
      }
    }
  }

  const carriedZones = zones.length
    ? zones
    : opts.carryZones && opts.base?.zones?.length
      ? opts.base.zones
      : [];
  return validateTemplate(
    {
      version: 1,
      meta: opts.meta,
      ...(carriedZones.length ? { zones: carriedZones } : {}),
      nodes: built,
      edges: builtEdges,
    },
    opts,
  );
}

// ─── Example ─────────────────────────────────────────────────────────────────

export const EXAMPLE_TEMPLATE: DiagramTemplate = {
  version: 1,
  meta: { title: "Clinic platform" },
  nodes: [
    { id: "u", label: "Clinic Staff", kind: "client", icon: "users", description: "Dentists & admins on desktop", parentId: null, x: 30, y: 190, w: 180, h: 76 },
    { id: "gw", label: "API Gateway", kind: "gateway", icon: "shield", description: "Auth, rate limiting", parentId: null, x: 280, y: 190, w: 170, h: 76 },
    { id: "vpc", label: "Application VPC", kind: "group", icon: "none", description: "", parentId: null, x: 520, y: 40, w: 440, h: 380 },
    { id: "api", label: "REST API", kind: "service", icon: "box", description: "Node / TypeScript", parentId: "vpc", x: 30, y: 60, w: 170, h: 76 },
    { id: "wrk", label: "Worker Service", kind: "service", icon: "gear", description: "Billing & claim jobs", parentId: "vpc", x: 30, y: 260, w: 170, h: 76 },
    { id: "q", label: "Job Queue", kind: "queue", icon: "layers", description: "", parentId: "vpc", x: 250, y: 165, w: 160, h: 64 },
    { id: "db", label: "Postgres", kind: "database", icon: "database", description: "Per-tenant schemas", parentId: null, x: 1030, y: 110, w: 170, h: 76 },
    { id: "cache", label: "Redis", kind: "database", icon: "bolt", description: "Sessions & cache", parentId: null, x: 1030, y: 270, w: 170, h: 76 },
    { id: "note", label: "All traffic is TLS. Tenant isolation enforced at the schema layer.", kind: "text", icon: "none", description: "", parentId: null, x: 520, y: 460, w: 340, h: 60, fontSize: 13 },
  ],
  edges: [
    { id: "e1", source: "u", target: "gw", label: "HTTPS", style: "solid", color: "slate" },
    { id: "e2", source: "gw", target: "api", label: "", style: "solid", color: "sky" },
    { id: "e3", source: "api", target: "q", label: "enqueue", style: "dashed", color: "violet" },
    { id: "e4", source: "q", target: "wrk", label: "consume", style: "dashed", color: "violet" },
    { id: "e5", source: "api", target: "db", label: "read/write", style: "solid", color: "amber" },
    { id: "e6", source: "api", target: "cache", label: "", style: "dotted", color: "rose" },
    { id: "e7", source: "wrk", target: "db", label: "", style: "solid", color: "amber" },
  ],
};

/**
 * A diagram that exercises zones: one cloud region that can be switched between
 * Azure, AWS, and GCP, with a third-party SaaS *island* drawn on top of it that
 * stays put whichever cloud is selected.
 *
 * The managed-database nodes each declare a single provider, so exactly one of
 * them is visible at a time — switching the region's toggle swaps Azure SQL for
 * RDS for Cloud SQL, in place, without editing the document.
 *
 * It also carries `date`s, so the timeline scrubber has something to run on out
 * of the box: the CDN and API are undated (they already exist), the worker
 * tier and the payments island land later in the year.
 */
export const EXAMPLE_ZONED_TEMPLATE: DiagramTemplate = {
  version: 1,
  meta: { title: "Multi-cloud deployment", versionTag: "v2.1" },
  zones: [
    {
      id: "region",
      label: "Cloud Region",
      shape: "rounded",
      x: 40,
      y: 40,
      w: 940,
      h: 520,
      providers: ["azure", "aws", "gcp"],
      provider: "azure",
      z: 0,
    },
    {
      id: "vendor",
      label: "Stripe",
      shape: "hexagon",
      x: 660,
      y: 340,
      w: 280,
      h: 190,
      providers: ["saas"],
      provider: "saas",
      // Higher z so it sits on top of the region and claims the nodes inside it.
      z: 1,
      // The island arrives with the node on it — a zone's date is its own, so
      // this has to be stated rather than inherited from `pay`.
      date: "2026-09-30",
    },
  ],
  nodes: [
    { id: "cdn", label: "CDN", kind: "gateway", icon: "globe", description: "Edge cache", parentId: null, zoneId: "region", x: 90, y: 130, w: 170, h: 76 },
    { id: "api", label: "REST API", kind: "service", icon: "box", description: "Node / TypeScript", parentId: null, zoneId: "region", tags: ["core"], url: "https://github.com/example/api", team: "Platform", x: 330, y: 130, w: 170, h: 76 },
    { id: "wrk", label: "Worker", kind: "service", icon: "gear", description: "Background jobs", parentId: null, zoneId: "region", date: "2026-06-15", x: 330, y: 300, w: 170, h: 76 },
    { id: "q", label: "Queue", kind: "queue", icon: "layers", description: "", parentId: null, zoneId: "region", date: "2026-06-15", x: 330, y: 440, w: 170, h: 64 },

    // Exactly one of these three renders at a time.
    { id: "sql-az", label: "Azure SQL", kind: "database", icon: "database", description: "Managed, geo-replicated", parentId: null, zoneId: "region", providers: ["azure"], date: "2026-03-02", x: 590, y: 120, w: 180, h: 76 },
    { id: "sql-aws", label: "Amazon RDS", kind: "database", icon: "database", description: "Multi-AZ Postgres", parentId: null, zoneId: "region", providers: ["aws"], date: "2026-03-02", x: 590, y: 120, w: 180, h: 76 },
    { id: "sql-gcp", label: "Cloud SQL", kind: "database", icon: "database", description: "Regional Postgres", parentId: null, zoneId: "region", providers: ["gcp"], date: "2026-03-02", x: 590, y: 120, w: 180, h: 76 },

    // Azure and AWS have a first-party cache here; the GCP build does without.
    { id: "cache", label: "Redis", kind: "database", icon: "bolt", description: "Sessions", parentId: null, zoneId: "region", providers: ["azure", "aws"], status: "deprecated", x: 590, y: 240, w: 180, h: 76 },

    // On the island — unaffected by the region's toggle.
    { id: "pay", label: "Payments", kind: "external", icon: "lock", description: "PCI scope", parentId: null, zoneId: "vendor", tags: ["pci"], team: "Fintech", date: "2026-09-30", x: 725, y: 405, w: 160, h: 72 },
  ],
  edges: [
    { id: "z1", source: "cdn", target: "api", label: "HTTPS", style: "solid", color: "sky" },
    { id: "z2", source: "api", target: "sql-az", label: "read/write", tech: "SQL", style: "solid", color: "amber" },
    { id: "z3", source: "api", target: "sql-aws", label: "read/write", style: "solid", color: "amber" },
    { id: "z4", source: "api", target: "sql-gcp", label: "read/write", style: "solid", color: "amber" },
    { id: "z5", source: "api", target: "cache", label: "", style: "dotted", color: "rose" },
    { id: "z6", source: "api", target: "q", label: "enqueue", tech: "AMQP", seq: 1, style: "dashed", color: "violet" },
    { id: "z7", source: "q", target: "wrk", label: "consume", tech: "AMQP", seq: 2, style: "dashed", color: "violet" },
    { id: "z8", source: "api", target: "pay", label: "charge", style: "solid", color: "emerald" },
  ],
};

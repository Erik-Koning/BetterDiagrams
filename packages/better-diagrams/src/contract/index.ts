/**
 * contract/ — the portable half.
 *
 * Zero dependencies: no React, no @xyflow/react, no DOM. This is the half you
 * can copy into a backend, a Lambda, or an LLM pipeline and run as-is — it
 * defines the document, validates it, generates the system prompt that
 * produces it, and transforms it.
 *
 *   import { validateTemplate, buildSystemPrompt } from "@mosphere/better-diagrams/contract";
 *
 * The React Flow adapters live here too (`toReactFlow` / `fromReactFlow`), but
 * only as *structural* types — they describe the shape without importing the
 * library, so a server can produce React Flow state it never has to render.
 *
 * Exports are curated: every name here is a deliberate semver commitment.
 * Layout maths, pixel constants, and id plumbing stay module-private — if you
 * need one of them, open an issue rather than reaching into the source.
 */

// ── The document: vocabulary, schema, validation, migration ──────────────────
export {
  NODE_KINDS,
  CONTAINER_KINDS,
  ANNOTATION_KINDS,
  ICON_NAMES,
  EDGE_STYLES,
  EDGE_COLORS,
  PROVIDER_IDS,
  EDGE_DIRECTIONS,
  EDGE_ROUTINGS,
  EDGE_ANCHOR_SIDES,
  FIELD_KEYS,
  NODE_STATUSES,
  VERSION_TAG_POSITIONS,
  GROUP_CONTENTS,
  ARRANGE_MODES,
  NOTATIONS,
  EDGE_COLOR_HEX,
  EDGE_DASH,
  KIND_DEFAULT_SIZE,
  EMPTY_TEMPLATE,
  EXAMPLE_TEMPLATE,
  EXAMPLE_ZONED_TEMPLATE,
  CURRENT_VERSION,
  MIGRATIONS,
  migrateTemplate,
  validateTemplate,
  visibleElements,
  assignZonesByGeometry,
  snapNodesIntoZones,
  scaleZoneMembers,
  setZoneProvider,
  setAllZoneProviders,
  templateProviders,
  activeScenario,
  absolutePosition,
  templateBounds,
  buildSystemPrompt,
  DIAGRAM_SYSTEM_PROMPT,
  parseLlmTemplate,
  parseLlmTemplateReport,
  safeUrl,
  FILE_LINK_PREFIX,
  toReactFlow,
  fromReactFlow,
  // Data-model rows: the metrics, the row→anchor maths, and the resolvers
  // both the canvas and the exporters route field-anchored edges through —
  // one edge's rows, and the document-wide pass that un-crosses them.
  FIELD_ROW_H,
  MAX_NODE_FIELDS,
  fieldListTop,
  fieldsBoxHeight,
  fieldRowT,
  fieldAnchors,
  uncrossFieldAnchors,
  withEndSlots,
  // Node text layout and container frame styling — the vocabularies a host
  // building its own inspector needs, plus the height a wrapped label demands.
  NODE_TEXT_ALIGNS,
  NODE_TEXT_VALIGNS,
  NODE_OUTLINES,
  DEFAULT_CONTAINER_OPACITY,
  DEFAULT_FONT_SIZE,
  nodeTextWidth,
  wrappedTitleHeight,
} from "./schema";
// The one text measurement validation, the canvas and every exporter share.
// Public because a host drawing its own node bodies has to agree with it.
export { approxTextWidth, ellipsise, wrapText, wrappedLineCount } from "./text";
export type { TextFont } from "./text";
export type {
  NodeKind,
  IconName,
  EdgeStyle,
  EdgeColor,
  ProviderId,
  EdgeDirection,
  EdgeRouting,
  EdgeAnchor,
  EdgeAnchorSide,
  NodeField,
  FieldKey,
  FieldAnchorNode,
  UncrossNode,
  EndSlots,
  NodeStatus,
  NodeTextAlign,
  NodeTextVAlign,
  NodeOutline,
  VersionTagPosition,
  GroupContents,
  ArrangeMode,
  Notation,
  DiagramNode,
  DiagramEdge,
  DiagramTemplate,
  DiagramSettings,
  ZoneBox,
  ScaleZoneOptions,
  Migration,
  PromptOptions,
  ValidateOptions,
  Visibility,
  DiagramNodeData,
  ZoneNodeData,
  DiagramEdgeData,
  RFNode,
  RFEdge,
  RFNodeLike,
  RFEdgeLike,
} from "./schema";

// ── Zones ────────────────────────────────────────────────────────────────────
export { ZONE_SHAPES, ZONE_OUTLINES } from "./zones";
export type { DiagramZone, ZoneOutline, ZoneShape, ZonePoint } from "./zones";

// ── Relationship kinds (what a data model's lines mean, and how they dress) ─
export {
  RELATION_KINDS,
  RELATION_KIND_ORDER,
  FALLBACK_RELATION,
  relationDressing,
  resolveRelationKinds,
} from "./relations";
export type { RelationKindDef } from "./relations";
export { junctionTables, collapseJunctions } from "./junctions";
export type { JunctionTable } from "./junctions";

// ── Fields (rows plus what the data bag knows about them) ───────────────────
export {
  fieldKey,
  sameFieldRef,
  edgeFieldIds,
  dataFields,
  nameIndex,
  fieldRecords,
  fieldOutEdges,
  fieldInEdges,
  referencedKey,
  hasField,
  buildFieldIndex,
  searchFields,
  keyFields,
  edgeKeyOf,
} from "./fields";
export type {
  FieldRef,
  Pin,
  KeyInfo,
  FieldTarget,
  FieldRecord,
  FieldDocument,
  DataField,
  FieldIndex,
  FieldIndexEntry,
  FieldHit,
} from "./fields";

// ── Key coverage (how much of a model a set of keys reaches) ────────────────
export { keyCoverage, marginalGains, minimalKeyCover, storesFields } from "./coverage";
export type {
  CoverageScope,
  CoverageOptions,
  CoverageResult,
  KeyGain,
  MinimalCoverOptions,
  MinimalCoverResult,
} from "./coverage";

// ── Paths (named flows the reader can light up) ──────────────────────────────
export { PATH_COLOR_CYCLE, pathColor, resolvePath } from "./paths";
export type { DiagramPath, PathGlow, ResolvedPath, ResolvedPathStep } from "./paths";
// Finding walks rather than resolving written ones: BFS, k-shortest, all
// simple routes, neighbourhoods — and the bridge back to a lit path.
export {
  shortestPath,
  shortestPaths,
  allSimplePaths,
  neighbourhood,
  walkToPath,
  walkLength,
  sameWalk,
  fieldPaths,
  between,
  enumerateRoutes,
  keyFrequency,
  reachableFrom,
} from "./graph";
export type {
  GraphDocument,
  GraphOptions,
  GraphWalk,
  FieldEndpoint,
  FieldPathOptions,
  FieldPathResult,
  BetweenOptions,
  BetweenResult,
  KeyUse,
  KeyFrequencyResult,
  ReachableResult,
} from "./graph";

// ── Folder format (directory tree ⇄ document) ───────────────────────────────
export {
  importFolder,
  exportFolder,
  detectDialect,
  buildFolderTree,
  treeFiles,
  genericDialect,
  dataModelDialect,
  createDataModelDialect,
  DATAMODEL_KINDS,
  dataModelRegistry,
  SIDECAR_DIR,
  LAYOUT_FILE,
  OVERRIDES_FILE,
  MANIFEST_FILE,
  OVERRIDES_FORMAT,
  FOLDER_FORMAT,
  AUTO_FOLD_NODES,
  parseFlatYaml,
  patchFlatYaml,
} from "./folder";
export type {
  Dialect,
  DialectRegistry,
  FolderExportOptions,
  FolderExportResult,
  FileMap,
  FolderEntry,
  FolderNode,
  FolderOverrides,
  FolderTree,
  FolderManifest,
  FolderImportOptions,
  FolderImportResult,
  ImportStats,
  ImportWarning,
  ImportWarningCode,
  NodeBaseline,
  NodeOverride,
  DataModelDialectOptions,
  EntitySchema,
  EntityField,
  ForeignKey,
  RelationshipKind,
} from "./folder";

// ── Auto-layout ──────────────────────────────────────────────────────────────
export { autoLayout, hasOverlaps, placeUnpositioned } from "./layout";
export type { LayoutOptions } from "./layout";

// ── Content/presentation split ───────────────────────────────────────────────
export {
  PRESENTATION_FORMAT,
  validatePresentation,
  splitTemplate,
  mergeTemplate,
} from "./presentation";
export type {
  DiagramPresentation,
  DiagramContent,
  NodePlacement,
  EdgeRoute,
  ViewRecord,
} from "./presentation";

// ── Scoped views (C4 drill-down) ─────────────────────────────────────────────
export { scopedView, liftScopedReactFlow, drillableIds, focusPath } from "./scope";
export type { ScopedViewOptions } from "./scope";
// Moving contents BETWEEN levels — the edit the views above only display.
export { nestContents, inlineContents } from "./nesting";
export type { NestOptions, InlineOptions } from "./nesting";
export {
  BOUNDARY_NODE_PREFIX,
  GHOST_NODE_PREFIX,
  GHOST_EDGE_PREFIX,
  isBoundaryNodeId,
  isGhostNodeId,
  isGhostEdgeId,
  ghostSourceId,
  validateViewRecords,
} from "./schema";

// ── Clipboard ────────────────────────────────────────────────────────────────
export {
  FRAGMENT_MARKER,
  copyFragment,
  pasteFragment,
  duplicateWithConnections,
  parseFragment,
} from "./clipboard";
export type { Fragment, PasteResult } from "./clipboard";

// ── LLM generation ───────────────────────────────────────────────────────────
export {
  createProxyGenerator,
  coerceGeneratorResult,
  buildRefineMessage,
} from "./llm";
export type {
  GenerateRequest,
  DiagramGenerator,
  ProxyGeneratorOptions,
} from "./llm";

// ── JSON repair ──────────────────────────────────────────────────────────────
// The gentle healer behind parseLlmTemplate / parseLlmSequence, exported on
// its own for pipelines that parse model replies or pasted JSON themselves.
export { repairJsonText } from "./json-repair";
export type { JsonRepairResult, JsonRepairOptions, JsonApproximation } from "./json-repair";

// ── Lint ─────────────────────────────────────────────────────────────────────
export { BUILTIN_LINT_RULES, lintTemplate, LINT_IGNORE_TAG, lintIgnored } from "./lint";
export type { LintSeverity, LintIssue, LintRuleDef, LintFinding } from "./lint";

// ── Diff ─────────────────────────────────────────────────────────────────────
export {
  POSITIONAL_FIELDS,
  VIEW_FIELDS,
  DEFAULT_DIFF_IGNORE,
  diffTemplates,
  diffSequences,
} from "./diff";
export type {
  DiffState,
  ChangedEntry,
  CollectionDiff,
  TemplateDiff,
  SequenceDiff,
} from "./diff";

// ── Sequence diagrams ────────────────────────────────────────────────────────
export {
  SEQ_CURRENT_VERSION,
  SEQ_MIGRATIONS,
  migrateSequence,
  PARTICIPANT_KINDS,
  MESSAGE_STYLES,
  FRAGMENT_KINDS,
  NOTE_SIDES,
  EMPTY_SEQUENCE,
  EXAMPLE_SEQUENCE,
  validateSequence,
  sequenceFromTemplate,
  removeMessages,
  moveMessage,
  moveParticipant,
  buildSequencePrompt,
  parseLlmSequence,
  parseLlmSequenceReport,
  buildSequenceRefineMessage,
  toSequenceFlow,
  fromSequenceFlow,
} from "./sequence";
export type {
  ParticipantKind,
  MessageStyle,
  FragmentKind,
  NoteSide,
  SeqParticipant,
  SeqMessage,
  SeqActivation,
  SeqFragment,
  SeqNote,
  SequenceTemplate,
  SeqRFNode,
  SeqRFEdge,
} from "./sequence";

// ── Timeline ─────────────────────────────────────────────────────────────────
export {
  normalizeDate,
  formatDiagramDate,
  TIMELINE_FUTURE_MODES,
  EMPTY_TIMELINE,
  buildTimeline,
  timelineStop,
  effectiveNodeDates,
  timelineView,
  templateTimeline,
  sequenceTimelineView,
  sequenceTimeline,
  PRE_ACTIVE_STATUSES,
  isOverdue,
} from "./timeline";
export type {
  DiagramDate,
  FormatDateOptions,
  TimelineFutureMode,
  Timeline,
  TimelineFuture,
  TimelineView,
  SequenceTimelineView,
} from "./timeline";

// ── Visual states (zone providers × timeline stops) ──────────────────────────
export {
  templateStateAxes,
  sequenceStateAxes,
  countStateCombos,
  enumerateStateCombos,
  comboLabel,
  comboSlug,
  materializeCombo,
  materializeSequenceCombo,
} from "./states";
export type { ZoneAxis, StateAxes, StateCombo, StateSelection } from "./states";

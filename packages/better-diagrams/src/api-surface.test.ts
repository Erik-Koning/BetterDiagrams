/**
 * @vitest-environment jsdom
 *
 * The public API surface, pinned.
 *
 * Every name below is a semver commitment. A new export must be added here
 * deliberately; a removed or renamed one is a breaking change. If this test
 * fails because you added `export *` or a new symbol to a barrel, that is the
 * test doing its job — curate, then update the list.
 *
 * `Object.keys` on a module namespace sees runtime exports only; type-only
 * drift is not caught here.
 */
import { describe, expect, it } from "vitest";

// Grouped by contract module, mirroring src/contract/index.ts.
const CONTRACT_EXPORTS = [
  // schema
  "NODE_KINDS",
  "CONTAINER_KINDS",
  "ANNOTATION_KINDS",
  "ICON_NAMES",
  "EDGE_STYLES",
  "EDGE_COLORS",
  "PROVIDER_IDS",
  "EDGE_DIRECTIONS",
  "EDGE_ROUTINGS",
  "EDGE_ANCHOR_SIDES",
  "NODE_STATUSES",
  "VERSION_TAG_POSITIONS",
  "EDGE_COLOR_HEX",
  "EDGE_DASH",
  "KIND_DEFAULT_SIZE",
  "EMPTY_TEMPLATE",
  "EXAMPLE_TEMPLATE",
  "EXAMPLE_ZONED_TEMPLATE",
  "CURRENT_VERSION",
  "MIGRATIONS",
  "migrateTemplate",
  "validateTemplate",
  "visibleElements",
  "assignZonesByGeometry",
  "snapNodesIntoZones",
  "scaleZoneMembers",
  "setZoneProvider",
  "setAllZoneProviders",
  "templateProviders",
  "activeScenario",
  "absolutePosition",
  "templateBounds",
  "buildSystemPrompt",
  "DIAGRAM_SYSTEM_PROMPT",
  "parseLlmTemplate",
  "toReactFlow",
  "fromReactFlow",
  // data-model rows
  "FIELD_KEYS",
  "FIELD_ROW_H",
  "MAX_NODE_FIELDS",
  "fieldListTop",
  "fieldsBoxHeight",
  "fieldRowT",
  "fieldAnchors",
  // zones
  "ZONE_OUTLINES",
  "ZONE_SHAPES",
  // layout
  "autoLayout",
  "hasOverlaps",
  "placeUnpositioned",
  // content/presentation split
  "PRESENTATION_FORMAT",
  "validatePresentation",
  "splitTemplate",
  "mergeTemplate",
  // scoped views (C4 drill-down)
  "scopedView",
  "liftScopedReactFlow",
  "drillableIds",
  "focusPath",
  "BOUNDARY_NODE_PREFIX",
  "GHOST_NODE_PREFIX",
  "GHOST_EDGE_PREFIX",
  "isBoundaryNodeId",
  "isGhostNodeId",
  "isGhostEdgeId",
  "ghostSourceId",
  "validateViewRecords",
  // clipboard
  "FRAGMENT_MARKER",
  "copyFragment",
  "pasteFragment",
  "duplicateWithConnections",
  "parseFragment",
  // llm
  "createProxyGenerator",
  "coerceGeneratorResult",
  "buildRefineMessage",
  // json repair
  "repairJsonText",
  // lint
  "BUILTIN_LINT_RULES",
  "lintTemplate",
  // diff
  "POSITIONAL_FIELDS",
  "PRE_ACTIVE_STATUSES",
  "diffTemplates",
  // sequence
  "SEQ_CURRENT_VERSION",
  "SEQ_MIGRATIONS",
  "migrateSequence",
  "PARTICIPANT_KINDS",
  "MESSAGE_STYLES",
  "FRAGMENT_KINDS",
  "NOTE_SIDES",
  "EMPTY_SEQUENCE",
  "EXAMPLE_SEQUENCE",
  "validateSequence",
  "sequenceFromTemplate",
  "buildSequencePrompt",
  "parseLlmSequence",
  "buildSequenceRefineMessage",
  "toSequenceFlow",
  "fromSequenceFlow",
  // timeline
  "isOverdue",
  "normalizeDate",
  "formatDiagramDate",
  "TIMELINE_FUTURE_MODES",
  "EMPTY_TIMELINE",
  "buildTimeline",
  "timelineStop",
  "effectiveNodeDates",
  "timelineView",
  "templateTimeline",
  "sequenceTimelineView",
  "sequenceTimeline",
  // states
  "templateStateAxes",
  "sequenceStateAxes",
  "countStateCombos",
  "enumerateStateCombos",
  "comboLabel",
  "comboSlug",
  "materializeCombo",
  "materializeSequenceCombo",
];

// Grouped by react module, mirroring src/react/index.ts.
const REACT_EXPORTS = [
  // ArchitectureStudio / DiffCanvas
  "ArchitectureStudio",
  "DiffCanvas",
  // sequence
  "SequenceStudio",
  "BUILTIN_SEQUENCE_EXPORTERS",
  "renderSequenceToCanvas",
  "renderSequenceToSvg",
  "renderSequenceToMermaid",
  "renderSequenceToPlantUml",
  "emitSequence",
  // registry
  "createRegistry",
  "resolveRegistry",
  "BUILTIN_NODE_KINDS",
  "BUILTIN_PROVIDERS",
  "kindDef",
  "iconPaths",
  "providerDef",
  "zoneFill",
  "zoneInk",
  "FALLBACK_KIND",
  "FALLBACK_PROVIDER",
  // icons
  "BUILTIN_ICON_PATHS",
  "SvgIcon",
  // exporters
  "BUILTIN_EXPORTERS",
  "renderTemplateToCanvas",
  "renderTemplateToSvg",
  "renderTemplateToMermaid",
  "renderTemplateToC4Puml",
  "emitTemplate",
  "DARK_EXPORT_PALETTE",
  "LIGHT_EXPORT_PALETTE",
  "buildTimelineHtml",
  "buildMultiViewHtml",
  "buildTemplateSystemPrompt",
  "templatePromptContext",
  "silhouettePath",
  // theme
  "themeToStyle",
  "paletteFromTheme",
  "DARK_THEME",
  "LIGHT_THEME",
  // chrome
  "BrandMark",
  "DateChip",
  "WelcomeModal",
  "TimelineScrubber",
];

describe("public API surface", () => {
  it("contract entry exports exactly the curated list", async () => {
    const actual = Object.keys(await import("./contract/index")).sort();
    expect(actual).toEqual([...CONTRACT_EXPORTS].sort());
  });

  it("root entry exports exactly contract + react", async () => {
    const actual = Object.keys(await import("./index")).sort();
    expect(actual).toEqual([...CONTRACT_EXPORTS, ...REACT_EXPORTS].sort());
  });

  // The root barrel is a double `export *`; a name collision between the
  // halves would silently drop one binding.
  it("the two halves never collide", () => {
    expect(CONTRACT_EXPORTS.filter((n) => REACT_EXPORTS.includes(n))).toEqual([]);
  });
});
